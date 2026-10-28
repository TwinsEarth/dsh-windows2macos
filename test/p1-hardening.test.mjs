/** P1: audit fail-closed/deep filtering and the dispatcher's plugin-version gate. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendAudit } from '../src/plugin/joint-dev/audit-file.mjs';
import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';

const HEALTH = { relay_version: 'test', features: ['target-machines', 'result-projection'] };
const APPROVAL = { approval_sha256: 'c'.repeat(64) };
const planOf = () => buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
const jsonResponse = (status, doc) => ({ ok: status >= 200 && status < 300, status, json: async () => doc });

describe('audit file hardening', () => {
  it('refuses a nested content field', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'w2m-audit-')), 'audit.jsonl');
    const result = appendAudit(file, { event: 'joint.dispatch.sending', nested: { payload: { stdout: 'secret' } } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUDIT_CONTENT_FORBIDDEN');
  });

  it('fails closed on a corrupt tail instead of resetting the chain', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'w2m-audit-')), 'audit.jsonl');
    assert.equal(appendAudit(file, { event: 'joint.dispatch.sending' }).ok, true);
    writeFileSync(file, readFileSync(file, 'utf8') + 'not-json\n', 'utf8');
    const result = appendAudit(file, { event: 'joint.dispatch.sent' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUDIT_TAIL_CORRUPT');
  });

  it('appends with a lock that is removed again', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'w2m-audit-')), 'audit.jsonl');
    assert.equal(appendAudit(file, { event: 'joint.dispatch.sending', plan_sha256: 'a'.repeat(64) }).ok, true);
    assert.equal(appendAudit(file, { event: 'joint.dispatch.sent', plan_sha256: 'a'.repeat(64) }).ok, true);
    assert.throws(() => readFileSync(file + '.lock', 'utf8'), /ENOENT/);
  });
});

describe('dispatcher plugin-version gate', () => {
  it('refuses a machine whose advertised plugin version differs', async () => {
    const plan = planOf();
    const relay = async (url, _init) => {
      const target = String(url);
      if (target.endsWith('/healthz')) return jsonResponse(200, HEALTH);
      if (target.endsWith('/v1/devices')) return jsonResponse(200, { devices: [{ machine_id: 'm-1', caps: { plugin_version: '1.9.16' } }] });
      assert.fail('no task should be sent for a skewed machine');
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', deviceToken: 'd', expectedVersion: '2.0.0-beta.1', plan, approval: APPROVAL, fetchImpl: relay });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VERSION_SKEW');
    assert.deepEqual(result.detail.machines, [{ machine_id: 'm-1', version: '1.9.16' }]);
  });

  it('dispatches when every target advertises the expected version', async () => {
    const plan = planOf();
    const relay = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/healthz')) return jsonResponse(200, HEALTH);
      if (target.endsWith('/v1/devices')) return jsonResponse(200, { devices: [{ machine_id: 'm-1', caps: { plugin_version: '2.0.0-beta.1' } }] });
      const body = JSON.parse(init.body);
      return jsonResponse(200, { task_id: body.task_id, leases: [{ machine_id: 'm-1', state: 'queued' }] });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', deviceToken: 'd', expectedVersion: '2.0.0-beta.1', plan, approval: APPROVAL, fetchImpl: relay });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});
