/**
 * Operator signing keys: generation, pinning and rotation for the maintenance channel (M1, v1.3.2-beta).
 *
 * The operator key is the only thing that can authorise a maintenance action, so it must not be the same credential as
 * the operator token used to dispatch tasks: a leaked dispatch token should not become a leaked authorisation.
 *
 * Target machines pin the operator public key. First contact is trust-on-first-use (the relay hands out the registered
 * key), and every later change must be signed by the currently pinned key — the rotation chain. That turns a key swap
 * from a silent event into a refusal unless the previous key authorised it.
 */
import { createHash, generateKeyPairSync, sign as signBytes, verify as verifyBytes, createPublicKey, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const OPERATOR_ROTATION_PROTOCOL = 'w2m-operator-rotation/v1';

export class OperatorKeyError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'OperatorKeyError';
    this.code = code;
    this.detail = detail;
  }
}

export function keyIdOf(publicKeyLike) {
  const key = publicKeyLike?.type === 'public' ? publicKeyLike : createPublicKey(publicKeyLike);
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** Create a fresh Ed25519 operator key pair. The caller is responsible for storing the private half safely. */
export function generateOperatorKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId: keyIdOf(publicKey),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function publicKeyPemOf(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

/** What the control side sends to the relay so paired machines can pin the key. It is not a secret. */
export function registrationPayload(keyPair, nowIso = new Date().toISOString()) {
  return {
    protocol: 'w2m-operator-key/v1',
    key_id: keyPair.keyId,
    public_key_pem: keyPair.publicKeyPem,
    created_at: nowIso,
  };
}

/** The exact bytes signed when rotating to a new key. */
export function rotationPayload({ oldKeyId, newKeyId, newPublicKeyPem }) {
  return JSON.stringify({ protocol: OPERATOR_ROTATION_PROTOCOL, old_key_id: oldKeyId, new_key_id: newKeyId, new_public_key_pem: newPublicKeyPem });
}

/**
 * A target machine's pin store. One file, atomically replaced; the whole lifecycle (pin, rotate, revoke) is expressed
 * here so the runner never touches the file format directly.
 */
export function createPinStore(filePath, { now = () => Date.now() } = {}) {
  const empty = () => ({ protocol: 'w2m-operator-pins/v1', pinned: null, revoked: [], history: [] });
  const load = () => {
    if (!existsSync(filePath)) return empty();
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return {
        protocol: 'w2m-operator-pins/v1',
        pinned: parsed.pinned ?? null,
        revoked: Array.isArray(parsed.revoked) ? parsed.revoked : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch {
      // A corrupt pin file must not be silently replaced: refusing is the only safe reading of "I cannot tell which key
      // is trusted". The runner reports this as a failure rather than continuing with an empty pin.
      throw new OperatorKeyError('PINS_CORRUPT', 'operator pin store is unreadable; refusing to trust any key');
    }
  };
  const save = (state) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  };
  const isRevoked = (keyId) => {
    const state = load();
    return state.revoked.some((entry) => entry.key_id === keyId);
  };
  return {
    filePath,
    load,
    isRevoked,
    /**
     * Pin a key after checking a registration payload. First pin is TOFU; a different pinned key requires rotation.
     */
    pinFromRegistration(payload) {
      if (payload === null || typeof payload !== 'object' || typeof payload.public_key_pem !== 'string') {
        throw new OperatorKeyError('BAD_REGISTRATION', 'operator registration payload is malformed');
      }
      const keyId = keyIdOf(payload.public_key_pem);
      if (typeof payload.key_id === 'string' && payload.key_id !== keyId) {
        throw new OperatorKeyError('KEY_ID_MISMATCH', 'registration key_id does not match its public key', { claimed: payload.key_id, computed: keyId });
      }
      if (this.isRevoked(keyId)) throw new OperatorKeyError('KEY_REVOKED', 'operator key is revoked', { key_id: keyId });
      const state = load();
      if (state.pinned === null) {
        state.pinned = { key_id: keyId, public_key_pem: payload.public_key_pem, pinned_at: new Date(now()).toISOString(), rotation_of: null };
        state.history.push({ event: 'pinned', key_id: keyId, at: state.pinned.pinned_at });
        save(state);
        return { ok: true, pinned: state.pinned, firstContact: true };
      }
      if (state.pinned.key_id === keyId) return { ok: true, pinned: state.pinned, firstContact: false };
      throw new OperatorKeyError('ROTATION_REQUIRED', 'a different operator key is already pinned; sign a rotation with the pinned key', { pinned: state.pinned.key_id, offered: keyId });
    },
    /** Apply a rotation that was signed by the currently pinned key. */
    rotate({ newPublicKeyPem, signatureBase64 }) {
      const state = load();
      if (state.pinned === null) throw new OperatorKeyError('NO_PINNED_KEY', 'nothing is pinned yet; rotation is not possible');
      const newKeyId = keyIdOf(newPublicKeyPem);
      if (this.isRevoked(newKeyId)) throw new OperatorKeyError('KEY_REVOKED', 'new operator key is revoked', { key_id: newKeyId });
      const oldKey = createPublicKey(state.pinned.public_key_pem);
      const payload = rotationPayload({ oldKeyId: state.pinned.key_id, newKeyId, newPublicKeyPem });
      const ok = verifyBytes(null, Buffer.from(payload, 'utf8'), oldKey, Buffer.from(String(signatureBase64 ?? ''), 'base64'));
      if (ok !== true) throw new OperatorKeyError('ROTATION_BAD_SIGNATURE', 'rotation was not signed by the currently pinned key');
      state.history.push({ event: 'rotated', from: state.pinned.key_id, to: newKeyId, at: new Date(now()).toISOString() });
      state.pinned = { key_id: newKeyId, public_key_pem: newPublicKeyPem, pinned_at: new Date(now()).toISOString(), rotation_of: state.pinned.key_id };
      save(state);
      return { ok: true, pinned: state.pinned };
    },
    revoke(keyId, reason) {
      const state = load();
      if (!state.revoked.some((entry) => entry.key_id === keyId)) {
        state.revoked.push({ key_id: keyId, reason: String(reason ?? 'unspecified'), at: new Date(now()).toISOString() });
        save(state);
      }
      return { ok: true, key_id: keyId };
    },
  };
}

/** Sign a rotation payload with the old private key (control-side helper). */
export function signRotation({ oldPrivateKeyPem, oldKeyId, newPublicKeyPem }) {
  const oldKey = createPrivateKey(oldPrivateKeyPem);
  const newKeyId = keyIdOf(newPublicKeyPem);
  const payload = rotationPayload({ oldKeyId, newKeyId, newPublicKeyPem });
  const signature = signBytes(null, Buffer.from(payload, 'utf8'), oldKey);
  return { newKeyId, signatureBase64: signature.toString('base64') };
}
