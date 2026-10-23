/**
 * v1.6.1: the Node-code-execution capability is a manual, in-process switch.
 *
 * These tests pin the policy, because it is the machine's highest-privilege switch:
 *   * the standing default is denied;
 *   * a capability file on disk — including a `permanent` one written by a task/script/attacker —
 *     is IGNORED, because nothing a machine or automation runs may grant execution;
 *   * only the host route (the human UI click) moves the state, and it moves process memory only;
 *   * temporary really expires and permanent does not survive a restart by construction.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXEC_CAPABILITY_MANUAL_ONLY,
  MAX_TEMPORARY_TTL_MS,
  defaultExecCapabilityFile,
  describeExecCapability,
  effectiveExecCapabilityPrefixes,
  readExecCapability,
  resetExecCapability,
  writeExecCapability,
} from '../src/util/exec-capability.mjs';
import { registerExecCapabilityRoutes } from '../src/plugin/exec-capability-route.mjs';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'w2m-cap-')), 'exec-capability.json');

describe('Node exec capability: manual-only, in-process (v1.6.1)', () => {
  beforeEach(() => resetExecCapability());

  it('starts denied and says the authority is process memory, not a file', () => {
    const status = readExecCapability(tempFile());
    assert.equal(status.state, 'denied');
    assert.equal(status.effective, false);
    assert.equal(status.reason, 'manual_default');
    assert.equal(status.source, 'process-memory');
    assert.equal(status.file_ignored, true);
    assert.deepEqual(effectiveExecCapabilityPrefixes('ignored'), []);
  });

  it('IGNORES a permanent capability file written by anything else (the security invariant)', () => {
    const file = tempFile();
    mkdirSync(join(file, '..'), { recursive: true });
    // What a grant task, a scheduled script, or an attacker with file access can do today:
    writeFileSync(file, JSON.stringify({
      protocol: 'w2m-exec-capability/v1',
      state: 'permanent',
      activated_at_ms: Date.now(),
      expires_at_ms: null,
      actor: { kind: 'operator', id: 'totally-legit' },
    }), 'utf8');
    assert.equal(readExecCapability(file).state, 'denied', 'a disk file cannot grant execution');
    assert.deepEqual(effectiveExecCapabilityPrefixes(file), []);
  });

  it('moves only through the write path (the host route), and adds exactly node -e', () => {
    const file = tempFile();
    const written = writeExecCapability(file, { state: 'permanent', actor: { kind: 'operator', id: 'plugin-ui' } }, 1_000);
    assert.equal(written.ok, true);
    assert.equal(readExecCapability(file, 5_000).effective, true);
    assert.deepEqual(effectiveExecCapabilityPrefixes(file, 5_000), [['node', '-e']]);
    const described = describeExecCapability(file, 5_000);
    assert.equal(described.manual_only, true);
    assert.equal(described.survives_restart, false);
    assert.match(described.policy, /manual-only/i);
    assert.equal(described.policy, EXEC_CAPABILITY_MANUAL_ONLY);
    // Revocation works the same way.
    writeExecCapability(file, { state: 'denied' }, 6_000);
    assert.equal(readExecCapability(file, 7_000).state, 'denied');
    assert.equal(effectiveExecCapabilityPrefixes(file, 7_000).length, 0);
  });

  it('enforces the temporary window and refuses an over-long TTL', () => {
    const file = tempFile();
    writeExecCapability(file, { state: 'temporary', ttl_ms: 60_000 }, 1_000);
    assert.equal(readExecCapability(file, 30_000).effective, true);
    assert.equal(readExecCapability(file, 61_000).effective, false);
    assert.equal(readExecCapability(file, 61_000).reason, 'expired');
    assert.equal(writeExecCapability(file, { state: 'temporary', ttl_ms: MAX_TEMPORARY_TTL_MS + 1 }, 1_000).code, 'CAPABILITY_TTL_TOO_LONG');
    assert.equal(writeExecCapability(file, { state: 'always' }, 1_000).code, 'CAPABILITY_STATE_INVALID');
  });

  it('keeps the host route as the single setter and reports the manual-only policy', async () => {
    const handlers = [];
    const ctx = {
      inject: (_services, callback) => callback({ connection: { fetch: { register: (route) => handlers.push(route) } } }),
    };
    const mounted = registerExecCapabilityRoutes(ctx, { capabilityFile: () => tempFile() });
    assert.equal(mounted.mounted, true);
    const route = handlers[0];
    assert.equal(route.path, '/api/w2m/capability');
    const get = await route.fetch({ method: 'GET' });
    const getBody = await get.json();
    assert.equal(getBody.capability.manual_only, true);
    assert.equal(getBody.capability.state, 'denied');
    const post = await route.fetch({
      method: 'POST',
      json: async () => ({ state: 'temporary', ttl_ms: 3_600_000 }),
    });
    const postBody = await post.json();
    assert.equal(postBody.ok, true);
    assert.equal(postBody.capability.state, 'temporary');
    assert.equal(postBody.capability.manual_only, true);
    assert.equal(postBody.capability.survives_restart, false);
    assert.equal(readExecCapability(undefined).effective, true);
  });

  it('resets to denied (a restart is a revocation)', () => {
    writeExecCapability(undefined, { state: 'permanent' });
    assert.equal(readExecCapability(undefined).effective, true);
    resetExecCapability(); // what a new host process starts as
    assert.equal(readExecCapability(undefined).state, 'denied');
    assert.equal(defaultExecCapabilityFile('/home/x'), join('/home/x', '.w2m', 'exec-capability.json'));
  });
});
