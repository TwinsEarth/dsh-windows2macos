/**
 * D2/B5: the version gate defaults to warn.
 *
 * A mixed-version fleet must be visible without becoming a hard stop, and enforce must refuse before
 * anything is sent. The gate reads `caps.plugin_version` from the device roster, which the agent now
 * advertises (probeCaps) and refreshes on its diagnostic heartbeat.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';

const APPROVAL = { approval_sha256: 'c'.repeat(64) };
const HEALTH = { relay_version: 'test', features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false } };
const plan = () => buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
const jsonResponse = (status, doc) => ({ ok: status >= 200 && status < 300, status, json: async () => doc });

function fakeRelay({ devices = undefined, versions = ['1.0.0'] } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/healthz')) return jsonResponse(200, HEALTH);
    if (target.endsWith('/v1/devices')) {
      if (devices === null) return jsonResponse(503, { error: { code: 'NO_ONLINE_DEVICE' } });
      const roster = Array.isArray(devices) ? devices : versions.map((version, index) => ({ machine_id: index === 0 ? 'm-1' : 'm-' + (index + 1), caps: version === null ? {} : { plugin_version: version } }));
      return jsonResponse(200, { devices: roster });
    }
    if (target.endsWith('/v1/task')) {
      posts.push(JSON.parse(init.body));
      return jsonResponse(200, { task_id: 'jd-task', leases: [{ machine_id: 'm-1', state: 'queued' }] });
    }
    return jsonResponse(404, {});
  };
  return { fetchImpl, posts };
}

describe('version gate', () => {
  it('warn reports a skew but still dispatches', async () => {
    const { fetchImpl, posts } = fakeRelay({ versions: ['1.0.0'] });
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl, deviceToken: 'dev', expectedVersion: '2.0.4', versionGate: 'warn' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(posts.length, 1);
    assert.equal(result.warnings?.[0]?.code, 'VERSION_SKEW');
  });

  it('enforce refuses a skew and sends nothing', async () => {
    const { fetchImpl, posts } = fakeRelay({ versions: ['1.0.0'] });
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl, deviceToken: 'dev', expectedVersion: '2.0.4', versionGate: 'enforce' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VERSION_SKEW');
    assert.equal(posts.length, 0);
  });

  it('warn treats an unreadable roster as unverifiable', async () => {
    const { fetchImpl, posts } = fakeRelay({ devices: null });
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl, deviceToken: 'dev', expectedVersion: '2.0.4', versionGate: 'warn' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(posts.length, 1);
    assert.equal(result.warnings?.[0]?.code, 'VERSION_UNVERIFIABLE');
  });

  it('enforce treats an unreadable roster as a refusal', async () => {
    const { fetchImpl, posts } = fakeRelay({ devices: null });
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl, deviceToken: 'dev', expectedVersion: '2.0.4', versionGate: 'enforce' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VERSION_UNVERIFIABLE');
    assert.equal(posts.length, 0);
  });

  it('rejects a malformed expected version without parsing it loosely', async () => {
    const { fetchImpl, posts } = fakeRelay({ versions: ['2.0.4'] });
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl, deviceToken: 'dev', expectedVersion: 'not-a-version', versionGate: 'warn' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VERSION_UNPARSED');
    assert.equal(posts.length, 0);
  });

  it('off skips the roster read entirely', async () => {
    let deviceReads = 0;
    const { fetchImpl, posts } = fakeRelay({ versions: ['2.0.4'] });
    const counted = async (url, init) => { if (String(url).endsWith('/v1/devices')) deviceReads += 1; return fetchImpl(url, init); };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 'op', plan: plan(), approval: APPROVAL, fetchImpl: counted, deviceToken: 'dev', expectedVersion: '2.0.4', versionGate: 'off' });
    assert.equal(result.ok, true);
    assert.equal(deviceReads, 0);
    assert.equal(posts.length, 1);
  });
});
