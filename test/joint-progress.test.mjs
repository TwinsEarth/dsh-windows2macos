/**
 * A5: progress consumer. The relay's projection is rebuilt from an allow-list; argv/content never
 * leave the tool, and a relay without the `progress` key is reported as PROGRESS_UNSUPPORTED rather
 * than as an empty success.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planProgress } from '../src/plugin/joint-dev/progress.mjs';

const PLAN = 'a'.repeat(64);
const APPROVAL = 'c'.repeat(64);
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-progress-'));
  mkdirSync(join(dir, 'joint-dev', 'dispatches'), { recursive: true });
  writeFileSync(join(dir, 'joint-dev', 'dispatches', PLAN + '.json'), JSON.stringify({ v: 1, plan_sha256: PLAN, approval_sha256: APPROVAL, dispatched_at: '2026-01-01T00:00:00.000Z', tasks: [{ step_id: 's1', task_id: 'jd-1', machine_id: 'm-1' }] }), 'utf8');
  return dir;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const base = { planSha: PLAN, relayUrl: 'http://relay.test', deviceToken: 'dev' };

describe('progress consumer', () => {
  it('projects status/progress and strips argv/content', async () => {
    const fetchImpl = async () => jsonResponse(200, {
      task: { task_id: 'jd-1', status: 'running', command_argv: ['node', '-e', 'secret'], stdout_head: 'SEKRET' },
      leases: [{ machine_id: 'm-1', state: 'running' }],
      progress: { phase: 'running', attempt: 1, steps: [{ step_id: 's1', status: 'running', command_argv: ['node'] }] },
    });
    const result = await planProgress({ ...base, stateDir: stateDir(), fetchImpl });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.progress_state, 'partial');
    const row = result.steps[0];
    assert.equal(row.status, 'running');
    assert.equal(row.progress.phase, 'running');
    assert.equal(row.leak_fields_stripped, true);
    assert.equal(JSON.stringify(result).includes('SEKRET'), false);
    assert.equal(JSON.stringify(result).includes('command_argv'), false);
    assert.equal(JSON.stringify(result).includes('node'), false);
  });

  it('reports PROGRESS_UNSUPPORTED when the relay has no progress key (1.9.16)', async () => {
    const fetchImpl = async () => jsonResponse(200, { task: { task_id: 'jd-1', status: 'waiting' }, leases: [] });
    const result = await planProgress({ ...base, stateDir: stateDir(), fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'PROGRESS_UNSUPPORTED');
    assert.equal(result.steps[0].progress_state, 'unavailable');
  });

  it('reports NOT_DISPATCHED without a dispatch record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-progress-empty-'));
    const result = await planProgress({ ...base, stateDir: dir, fetchImpl: async () => jsonResponse(500, {}) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_DISPATCHED');
  });

  it('maps a 404 to TASK_NOT_FOUND and requires a device token', async () => {
    const fetchImpl = async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } });
    const missing = await planProgress({ ...base, stateDir: stateDir(), fetchImpl });
    assert.equal(missing.steps[0].code, 'TASK_NOT_FOUND');
    const noToken = await planProgress({ ...base, deviceToken: '', stateDir: stateDir(), fetchImpl });
    assert.equal(noToken.ok, false);
    assert.equal(noToken.code, 'DEVICE_TOKEN_REQUIRED');
  });
});
