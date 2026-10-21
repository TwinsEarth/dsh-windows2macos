/**
 * Grant gate tests (agent-side, v1.3.10-beta.3 slice).
 *
 * The gate is the last thing between a signed authorisation and a command that would otherwise be refused. These cases
 * pin the two properties that matter: a valid grant is per-use (a second call is refused), and every refusal is a named
 * value rather than a boolean the caller has to interpret.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrant, signGrant } from '../src/maintenance/grant.mjs';
import { generateOperatorKeyPair, registrationPayload } from '../src/maintenance/operator-key.mjs';
import { authorizeWithGrant } from '../src/agent/grant-gate.mjs';

const MACHINE = '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc';
const OTHER = '6c92b251-3728-48bc-82a9-56cc40df48f2';
const NOW = Date.parse('2026-10-21T14:00:00Z');
const ARGV = ['node', '-e', 'console.log(process.version)'];
const TASK = '01M5F000000000000000000000';

describe('grant gate', () => {
  let keys;
  let dir;
  let pinFile;
  let usedFile;

  beforeEach(() => {
    keys = generateOperatorKeyPair();
    dir = mkdtempSync(join(tmpdir(), 'w2m-grant-gate-'));
    pinFile = join(dir, 'pins.json');
    usedFile = join(dir, 'used.json');
  });

  const offer = (overrides = {}) => ({
    task_id: TASK,
    command_argv: ARGV,
    mode: 'replicate',
    cwd_rel: '.',
    write: false,
    machine_id: MACHINE,
    operator_key: registrationPayload(keys),
    grant: signGrant(buildGrant({ taskId: TASK, machineIds: [MACHINE], argv: ARGV, nowMs: NOW, ttlMs: 5 * 60 * 1000 }), keys.privateKeyPem),
    ...overrides,
  });

  const run = (overrides = {}) => authorizeWithGrant({ offer: offer(overrides), machineId: MACHINE, pinFile, usedFile, now: () => NOW });

  it('accepts a valid grant, pins the key, and refuses the same grant on a second use', async () => {
    const once = signGrant(buildGrant({ taskId: TASK, machineIds: [MACHINE], argv: ARGV, nowMs: NOW, ttlMs: 5 * 60 * 1000 }), keys.privateKeyPem);
    const make = () => authorizeWithGrant({ offer: offer({ grant: once }), machineId: MACHINE, pinFile, usedFile, now: () => NOW });
    const first = await make();
    assert.equal(first.ok, true);
    assert.equal(first.used, 1);
    const second = await make();
    assert.equal(second.ok, false);
    assert.equal(second.code, 'GRANT_REPLAY');
  });

  it('refuses a grant for another machine without consuming it', async () => {
    const once = signGrant(buildGrant({ taskId: TASK, machineIds: [MACHINE], argv: ARGV, nowMs: NOW, ttlMs: 5 * 60 * 1000 }), keys.privateKeyPem);
    const wrong = await authorizeWithGrant({ offer: offer({ grant: once }), machineId: OTHER, pinFile, usedFile, now: () => NOW });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'GRANT_WRONG_MACHINE');
    const right = await authorizeWithGrant({ offer: offer({ grant: once }), machineId: MACHINE, pinFile, usedFile, now: () => NOW });
    assert.equal(right.ok, true, 'the wrong-machine call must not have consumed the grant');
  });

  it('refuses a mismatched argv and a mismatched task', async () => {
    const argvMismatch = await run({ command_argv: ['node', '-e', 'console.log(process.env)'] });
    assert.equal(argvMismatch.code, 'GRANT_ARGV_MISMATCH');
    const taskMismatch = await run({ task_id: 'another-task' });
    assert.equal(taskMismatch.code, 'GRANT_WRONG_TASK');
  });

  it('refuses when no key is pinned and none is supplied', async () => {
    const result = await authorizeWithGrant({ offer: offer({ operator_key: undefined }), machineId: MACHINE, pinFile, usedFile, now: () => NOW });
    assert.equal(result.code, 'GRANT_NO_PINNED_KEY');
  });

  it('refuses a grant that would widen a read-only task', async () => {
    const writer = signGrant(buildGrant({ taskId: TASK, machineIds: [MACHINE], argv: ARGV, nowMs: NOW, write: true }), keys.privateKeyPem);
    const result = await authorizeWithGrant({ offer: offer({ grant: writer }), machineId: MACHINE, pinFile, usedFile, now: () => NOW });
    assert.equal(result.code, 'GRANT_CONSTRAINT_VIOLATION');
  });

  it('refuses a revoked operator key', async () => {
    const { createPinStore } = await import('../src/maintenance/operator-key.mjs');
    const store = createPinStore(pinFile);
    store.pinFromRegistration(registrationPayload(keys));
    store.revoke(keys.keyId, 'test revocation');
    const result = await run();
    assert.equal(result.code, 'GRANT_REVOKED');
  });
});
