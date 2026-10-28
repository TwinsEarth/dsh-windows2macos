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
import { readFileSync } from 'node:fs';

import { buildControlEnvelopes, buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { negotiateFeatures, readRelayCapabilities } from '../src/plugin/relay-capabilities.mjs';
import {
  approvePlan,
  assertDispatchAllowed,
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
const stateDir = typeof args.state === 'string' ? args.state : (process.env.W2M_JOINT_STATE ?? null);
if (stateDir === null) fail('STATE_DIR_REQUIRED', 'pass --state <dir> (the joint-dev state directory)');

if (command === 'plan' && action === 'create') {
  if (typeof args.steps !== 'string') fail('STEPS_REQUIRED', 'pass --steps <steps.json>');
  let steps;
  try { steps = JSON.parse(readFileSync(args.steps, 'utf8').replace(/^\\uFEFF/, '')); } catch (error) {
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
  const approved = approvePlan({
    stateDir,
    planSha: args.plan,
    approver: args.approver,
    authority,
    note: typeof args.note === 'string' ? args.note : '',
    ttlMs: (Number.isFinite(ttlMin) ? ttlMin : 10) * 60_000,
  });
  if (approved.ok !== true) fail(approved.code ?? 'APPROVAL_FAILED', approved.detail ?? null);
  print({ ok: true, approval: approved.approval, path: approved.path });
  process.exit(0);
}

if (command === 'status') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  const plan = loadPlan({ stateDir, planSha: args.plan });
  if (plan.ok !== true) fail(plan.code ?? 'PLAN_NOT_FOUND');
  const approval = loadApproval({ stateDir, planSha: args.plan });
  const gate = assertDispatchAllowed({ stateDir, planSha: args.plan });
  print({
    ok: true,
    plan_sha256: plan.plan.plan_sha256,
    steps: plan.plan.steps.map((step) => ({ step_id: step.step_id, machine_id: step.machine_id, command_hash: step.command_hash })),
    approval: approval.ok ? { approver: approval.approval.approver, authority: approval.approval.authority, expires_at: approval.approval.expires_at } : { state: approval.code },
    dispatch_allowed: gate.ok === true,
    blocked_by: gate.ok === true ? null : gate.code,
  });
  process.exit(0);
}

if (command === 'dispatch') {
  if (typeof args.plan !== 'string') fail('PLAN_REQUIRED', 'pass --plan <sha256>');
  const gate = assertDispatchAllowed({ stateDir, planSha: args.plan });
  if (gate.ok !== true) fail(gate.code ?? 'APPROVAL_REQUIRED', 'dispatch refused before anything was sent');
  if (args['dry-run'] !== true) {
    fail('DISPATCH_NOT_WIRED', 'real dispatch is the next slice: it needs the operator token and a relay with target_machines/capability advertisement; use --dry-run to inspect the envelopes');
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
    plan_sha256: gate.plan.plan_sha256,
    approval_sha256: gate.approval.approval_sha256,
    envelopes: envelopes.length,
    control: envelopes.map((envelope) => ({ type: envelope.type, body: envelope.body })),
  });
  process.exit(0);
}

process.stderr.write('usage: node bin/w2m-joint.mjs <plan create|list|get|approve|status|dispatch> [options]\n');
process.exit(2);
