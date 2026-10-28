/**
 * B4: audit-before-send is an invariant, not a best effort.
 *
 * dispatchPlanToRelay must refuse to send when the audit record cannot be written, must write a
 * `joint.dispatch.sending` line before the POST, and must not report success when only the trailing
 * audit write failed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';

const APPROVAL = { approval_sha256: 'c'.repeat(64) };
const plan = () => buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
const jsonResponse = (status, doc) => ({ ok: status >= 200 && status < 300, status, json: async () => doc });
const HEALTH = { relay_version: 'test', features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false } };

describe('dispatch audit is fail-closed', () => {
  it('writes sending before the POST and sent after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-audit-ok-'));
    const auditFile = join(dir, 'audit.jsonl');
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      return jsonResponse(200, { task_id: 'jd-task', leases: [{ machine_id: 'm-1', state: 'queued' }] });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan: plan(), approval: APPROVAL, fetchImpl, auditFile });
    assert.equal(result.ok, true, JSON.stringify(result));
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].event, 'joint.dispatch.sending');
    assert.equal(lines[lines.length - 1].event, 'joint.dispatch.sent');
    assert.match(lines[0].control_sha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(lines).includes('node'), false, 'audit lines never carry argv');
  });

  it('refuses to send when the audit tail is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-audit-bad-'));
    const auditFile = join(dir, 'audit.jsonl');
    writeFileSync(auditFile, '{"broken"\n', 'utf8');
    let fetches = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      fetches += 1;
      return jsonResponse(200, { task_id: 'jd-task', leases: [] });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan: plan(), approval: APPROVAL, fetchImpl, auditFile });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUDIT_UNAVAILABLE');
    assert.equal(fetches, 0, 'no task may be sent without a pre-send audit line');
  });
});
