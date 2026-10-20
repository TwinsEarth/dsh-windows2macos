/**
 * The fleet chat's end-to-end encryption.
 *
 * ## Why the relay never sees the key
 *
 * The group key is HKDF over the fleet key, and the fleet key is derived from the account identity on each machine -- it never
 * travels to the relay. So the relay stores ciphertext it cannot open, and the honest consequence is written down rather than
 * discovered later: the relay cannot search message content, and the quota it enforces is measured on ciphertext length.
 *
 * ## Why the metadata is next to the ciphertext, not inside it
 *
 * `{v, alg, iv, tag}` has to be readable by every client of every version, including one that cannot decrypt. Keeping it in a
 * plain field means a reader can say "encrypted with aes-256-gcm, version 1" even when it has no key, instead of guessing from
 * random-looking text.
 *
 * ## Backward compatibility, both directions
 *
 * A message with no `enc` field is plaintext and stays readable. A reader with no key keeps the ciphertext and marks it
 * `encrypted: true` rather than throwing: an unreadable message must not break a whole page.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const CHAT_CIPHER = Object.freeze({ version: 1, alg: 'aes-256-gcm' });
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Turn the fleet key into the chat group key. Deterministic: every machine in the fleet derives the same key from the same
 * fleet key, which is what makes a message encrypted on one machine readable on another.
 *
 * @param {string} fleetKey base64 (the usual shape) or a passphrase
 * @returns {Buffer|null}
 */
export function deriveChatKey(fleetKey) {
  if (typeof fleetKey !== 'string' || fleetKey.trim() === '') return null;
  try {
    let material = null;
    try {
      const decoded = Buffer.from(fleetKey.trim(), 'base64');
      material = decoded.length >= 16 ? decoded : Buffer.from(fleetKey.trim(), 'utf8');
    } catch {
      material = Buffer.from(fleetKey.trim(), 'utf8');
    }
    return Buffer.from(hkdfSync('sha256', material, Buffer.from('w2m-fleet-chat-salt'), Buffer.from('fleet-chat-v1'), KEY_BYTES));
  } catch {
    return null;
  }
}

/**
 * @param {Buffer|null} key
 * @param {string} text
 * @returns {{ok: true, text: string, enc: {v: number, alg: string, iv: string, tag: string}} | {ok: false, code: string}}
 */
export function encryptChatText(key, text) {
  if (key === null || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) return { ok: false, code: 'CHAT_NO_KEY' };
  if (typeof text !== 'string' || text === '') return { ok: false, code: 'CHAT_EMPTY_TEXT' };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ok: true,
    text: ciphertext.toString('base64'),
    enc: { v: CHAT_CIPHER.version, alg: CHAT_CIPHER.alg, iv: iv.toString('base64'), tag: tag.toString('base64') },
  };
}

/**
 * @param {Buffer|null} key
 * @param {{text?: string, enc?: object|null}} message
 * @returns {{ok: true, text: string} | {ok: false, code: string}}
 */
export function decryptChatMessage(key, message = {}) {
  const enc = message?.enc ?? null;
  if (enc === null || enc === undefined) {
    // Plaintext: the pre-encryption shape, still readable by everyone.
    return typeof message?.text === 'string' ? { ok: true, text: message.text } : { ok: false, code: 'CHAT_TEXT_MISSING' };
  }
  if (key === null || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) return { ok: false, code: 'CHAT_NO_KEY' };
  if (enc.alg !== CHAT_CIPHER.alg || enc.v !== CHAT_CIPHER.version) return { ok: false, code: 'CHAT_UNSUPPORTED_CIPHER' };
  try {
    const iv = Buffer.from(String(enc.iv ?? ''), 'base64');
    const tag = Buffer.from(String(enc.tag ?? ''), 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return { ok: false, code: 'CHAT_BAD_ENCRYPTION' };
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(String(message.text ?? ''), 'base64')), decipher.final()]);
    return { ok: true, text: plain.toString('utf8') };
  } catch {
    return { ok: false, code: 'CHAT_DECRYPT_FAILED' };
  }
}

/** True when a message carries the encryption metadata, whatever its text looks like. */
export function isEncrypted(message) {
  return message?.enc !== null && message?.enc !== undefined && typeof message.enc === 'object';
}
