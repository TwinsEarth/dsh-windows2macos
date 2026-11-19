/**
 * The execute phase: argv execution, timeout/cancel handling and the evidence a
 * result envelope is shaped from.
 *
 * `runTask()` is the second half of the one lifecycle `handleOffer()` used to be:
 * the offer phase validates and gates an offer, then hands it here together with
 * the anchors it already collected, the allow-list decision it already made and
 * the abort controller it already created. The stage loop keeps its original
 * order exactly -- per-stage allow-list check, whole-chain timeout budget,
 * per-stage blob decision, then the workspace/patch evidence and `finish()` --
 * because that order is the contract the suites pin.
 *
 * The one piece of state shared with the offer phase is passed by reference
 * (`executionState.workspaceState`) so the offer phase's catch can still remove a
 * worktree this phase created before it threw, exactly as the single closure did.
 *
 * No module-level mutable state.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyExit, runArgv, sha256Hex } from '../exec.mjs';
import {
  WARN_DIRTY_WORKTREE,
  WARN_FINGERPRINT_UNAVAILABLE,
  collectPreAnchors,
  normalizeRelPath,
  resolveProjectCwd,
} from '../git.mjs';
import { matchAllowedCommand } from '../allowed-commands.mjs';
import { EXEC_CAPABILITY_PREFIXES } from '../../util/exec-capability.mjs';
import {
  commitTaskChanges,
  createWorktree,
  listChangedFiles,
  producePatch,
  removeWorktree,
} from '../worktree.mjs';
import { describePatchArtifact } from '../patch-artifact.mjs';
import { ferryMaintenance } from '../maintenance-ferry.mjs';
import { planStageOutput } from '../../util/dataflow.mjs';
import { DEFAULT_TIMEOUT_MS, REFUSAL } from './shared.mjs';

/**
 * @param {object} deps The composition bag assembled by `createAgent()`.
 */
export function createExecutePhase(deps) {
  const { log, identity, project, allowedCommands, maxOutputBytes, tmpDir, objectMode, rabbitUrl } = deps;
  const { putBlobBytes } = deps.http;
  const { finish } = deps.deliver;

  const token = () => identity.device_token;

  /** Collect anchors, converting failures into warnings instead of throws. */
  async function safeAnchors(warnings) {
    try {
      const anchors = await collectPreAnchors({
        cwd: project,
        tmpDir,
        objectMode,
      });
      if (anchors.fingerprint_error && !warnings.includes(WARN_FINGERPRINT_UNAVAILABLE)) {
        warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      }
      if (anchors.dirty_before === true && !warnings.includes(WARN_DIRTY_WORKTREE)) {
        warnings.push(WARN_DIRTY_WORKTREE);
      }
      return anchors;
    } catch (error) {
      warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      log('warn', 'could not collect anchors', { error: error?.message ?? String(error) });
      return {
        head_commit: null,
        head_tree: null,
        pre_tree_fingerprint: null,
        fingerprint_error: 'ANCHOR_COLLECTION_FAILED',
        fingerprint_error_detail: error?.message ?? String(error),
        dirty_before: null,
        untracked: [],
      };
    }
  }

  /**
   * Run the remaining lifecycle of one offer, from the argv loop to `finish()`.
   *
   * @param {object} context The gates the offer phase already passed.
   */
  async function runTask(context) {
    const {
      offer,
      cwdRel,
      commandArgv,
      controller,
      anchorsBefore,
      warnings,
      startedAt,
      heartbeat,
      authorization,
      grantAuthorized,
      capabilityAuthorized,
      executionState,
    } = context;

      // ---- 6. execute ------------------------------------------------------
      //
      // Every offer has at least one stage: a single-command task is the one-stage case (the relay
      // normalizes it that way), so there is no separate branch for the chain. `pipeline` adds
      // ordering and stop-on-failure, not a second execution path.
      const isPipeline = Array.isArray(offer.stages) && offer.stages.length > 0;
      const plannedStages = isPipeline
        ? offer.stages.map((s, i) => ({
          index: i,
          command_argv: [...s.command_argv],
          cwd_rel: typeof s.cwd_rel === 'string' && s.cwd_rel ? s.cwd_rel : (offer.cwd_rel ?? '.'),
          continue_on_failure: s.continue_on_failure === true,
        }))
        : [{ index: 0, command_argv: [...offer.command_argv], cwd_rel: offer.cwd_rel ?? '.', continue_on_failure: false }];

      // ---- 6a. allow-list, again, for **every** stage ----------------------
      //
      // Step 5 checked the offer's `command_argv`, which the relay sets to `stages[0].command_argv`
      // (src/relay/state.mjs) -- so on a chain it vouched for the first stage alone. The plugin's
      // dispatch-time pre-flight does check every stage (src/plugin/tools.mjs), and its comment says
      // why: "the allow-list is a default-deny control, and a chain is not an exemption from it".
      // But that pre-flight runs on the *dispatcher*, and a dispatcher that posts straight to
      // `/v1/task` with the operator token never calls it. Enforcement on the machine that executes
      // is the only control that survives a hostile dispatcher, so it has to be here as well.
      //
      // The whole chain is refused before anything runs, not at the offending stage: running stages
      // 1..n-1 of a chain that will not finish would leave side effects from work the caller was
      // never allowed to ask for, and the plugin's pre-flight refuses the dispatch as a whole for the
      // same reason. The refusal names the stage index, because "this chain is not allowed" is not
      // actionable without knowing which stage.
      /**
       * v1.2.10: a reduce task carries the artifacts it consumes, and the machine fetches them BEFORE the reduce command runs.
       *
       * The list is the caller's completeness decision (the relay validated its shape, never its truth), and the bytes are
       * content-addressed, so the fetch verifies nothing less than the hash already did. A failed fetch refuses the whole task:
       * a reduce that ran on half the inputs would produce a confident wrong answer, which is the failure this feature exists to
       * make impossible.
       */
      /**
       * v1.3.10-beta.2: a maintenance request is verified and carried by maintenance-ferry.mjs, not executed here. The
       * agent has no privilege to run update/restart/diag, which is the point of the separation.
       */
      if (offer && typeof offer.maintenance === 'object' && offer.maintenance !== null) {
        const ferryStarted = Date.now();
        const ferriedRaw = await ferryMaintenance({ offer, machineId: String(offer.machine_id ?? identity.machine_id ?? '') });
        // The ferry successful only means the runner wrote a result file; the runner itself may have failed. Reporting that
        // as ok would tell the operator a restart/update happened when it did not.
        const runnerOk = ferriedRaw.ok === true && ferriedRaw.result?.status === 'ok';
        const ferried = runnerOk ? ferriedRaw : { ok: false, code: ferriedRaw.result?.code ?? ferriedRaw.code ?? 'MAINTENANCE_FAILED', message: ferriedRaw.result?.code ?? ferriedRaw.message ?? 'maintenance runner reported failure', requestId: ferriedRaw.requestId };
        const stdoutText = JSON.stringify(ferried).slice(0, 64 * 1024);
        const stderrText = ferried.ok ? '' : (ferried.message ?? ferried.code ?? 'maintenance failed');
        // The envelope builder hashes and sizes the output; leaving any of these undefined makes canonicalisation fail
        // with a JCS error and the task is reported as crashed after the maintenance action already ran.
        const execution = {
          exit_code: ferried.ok ? 0 : 1,
          stdout: stdoutText,
          stderr: stderrText,
          stdout_sha256: sha256Hex(stdoutText),
          stderr_sha256: sha256Hex(stderrText),
          stdout_bytes: Buffer.byteLength(stdoutText, 'utf8'),
          stderr_bytes: Buffer.byteLength(stderrText, 'utf8'),
          duration_ms: Date.now() - ferryStarted,
          timed_out: ferried.code === 'MAINTENANCE_RUNNER_TIMEOUT',
        };
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution,
          authorization: { provenance: 'maintenance', capability_id: typeof offer.maintenance?.request_id === 'string' ? offer.maintenance.request_id : null },
          status: ferried.ok ? 'ok' : 'failed',
          refusalReason: ferried.ok ? null : 'MAINTENANCE_FAILED',
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
          protocolViolations: [],
        });
        return;
      }

      let reduceEnv = null;
      if (Array.isArray(offer.reduce_inputs) && offer.reduce_inputs.length > 0) {
        try {
          const inputDir = mkdtempSync(join(tmpdir(), 'w2m-reduce-'));
          const manifest = [];
          for (const artifact of offer.reduce_inputs) {
            const response = await fetch(rabbitUrl + '/v1/fleet/blobs/' + encodeURIComponent(artifact.sha256), {
              headers: token() ? { authorization: 'Bearer ' + token() } : {},
            });
            if (response.status !== 200) {
              throw new Error('blob ' + artifact.sha256 + ' -> HTTP ' + response.status);
            }
            const body = Buffer.from(await response.arrayBuffer());
            const file = join(inputDir, String(artifact.machine_id).replace(/[^A-Za-z0-9._-]/g, '_') + '.bin');
            writeFileSync(file, body);
            manifest.push({ machine_id: artifact.machine_id, sha256: artifact.sha256, bytes: body.length, file });
          }
          const manifestPath = join(inputDir, 'manifest.json');
          writeFileSync(manifestPath, JSON.stringify({ reduce_of: offer.reduce_of ?? null, inputs: manifest }, null, 2));
          reduceEnv = {
            W2M_REDUCE_INPUTS_DIR: inputDir,
            W2M_REDUCE_MANIFEST: manifestPath,
            W2M_REDUCE_OF: String(offer.reduce_of ?? ''),
          };
        } catch (error) {
          log('warn', offer.task_id + ': reduce input fetch failed', { error: error?.message ?? String(error) });
          await finish({
            offer,
            cwdRel,
            commandArgv,
            anchorsBefore,
            anchorsAfter: null,
            execution: null,
            status: 'refused',
            refusalReason: 'REDUCE_INPUT_FETCH_FAILED',
            warnings,
            startedAt,
            endedAt: new Date().toISOString(),
            protocolViolations: ['reduce inputs could not be fetched: ' + (error?.message ?? String(error))],
          });
          return;
        }
      }

      /**
       * v1.3.13-beta.2 (task model): run a workspace task in its own git worktree at the caller base_commit, then turn the
       * result into a content-addressed patch. Created only after the allow-list/grant gate, so a refused task never leaves a
       * tree behind; cleaned before the envelope is sent, so the reported evidence describes a finished state.
       */
      if (offer.workspace !== null && offer.workspace !== undefined) {
        if (offer.workspace.kind !== 'worktree') {
          await finish({ offer, cwdRel, commandArgv, anchorsBefore, anchorsAfter: null, execution: null, status: 'refused', refusalReason: 'WORKSPACE_UNSUPPORTED', warnings: ['WORKSPACE_UNSUPPORTED: only worktree workspaces exist'], startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
          return;
        }
        const workspaceDirName = String(offer.task_id).replace(/[^A-Za-z0-9._-]/g, '_');
        const worktreeDir = join(project, '.w2m-worktrees', workspaceDirName);
        const created = await createWorktree({ repoDir: project, baseCommit: offer.workspace.base_commit, worktreeDir });
        if (created.ok !== true) {
          log('warn', `refused ${offer.task_id}: WORKSPACE_CREATE_FAILED`, { code: created.code });
          await finish({ offer, cwdRel, commandArgv, anchorsBefore, anchorsAfter: null, execution: null, status: 'refused', refusalReason: 'WORKSPACE_CREATE_FAILED', warnings: ['WORKSPACE_CREATE_FAILED: ' + String(created.code ?? 'unknown')], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), protocolViolations: ['workspace could not be created'] });
          return;
        }
        executionState.workspaceState = { worktreeDir, baseCommit: offer.workspace.base_commit, produce: offer.workspace.produce ?? 'patch', relCwd: '.w2m-worktrees/' + workspaceDirName };
        log('info', `${offer.task_id} workspace ${executionState.workspaceState.baseCommit.slice(0, 12)} at ${executionState.workspaceState.relCwd}`);
      }

      for (const stage of plannedStages) {
        // v1.3.10-beta.6: a grant that authorised step 5 covers the whole task, but only for the argv it signed.
      const stageAllowList = matchAllowedCommand(stage.command_argv, allowedCommands);
      const stageAllowed = grantAuthorized
        ? { allowed: true, ok: true }
        : stageAllowList.allowed === true
          ? { allowed: true, ok: true }
          : capabilityAuthorized ? matchAllowedCommand(stage.command_argv, EXEC_CAPABILITY_PREFIXES) : stageAllowList;
        if (stageAllowed.allowed) continue;
        const code = stageAllowed.reason_code ?? REFUSAL.COMMAND_NOT_ALLOWED;
        if (executionState.workspaceState !== null) { try { await removeWorktree({ repoDir: project, worktreeDir: executionState.workspaceState.worktreeDir }); } catch { /* best effort */ } }
        log('warn', `refused ${offer.task_id}: ${code} at stage ${stage.index}`, {
          argv: stage.command_argv,
        });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: code,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
          // `protocol_violations` is the field a reader already finds a refused stage in (see the
          // cwd refusal below), and the stage index is the fact that makes it actionable. The
          // top-level `refusal_reason` carries the code the plugin's pre-flight would have reported.
          protocolViolations: [`stage ${stage.index}: ${code} - ${stageAllowed.detail}`],
        });
        return;
      }

      // The task's timeout is a budget for the whole chain, not per stage. Giving each stage the full
      // timeout would let a 16-stage pipeline run 16x longer than the caller asked for, and the relay
      // would have given up long before.
      const totalBudgetMs = Number.isFinite(offer.timeout_ms) ? offer.timeout_ms : DEFAULT_TIMEOUT_MS;
      const chainStartedAt = Date.now();

      const stageReports = [];
      /** The last stage's blob reference, so the envelope can name it without re-deriving anything. */
      let lastBlobSha256 = null;
      /** The last stage's execution, used for the envelope's top-level exit code and output hashes. */
      let execution = null;
      let stoppedAt = null;
      const protocolViolations = [];

      for (const stage of plannedStages) {
        heartbeat.setPhase('running', 50);

        // A workspace task runs in its own copy: an explicit stage cwd is relative to that copy, and the default is its root.
      const workspaceRel = executionState.workspaceState === null
        ? null
        : (stage.cwd_rel === undefined || stage.cwd_rel === cwdRel || stage.cwd_rel === '.')
          ? executionState.workspaceState.relCwd
          : executionState.workspaceState.relCwd + '/' + normalizeRelPath(stage.cwd_rel);
      const stageCwdOutcome = resolveProjectCwd(project, workspaceRel ?? stage.cwd_rel, { allowOutside: offer.cwd_outside_project === true });
        if (!stageCwdOutcome.ok) {
          // A stage whose cwd is outside the project is a refusal of the whole chain: continuing
          // would run later stages against a working directory the caller never asked for.
          protocolViolations.push(`stage ${stage.index}: ${stageCwdOutcome.reason}`);
          stageReports.push({
            index: stage.index,
            command_argv: stage.command_argv,
            cwd_rel: stage.cwd_rel,
            status: 'refused',
            refusal_reason: stageCwdOutcome.reason,
            exit_code: null,
            duration_ms: 0,
          });
          stoppedAt = stage.index;
          break;
        }

        const elapsedMs = Date.now() - chainStartedAt;
        const remainingMs = totalBudgetMs - elapsedMs;
        if (remainingMs <= 0) {
          warnings.push('PIPELINE_BUDGET_EXHAUSTED');
          stageReports.push({
            index: stage.index,
            command_argv: stage.command_argv,
            cwd_rel: stage.cwd_rel,
            status: 'timeout',
            exit_code: null,
            duration_ms: 0,
          });
          stoppedAt = stage.index;
          break;
        }

        /**
         * v1.1.15 (P1): the executed command learns which machine and which slice it is.
         *
         * Values come from the OFFER, never from argv, so a fleet-wide split cannot be reshaped by one machine.
         * W2M_STAGE_INDEX is separate from W2M_INDEX: for a split over four machines, each runs one stage (0) but they
         * are machines 0..3, and conflating the two would make "print my index" print 0 everywhere.
         */
        const taskEnv = {
          W2M_INDEX: String(Number.isInteger(offer.index) ? offer.index : 0),
          W2M_INDEX_TOTAL: String(Number.isInteger(offer.index_total) ? offer.index_total : 1),
          W2M_STAGE_INDEX: String(Number.isInteger(stage.index) ? stage.index : 0),
          W2M_TASK_ID: String(offer.task_id ?? ''),
          W2M_MODE: String(offer.mode ?? ''),
          W2M_MACHINE_ID: String(offer.machine_id ?? ''),
          W2M_MACHINE_NAME: String(offer.machine_name ?? ''),
          ...(reduceEnv ?? {}),
        };
        const ran = await runArgv(stage.command_argv, {
          cwd: stageCwdOutcome.cwd,
          timeoutMs: remainingMs,
          maxOutputBytes,
          signal: controller.signal,
          env: taskEnv,
        });
        execution = ran;
        for (const warning of ran.warnings) if (!warnings.includes(warning)) warnings.push(warning);

        const stageStatus = classifyExit(ran);
        /**
         * v1.2.4: a stage whose stdout is large leaves it as a blob, and the stage record carries the reference instead of
         * the text. The upload is authoritative: a blob that did not land FAILS the stage (BLOB_UPLOAD_FAILED) rather than
         * leaving a reference to nothing, because a reduce over a partial fleet that calls itself complete is worse than a
         * failed stage.
         */
        const stagePlan = planStageOutput({
          machineId: identity.machine_id,
          stageIndex: stage.index,
          stdoutBytes: ran.stdout_bytes,
        });
        if (stagePlan.ok !== true) {
          stageReports.push({
            index: stage.index,
            command_argv: stage.command_argv,
            cwd_rel: stageCwdOutcome.cwd_rel ?? stage.cwd_rel,
            continue_on_failure: stage.continue_on_failure,
            status: 'failed',
            refusal_reason: stagePlan.code,
            exit_code: ran.exit_code,
            duration_ms: ran.duration_ms,
            stdout_sha256: ran.stdout_sha256,
            stderr_sha256: ran.stderr_sha256,
          });
          stoppedAt = stage.index;
          break;
        }
        let blobSha256 = null;
        if (stagePlan.mode === 'blob') {
          // The agent caps what it keeps in memory; if that cap was hit the blob holds the same bytes the hash covers, and
          // the warning says so instead of letting a reader assume the stage printed exactly this much.
          if (ran.truncated_stdout === true && !warnings.includes('PIPELINE_STDOUT_TRUNCATED')) warnings.push('PIPELINE_STDOUT_TRUNCATED');
          const uploaded = await putBlobBytes(ran.stdout_sha256, ran.stdout, 'stdout', offer.task_id);
          if (uploaded.ok !== true && uploaded.code === 'ARTIFACT_NOT_DELIVERED') {
            // No sink configured: the stage itself succeeded and its bytes are kept locally.
            warnings.push('ARTIFACT_NOT_DELIVERED');
            blobSha256 = null;
          } else if (uploaded.ok !== true) {
            log("warn", offer.task_id + " stage " + stage.index + ": blob upload failed", { code: uploaded.code });
            stageReports.push({
              index: stage.index,
              command_argv: stage.command_argv,
              cwd_rel: stageCwdOutcome.cwd_rel ?? stage.cwd_rel,
              continue_on_failure: stage.continue_on_failure,
              status: 'failed',
              refusal_reason: 'BLOB_UPLOAD_FAILED',
              detail: { code: uploaded.code, http_status: uploaded.status },
              exit_code: ran.exit_code,
              duration_ms: ran.duration_ms,
              stdout_sha256: ran.stdout_sha256,
              stderr_sha256: ran.stderr_sha256,
            });
            stoppedAt = stage.index;
            break;
          } else {
            blobSha256 = uploaded.sha256;
            lastBlobSha256 = blobSha256;
          }
        }
        stageReports.push({
          index: stage.index,
          command_argv: stage.command_argv,
          cwd_rel: stageCwdOutcome.cwd_rel ?? stage.cwd_rel,
          // Carried so the agent's pipeline hash covers the same shape the relay hashes. Omitting it
          // would make the two disagree the moment a caller sets `continue_on_failure: true`.
          continue_on_failure: stage.continue_on_failure,
          status: stageStatus,
          exit_code: ran.exit_code,
          duration_ms: ran.duration_ms,
          stdout_sha256: ran.stdout_sha256,
          stderr_sha256: ran.stderr_sha256,
          ...(blobSha256 === null
            ? {}
            : {
                blob_sha256: blobSha256,
                output_mode: 'blob',
              }),
        });

        if (ran.timed_out) log('warn', `${offer.task_id} stage ${stage.index} timed out`);
        if (ran.cancelled) log('warn', `${offer.task_id} stage ${stage.index} was cancelled`);

        if (stageStatus !== 'ok' && !stage.continue_on_failure) {
          stoppedAt = stage.index;
          break;
        }
      }

      /**
       * v1.2.7: a plain command's large stdout is a stage artifact too.
       *
       * The blob path used to live only in the pipeline loop, so a split/mapreduce map result was always inlined and a
       * reduce plan could never see the data it reduces -- the missing-shard check was unreachable from a real task. A
       * command that prints more than the inline cap now uploads its stdout exactly as a stage does. Best effort here: a
       * failed upload must not turn a successful command into a failure, so the envelope stays inline and says why.
       */
      if (isPipeline !== true && execution !== null && lastBlobSha256 === null) {
        const plainPlan = planStageOutput({ machineId: identity.machine_id, stageIndex: 0, stdoutBytes: execution.stdout_bytes });
        if (plainPlan.ok === true && plainPlan.mode === 'blob') {
          if (execution.truncated_stdout === true && !warnings.includes('STDOUT_TRUNCATED')) warnings.push('STDOUT_TRUNCATED');
          const uploaded = await putBlobBytes(execution.stdout_sha256, execution.stdout, 'stdout', offer.task_id);
          if (uploaded.ok === true) {
            lastBlobSha256 = uploaded.sha256;
          } else {
            log('warn', offer.task_id + ': plain stdout blob upload failed', { code: uploaded.code });
            warnings.push(uploaded.code === 'ARTIFACT_NOT_DELIVERED' ? 'ARTIFACT_NOT_DELIVERED' : 'BLOB_UPLOAD_FAILED');
          }
        }
      }

      heartbeat.setPhase('finalizing', 90);
      if (execution === null) {
        // Nothing ran at all (a refused first stage, or a budget already spent). `execution` stays
        // null, which `finish` renders as an empty-output envelope -- the honest shape for "no
        // command produced output".
        log('warn', `${offer.task_id} ran no pipeline stage`);
      }
      if (execution?.timed_out) log('warn', `${offer.task_id} timed out after ${offer.timeout_ms}ms`);
      if (execution?.cancelled) log('warn', `${offer.task_id} was cancelled`);

      let workspaceEvidence = null;
      if (executionState.workspaceState !== null) {
        const commit = await commitTaskChanges({ worktreeDir: executionState.workspaceState.worktreeDir, message: 'task ' + offer.task_id });
        const patch = await producePatch({ worktreeDir: executionState.workspaceState.worktreeDir, baseCommit: executionState.workspaceState.baseCommit });
        const changed = await listChangedFiles({ worktreeDir: executionState.workspaceState.worktreeDir, baseCommit: executionState.workspaceState.baseCommit });
        const artifact = patch.ok === true ? describePatchArtifact({ patch: patch.patch, baseCommit: executionState.workspaceState.baseCommit, headCommit: commit.ok === true ? (commit.headCommit ?? null) : null, filesChanged: changed.ok === true ? changed.files : [] }) : null;
        let patchSha = null;
        if (patch.ok === true && typeof patch.patch === 'string' && patch.patch.trim() !== '') {
          const sha = sha256Hex(patch.patch);
          const uploaded = await putBlobBytes(sha, patch.patch, 'patch', offer.task_id);
          if (uploaded.ok === true) patchSha = sha;
          else warnings.push(uploaded.code === 'ARTIFACT_NOT_DELIVERED' ? 'ARTIFACT_NOT_DELIVERED' : 'PATCH_UPLOAD_FAILED');
        }
        const removed = await removeWorktree({ repoDir: project, worktreeDir: executionState.workspaceState.worktreeDir });
        if (removed.ok !== true) warnings.push('WORKTREE_CLEANUP_FAILED');
        workspaceEvidence = {
          kind: 'worktree',
          base_commit: executionState.workspaceState.baseCommit,
          produce: executionState.workspaceState.produce,
          head_commit: commit.ok === true ? (commit.headCommit ?? null) : null,
          changed_files: artifact !== null && artifact.ok === true ? artifact.filesChanged : [],
          patch_sha256: patchSha,
          patch_bytes: typeof patch.patch === 'string' ? Buffer.byteLength(patch.patch, 'utf8') : 0,
          cleaned: removed.ok === true,
        };
      }

      const anchorsAfter = await safeAnchors(warnings);
      const status = execution ? classifyExit(execution) : (protocolViolations.length > 0 ? 'refused' : 'unverifiable');

      await finish({
        offer,
        cwdRel,
        commandArgv,
        anchorsBefore,
        anchorsAfter,
        execution,
        authorization,
        workspace: workspaceEvidence,
        blobSha256: lastBlobSha256,
        status,
        refusalReason: null,
        warnings,
        startedAt,
        endedAt: new Date().toISOString(),
        // v0.3.3: the per-stage record travels with the envelope so a reader can see which stage
        // failed and which never ran, instead of only a final exit code.
        pipeline: isPipeline
          ? {
            total_stages: plannedStages.length,
            completed_stages: stageReports.length,
            stopped_at: stoppedAt,
            stages: stageReports,
          }
          : null,
        protocolViolations,
      });
  }

  return { safeAnchors, runTask };
}
