/**
 * M1 maintenance channel: protocol, operator keys and runner (v1.3.2-beta).
 *
 * The destructive actions (update/restart) are not executed here — these tests cover the parts a bug would be silent in:
 * what the operator signed, whether a refusal is the right refusal, and whether a runner can ever execute twice.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAINTENANCE_PROTOCOL,
  MAX_TTL_MS,
  buildRequest,
  canonicalize,
  signRequest,
  verifyRequest,
} from '../src/maintenance/protocol.mjs';
import {
  OperatorKeyError,
  createPinStore,
  generateOperatorKeyPair,
  keyIdOf,
  registrationPayload,
  signRotation,
} from '../src/maintenance/operator-key.mjs';
import { runOnce } from '../src/maintenance/runner.mjs';

const MACHINE = '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc';
const NOW = Date.parse('2026-10-21T13:00:00Z');

function signedDiag(keys, overrides = {}) {
  const request = buildRequest({
    action: 'diag',
    params: {},
    machineId: MACHINE,
    issuedBy: 'lead',
    ttlMs: 5 * 60 * 1000,
    nowMs: NOW,
    ...overrides,
  });
  return signRequest(request, keys.privateKeyPem);
}

function verifyContext(keys, extra = {}) {
  return { publicKeyPem: keys.publicKeyPem, expectedKeyId: keys.keyId, expectedMachineId: MACHINE, nowMs: NOW, ...extra };
}

describe('maintenance protocol', () => {
  let keys;
  beforeEach(() => { keys = generateOperatorKeyPair(); });

  it('canonicalizes objects deterministically but keeps array order', () => {
    assert.equal(canonicalize({ b: 1, a: [2, 1] }), canonicalize({ a: [2, 1], b: 1 }));
    assert.equal(canonicalize({ a: [1, 2] }), '{"a":[1,2]}');
    assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
  });

  it('accepts a correctly signed request from the pinned key', () => {
    const request = signedDiag(keys);
    const verified = verifyRequest(request, verifyContext(keys));
    assert.equal(verified.ok, true);
    assert.equal(verified.request.request_id, request.request_id);
    assert.equal(request.protocol, MAINTENANCE_PROTOCOL);
  });

  it('refuses a request whose parameters were changed after signing', () => {
    const request = signedDiag(keys);
    const tampered = { ...request, params: { sections: ['version'] } };
    assert.equal(verifyRequest(tampered, verifyContext(keys)).code, 'MAINTENANCE_BAD_SIGNATURE');
  });

  it('refuses a request signed by an unknown key', () => {
    const other = generateOperatorKeyPair();
    const request = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW }), other.privateKeyPem);
    assert.equal(verifyRequest(request, verifyContext(keys)).code, 'MAINTENANCE_UNKNOWN_KEY');
  });

  it('refuses revoked keys', () => {
    const request = signedDiag(keys);
    assert.equal(verifyRequest(request, verifyContext(keys, { isRevoked: () => true })).code, 'MAINTENANCE_REVOKED');
  });

  it('refuses another machine, an unusable time window, and a too-long TTL', () => {
    const wrongMachine = signRequest(buildRequest({ action: 'diag', params: {}, machineId: 'some-other-machine', nowMs: NOW }), keys.privateKeyPem);
    assert.equal(verifyRequest(wrongMachine, verifyContext(keys)).code, 'MAINTENANCE_WRONG_MACHINE');

    const future = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW + 5 * 60 * 1000 }), keys.privateKeyPem);
    assert.equal(verifyRequest(future, verifyContext(keys)).code, 'MAINTENANCE_FUTURE');

    const expired = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW - 30 * 60 * 1000 }), keys.privateKeyPem);
    assert.equal(verifyRequest(expired, verifyContext(keys)).code, 'MAINTENANCE_EXPIRED');

    const longTtl = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW, ttlMs: MAX_TTL_MS + 1 }), keys.privateKeyPem);
    assert.equal(verifyRequest(longTtl, verifyContext(keys)).code, 'MAINTENANCE_TTL_TOO_LONG');
  });

  it('refuses replays of the same request id or nonce', () => {
    const request = signedDiag(keys);
    assert.equal(verifyRequest(request, verifyContext(keys, { usedRequestIds: new Set([request.request_id]) })).code, 'MAINTENANCE_REPLAY');
    assert.equal(verifyRequest(request, verifyContext(keys, { usedNonces: new Set([request.nonce]) })).code, 'MAINTENANCE_REPLAY');
  });

  it('refuses unknown actions, malformed action parameters and missing signatures', () => {
    const unsigned = buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW });
    assert.equal(verifyRequest(unsigned, verifyContext(keys)).code, 'MAINTENANCE_MISSING_SIGNATURE');

    const unknown = signRequest({ ...unsigned, action: 'shell' }, keys.privateKeyPem);
    assert.equal(verifyRequest(unknown, verifyContext(keys)).code, 'MAINTENANCE_BAD_ACTION');

    const badUpdate = signRequest(buildRequest({ action: 'update', params: { target: 'plugin', version: '1.3.2-beta.1', artifact_sha256: 'x', artifact_urls: ['http://insecure'] }, machineId: MACHINE, nowMs: NOW }), keys.privateKeyPem);
    assert.equal(verifyRequest(badUpdate, verifyContext(keys)).code, 'MAINTENANCE_BAD_PARAMS');

    const widenedDiag = signRequest(buildRequest({ action: 'diag', params: { shell: 'id' }, machineId: MACHINE, nowMs: NOW }), keys.privateKeyPem);
    assert.equal(verifyRequest(widenedDiag, verifyContext(keys)).code, 'MAINTENANCE_BAD_PARAMS');

    const badRestart = signRequest(buildRequest({ action: 'restart', params: { targets: 'sshd' }, machineId: MACHINE, nowMs: NOW }), keys.privateKeyPem);
    assert.equal(verifyRequest(badRestart, verifyContext(keys)).code, 'MAINTENANCE_BAD_PARAMS');
  });
});

describe('operator key pinning', () => {
  it('pins on first contact and refuses a different key without a rotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-pins-'));
    const store = createPinStore(join(dir, 'pins.json'));
    const first = generateOperatorKeyPair();
    const second = generateOperatorKeyPair();
    assert.equal(store.pinFromRegistration(registrationPayload(first)).firstContact, true);
    assert.equal(store.pinFromRegistration(registrationPayload(first)).firstContact, false);
    assert.throws(() => store.pinFromRegistration(registrationPayload(second)), (error) => error instanceof OperatorKeyError && error.code === 'ROTATION_REQUIRED');
  });

  it('accepts a rotation signed by the pinned key and rejects an unsigned one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-pins-'));
    const store = createPinStore(join(dir, 'pins.json'));
    const oldKey = generateOperatorKeyPair();
    const newKey = generateOperatorKeyPair();
    store.pinFromRegistration(registrationPayload(oldKey));
    assert.throws(() => store.rotate({ newPublicKeyPem: newKey.publicKeyPem, signatureBase64: Buffer.from('nope').toString('base64') }), (error) => error.code === 'ROTATION_BAD_SIGNATURE');
    const { signatureBase64 } = signRotation({ oldPrivateKeyPem: oldKey.privateKeyPem, oldKeyId: oldKey.keyId, newPublicKeyPem: newKey.publicKeyPem });
    const rotated = store.rotate({ newPublicKeyPem: newKey.publicKeyPem, signatureBase64 });
    assert.equal(rotated.pinned.key_id, newKey.keyId);
    assert.equal(rotated.pinned.rotation_of, oldKey.keyId);
  });

  it('records revocation and refuses a revoked registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-pins-'));
    const store = createPinStore(join(dir, 'pins.json'));
    const key = generateOperatorKeyPair();
    store.revoke(key.keyId, 'lost laptop');
    assert.equal(store.isRevoked(key.keyId), true);
    assert.throws(() => store.pinFromRegistration(registrationPayload(key)), (error) => error.code === 'KEY_REVOKED');
  });

  it('refuses to read a corrupt pin store rather than trusting nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-pins-'));
    const file = join(dir, 'pins.json');
    writeFileSync(file, '{ not json', 'utf8');
    const store = createPinStore(file);
    assert.throws(() => store.load(), (error) => error.code === 'PINS_CORRUPT');
  });

  it('derives a stable key id from the public key', () => {
    const key = generateOperatorKeyPair();
    assert.equal(keyIdOf(key.publicKeyPem), key.keyId);
    assert.equal(key.keyId, keyIdOf(key.publicKeyPem));
  });
});

describe('maintenance runner', () => {
  let dirs;
  let keys;
  let pins;
  let executed;
  let store;

  beforeEach(() => {
    dirs = {
      queueDir: mkdtempSync(join(tmpdir(), 'w2m-q-')),
      doneDir: mkdtempSync(join(tmpdir(), 'w2m-d-')),
      claimedDir: mkdtempSync(join(tmpdir(), 'w2m-c-')),
      stateFile: join(mkdtempSync(join(tmpdir(), 'w2m-s-')), 'state.json'),
    };
    keys = generateOperatorKeyPair();
    store = createPinStore(join(mkdtempSync(join(tmpdir(), 'w2m-p-')), 'pins.json'));
    pins = { load: () => store.load(), isRevoked: (id) => store.isRevoked(id) };
    executed = [];
  });

  const enqueue = (request, name) => writeFileSync(join(dirs.queueDir, name ?? request.request_id + '.json'), JSON.stringify(request), 'utf8');

  it('executes a verified request exactly once and writes a result', async () => {
    store.pinFromRegistration(registrationPayload(keys));
    const request = signedDiag(keys);
    enqueue(request);
    const run = () => runOnce({ ...dirs, machineId: MACHINE, pinStore: pins, executeAction: async (action) => { executed.push(action); return { status: 'ok', detail: { sections: {} } }; }, now: () => NOW });
    await run();
    await run();
    assert.deepEqual(executed, ['diag']);
    const results = readdirSync(dirs.doneDir);
    assert.equal(results.length, 1);
    const result = JSON.parse(readFileSync(join(dirs.doneDir, results[0]), 'utf8'));
    assert.equal(result.status, 'ok');
    assert.equal(result.request_id, request.request_id);
  });

  it('refuses unsigned, wrongly signed and tampered requests with named codes', async () => {
    store.pinFromRegistration(registrationPayload(keys));
    const unsigned = buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW });
    enqueue(unsigned, 'unsigned.json');
    const tampered = { ...signedDiag(keys), params: { sections: ['disk'] } };
    enqueue(tampered, 'tampered.json');
    await runOnce({ ...dirs, machineId: MACHINE, pinStore: pins, executeAction: async () => { throw new Error('must not run'); }, now: () => NOW });
    const codes = readdirSync(dirs.doneDir).map((name) => JSON.parse(readFileSync(join(dirs.doneDir, name), 'utf8')).code).sort();
    assert.deepEqual(codes, ['MAINTENANCE_BAD_SIGNATURE', 'MAINTENANCE_MISSING_SIGNATURE']);
    assert.deepEqual(executed, []);
  });

  it('refuses everything when no operator key is pinned', async () => {
    enqueue(signedDiag(keys));
    await runOnce({ ...dirs, machineId: MACHINE, pinStore: pins, executeAction: async () => { throw new Error('must not run'); }, now: () => NOW });
    const result = JSON.parse(readFileSync(join(dirs.doneDir, readdirSync(dirs.doneDir)[0]), 'utf8'));
    assert.equal(result.code, 'MAINTENANCE_NO_PINNED_KEY');
  });

  it('turns an action exception into a failed result instead of a stuck request', async () => {
    store.pinFromRegistration(registrationPayload(keys));
    enqueue(signedDiag(keys));
    await runOnce({ ...dirs, machineId: MACHINE, pinStore: pins, executeAction: async () => { throw new Error('boom'); }, now: () => NOW });
    const result = JSON.parse(readFileSync(join(dirs.doneDir, readdirSync(dirs.doneDir)[0]), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'MAINTENANCE_ACTION_FAILED');
    assert.equal(existsSync(dirs.claimedDir), true);
  });
});
