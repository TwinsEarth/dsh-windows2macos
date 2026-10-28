#!/usr/bin/env node
/**
 * Operator CLI for joint-dev plans (v2 S2 slice).
 *
 * This is the operator side of the SOP, not an agent tool: a plan is created here, approved here by
 * a human, and only then may a dispatch run. It never talks to a relay in this slice; `dispatch
 * --dry-run` prints the control envelopes that would be sent. Real dispatch needs the operator token
 * and the relay capability check, which land in the next slice.
 *
 * Usage:
 *   node bin/w2m-joint.mjs plan create --state <dir> --steps <steps.json> [--base-commit <sha>] [--title <text>]
 *   node bin/w2m-joint.mjs plan list  --state <dir>
 *   node bin/w2m-joint.mjs plan get   --state <dir> --plan <sha>
 *   node bin/w2m-joint.mjs approve    --state <dir> --plan <sha> --approver <name> --authority <n> [--ttl-min <n>] [--note <text>]
 *   node bin/w2m-joint.mjs status     --state <dir> --plan <sha>
 *   node bin/w2m-joint.mjs dispatch   --state <dir> --plan <sha> --dry-run
 *
 * Exit codes: 0 ok, 1 refusal (named code), 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs';

import { deviceFilePath } from '../src/agent/identity.mjs';
import { resolveStateDir } from '../src/util/cli.mjs';

import { buildControlEnvelopes, buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { abortMerge, advanceTarget, mergePatches } from '../src/plugin/joint-dev/merge-engine.mjs';
import { consumeMergeApproval, createMergeApproval, loadMergeApproval } from '../src/plugin/joint-dev/merge-approval.mjs';
import { resolve as resolvePath } from 'node:path';
import { negotiateFeatures, readRelayCapabilities } from '../src/plugin/relay-capabilities.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';
import { readOperatorToken } from '../src/plugin/operator-token.mjs';
import { ensureOperatorKey, signApprovalPayload } from '../src/plugin/operator-key.mjs';
import {
  approvePlan,
  assertDispatchAllowed,
  consumeApproval,
  listPlans,
  loadApproval,
  loadPlan,
  savePlan,
} from '../src/plugin/joint-dev/plan-store.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
      else out[key] = true;
    } else out._.push(arg);
  }
  return out;
}

const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const fail = (code, detail) => { print({ ok: false, code, detail: detail ?? null }); process.exit(1); };

const args = parseArgs(process.argv.slice(2));
const [command, action] = args._;
if (args['allow-unsigned-approval'] === true) fail('UNKNOWN_FLAG', '--allow-unsigned-approval was removed: joint approvals must be signed');
const stateDir = resolveStateDir(typeof args.state === 'string' ? args.state : (process.env.W2M_JOINT_STATE ?? null), 'joint-dev');

if (command === 'plan' && action === 'create') {
  if (typeof args.steps !== 'string') fail('STEPS_REQUIRED', 'pass --steps <steps.json>');
  let steps;
  try { steps = JSON.parse(readFileSync(args.steps, 'utf8').replace(/^\uFEFF/, '')); } catch (error) {
    fail('STEPS_UNREADABLE', error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(steps)) fail('STEPS_INVALID', 'steps.json must be a JSON array');
  const built = buildPlan({
    base_commit: typeof args['base-commit'] === 'string' ? args['base-commit'] : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    steps,
  });
  if (built.ok !== true) fail(built.code ?? 'PLAN_INVALID', built.detail ?? null);
  const saved = savePlan({ stateDir, plan: built.plan });
  if (saved.ok !== true) fail(saved.code ?? 'PLAN_SAVE_FAILED', saved.detail ?? null);
  print({
    ok: true,
    plan_sha256: built.plan.plan_sha256,
    steps: built.plan.steps.length,
    machines: [...new Set(built.plan.steps.map((step) => step.machine_id))],
    path: saved.path,
    reused: saved.reused,
  });
  process.exit(0);
}

if (command === 'plan' && action === 'list') {
  const listed = listPlans({ stateDir, limit: Number(args.limit) || 50 });
  if (listed.ok !== true) fail(listed.code ?? 'PLAN_LIST_FAILED');
  print({ ok: true, total: listed.total, plans: listed.plans });
  process.exit(0);
}

if (command === 'plan' && action === 'get') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  const loaded = loadPlan({ stateDir, planSha: args.plan });
  if (loaded.ok !== true) fail(loaded.code ?? 'PLAN_NOT_FOUND', loaded.detail ?? null);
  print({ ok: true, plan: loaded.plan, saved_at: loaded.saved_at });
  process.exit(0);
}

if (command === 'approve') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  if (typeof args.approver !== 'string') fail('APPROVER_REQUIRED', 'pass --approver <name>');
  const authority = Number.parseInt(String(args.authority ?? ''), 10);
  if (!Number.isInteger(authority)) fail('AUTHORITY_REQUIRED', 'pass --authority <0..100>');
  const ttlMin = Number.parseInt(String(args['ttl-min'] ?? '10'), 10);
  // decision 1/2: approvals are signed by the local operator Ed25519 key; the private key never
  // leaves this machine, and only its fingerprint is printed.
  const key = ensureOperatorKey();
  if (key.ok !== true) fail(key.code ?? 'OPERATOR_KEY_MISSING', key.detail ?? null);
  const approved = approvePlan({
    stateDir,
    planSha: args.plan,
    approver: args.approver,
    authority,
    note: typeof args.note === 'string' ? args.note : '',
    ttlMs: (Number.isFinite(ttlMin) ? ttlMin : 10) * 60_000,
    signer: (body) => ({
      sig: signApprovalPayload(body, key.privateKey),
      key_id: key.key_id,
      public_key_pem: key.publicKeyPem,
    }),
  });
  if (approved.ok !== true) fail(approved.code ?? 'APPROVAL_FAILED', approved.detail ?? null);
  print({ ok: true, approval: approved.approval, path: approved.path, signed: approved.signed === true, operator_key_id: key.key_id });
  process.exit(0);
}

if (command === 'status') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  const plan = loadPlan({ stateDir, planSha: args.plan });
  if (plan.ok !== true) fail(plan.code ?? 'PLAN_NOT_FOUND');
  const approval = loadApproval({ stateDir, planSha: args.plan });
  const gate = assertDispatchAllowed({ stateDir, planSha: args.plan, requireSignature: true });
  print({
    ok: true,
    plan_sha256: plan.plan.plan_sha256,
    steps: plan.plan.steps.map((step) => ({ step_id: step.step_id, machine_id: step.machine_id, command_hash: step.command_hash })),
    approval: approval.ok ? { approver: approval.approval.approver, authority: approval.approval.authority, expires_at: approval.approval.expires_at } : { state: approval.code },
    approval_strength: gate.strength ?? null,
    dispatch_allowed: gate.ok === true,
    blocked_by: gate.ok === true ? null : gate.code,
  });
  process.exit(0);
}

if (command === 'dispatch') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  const key = ensureOperatorKey();
  const trusted = key.ok === true ? [key.key_id] : [];
  const gate = assertDispatchAllowed({ stateDir, planSha: args.plan, requireSignature: true, trustedOperatorKeyIds: trusted });
  if (gate.ok !== true) fail(gate.code ?? 'APPROVAL_REQUIRED', 'dispatch refused before anything was sent');
  const relayUrl = typeof args.relay === 'string' ? args.relay : null;
  if (args['dry-run'] !== true) {
    if (relayUrl === null) fail('RELAY_REQUIRED', 'real dispatch needs --relay <url>');
    let token = null;
    if (typeof args['token-file'] === 'string') {
      token = readFileSync(args['token-file'], 'utf8').trim();
    } else {
      const secure = readOperatorToken();
      token = secure.configured === true ? secure.token : null;
    }
    if (token === null) fail('OPERATOR_TOKEN_MISSING', 'run w2m-operator set --file <token file>, or pass --token-file');
    // decision 2: one approval authorises exactly one dispatch.
    const consumed = consumeApproval({ stateDir, planSha: args.plan, approvalSha: gate.approval.approval_sha256 });
    if (consumed.ok !== true) fail(consumed.code ?? 'APPROVAL_CONSUME_FAILED', consumed.detail ?? null);
      // D2/B5: the gate is on by default in warn mode; enforce is explicit.
      let deviceToken = '';
      if (typeof args['device-token-file'] === 'string') {
        deviceToken = readFileSync(args['device-token-file'], 'utf8').trim();
      } else {
        try {
          const file = deviceFilePath({});
          if (existsSync(file)) deviceToken = String(JSON.parse(readFileSync(file, 'utf8')).device_token ?? '');
        } catch { deviceToken = ''; }
      }
      const expectedVersion = typeof args['expect-version'] === 'string' && args['expect-version'] !== ''
        ? args['expect-version']
        : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      const versionGate = args['version-gate'] === 'off' || args['version-gate'] === 'enforce' ? args['version-gate'] : 'warn';
      const sent = await dispatchPlanToRelay({ rabbitUrl: relayUrl, token, plan: gate.plan, approval: gate.approval, auditFile: stateDir + '/joint-dev/audit.jsonl', dispatchDir: stateDir + '/joint-dev/dispatches', deviceToken, expectedVersion, versionGate });
    print({ ...sent, plan_sha256: gate.plan.plan_sha256, relay: relayUrl });
    process.exit(sent.ok === true ? 0 : 1);
  }
  let capabilities = null;
  let negotiation = null;
  if (typeof args.relay === 'string') {
    capabilities = await readRelayCapabilities({ rabbitUrl: args.relay });
    negotiation = negotiateFeatures(capabilities);
    if (negotiation.ok !== true) {
      fail(negotiation.code ?? 'RELAY_CAPABILITIES_MISSING', { missing: negotiation.missing ?? null, relay: args.relay });
    }
  }
  const envelopes = buildControlEnvelopes(gate.plan);
  print({
    ok: true,
    dry_run: true,
    relay: typeof args.relay === 'string' ? args.relay : null,
    relay_capabilities: capabilities === null ? null : { relay_version: capabilities.relay_version, features: capabilities.features },
    relay_negotiation: negotiation,
    version_gate: args['version-gate'] === 'off' || args['version-gate'] === 'enforce' ? args['version-gate'] : 'warn',
    plan_sha256: gate.plan.plan_sha256,
    approval_sha256: gate.approval.approval_sha256,
    envelopes: envelopes.length,
    control: envelopes.map((envelope) => ({ type: envelope.type, body: envelope.body })),
  });
  process.exit(0);
}

if (command === 'merge') {
  const repo = typeof args.repo === 'string' ? resolvePath(args.repo) : null;
  const baseCommit = typeof args.base === 'string' ? args.base : null;
  const targetRef = typeof args['target-ref'] === 'string' ? args['target-ref'] : null;
  const expectedOld = typeof args['expected-old'] === 'string' ? args['expected-old'] : null;
  if (repo === null || baseCommit === null || targetRef === null || expectedOld === null) {
    fail('MERGE_ARGS_REQUIRED', 'merge needs --repo --base --target-ref --expected-old');
  }
  if (action === 'approve') {
    if (typeof args.head !== 'string' || typeof args.approver !== 'string') fail('MERGE_APPROVER_REQUIRED', 'merge approve needs --head <sha> --approver <name> --authority <70..100>');
    const authority = Number.parseInt(String(args.authority ?? ''), 10);
    if (!Number.isInteger(authority)) fail('AUTHORITY_REQUIRED', 'pass --authority <70..100>');
    const ttlMin = Number.parseInt(String(args['ttl-min'] ?? '10'), 10);
    const created = createMergeApproval({ stateDir, planSha: typeof args.plan === 'string' ? args.plan : null, repo, baseCommit, targetRef, expectedOld, integrationHead: args.head, approver: args.approver, authority, ttlMs: (Number.isFinite(ttlMin) ? ttlMin : 10) * 60_000 });
    if (created.ok !== true) fail(created.code ?? 'MERGE_APPROVAL_FAILED', created.detail ?? null);
    print({ ok: true, approval_sha256: created.approval_sha256, approval: created.approval });
    process.exit(0);
  }
  if (typeof args.patches !== 'string') fail('MERGE_PATCHES_REQUIRED', 'pass --patches <manifest.json>');
  let patches = null;
  try { patches = JSON.parse(readFileSync(args.patches, 'utf8').replace(/^\uFEFF/, '')); } catch (error) { fail('MERGE_PATCHES_UNREADABLE', error instanceof Error ? error.message : String(error)); }
  if (!Array.isArray(patches) || patches.length === 0) fail('MERGE_PATCHES_INVALID', 'manifest must be a non-empty JSON array of {step_id, patch}');
  const merged = mergePatches({ repoDir: repo, baseCommit, patches });
  if (merged.ok !== true) fail(merged.code ?? 'MERGE_FAILED', merged.detail ?? null);
  const dryRun = args.apply !== true;
  print({ ok: true, dry_run: dryRun, integration_head: merged.integration_head, applied: merged.applied, target_ref: targetRef, expected_old: expectedOld });
  if (dryRun) { abortMerge({ repoDir: repo, worktree: merged.worktree }); process.exit(0); }
  if (typeof args.approval !== 'string') { abortMerge({ repoDir: repo, worktree: merged.worktree }); fail('MERGE_APPROVAL_REQUIRED', '--apply needs --approval <merge_approval_sha256>'); }
  const gate = loadMergeApproval({ stateDir, approvalSha: args.approval, repo, baseCommit, targetRef, expectedOld, integrationHead: merged.integration_head, planSha: typeof args.plan === 'string' ? args.plan : null });
  if (gate.ok !== true) { abortMerge({ repoDir: repo, worktree: merged.worktree }); fail(gate.code ?? 'MERGE_APPROVAL_INVALID', gate.detail ?? null); }
  const consumed = consumeMergeApproval({ stateDir, approvalSha: args.approval });
  if (consumed.ok !== true) { abortMerge({ repoDir: repo, worktree: merged.worktree }); fail(consumed.code ?? 'MERGE_APPROVAL_CONSUME_FAILED', consumed.detail ?? null); }
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rollbackRef = 'refs/w2m/rollback/' + (typeof args.plan === 'string' ? args.plan.slice(0, 12) : 'plan') + '-' + stamp;
  const advanced = advanceTarget({ repoDir: repo, targetRef, expectedOld, newCommit: merged.integration_head, rollbackRef });
  abortMerge({ repoDir: repo, worktree: merged.worktree });
  if (advanced.ok !== true) fail(advanced.code ?? 'MERGE_CAS_FAILED', advanced.detail ?? null);
  print({ ok: true, dry_run: false, integration_head: merged.integration_head, target_ref: targetRef, rollback_ref: rollbackRef });
  process.exit(0);
}

process.stderr.write('usage: node bin/w2m-joint.mjs <plan create|list|get|approve|status|dispatch> [options]\n');
process.exit(2);
