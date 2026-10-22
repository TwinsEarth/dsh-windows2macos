/**
 * The UI-activated Node-code-execution capability: the machine-local switch behind the composer control.
 *
 * The tests are grouped the way the feature fails: the store's fail-closed defaults, the expiry boundary, and the
 * host route's two verbs (plus the verbs it refuses by name). The agent's use of the same file is covered by the
 * agent suite; here the contract is "a decision is stored, expires and is read back exactly as written".
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_TEMPORARY_TTL_MS,
  MAX_TEMPORARY_TTL_MS,
  describeExecCapability,
  effectiveExecCapabilityPrefixes,
  readExecCapability,
  writeExecCapability,
} from '../src/util/exec-capability.mjs';
import { registerExecCapabilityRoutes } from '../src/plugin/exec-capability-route.mjs';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'w2m-cap-')), 'exec-capability.json');

describe('exec capability store', () => {
  it('is denied by default, including for a missing or malformed file', () => {
    const file = tempFile();
    assert.equal(readExecCapability(file).state, 'denied');
    assert.equal(readExecCapability(file).reason, 'absent');
    assert.deepEqual(effectiveExecCapabilityPrefixes(file), []);
    writeFileSync(file, 'not json');
    assert.equal(readExecCapability(file).state, 'denied');
    assert.equal(readExecCapability(file).reason, 'invalid');
  });

  it('stores a permanent decision and exposes exactly the one fixed prefix', () => {
    const file = tempFile();
    const written = writeExecCapability(file, { state: 'permanent', actor: { kind: 'operator' } }, 1_000);
    assert.equal(written.ok, true);
    const state = readExecCapability(file, 5_000);
    assert.equal(state.state, 'permanent');
    assert.equal(state.effective, true);
    assert.deepEqual(effectiveExecCapabilityPrefixes(file, 5_000), [['node', '-e']]);
    const described = describeExecCapability(file, 5_000);
    assert.deepEqual(described.allows, ['node -e']);
    assert.match(described.warning, /RCE/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'permanent');
  });

  it('expires a temporary decision at its boundary and reports why', () => {
    const file = tempFile();
    const written = writeExecCapability(file, { state: 'temporary', ttl_ms: 60_000 }, 1_000);
    assert.equal(written.ok, true);
    assert.equal(readExecCapability(file, 30_000).effective, true);
    assert.equal(readExecCapability(file, 61_000).effective, false);
    assert.equal(readExecCapability(file, 61_000).state, 'denied');
    assert.equal(readExecCapability(file, 61_000).reason, 'expired');
    assert.deepEqual(effectiveExecCapabilityPrefixes(file, 61_000), []);
    // Default TTL is 24 h, the choice the UI offers.
    const file2 = tempFile();
    writeExecCapability(file2, { state: 'temporary' }, 0);
    assert.equal(JSON.parse(readFileSync(file2, 'utf8')).expires_at_ms, DEFAULT_TEMPORARY_TTL_MS);
  });

  it('records a refusal and refuses impossible requests by name', () => {
    const file = tempFile();
    writeExecCapability(file, { state: 'permanent' }, 1_000);
    writeExecCapability(file, { state: 'denied' }, 2_000);
    assert.equal(readExecCapability(file, 3_000).state, 'denied');
    assert.equal(effectiveExecCapabilityPrefixes(file, 3_000).length, 0);
    assert.equal(writeExecCapability(file, { state: 'always' }).code, 'CAPABILITY_STATE_INVALID');
    assert.equal(writeExecCapability(file, { state: 'temporary', ttl_ms: MAX_TEMPORARY_TTL_MS + 1 }).code, 'CAPABILITY_TTL_TOO_LONG');
  });
});

describe('exec capability host route', () => {
  const mount = (capabilityFile) => {
    let route = null;
    const ctx = { inject: (_deps, callback) => callback({ connection: { fetch: { register: (registered) => { route = registered; } } } }) };
    const status = registerExecCapabilityRoutes(ctx, { capabilityFile: () => capabilityFile });
    return { status, route };
  };

  it('reads the current decision and writes one of the three states', async () => {
    const file = tempFile();
    const mounted = mount(file);
    assert.equal(mounted.status.mounted, true);
    assert.equal(mounted.route.path, '/api/w2m/capability');
    const read = await mounted.route.fetch(new Request('http://host/api/w2m/capability'));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).capability.state, 'denied');

    const write = await mounted.route.fetch(new Request('http://host/api/w2m/capability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'temporary', ttl_ms: 3_600_000 }),
    }));
    assert.equal(write.status, 200);
    assert.equal((await write.json()).capability.effective, true);

    const permanent = await mounted.route.fetch(new Request('http://host/api/w2m/capability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'permanent' }),
    }));
    assert.equal((await permanent.json()).capability.state, 'permanent');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'permanent');
  });

  it('refuses a bad body and any verb it does not name', async () => {
    const file = tempFile();
    const mounted = mount(file);
    const bad = await mounted.route.fetch(new Request('http://host/api/w2m/capability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'sometimes' }),
    }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason_code, 'CAPABILITY_STATE_INVALID');
    const wrongVerb = await mounted.route.fetch(new Request('http://host/api/w2m/capability', { method: 'DELETE' }));
    assert.equal(wrongVerb.status, 405);
  });

  it('reports a host without the Connection service rather than throwing', () => {
    const status = registerExecCapabilityRoutes({ inject: undefined }, { capabilityFile: () => tempFile() });
    assert.equal(status.mounted, false);
    assert.match(status.reason, /Connection/);
  });
});