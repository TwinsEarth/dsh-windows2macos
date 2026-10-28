/**
 * Operator Ed25519 key (v2 decisions 1 & 2).
 *
 * The key is generated once, stored as a 0600 PKCS#8 PEM under `~/.w2m/operator-key.pem`
 * (`W2M_OPERATOR_KEY_FILE` overrides), and used to sign plan approvals. The public key travels
 * with the approval; the private key never leaves this machine and is never logged.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function operatorKeyPath(env = process.env) {
  const explicit = typeof env.W2M_OPERATOR_KEY_FILE === 'string' ? env.W2M_OPERATOR_KEY_FILE.trim() : '';
  if (explicit !== '') return explicit;
  return join(homedir(), '.w2m', 'operator-key.pem');
}

export function keyIdOf(publicKeyPem) {
  return createHash('sha256').update(publicKeyPem, 'utf8').digest('hex').slice(0, 16);
}

/** The exact bytes that are signed: the approval body without its signature fields. */
export function approvalPayloadOf(body) {
  const { sig, approval_sha256: _ignored, operator_key: _key, ...rest } = body ?? {};
  return Buffer.from(JSON.stringify(rest), 'utf8');
}

export function signApprovalPayload(body, privateKey) {
  return sign(null, approvalPayloadOf(body), privateKey).toString('base64');
}

export function verifyApprovalPayload(body, signatureBase64, publicKeyPem) {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, approvalPayloadOf(body), key, Buffer.from(String(signatureBase64), 'base64'));
  } catch { return false; }
}

/** Load the existing key, or create one and write it 0600. */
export function ensureOperatorKey(options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? operatorKeyPath(env);
  if (existsSync(path)) {
    const loaded = loadOperatorKey({ path });
    return loaded.ok === true ? { ...loaded, created: false } : loaded;
  }
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows ACL */ }
    const loaded = loadOperatorKey({ path });
    return loaded.ok === true ? { ...loaded, created: true } : loaded;
  } catch (error) {
    return { ok: false, code: 'OPERATOR_KEY_CREATE_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function loadOperatorKey(options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? operatorKeyPath(env);
  if (!existsSync(path)) return { ok: false, code: 'OPERATOR_KEY_MISSING', path };
  try {
    const pem = readFileSync(path, 'utf8');
    const privateKey = createPrivateKey(pem);
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return { ok: true, path, privateKey, publicKeyPem, key_id: keyIdOf(publicKeyPem) };
  } catch (error) {
    return { ok: false, code: 'OPERATOR_KEY_UNREADABLE', path, detail: error instanceof Error ? error.message : String(error) };
  }
}
