/**
 * A7/S2: chat AEAD v2 binds the ciphertext to its session and sender via AAD.
 *
 * v1 stays readable forever (read-only compatibility); the v2 path refuses a whole message copied
 * into another session instead of decrypting it with the wrong attribution.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHAT_CIPHER,
  CHAT_CIPHER_V2,
  decryptChatMessage,
  deriveChatKey,
  encryptChatText,
  encryptChatTextV2,
} from '../src/util/chat-crypto.mjs';

const key = deriveChatKey('fleet-key-for-aad-tests');
const ctx = { sessionId: 's-1', machineId: 'm-1', messageId: 'msg-1' };

describe('chat AEAD v2', () => {
  it('round-trips with the expected context', () => {
    const encrypted = encryptChatTextV2(key, 'hello fleet', ctx);
    assert.equal(encrypted.ok, true, encrypted.code);
    assert.equal(encrypted.enc.v, CHAT_CIPHER_V2.version);
    const decrypted = decryptChatMessage(key, encrypted, ctx);
    assert.equal(decrypted.ok, true, decrypted.code);
    assert.equal(decrypted.text, 'hello fleet');
  });

  it('refuses a message replayed into another session or sender', () => {
    const encrypted = encryptChatTextV2(key, 'hello fleet', ctx);
    const otherSession = decryptChatMessage(key, encrypted, { ...ctx, sessionId: 's-2' });
    assert.equal(otherSession.ok, false);
    assert.equal(otherSession.code, 'CHAT_AAD_MISMATCH');
    assert.equal(otherSession.detail.field, 'session_id');
    const otherMachine = decryptChatMessage(key, encrypted, { ...ctx, machineId: 'm-2' });
    assert.equal(otherMachine.code, 'CHAT_AAD_MISMATCH');
  });

  it('fails when any ciphertext metadata is tampered with', () => {
    const encrypted = encryptChatTextV2(key, 'hello fleet', ctx);
    const badTag = { ...encrypted, enc: { ...encrypted.enc, tag: Buffer.alloc(16).toString('base64') } };
    assert.equal(decryptChatMessage(key, badTag, ctx).ok, false);
    const movedAad = { ...encrypted, enc: { ...encrypted.enc, aad: { ...encrypted.enc.aad, session_id: 's-2' } } };
    // The caller's expected context no longer matches the (tampered) clear AAD.
    assert.equal(decryptChatMessage(key, movedAad, ctx).code, 'CHAT_AAD_MISMATCH');
    // ...and without caller context the GCM tag itself rejects the change.
    assert.equal(decryptChatMessage(key, movedAad).ok, false);
  });

  it('requires context to encrypt and refuses an unknown version', () => {
    assert.equal(encryptChatTextV2(key, 'x', {}).code, 'CHAT_AAD_CONTEXT_REQUIRED');
    const unknown = { text: 'AAAA', enc: { v: 3, alg: 'aes-256-gcm', iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' } };
    assert.equal(decryptChatMessage(key, unknown).code, 'CHAT_UNSUPPORTED_CIPHER');
  });

  it('keeps v1 messages readable (read-only compatibility)', () => {
    const v1 = encryptChatText(key, 'legacy message');
    assert.equal(v1.ok, true);
    assert.equal(v1.enc.v, CHAT_CIPHER.version);
    const read = decryptChatMessage(key, v1);
    assert.equal(read.ok, true);
    assert.equal(read.text, 'legacy message');
    // v2 decrypt expects AAD; a v1 message has no enc.aad and must not be routed through v2.
    assert.equal(decryptChatMessage(key, v1, ctx).ok, true);
  });
});
