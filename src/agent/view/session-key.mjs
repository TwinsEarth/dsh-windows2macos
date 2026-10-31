/**
 * P1.5 view-session keys (VK).
 *
 * Ephemeral X25519 per session; both sides mix the shared secret with the two
 * sorted public keys, so viewer and target derive the same 32-byte key without
 * a static device key being reused for media. Frames are AES-256-GCM sealed;
 * the relay only ever sees the base64 ciphertext.
 */
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

export const VIEW_VK_LABEL = 'w2m-remote-view v1 session';
export const VIEW_VK_SALT = 'w2m-remote-view v1 salt';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function ephemeral() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI_PREFIX.length);
  return { privateKey, publicKeyB64: raw.toString('base64') };
}

function peerPublic(raw) {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function deriveKey(shared, publicA, publicB) {
  const [first, second] = [publicA, publicB].sort();
  return Buffer.from(hkdfSync('sha256', Buffer.from(shared), Buffer.from(VIEW_VK_SALT), Buffer.from(VIEW_VK_LABEL + '|' + first + '|' + second), 32));
}

/** One side's ephemeral keypair plus the public key to put in the signal. */
export function createViewSide() {
  const eph = ephemeral();
  const publicKey = eph.publicKeyB64;
  return {
    public_key: publicKey,
    /** @param {string} peerPublicKey base64 X25519 public key from the peer */
    finish(peerPublicKey) {
      if (typeof peerPublicKey !== 'string' || peerPublicKey === '') throw new Error('VIEW_VK_BAD_PEER_KEY');
      const peer = Buffer.from(peerPublicKey, 'base64');
      if (peer.length !== 32) throw new Error('VIEW_VK_BAD_PEER_KEY');
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: peerPublic(peer) });
      return { key: deriveKey(shared, publicKey, peerPublicKey), public_key: publicKey };
    },
  };
}

export function sealViewFrame(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('VIEW_VK_BAD_KEY');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('w2m-remote-view/frame'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64');
}

export function openViewFrame(key, encoded) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('VIEW_VK_BAD_KEY');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < 28) throw new Error('VIEW_VK_BAD_FRAME');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('w2m-remote-view/frame'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}
