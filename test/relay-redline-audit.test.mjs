/**
 * Relay red-line audit (v1.9.9 relay work): the three claims the relay makes about its P0 cut
 * must be true in the source and at the boundaries, not only in a helper's unit test.
 *
 *  1. ONE guard entry: the data-plane refusal is decided once, after the request path is
 *     normalised (so `..`, `%2e%2e` and basePath prefixes cannot walk around it).
 *  2. PROJECTION IS WIRED: results are projected before they are stored, and the report strips
 *     content fields again so a legacy record cannot leak them.
 *  3. BLOB ENDPOINTS ARE RETIRED: the legacy handlers may remain in the file for a migration
 *     window, but they sit strictly after the refusal and cannot be reached first.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { projectResultEnvelope, stripReportAggregate } from '../src/relay/p0-projection.mjs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

describe('relay red-line audit: single guard entry', () => {
  it('guardBlobRoute is defined once and called once (server only)', () => {
    const server = read('src/relay/server.mjs');
    const guard = read('src/relay/redline-guard.mjs');
    assert.equal((server.match(/guardBlobRoute\(/g) ?? []).length, 1, 'server calls it exactly once');
    assert.equal((guard.match(/export function guardBlobRoute/g) ?? []).length, 1, 'defined once');
    for (const rel of ['src/relay/guarded-dispatch.mjs', 'src/relay/p0-projection.mjs']) {
      assert.equal((read(rel).match(/guardBlobRoute\(/g) ?? []).length, 0, rel + ' must not duplicate the guard');
    }
  });

  it('the refusal runs after path normalisation and before routing', () => {
    const s = read('src/relay/server.mjs');
    const normalise = s.indexOf('const path = normalizePath(stripped);');
    const gate = s.indexOf("path === '/v1/fleet/blob-sessions'");
    const firstRoute = s.indexOf("method === 'GET' && path === '/healthz'");
    assert.ok(normalise > 0, 'the request path is normalised');
    assert.ok(gate > normalise, 'the gate must see the normalised path');
    assert.ok(firstRoute > gate, 'the gate must run before any route is matched');
  });
});

describe('relay red-line audit: result guard is window-scoped', () => {
  it('the hard result guard only runs under enforce; window accepts and projects', () => {
    const s = read('src/relay/server.mjs');
    const env = s.indexOf("W2M_DATA_PLANE_GUARD ?? 'window'");
    const guard = s.indexOf('guardResultEnvelope(body)');
    assert.ok(env > 0, 'the guard mode is read from the environment');
    assert.ok(guard > env, 'the result guard sits inside the enforce branch');
    const state = read('src/relay/state.mjs');
    assert.ok(state.indexOf('projectResultEnvelope(envelope)') > 0, 'window still projects before storage');
  });
});

describe('relay red-line audit: projection is wired', () => {
  it('state projects the envelope before it stores the record', () => {
    const s = read('src/relay/state.mjs');
    const project = s.indexOf('projectResultEnvelope(envelope)');
    const store = s.indexOf('this.results.set(instanceKey, record)');
    assert.ok(project > 0, 'submitResult projects');
    assert.ok(project < store, 'projection happens before storage');
    assert.ok(s.includes('envelope_sha256_received'), 'the received hash is kept for audit');
  });

  it('report strips content fields again (defence in depth)', () => {
    const s = read('src/relay/report.mjs');
    assert.ok(s.includes('stripReportAggregate('), 'aggregate is wrapped');
    const agg = stripReportAggregate({
      machines: [{ stdout_head: 'SECRET', output_mode: 'blob', blob_sha256: 'a'.repeat(64), stdout_bytes: 7 }],
    });
    assert.equal(JSON.stringify(agg).includes('SECRET'), false, 'no inline content survives the report');
    assert.equal(agg.machines[0].blob_sha256, null, 'the data-plane pointer is projected to null');
    assert.equal(agg.machines[0].stdout_bytes, 7, 'size metadata is kept');
  });

  it('a raw result envelope is projected: content dropped, sizes kept', () => {
    const { projected, dropped } = projectResultEnvelope({
      stdout_head: 'SECRET', stdout_tail: 'SECRET', command_argv: ['x', '--secret'],
      stdout_sha256: 'c'.repeat(64), stdout_bytes: 12,
    });
    assert.equal(JSON.stringify(projected).includes('SECRET'), false);
    assert.ok(dropped.includes('stdout_head'));
    assert.equal(projected.stdout_bytes, 12);
    assert.equal(projected.stdout_sha256, 'c'.repeat(64));
  });
});

describe('relay red-line audit: blob endpoints retired', () => {
  it('legacy blob handlers sit strictly after the refusal', () => {
    const s = read('src/relay/server.mjs');
    const gate = s.indexOf("path.startsWith('/v1/fleet/blobs')");
    const legacySession = s.indexOf("const blobSessionCreate = method === 'POST'");
    assert.ok(gate > 0, 'the blob gate exists');
    assert.ok(legacySession > gate, 'legacy handlers are unreachable before the gate');
  });

  it('the guard answers 403 with a machine-readable code', () => {
    const guard = read('src/relay/redline-guard.mjs');
    const body = guard.slice(guard.indexOf('export function guardBlobRoute'));
    assert.match(body, /status: 403/);
    assert.match(body, /DATA_PLANE_REFUSED/);
  });
});
