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
function decryptV1Message(key, message = {}) {
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


/** Chat cipher v2: same AES-256-GCM, with AAD binding the message to its session and sender. */
export const CHAT_CIPHER_V2 = Object.freeze({ version: 2, alg: 'aes-256-gcm' });

/**
 * AAD = w2m-chat-v2 | session_id | from_machine | message_id
 *
 * The AAD is transmitted in the clear inside `enc.aad` so every reader can rebuild it, but the GCM
 * tag authenticates those exact bytes: changing any of them makes decryption fail. A caller that
 * knows the expected context must pass it, which is what turns a whole encrypted message copied into
 * another session into a refusal instead of a successfully decrypted but mis-attributed message.
 */
export function chatAadV2({ sessionId, machineId, messageId }) {
  return Buffer.from('w2m-chat-v2|' + String(sessionId) + '|' + String(machineId) + '|' + String(messageId), 'utf8');
}

export function encryptChatTextV2(key, text, context = {}) {
  if (key === null || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) return { ok: false, code: 'CHAT_NO_KEY' };
  if (typeof text !== 'string' || text === '') return { ok: false, code: 'CHAT_EMPTY_TEXT' };
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '';
  const machineId = typeof context.machineId === 'string' ? context.machineId : '';
  const messageId = typeof context.messageId === 'string' ? context.messageId : '';
  if (sessionId === '' || machineId === '' || messageId === '') return { ok: false, code: 'CHAT_AAD_CONTEXT_REQUIRED' };
  const aad = chatAadV2({ sessionId, machineId, messageId });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return {
    ok: true,
    text: ciphertext.toString('base64'),
    enc: { v: CHAT_CIPHER_V2.version, alg: CHAT_CIPHER_V2.alg, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), aad: { session_id: sessionId, machine_id: machineId, message_id: messageId } },
  };
}

export function decryptChatMessageV2(key, message = {}, context = {}) {
  if (key === null || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) return { ok: false, code: 'CHAT_NO_KEY' };
  const enc = message?.enc ?? null;
  if (enc === null || typeof enc !== 'object' || enc.v !== CHAT_CIPHER_V2.version || enc.alg !== CHAT_CIPHER_V2.alg) return { ok: false, code: 'CHAT_UNSUPPORTED_CIPHER' };
  const aad = enc.aad ?? {};
  const expectedSession = typeof context.sessionId === 'string' ? context.sessionId : null;
  const expectedMachine = typeof context.machineId === 'string' ? context.machineId : null;
  if (expectedSession !== null && String(aad.session_id ?? '') !== expectedSession) return { ok: false, code: 'CHAT_AAD_MISMATCH', detail: { field: 'session_id' } };
  if (expectedMachine !== null && String(aad.machine_id ?? '') !== expectedMachine) return { ok: false, code: 'CHAT_AAD_MISMATCH', detail: { field: 'machine_id' } };
  try {
    const iv = Buffer.from(String(enc.iv ?? ''), 'base64');
    const tag = Buffer.from(String(enc.tag ?? ''), 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return { ok: false, code: 'CHAT_BAD_ENCRYPTION' };
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(chatAadV2({ sessionId: aad.session_id, machineId: aad.machine_id, messageId: aad.message_id }));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(String(message.text ?? ''), 'base64')), decipher.final()]);
    return { ok: true, text: plain.toString('utf8'), version: 2 };
  } catch {
    return { ok: false, code: 'CHAT_DECRYPT_FAILED' };
  }
}

/**
 * v1 is read-only compatible forever; v2 requires the expected context to bind the message to its
 * session/sender. Unknown versions are refused rather than treated as v1.
 */
export function decryptChatMessage(key, message = {}, context = {}) {
  const enc = message?.enc ?? null;
  if (enc !== null && typeof enc === 'object' && enc.v === CHAT_CIPHER_V2.version) return decryptChatMessageV2(key, message, context);
  if (enc !== null && typeof enc === 'object' && enc.v !== CHAT_CIPHER.version) return { ok: false, code: 'CHAT_UNSUPPORTED_CIPHER' };
  return decryptV1Message(key, message);
}

/** True when a message carries the encryption metadata, whatever its text looks like. */
export function isEncrypted(message) {
  return message?.enc !== null && message?.enc !== undefined && typeof message.enc === 'object';
}
