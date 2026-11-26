/**
 * Relay state — the task board, dependency graph, cancellation and the project-scoped
 * shared objects (board/artifacts/decisions/memory).
 *
 * Split out of `state.mjs` (P1 refactor slice S5). Every function takes the owning
 * `RabbitState` as its first argument: the state remains owned by the facade (one copy of
 * every field), and this module only operates on it. No module-level mutable state, no new
 * timers, no network; project rooms are reached through the facade exactly as before.
 */

import { targetsFor } from '../../chatops/fleet-wiring.mjs';
import { argvHash as grantArgvHash } from '../../maintenance/grant.mjs';
import { deleteOfferJournal, writeOfferJournal } from '../offer-journal.mjs';
import { validateTaskDependencies } from '../task-deps.mjs';
import {
  ACTIVE_LEASE_STATES,
  FAILURE_STATUSES,
  MAX_ORIGIN_MACHINE_ID_LENGTH,
  MAX_PIPELINE_STAGES,
  P2P_MODES,
  ProtocolError,
  SHELL_ID_DIRECT,
  computeCommandHash,
  computeDedupeKey,
  computePipelineCommandHash,
  normalizeCwdRel,
  rfc3339,
} from './shared.mjs';
import { gateMachine } from './members.mjs';

/* ---------------- tasks (§4) ---------------- */

/**
 * Did a settled task actually succeed? `_taskSettled` only means "no lease can still produce a
 * result", which a refusal also satisfies. Dependencies need the stronger fact: F-3 (3.7.6) —
 * `chain-a` refused and `chain-b` was still offered, because `settled` was read as `completed`.
 *
 * @returns {'ok'|'failed'|'waiting'}
 */
export function taskOutcomeOf(state, task) {
  if (task.cancelled === true) return 'failed';
  if (state._taskSettled(task) !== true) return 'waiting';
  const executor = typeof task.executor_machine_id === 'string' && task.executor_machine_id !== ''
    ? task.executor_machine_id
    : null;
  let succeeded = false;
  for (const lease of task.leases.values()) {
    if (lease.state === 'observing') continue;
    if (executor !== null && lease.machine_id !== executor) continue;
    if (lease.state === 'refused' || lease.state === 'expired' || lease.state === 'cancelled') return 'failed';
    if (lease.state === 'done') succeeded = true;
  }
  // A lease marked `done` can still carry a failed result envelope; the envelope is the outcome.
  let latest = null;
  for (const record of state.results.values()) {
    if (record?.envelope?.task_id !== task.task_id) continue;
    if (executor !== null && record.machine_id !== executor) continue;
    if (latest === null || record.received_at_ms >= latest.received_at_ms) latest = record;
  }
  if (latest !== null) {
    if (latest.envelope?.status !== 'ok') return 'failed';
    return 'ok';
  }
  return succeeded === true ? 'ok' : 'failed';
}


/**
 * v0.4.0: validate the routing metadata a `POST /v1/task` body may carry.
 *
 * A machine, not a mode, is `origin_machine_id`: where the task was typed (`device.json`), so an
 * offer can carry that fact to the machine that has to run it. `p2p.mode` is the dispatcher's
 * resolved mode for this particular task — the plugin may be configured `direct` while a
 * scheduled run is `relay`.
 *
 * Validation is deliberately shallow and strictly typed, in the house style of this file: a
 * missing value is the v0.3.9 shape and stays valid, while a present-but-wrong value is refused
 * by name. Accepting a non-string here would put a number into `origin_machine_id` and only fail
 * later, on a machine that cannot tell a bad field from a bad relay.
 *
 * @returns {{origin_machine_id:string|null, p2p:{mode:string}|null}}
 */
export function validateTaskRouting(input = {}) {
  let originMachineId = null;
  if (input.origin_machine_id !== undefined && input.origin_machine_id !== null) {
    if (typeof input.origin_machine_id !== 'string'
      || input.origin_machine_id.length === 0
      || input.origin_machine_id.length > MAX_ORIGIN_MACHINE_ID_LENGTH) {
      throw new ProtocolError(
        'BAD_REQUEST',
        `origin_machine_id must be a non-empty string of at most ${MAX_ORIGIN_MACHINE_ID_LENGTH} characters`,
        { origin_machine_id: input.origin_machine_id },
      );
    }
    originMachineId = input.origin_machine_id;
  }

  let p2p = null;
  if (input.p2p !== undefined && input.p2p !== null) {
    if (typeof input.p2p !== 'object' || Array.isArray(input.p2p)) {
      throw new ProtocolError('BAD_REQUEST', 'p2p must be an object with a `mode` field', { p2p: input.p2p });
    }
    if (!P2P_MODES.includes(input.p2p.mode)) {
      throw new ProtocolError(
        'BAD_REQUEST',
        `p2p.mode must be one of ${P2P_MODES.join('|')}`,
        { 'p2p.mode': input.p2p.mode ?? null },
      );
    }
    // Copied rather than referenced: the recorded task must not be mutable through the request
    // body the caller still holds.
    p2p = { ...input.p2p };
  }

  return { origin_machine_id: originMachineId, p2p };
}

/**
 * §4.1 POST /v1/task.
 * Machine selection is not specified by the PROTOCOL; we implement:
 *   - `target_machines` (optional explicit list), else every paired device
 *   - capability gate §6.1 per machine (failures become `refused` leases)
 *   - index assignment: replicate -> 0, split -> round-robin modulo index_total
 */
export function createTask(state, input = {}) {
  // v0.4.0: refused BEFORE the task literal is built and before any offer is emitted, so a bad
  // value cannot leave a half-created task behind. `POST /v1/task` is all-or-nothing.
  const routing = validateTaskRouting(input);
  // v1.2.4: prerequisites are validated where the task is CREATED. A graph that only fails later puts the
  // refusal on a machine that did not create the problem.
  const deps = validateTaskDependencies({
    task_id: typeof input.task_id === 'string' ? input.task_id : null,
    depends_on: input.depends_on,
    tasksById: state.tasks,
  });
  if (deps.ok !== true) return { status: 'refused', refusal_reason: deps.code, detail: deps.detail ?? {} };

  const mode = input.mode ?? 'replicate';
  if (mode !== 'replicate' && mode !== 'split' && mode !== 'broadcast' && mode !== 'pipeline' && mode !== 'compose' && mode !== 'mapreduce') {
    throw new ProtocolError(
      'BAD_REQUEST',
      'mode must be replicate|split|broadcast|pipeline|compose|mapreduce',
      { mode },
    );
  }
  /**
   * v0.3.3 `pipeline`: the whole chain runs on each machine, stage after stage.
   *
   * The semantics were chosen against the alternative (fan out stage 1, converge its outputs into
   * stage 2) because that one has no well-defined input: on a fleet, stage 1 produces n different
   * outputs, and "feed them all to stage 2" does not say in what order, or whether stage 2 then
   * runs once or n times. Worse, two machines finishing in a different order would produce
   * different stage-2 inputs, so one task_id would no longer describe one reproducible execution --
   * which is the property the rest of this system is built on. See docs/PIPELINE-DESIGN.md.
   *
   * So: a pipeline is `replicate` applied to a sequence. Every machine runs the whole chain, there
   * is no cross-machine data flow, and nothing new can be silently dropped in transit.
   */
  const rawStages = Array.isArray(input.stages) ? input.stages : null;
  const isPipeline = mode === 'pipeline';
  if (isPipeline) {
    if (rawStages === null || rawStages.length === 0) {
      throw new ProtocolError('BAD_REQUEST', 'mode=pipeline requires a non-empty `stages` array', {
        stages: rawStages === null ? null : rawStages.length,
      });
    }
    if (rawStages.length > MAX_PIPELINE_STAGES) {
      throw new ProtocolError('BAD_REQUEST', `stages must have at most ${MAX_PIPELINE_STAGES} entries`, {
        stages: rawStages.length,
      });
    }
    rawStages.forEach((stage, i) => {
      const argv = stage?.command_argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
        throw new ProtocolError('BAD_REQUEST', `stages[${i}].command_argv must be a non-empty string[]`, { index: i });
      }
    });
    // A chain is one execution on one machine; sharding it would mean each machine ran a chain of
    // its own slice, which is a different feature and not what the caller asked for.
    if (Number.isInteger(input.index_total) && input.index_total !== 1) {
      throw new ProtocolError('BAD_REQUEST', 'mode=pipeline runs the whole chain per machine, so index_total must be 1', {
        index_total: input.index_total,
      });
    }
  } else if (rawStages !== null) {
    // Refused rather than ignored: the caller believes they described a sequence, and running only
    // `command_argv` would silently drop every stage after the first.
    throw new ProtocolError('BAD_REQUEST', '`stages` is only valid with mode=pipeline', { mode, stages: rawStages.length });
  }

  /**
   * Normalized stage list. For every mode there is at least one stage, so downstream code has a
   * single shape to reason about and `pipeline` is not a special case at the execution layer.
   */
  const stages = isPipeline
    ? rawStages.map((s, i) => ({
      index: i,
      command_argv: [...s.command_argv],
      cwd_rel: typeof s.cwd_rel === 'string' && s.cwd_rel ? s.cwd_rel : (typeof input.cwd_rel === 'string' && input.cwd_rel ? input.cwd_rel : '.'),
      timeout_ms: Number.isInteger(s.timeout_ms) ? s.timeout_ms : null,
      continue_on_failure: s.continue_on_failure === true,
    }))
    : null;

  const commandArgv = isPipeline ? [...rawStages[0].command_argv] : input.command_argv;
  if (!Array.isArray(commandArgv) || commandArgv.length === 0 || commandArgv.some((a) => typeof a !== 'string')) {
    throw new ProtocolError('BAD_REQUEST', 'command_argv must be a non-empty string[]');
  }
  const indexTotal = Number.isInteger(input.index_total) ? input.index_total : 1;
  if (indexTotal < 1) throw new ProtocolError('BAD_REQUEST', 'index_total must be >= 1');
  /**
   * v1.2.4 mapreduce: the map half is ordinary dispatch; the reduce half is described here so the caller can run it as an
   * explicit second task once w2m_wait has verified every shard is present. Deliberately NOT a cascade: a relay that
   * launches the reduce itself would decide on a partial fleet, and the operator would see one task id for two executions.
   */
  let reduceArgv = null;
  let reducerMachineId = null;
  if (mode === 'mapreduce') {
    if (indexTotal !== 1) {
      throw new ProtocolError('BAD_REQUEST', 'mode=mapreduce maps the whole input on every machine, so index_total must be 1', { index_total: indexTotal });
    }
    const argv = input.reduce_argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part === '')) {
      throw new ProtocolError('BAD_REQUEST', 'mode=mapreduce requires reduce_argv as a non-empty string[]', { reduce_argv: argv ?? null });
    }
    reduceArgv = [...argv];
    if (input.reducer_machine_id !== undefined && input.reducer_machine_id !== null && typeof input.reducer_machine_id !== 'string') {
      throw new ProtocolError('BAD_REQUEST', 'reducer_machine_id must be a machine id string', { reducer_machine_id: input.reducer_machine_id });
    }
    reducerMachineId = typeof input.reducer_machine_id === 'string' && input.reducer_machine_id !== '' ? input.reducer_machine_id : null;
  } else if (input.reduce_argv !== undefined || input.reducer_machine_id !== undefined) {
    throw new ProtocolError('BAD_REQUEST', 'reduce_argv and reducer_machine_id are only valid with mode=mapreduce', { mode });
  }

  const halt = input.halt ?? 'never';
  if (halt !== 'never' && halt !== 'now') throw new ProtocolError('BAD_REQUEST', 'halt must be never|now', { halt });
  /**
   * v1.2.4 retry policy: how many attempts the task may take in total, and which terminal conditions justify
   * another. Default one attempt and no retry, so every existing caller keeps at-most-once semantics.
   */
  const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : 1;
  if (maxAttempts < 1 || maxAttempts > 5) {
    throw new ProtocolError('BAD_REQUEST', 'max_attempts must be an integer 1..5', { max_attempts: input.max_attempts });
  }
  const RETRYABLE = ['expired', 'failed', 'partial', 'timeout'];
  if (input.retry_on !== undefined && !Array.isArray(input.retry_on)) {
    throw new ProtocolError('BAD_REQUEST', 'retry_on must be an array of expired|failed|partial|timeout', { retry_on: input.retry_on });
  }
  const retryOn = Array.isArray(input.retry_on) ? [...new Set(input.retry_on)] : [];
  if (retryOn.some((reason) => typeof reason !== 'string' || !RETRYABLE.includes(reason))) {
    throw new ProtocolError('BAD_REQUEST', 'retry_on must list expired|failed|partial|timeout', { retry_on: input.retry_on, retryable: RETRYABLE });
  }

  const taskId = input.task_id ?? state.nextId();
  if (state.tasks.has(taskId)) {
    throw new ProtocolError('TASK_EXISTS', 'task_id already exists', { task_id: taskId });
  }

  const now = state.nowMs();
  const cwdRel = normalizeCwdRel(input.cwd_rel);
  const baseTree = input.base_tree ?? null;
  // v2 R5: a joint dispatch must be auditable; a malformed binding is refused, never nulled.
  for (const key of ['plan_sha256', 'approval_sha256']) {
    const value = input[key];
    if (value !== undefined && !(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) {
      throw new ProtocolError('BAD_REQUEST', key + ' must be 64 lowercase hex characters');
    }
  }
  if (input.step_id !== undefined && !(typeof input.step_id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(input.step_id))) {
    throw new ProtocolError('BAD_REQUEST', 'step_id must be ^[a-z][a-z0-9_-]{0,31}$');
  }

  const derivedCommandHash = isPipeline
    ? computePipelineCommandHash(stages, SHELL_ID_DIRECT)
    : computeCommandHash(commandArgv, SHELL_ID_DIRECT, cwdRel);
  if (input.command_hash !== undefined && input.command_hash !== derivedCommandHash) {
    throw new ProtocolError('BAD_REQUEST', 'command_hash does not match command_argv', { declared: input.command_hash, derived: derivedCommandHash });
  }
  const commandHash = derivedCommandHash;
  const timeoutMs = Number.isInteger(input.timeout_ms) ? input.timeout_ms : 300_000;

  // v0.3.3 `broadcast`: one machine runs the command, every other machine is told the outcome.
  //
  // The executor choice is deterministic rather than random. A random leader makes a task
  // impossible to reproduce from its own record -- the same task id would run somewhere else on a
  // retry -- and this project's whole value rests on being able to say exactly where something ran.
  // The first target in the relay's own device order is stable for a given device table.
  //
  // Observers get a lease so they are tracked and notified, but their lease is `observing`, which
  // every aggregation step treats as "did not run". That distinction is the point: a machine that
  // never executed anything agreeing with a result would be a fabrication, and it is exactly the
  // fabrication this mode could most easily produce.
  //
  // Resolved before the task literal because the literal records it. (`targets` is computed below,
  // so the executor is re-validated against it after that.)
  /**
   * v1.1.2: a dispatch that names no machines goes to the machines that are **online**.
   *
   * WHY THIS IS THE DEFAULT: this line used to return every paired device, including one whose agent stopped
   * heartbeating days ago. The relay still built it a lease, that lease expired, and \`partial\` became the only
   * verdict the task could reach -- so a fleet whose live machines agreed reported "incomplete" forever
   * (observed 2026-10-17: \`ok: 3, expired: 4\`). Liveness is the relay's own knowledge, which is why the fix
   * belongs here and not in a client-side pre-read that would add a round trip to every dispatch.
   *
   * \`include_offline: true\` restores the old behaviour for the operator who really does want to queue work for a
   * machine that is down. A device that comes back is online again and rejoins the default set with no bookkeeping:
   * nothing is deleted, and the only state consulted is \`online\`.
   */
  const targetIds = Array.isArray(input.target_machines) && input.target_machines.length > 0
    ? input.target_machines
    : input.include_offline === true || mode === 'broadcast'
      // broadcast is NOT a fan-out: it names one executor and tells the rest the outcome. Narrowing the default set
      // here would change WHICH machine is elected (or make the election impossible when the fixture's devices are
      // not marked online), so the default set stays every paired device for this mode only.
      ? [...state.devices.keys()]
      : [...state.devices.entries()].filter(([, d]) => state.isOnlineDevice(d)).map(([id]) => id);
  const executorMachineId = mode === 'broadcast'
    ? (typeof input.executor_machine_id === 'string' && input.executor_machine_id !== ''
      ? input.executor_machine_id
      : targetIds[0] ?? null)
    : null;

  /**
   * v1.2.10: validate the reduce artifact list up front. A malformed list would otherwise become an offer the machine
   * cannot execute, and the failure would surface as a generic refusal on the executor instead of at dispatch.
   */
  /**
   * v1.3.10-beta.2: a maintenance request is opaque to the relay (the root runner is the authority) but its shape and
   * size are checked here so a malformed request is refused at dispatch instead of on a machine it was never meant for.
   */
  const rawMaintenance = input.maintenance ?? null;
  let normalizedMaintenance = null;
  if (rawMaintenance !== null) {
    if (typeof rawMaintenance !== 'object' || Array.isArray(rawMaintenance) || Buffer.byteLength(JSON.stringify(rawMaintenance), 'utf8') > 64 * 1024) {
      throw new ProtocolError('BAD_REQUEST', 'maintenance must be an object of at most 64 KiB', {});
    }
    if (typeof rawMaintenance.request_id !== 'string' || rawMaintenance.request_id === '') {
      throw new ProtocolError('BAD_REQUEST', 'maintenance.request_id is required', {});
    }
    normalizedMaintenance = rawMaintenance;
  }
  /**
   * v1.3.10-beta.3: a task-level grant travels with the dispatch. The relay checks its shape and time window so a bad
   * grant is refused at dispatch, but the agent is the verifier — the relay never decides authorisation on its own.
   */
  /**
   * v1.3.13-beta.1 (task model): a task may explain WHICH copy of the project it runs on. The relay validates the
   * descriptor and carries it, exactly as it carries argv: the machine that owns the copy decides whether it can honour
   * it (and the agent currently refuses a workspace task with WORKSPACE_UNSUPPORTED until the execution slice lands).
   */
  const rawWorkspace = input.workspace ?? null;
  let normalizedWorkspace = null;
  if (rawWorkspace !== null) {
    if (typeof rawWorkspace !== 'object' || Array.isArray(rawWorkspace) || Buffer.byteLength(JSON.stringify(rawWorkspace), 'utf8') > 4 * 1024) {
      throw new ProtocolError('BAD_REQUEST', 'workspace must be an object of at most 4 KiB', {});
    }
    if (rawWorkspace.kind !== 'worktree') throw new ProtocolError('BAD_REQUEST', "workspace.kind must be 'worktree'", { kind: rawWorkspace.kind });
    if (typeof rawWorkspace.base_commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(rawWorkspace.base_commit)) {
      throw new ProtocolError('BAD_REQUEST', 'workspace.base_commit must be a hex commit id', { base_commit: rawWorkspace.base_commit });
    }
    const produce = rawWorkspace.produce ?? 'patch';
    if (!['patch', 'commit', 'none'].includes(produce)) throw new ProtocolError('BAD_REQUEST', "workspace.produce must be patch, commit or none", { produce });
    normalizedWorkspace = { kind: 'worktree', base_commit: rawWorkspace.base_commit, produce };
  }
  const rawGrant = input.grant ?? null;
  let normalizedGrant = null;
  if (rawGrant !== null) {
    if (typeof rawGrant !== 'object' || Array.isArray(rawGrant) || Buffer.byteLength(JSON.stringify(rawGrant), 'utf8') > 8 * 1024) {
      throw new ProtocolError('BAD_REQUEST', 'grant must be an object of at most 8 KiB', {});
    }
    if (typeof rawGrant.grant_id !== 'string' || rawGrant.grant_id === '' || !/^[0-9a-f]{64}$/.test(String(rawGrant.argv_hash ?? ''))) {
      throw new ProtocolError('BAD_REQUEST', 'grant needs grant_id and a 64-hex argv_hash', {});
    }
    // v1.3.12-beta.1: dispatch-side preflight of the execution-authorization model. The agent verifies the signature and
    // the use ledger; the relay refuses a grant that is plainly for another task or another argv, by name, before any
    // machine sees the task. This is a caller-bug check, not a second authorisation decision.
    if (typeof rawGrant.task_id === 'string' && rawGrant.task_id !== '' && rawGrant.task_id !== taskId) {
      throw new ProtocolError('GRANT_TASK_MISMATCH', 'the grant names another task_id', { grant_task_id: rawGrant.task_id, task_id: taskId });
    }
    if (grantArgvHash(commandArgv) !== String(rawGrant.argv_hash)) {
      throw new ProtocolError('GRANT_ARGV_MISMATCH', 'the grant argv_hash does not match command_argv', { argv_hash: String(rawGrant.argv_hash), computed: grantArgvHash(commandArgv) });
    }
    if (rawGrant.expires_at !== undefined) {
      const expiresAt = Date.parse(String(rawGrant.expires_at));
      if (Number.isNaN(expiresAt)) throw new ProtocolError('BAD_REQUEST', 'grant.expires_at is not a timestamp', { expires_at: rawGrant.expires_at });
      if (expiresAt <= state.nowMs()) throw new ProtocolError('GRANT_EXPIRED', 'the grant has already expired', { expires_at: rawGrant.expires_at });
    }
    if (state.revokedGrants.has(String(rawGrant.grant_id))) {
      throw new ProtocolError('GRANT_REVOKED', 'the grant was revoked by the operator', { grant_id: String(rawGrant.grant_id) });
    }
    normalizedGrant = rawGrant;
  }
  const rawOperatorKey = input.operator_key ?? null;
  let normalizedOperatorKey = null;
  if (rawOperatorKey !== null) {
    if (typeof rawOperatorKey !== 'object' || Array.isArray(rawOperatorKey)) throw new ProtocolError('BAD_REQUEST', 'operator_key must be an object', {});
    if (typeof rawOperatorKey.key_id !== 'string' || typeof rawOperatorKey.public_key_pem !== 'string') {
      throw new ProtocolError('BAD_REQUEST', 'operator_key needs key_id and public_key_pem', {});
    }
    normalizedOperatorKey = { key_id: rawOperatorKey.key_id, public_key_pem: rawOperatorKey.public_key_pem, created_at: rawOperatorKey.created_at ?? new Date(state.nowMs()).toISOString() };
    if (state.operatorKeys.has(normalizedOperatorKey.key_id) === false) {
      state.operatorKeys.set(normalizedOperatorKey.key_id, normalizedOperatorKey);
      state._ledger({ type: 'operator.key.registered', key: normalizedOperatorKey });
    }
  }
  const rawReduceInputs = input.reduce_inputs === undefined || input.reduce_inputs === null ? [] : input.reduce_inputs;
  if (!Array.isArray(rawReduceInputs) || rawReduceInputs.length > 16) {
    throw new ProtocolError('BAD_REQUEST', 'reduce_inputs must be an array of at most 16 artifacts', { count: Array.isArray(rawReduceInputs) ? rawReduceInputs.length : null });
  }
  const normalizedReduceInputs = [];
  for (const artifact of rawReduceInputs) {
    const machineId = typeof artifact?.machine_id === 'string' && artifact.machine_id !== '' ? artifact.machine_id : null;
    const sha256 = typeof artifact?.sha256 === 'string' ? artifact.sha256.toLowerCase() : '';
    if (machineId === null || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ProtocolError('BAD_REQUEST', 'each reduce input must be {machine_id, sha256}', { machine_id: machineId, sha256 });
    }
    normalizedReduceInputs.push({ machine_id: machineId, sha256 });
  }

  const task = {
    task_id: taskId,
    mode,
    command_argv: commandArgv,
    cwd_rel: cwdRel,
    // v0.43.0. The task construction is field-by-field, so a field not named here is silently dropped --
    // which is how a parameter can be accepted by the tool, validated by the tool, and never reach the
    // machine. Named explicitly so it travels.
    cwd_outside_project: input.cwd_outside_project === true,
    index_total: indexTotal,
    // v1.2.4: the reduce half travels with the task so a caller (and a revived relay) can read what was intended.
    ...(mode === 'mapreduce' ? { reduce_argv: reduceArgv, reducer_machine_id: reducerMachineId } : {}),
    timeout_ms: timeoutMs,
    write: input.write === true,
    write_scope: input.write_scope ?? [],
    require_exclusive_write: input.require_exclusive_write === true,
    base_commit: input.base_commit ?? null,
    base_tree: baseTree,
    requirements: input.requirements ?? {},
    compare_policy: input.compare_policy ?? {},
    include_offline: input.include_offline === true,
    halt,
    created_by: input.created_by ?? null,
      // v1.5.5: the fleet a task belongs to, so list endpoints can scope by it.
      // v1.5.5: the fleet this task belongs to, computed from the same requester rule fleet scoping
      // uses. scopedRequester is declared further down (target selection), so it cannot be referenced
      // from the task literal; this expression reads the same sources and stays a pure lookup.
      fleet_id: ((typeof input.created_by === 'string' ? state.devices.get(input.created_by) : null) ||
        (typeof input.requester_machine_id === 'string' ? state.devices.get(input.requester_machine_id) : null) ||
        (state.fleetId !== null ? { fleet_id: state.fleetId } : null))?.fleet_id ?? null,
    created_at_ms: now,
    command_hash: commandHash,
    // v2 R5: a joint dispatch records which plan/approval/step it belongs to. Hashes only.
    plan_sha256: /^[0-9a-f]{64}$/.test(String(input.plan_sha256 ?? '')) ? input.plan_sha256 : null,
    approval_sha256: /^[0-9a-f]{64}$/.test(String(input.approval_sha256 ?? '')) ? input.approval_sha256 : null,
    step_id: typeof input.step_id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(input.step_id) ? input.step_id : null,
    attempt: 1,
    // v1.2.4: the policy travels with the task so a revived relay can still decide to retry after a restart.
    max_attempts: maxAttempts,
    retry_on: retryOn,
    // v1.2.4: prerequisites and an assignee travel with the task, because a graph the relay validated but did not
    // store would have to be re-derived later -- and a re-derivation that disagrees with the validation is exactly
    // the silent-drop failure this field-by-field literal exists to prevent.
    depends_on: deps.ok === true ? deps.depends_on : [],
    assignee: typeof input.assignee === 'string' && input.assignee !== '' ? input.assignee : null,
    /**
     * v1.2.10: a reduce task names the map task it reduces and the artifacts it consumes. The artifact LIST travels with
     * the task (never inferred by the reducer), because "which shards this reduce covers" is the completeness contract.
     */
    project_id: state.ensureProject(input.project_id ?? null),
    reduce_of: typeof input.reduce_of === 'string' && input.reduce_of !== '' ? input.reduce_of : null,
    workspace: normalizedWorkspace,
    grant: normalizedGrant,
    grant_summary: normalizedGrant === null ? null : { grant_id: normalizedGrant.grant_id, argv_hash: normalizedGrant.argv_hash, key_id: normalizedGrant.signature?.key_id ?? null },
    /** v1.3.10-beta.2: a signed maintenance request travels with the task; the relay carries it, the root runner verifies it. */
    maintenance: normalizedMaintenance,
    operator_key: normalizedOperatorKey,
    maintenance_summary: normalizedMaintenance === null ? null : { request_id: normalizedMaintenance.request_id ?? null, action: normalizedMaintenance.action ?? null },
    reduce_inputs: normalizedReduceInputs,
    leases: new Map(),
    cancelled: false,
    cancel_reason: null,
    degraded: null,
    deadline_ms: now + timeoutMs,
    result_seqs: [],
    /** v0.3.3: which machine actually executes under `broadcast`; null for the other modes. */
    executor_machine_id: executorMachineId,
    /**
     * v0.3.3: the normalized stage list for `pipeline`, or null.
     *
     * Sent to the machine in the offer so it can run the whole chain. Kept on the task as well so
     * a report can say how many stages were supposed to run even when the machine crashed before
     * reporting any of them.
     */
    stages,
    /**
     * v0.4.0: where the task came from and under which P2P mode it was dispatched, or null.
     *
     * Kept on the task (not just passed to `emitOffer`) because an offer is emitted more than
     * once: `redeliverPendingOffers` re-states unclaimed work on every reconnect and
     * `_takeover` re-offers a freed index. A machine that reconnects must see the same routing
     * facts as the machine that was connected at dispatch time, or the direct-push half of the
     * feature would work exactly once and then quietly stop.
     */
    origin_machine_id: routing.origin_machine_id,
    p2p: routing.p2p,
  };

  /**
   * Fleet scoping (v0.7.7).
   *
   * This replaces `targets = [...state.devices.values()]`, which reached **every device on the
   * relay** with no filter — the finding that accounts were not isolated. The rule now lives in
   * `fleet-wiring.mjs` so it is one function with its own exhaustive tests rather than three
   * lines inside a two-thousand-line object.
   *
   * ## The migration is deliberate, and so is its limit
   *
   * The shared relay holds four devices that paired before fleets existed, and none of them has
   * a `fleet_id`. `targetsFor` therefore has two modes: a relay with no fleet configured keeps
   * exactly the old behaviour, and a relay that *is* scoped refuses a fleetless requester rather
   * than handing it the run of the fleet. So deploying this cannot be an outage, and scoping it
   * cannot be a silent grant.
   *
   * ## What this does NOT do, stated here rather than discovered later
   *
   * `POST /v1/task` authenticates with the **operator token**, and `authorizeTaskDispatch`
   * returns `{ role: 'operator', machine_id: null }` for it — there is no device, so there is no
   * fleet to scope by. Every device that authenticates with a **device token** gets full
   * isolation from this change; an operator-token dispatch remains relay-wide, because the
   * operator token *is* the relay-wide credential by design.
   *
   * `input.created_by` is the one device identity a task carries, and it is used when present:
   * a task submitted on behalf of a machine is scoped to that machine's fleet.
   */
  const requester =
    (typeof input.created_by === 'string' && state.devices.get(input.created_by)) ||
    (typeof input.requester_machine_id === 'string' && state.devices.get(input.requester_machine_id)) ||
    null;

  /**
   * An operator-token dispatch, on a relay that has been scoped, acts **within that scope**.
   *
   * A first version passed `requester: null` and let it be refused -- which broke every
   * operator dispatch on a scoped relay, and broke it in the least useful way: the operator had
   * just configured the fleet, and configuring it made them unable to dispatch at all.
   *
   * The reasoning for the fix: the relay's own `fleetId` *is* an admin's statement about which
   * fleet this relay serves. An operator dispatch therefore has an unambiguous scope, and
   * refusing it would be refusing the case that was explicitly asked for.
   *
   * What stays genuinely ambiguous is an operator dispatch on a relay holding **several** fleets
   * with no fleet of its own -- there is no way to tell which was meant, so `targetsFor` refuses
   * that rather than guessing.
   */
  const scopedRequester =
    requester ??
    (state.fleetId === null ? null : { machine_id: null, fleet_id: state.fleetId, fleet_source: 'relay_scope' });

  const scoped = targetsFor({
    devices: [...state.devices.values()],
    requester: scopedRequester,
    targetMachines: input.target_machines,
    relayFleetId: state.fleetId ?? null,
    // The existing code did not filter offline devices at selection time -- it offered to them and
    // let the lease expire. Keeping that here avoids changing two behaviours at once, and the
    // lease expiry is what `handoff.mjs` is for.
    requireOnline: false,
  });
  if (!scoped.ok) {
    /**
     * `NO_ONLINE_DEVICE`, not a new code.
     *
     * A first version invented `NO_ELIGIBLE_DEVICE`, which broke the one relay test that pins
     * this contract — and worse, it would have broken **callers**: `chatops/fleet.mjs` reads
     * `NO_ONLINE_DEVICE` to produce *"start an agent on each machine"*, and a code it has never
     * seen falls through to a generic refusal. The protocol's code table is part of the
     * protocol, and adding a member to it is a decision for a protocol revision, not for a
     * wiring change.
     *
     * What *is* new is why nothing was eligible, and that belongs in `detail`, where a caller
     * can read it without a new code entering the table.
     */
    throw new ProtocolError('NO_ONLINE_DEVICE', scoped.text, {
      reason: scoped.reason,
      legacy: scoped.legacy,
      fleet_scoped: scoped.legacy === false,
      hint:
        scoped.reason === 'requester_has_no_fleet'
          ? 'this relay is bound to a fleet and the requesting device is in none; pair it with a code issued for that fleet'
          : scoped.reason === 'target_outside_fleet'
            ? 'the named target is not in this fleet'
            : 'check that at least one device in this fleet is paired and streaming',
    });
  }
  const targets = scoped.targets;
  if (scoped.legacy) {
    // Logged at debug so an operator reading logs during a migration can see which rule applied.
    // "N targets" alone does not say whether isolation is on, and that is the question being asked.
    state.log?.('debug', 'task targets selected without a fleet (legacy path)', {
      task_candidates: targets.length,
      relay_fleet_id: state.fleetId ?? null,
    });
  }

  // v0.3.3 `broadcast`: validated here, where `targets` is known. The executor id itself was
  // resolved before the task literal because the literal records it.
  if (mode === 'broadcast' && executorMachineId !== null && !targets.some((d) => d.machine_id === executorMachineId)) {
    throw new ProtocolError('BAD_REQUEST', 'executor_machine_id is not among the target machines', {
      executor_machine_id: executorMachineId,
      targets: targets.map((d) => d.machine_id),
    });
  }

  if (targets.length === 0) {
    throw new ProtocolError('NO_ONLINE_DEVICE', 'no paired device available for this task', {
      /**
       * v0.9.0: `all` was never defined here — this threw `ReferenceError: all is not defined`
       * instead of the refusal it was written to be, and it did so on **the one path an operator
       * actually reaches**: `targets` is empty exactly when the fleet has nothing to dispatch to,
       * which is what a freshly configured machine sees before its first peer joins.
       *
       * The count an operator needs there is "how many devices does this relay know at all",
       * because the answer distinguishes *"nothing is paired"* from *"something is paired but
       * scoped out"* — and `targets` being fleet-filtered cannot answer that. `state.devices` is
       * the unfiltered set the same call hands to `targetsFor` a few lines above (see the
       * `devices: [...state.devices.values()]` there), so its size is that number.
       *
       * ESLint's `no-undef` found this, which is the rule the project's own lint audit credits as
       * "what caught the one real defect" of that round. This is the same class of defect one
       * release later, and the audit's note about it is worth repeating: an unbound identifier in
       * an ESM module is a `ReferenceError` at evaluation time, not an `undefined` that quietly
       * takes a branch.
       */
      known_devices: state.devices.size,
    });
  }

  const dedupeKeyBase = computeDedupeKey(taskId, 0, commandHash, baseTree);
  if (typeof dedupeKeyBase !== 'string' || dedupeKeyBase.length !== 64) {
    throw new ProtocolError('INTERNAL', 'failed to compute dedupe_key');
  }
  /**
   * v1.2.7: a dependency that is not settled means this task is NOT dispatched yet. Its leases are recorded as `waiting`,
   * which the sweeper ignores and redelivery skips, and `_releaseDependents` moves them to offers when the graph allows it.
   */
  const dependencyStates = (task.depends_on ?? []).map((depId) => {
    const dep = state.tasks.get(depId);
    if (dep === undefined) return 'unknown';
    if (dep.cancelled === true) return 'cancelled';
    if (state._taskSettled(dep) !== true) return 'waiting';
    // A settled prerequisite that did not succeed must not release its dependents (F-3).
    return taskOutcomeOf(state, dep) === 'ok' ? 'completed' : 'failed';
  });
  const graphBlocked = dependencyStates.some((state) => state === 'cancelled' || state === 'unknown' || state === 'failed');
  const graphReady = graphBlocked !== true && dependencyStates.every((state) => state === 'completed');
  const waitingOn = graphReady === true ? [] : (task.depends_on ?? []);
  /**
   * v1.2.7: an assignee is a restriction, not a label. Only that machine gets a lease; another machine cannot accidentally
   * take work that was meant for one host. An unknown assignee is refused by name rather than producing a task nobody holds.
   */
  if (task.assignee !== null && !state.devices.has(task.assignee)) {
    throw new ProtocolError('BAD_REQUEST', 'assignee is not a known device on this relay', { assignee: task.assignee });
  }
  if (task.assignee !== null) {
    const narrowed = targets.filter((device) => device.machine_id === task.assignee);
    targets.length = 0;
    targets.push(...narrowed);
  }
  let lastSeq = state.seq;
  targets.forEach((device, i) => {
    const index = mode === 'replicate' ? 0 : i % indexTotal;
    const observing = mode === 'broadcast' && device.machine_id !== executorMachineId;
    const lease = {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      index,
      attempt: 1,
      // `observing` is a lease state, not an outcome: the machine holds a place in this task and
      // will be told what happened, but it was never handed the command. `gateMachine` below is
      // skipped for it because refusing to do work you were never asked to do is not a refusal.
      state: observing ? 'observing' : 'queued',
      refusal_reason: null,
      refusal_detail: null,
      dedupe_key: computeDedupeKey(taskId, index, commandHash, baseTree),
      last_heartbeat_ms: now,
      claimed_at_ms: now,
      lease_until_ms: now + state.leaseWindowMs(),
      phase: null,
      progress: null,
      offered_seq: null,
      expired_at_ms: null,
      finished_at_ms: null,
      heartbeat_count: 0,
    };
    if (observing) {
      // No capability gate and no offer: the machine is not being asked to run anything, so there
      // is nothing to refuse and nothing to hand out. It is recorded so the task can tell it the
      // outcome afterwards.
      task.leases.set(device.machine_id, lease);
      return;
    }
    if (graphBlocked === true) {
      // F-3: a prerequisite that ended refused/failed/cancelled is not "something to wait for".
      // The dependent is marked cancelled with a named reason instead of being offered later.
      lease.state = 'cancelled';
      lease.refusal_reason = 'DEPENDENCY_FAILED';
      lease.refusal_detail = { depends_on: waitingOn };
      lease.finished_at_ms = now;
      task.leases.set(device.machine_id, lease);
      return;
    }
    if (graphReady !== true) {
      lease.state = 'waiting';
      lease.waiting_on = waitingOn;
      task.leases.set(device.machine_id, lease);
      return;
    }
    const gate = gateMachine(task, device);
    if (gate) {
      lease.state = 'refused';
      lease.refusal_reason = gate.refusal_reason;
      lease.refusal_detail = gate.detail;
      task.leases.set(device.machine_id, lease);
      state.emit('notice', {
        level: 'warn',
        code: 'CAPABILITY_REFUSED',
        message: `${device.machine_id} refused: ${gate.refusal_reason}`,
        task_id: taskId,
      });
      return;
    }
    task.leases.set(device.machine_id, lease);
    const grace = state._p2pOfferGraceMs(task);
    if (grace > 0) {
      // v0.4.0: the dispatcher is pushing this offer over the direct path right now. Hold the
      // relay's copy for `grace` ms so the direct one can win; see `p2pOfferGraceMs`.
      state._scheduleOffer(task, lease, grace);
    } else {
      const event = state.emitOffer(task, lease);
      lastSeq = event.seq;
    }
  });

  if (typeof state.persistence?.dir === 'string' && state.persistence.dir !== '') {
    writeOfferJournal(state.persistence.dir, taskId, {
      argv: commandArgv,
      stages: stages ?? null,
      reduce_argv: mode === 'mapreduce' ? reduceArgv : null,
    });
  }
  state.tasks.set(taskId, task);

  state._ledger({
    type: 'task.created',
    task: {
      task_id: task.task_id,
    plan_sha256: task.plan_sha256 ?? null,
    approval_sha256: task.approval_sha256 ?? null,
    step_id: task.step_id ?? null,
      workspace: task.workspace ?? null,
      project_id: task.project_id,
      mode: task.mode,
      command_argv_len: Array.isArray(task.command_argv) ? task.command_argv.length : 0,
      cwd_rel: task.cwd_rel,
      cwd_outside_project: task.cwd_outside_project === true,
      index_total: task.index_total,
      timeout_ms: task.timeout_ms,
      write: task.write,
      write_scope: task.write_scope,
      require_exclusive_write: task.require_exclusive_write,
      base_commit: task.base_commit,
      base_tree: task.base_tree,
      requirements: task.requirements,
      compare_policy: task.compare_policy,
      halt: task.halt,
      created_by: task.created_by,
      // v3.0.0: carry the fleet binding into the ledger, otherwise a restored/imported task is
      // invisible to every fleet-scoped listing (see `_applyLedgerEntry`).
      fleet_id: task.fleet_id ?? null,
      created_at_ms: task.created_at_ms,
      command_hash: task.command_hash,
      attempt: task.attempt,
      deadline_ms: task.deadline_ms,
      // v0.4.0: routing metadata, so a restarted relay re-offers with the same facts.
          // v1.2.7: the dependency graph and assignment belong to the task record, not to a reader's memory of it.
          depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
          assignee: task.assignee ?? null,
          reduce_of: task.reduce_of ?? null,
          maintenance_summary: task.maintenance_summary ?? null,
          grant_summary: task.grant_summary ?? null,
          operator_key: task.operator_key ?? null,
          reduce_inputs: Array.isArray(task.reduce_inputs) ? task.reduce_inputs : [],
      origin_machine_id: task.origin_machine_id ?? null,
      p2p: task.p2p ?? null,
    },
    leases: [...task.leases.values()].map((l) => ({ ...l })),
  });

  // v1.3.10-beta.13: a task belongs to a project, and the project room records the link as an event both clients see.
  try {
    state.projects.appendEvent({ projectId: task.project_id, type: 'task.linked', actor: { kind: 'operator', id: 'relay' }, payload: { task_id: taskId, mode: task.mode } });
  } catch { /* the ledger already carries the task; the room event is additive */ }

  const refusedOnly = [...task.leases.values()].every((l) => l.state === 'refused');
  if (refusedOnly) {
    // §6.3 Step 0 territory: a task nobody may execute is still a valid, reportable task.
    state.emit('notice', {
      level: 'warn',
      code: 'NO_ONLINE_DEVICE',
      message: 'every candidate machine refused the capability gate',
      task_id: taskId,
    });
  }

  return {
    task_id: taskId,
    leases: [...task.leases.values()].map((l) => ({
      machine_id: l.machine_id,
      index: l.index,
      state: l.state,
      // v0.4.0: the dispatcher pushes an offer over the direct path, and the executor dedupes it
      // against the relay's copy by (task_id, attempt, dedupe_key). Without this field the
      // dispatcher has to reproduce the §4.4 formula locally, which works for a single-command
      // task and cannot work for a pipeline one -- the key covers the relay's normalised stage
      // list. Publishing it makes the pushed copy recognisably the same work item, which is what
      // keeps the direct path from turning exactly-once into at-least-twice.
      dedupe_key: l.dedupe_key ?? null,
      attempt: l.attempt,
      ...(l.refusal_reason ? { refusal_reason: l.refusal_reason } : {}),
    })),
    seq: lastSeq,
  };
}

/**
 * Resolve the project a task belongs to. The implicit default project is created lazily, so existing callers keep working
 * without naming one; an explicit unknown project is a refusal, not a new project.
 */
export function ensureProject(state, projectId) {
  const wanted = typeof projectId === 'string' && projectId !== '' ? projectId : state.defaultProjectId;
  try {
    state.projects.snapshot({ projectId: wanted });
    return wanted;
  } catch (error) {
    if (error?.code !== 'PROJECT_NOT_FOUND') throw error;
    if (wanted !== state.defaultProjectId) throw new ProtocolError('BAD_REQUEST', 'unknown project_id', { project_id: wanted });
    state.projects.createProject({ projectId: state.defaultProjectId, name: 'default', createdBy: { kind: 'operator', id: 'relay', name: 'relay' } });
    return wanted;
  }
}

/** Snapshot helpers the project routes use; kept on state so the relay has one owner of the room. */
export function projectSnapshot(state, projectId) { return state.projects.snapshot({ projectId: state.ensureProject(projectId) }); }
export function projectEvents(state, projectId, options = {}) { return state.projects.events({ projectId: state.ensureProject(projectId), ...options }); }

export function getTask(state, taskId) { return state.tasks.get(taskId) ?? null; }

export function requireTask(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) throw new ProtocolError('NOT_FOUND', 'unknown task_id', { task_id: taskId });
  return task;
}

export function listTasks(state, { limit = 50, fleetId = null } = {}) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
  return [...state.tasks.values()]
    // v1.5.5: a fleet-bound caller lists only its own fleet's tasks; null fleet keeps the old view.
    .filter((task) => fleetId === null || task.fleet_id === fleetId)
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .slice(0, n)
    .map((t) => state.taskSummary(t));
}

/** v1.2.7: a task is settled when no lease can still produce a result. Dependencies wait for that, not for a wording. */
export function _taskSettled(state, task) {
  for (const lease of task.leases.values()) if (ACTIVE_LEASE_STATES.includes(lease.state)) return false;
  return true;
}

/**
 * v1.2.7: release tasks whose prerequisites are all settled.
 *
 * Called after a result is stored: a dependency that finished must actually move its dependents from `waiting` to an offer.
 * Without this the graph would be validated, stored, and then never scheduled -- the exact "validated but not enforced" gap.
 */
export function _releaseDependents(state, completedTaskId = null) {
  const released = [];
  for (const candidate of state.tasks.values()) {
    if (!Array.isArray(candidate.depends_on) || candidate.depends_on.length === 0) continue;
    if (completedTaskId !== null && !candidate.depends_on.includes(completedTaskId)) continue;
    const waiting = [...candidate.leases.values()].filter((lease) => lease.state === 'waiting');
    if (waiting.length === 0) continue;
    let ready = true;
    let blocked = false;
    for (const depId of candidate.depends_on) {
      const dep = state.tasks.get(depId);
      if (dep === undefined) { blocked = true; break; }
      if (dep.cancelled === true) { blocked = true; break; }
      if (state._taskSettled(dep) !== true) { ready = false; break; }
      if (taskOutcomeOf(state, dep) !== 'ok') { blocked = true; break; }
    }
    if (blocked === true) {
      // F-3: release is not the same as "the blocker finished". A refused prerequisite cancels its
      // dependents by name, so a build→test chain cannot run tests after the build failed.
      const at = state.nowMs();
      for (const lease of waiting) {
        lease.state = 'cancelled';
        lease.refusal_reason = 'DEPENDENCY_FAILED';
        lease.refusal_detail = { depends_on: candidate.depends_on };
        lease.finished_at_ms = at;
      }
      state.emit('notice', { level: 'warn', code: 'DEPENDENCY_FAILED', message: candidate.task_id + ' skipped: a prerequisite did not succeed', task_id: candidate.task_id });
      continue;
    }
    if (ready !== true) continue;
    for (const lease of waiting) {
      lease.state = 'queued';
      lease.claimed_at_ms = state.nowMs();
      lease.lease_until_ms = state.nowMs() + state.leaseWindowMs();
      const device = state.devices.get(lease.machine_id);
      if (device === undefined) continue;
      state.emitOffer(candidate, lease);
    }
    state.emit('notice', { level: 'info', code: 'TASK_READY', message: candidate.task_id + ' is ready: dependencies settled', task_id: candidate.task_id });
    released.push(candidate.task_id);
  }
  return released;
}

/** Stop one issued grant from being used. Idempotent: revoking twice is the same authorisation state. */
export function revokeGrant(state, { grantId, reason = null, actor = { kind: "operator", id: "operator" } }) {
  if (typeof grantId !== "string" || grantId === "") throw new ProtocolError("BAD_REQUEST", "grant_id is required");
  const existing = state.revokedGrants.get(grantId);
  if (existing !== undefined) return { ok: true, already_revoked: true, revocation: { ...existing } };
  const revocation = { grant_id: grantId, reason: typeof reason === "string" && reason !== "" ? reason : null, revoked_at: state.nowIso(), revoked_by: actor };
  state.revokedGrants.set(grantId, revocation);
  state._ledger({ type: "grant.revoked", grant_id: grantId, reason: revocation.reason, revoked_by: actor });
  return { ok: true, already_revoked: false, revocation: { ...revocation } };
}

/** Audit view: every task that carried a grant, plus every revocation. Operator credential only. */
export function grantedTasks(state) {
  const tasks = [];
  for (const task of state.tasks.values()) {
    if (task.grant_summary === null || task.grant_summary === undefined) continue;
    tasks.push({ task_id: task.task_id, grant_id: task.grant_summary.grant_id, argv_hash: task.grant_summary.argv_hash, key_id: task.grant_summary.key_id, mode: task.mode, created_at: rfc3339(task.created_at_ms) });
  }
  return { tasks, revoked: [...state.revokedGrants.values()].map((entry) => ({ ...entry })) };
}

/** Register a content-addressed artifact against a project (idempotent by sha256). */
export function registerArtifact(state, { projectId, sha256, bytes, kind = "artifact", sourceTaskId = null, actor = null }) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new ProtocolError("BAD_REQUEST", "artifact sha256 must be 64 hex", {});
  const wanted = state.ensureProject(projectId);
  const existing = state.artifacts.get(sha256);
  if (existing !== undefined && existing.project_id === wanted) return { ok: true, artifact: { ...existing }, already: true };
  const artifact = { project_id: wanted, sha256: String(sha256), bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null, kind: String(kind), source_task_id: sourceTaskId, created_at: state.nowIso(), actor };
  state.artifacts.set(sha256, artifact);
  try { state.projects.appendEvent({ projectId: wanted, type: "artifact.registered", actor: actor ?? { kind: "operator", id: "relay" }, payload: { sha256: artifact.sha256, bytes: artifact.bytes, kind: artifact.kind, source_task_id: sourceTaskId } }); } catch { /* history */ }
  return { ok: true, artifact: { ...artifact }, already: false };
}

export function listArtifacts(state, { projectId }) {
  const wanted = state.ensureProject(projectId);
  return [...state.artifacts.values()].filter((artifact) => artifact.project_id === wanted).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((artifact) => ({ ...artifact }));
}

/** The project board: every task attributed to this project, with the scheduler's own status. */
export function projectBoard(state, { projectId }) {
  const wanted = state.ensureProject(projectId);
  const tasks = [...state.tasks.values()].filter((task) => task.project_id === wanted).map((task) => {
    const summary = state.taskSummary(task);
    return { task_id: summary.task_id, status: summary.status, mode: summary.mode, created_at: summary.created_at, leases: summary.leases, lease_states: summary.lease_states, result_count: [...state.results.values()].filter((record) => record?.envelope?.task_id === task.task_id).length };
  });
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return { project_id: wanted, tasks, counts, generated_at: state.nowIso() };
}

/** Append a decision to a project. Decisions are records; there is no edit or delete. */
export function addDecision(state, { projectId, title, text = null, actor = null, refs = {}, kind = "decision" }) {
  const wanted = state.ensureProject(projectId);
  if (typeof title !== "string" || title.trim() === "") throw new ProtocolError("BAD_REQUEST", "decision title is required", {});
  const list = state.decisions.get(wanted) ?? [];
  const index = list.length + 1;
  const decision = {
    decision_id: wanted + "-d" + (state._projectObjectIdPrefix ? state._projectObjectIdPrefix + "-" : "") + String(index).padStart(4, "0"),
    project_id: wanted, title: title.trim().slice(0, 200), text: typeof text === "string" ? text.slice(0, 4000) : null,
    kind: String(kind), refs: refs !== null && typeof refs === "object" ? { ...refs } : {},
    actor, created_at: state.nowIso(),
  };
  list.push(decision);
  state.decisions.set(wanted, list);
  try { state.projects.appendEvent({ projectId: wanted, type: "decision.recorded", actor: actor ?? { kind: "operator", id: "relay" }, payload: { decision_id: decision.decision_id, title: decision.title, kind: decision.kind } }); } catch { /* history */ }
  return { ok: true, decision: { ...decision } };
}

export function listDecisions(state, { projectId }) {
  const wanted = state.ensureProject(projectId);
  return (state.decisions.get(wanted) ?? []).map((decision) => ({ ...decision, refs: { ...decision.refs } }));
}

/** A small versioned document per project (64 KiB cap): shared context that is not a log. */
export function setProjectMemory(state, { projectId, text, actor = null }) {
  const wanted = state.ensureProject(projectId);
  if (typeof text !== "string") throw new ProtocolError("BAD_REQUEST", "memory text must be a string", {});
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new ProtocolError("PROJECT_MEMORY_TOO_LARGE", "project memory is limited to 64 KiB", { bytes: Buffer.byteLength(text, "utf8") });
  const previous = state.projectMemory.get(wanted);
  const doc = { project_id: wanted, text, version: (previous?.version ?? 0) + 1, updated_at: state.nowIso(), actor };
  state.projectMemory.set(wanted, doc);
  try { state.projects.appendEvent({ projectId: wanted, type: "memory.updated", actor: actor ?? { kind: "operator", id: "relay" }, payload: { version: doc.version, bytes: Buffer.byteLength(text, "utf8") } }); } catch { /* history */ }
  return { ok: true, document: { ...doc } };
}

export function getProjectMemory(state, { projectId }) {
  const wanted = state.ensureProject(projectId);
  const doc = state.projectMemory.get(wanted);
  return doc === undefined ? { project_id: wanted, text: "", version: 0, updated_at: null, actor: null } : { ...doc };
}

/** Subscribe to every project event. Returns an unsubscribe function. */
export function onProjectEvent(state, listener) {
  state.projectSubscribers.add(listener);
  return () => { state.projectSubscribers.delete(listener); };
}

export function taskSummary(state, task) {
  return {
    task_id: task.task_id,
    plan_sha256: task.plan_sha256 ?? null,
    approval_sha256: task.approval_sha256 ?? null,
    step_id: task.step_id ?? null,
    mode: task.mode,
    created_at: rfc3339(task.created_at_ms),
    created_by: task.created_by,
    index_total: task.index_total,
    cancelled: task.cancelled,
    degraded: task.degraded,
    leases: [...task.leases.values()].map((l) => l.machine_id),
    lease_states: Object.fromEntries([...task.leases.values()].map((l) => [l.machine_id, l.state])),
    /**
     * v1.2.7: the state the scheduler is actually in, derived here rather than by each reader.
     *
     * Before this, GET /v1/tasks carried no status at all, so a board classified a waiting task as "ready" (its dependencies
     * map empty) and a released task as "waiting" forever. The board must read the scheduler's own words or it is decoration.
     */
    project_id: task.project_id ?? null,
    reduce_of: task.reduce_of ?? null,
    reduce_inputs: Array.isArray(task.reduce_inputs) ? task.reduce_inputs : [],
    maintenance_request_id: task.maintenance_summary?.request_id ?? null,
    workspace: task.workspace === null || task.workspace === undefined ? null : { ...task.workspace },
  grant_id: task.grant_summary?.grant_id ?? null,
  argv_hash: task.grant_summary?.argv_hash ?? null,
  grant_key_id: task.grant_summary?.key_id ?? null,
    status: (() => {
      if (task.cancelled === true) return 'cancelled';
      const leases = [...task.leases.values()];
      if (leases.some((lease) => lease.state === 'waiting')) return 'waiting';
      if (leases.some((lease) => ACTIVE_LEASE_STATES.includes(lease.state))) return 'active';
      // A lease that produced no result is not a success, however the scheduler settled it.
      if (leases.some((lease) => lease.state === 'refused' || lease.state === 'expired')) return 'failed';
      const results = [...state.results.values()].filter((record) => record?.envelope?.task_id === task.task_id);
      const failures = results.filter((record) => {
        const s = record?.envelope?.status;
        // Missing required fields make the result unverifiable, not successful.
        return (record?.validation?.missing?.length ?? 0) > 0
          || FAILURE_STATUSES.includes(s) || s === 'refused' || s === 'failed' || s === 'unverifiable';
      });
      if (results.length > 0 && failures.length === results.length) return 'failed';
      // Some machines failed while others reported: the task did not fully succeed.
      if (failures.length > 0) return 'failed';
      return state._taskSettled(task) === true ? 'done' : 'unknown';
    })(),
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
    assignee: task.assignee ?? null,
    waiting_on: [...task.leases.values()].some((l) => l.state === 'waiting') ? (Array.isArray(task.depends_on) ? task.depends_on : []) : [],
  };
}

export function cancelTask(state, taskId, reason = 'cancelled_by_operator') {
  const task = state.requireTask(taskId);
  if (task.cancelled) return task;
  task.cancelled = true;
  task.cancel_reason = reason;
  for (const lease of task.leases.values()) {
    if (ACTIVE_LEASE_STATES.includes(lease.state)) lease.state = 'cancelled';
  }
  if (typeof state.persistence?.dir === 'string') deleteOfferJournal(state.persistence.dir, taskId);
  state.emit('task.cancel', { task_id: taskId, reason });
  state._ledger({ type: 'task.cancelled', task_id: taskId, reason });
  return task;
}
