/**
 * Fleet chat encryption: same key on two machines, ciphertext the pair can open, plaintext still readable, tampering refused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decryptChatMessage, deriveChatKey, encryptChatText, isEncrypted } from '../src/util/chat-crypto.mjs';

const FLEET_KEY = Buffer.from('a-shared-fleet-key-of-at-least-32-bytes!').toString('base64');

describe('deriveChatKey', () => {
  it('is deterministic on every machine with the same fleet key', () => {
    const a = deriveChatKey(FLEET_KEY);
    const b = deriveChatKey(FLEET_KEY);
    assert.ok(Buffer.isBuffer(a));
    assert.equal(a.length, 32);
    assert.deepEqual(a, b, 'two machines must derive the same group key');
  });

  it('produces a different key for a different fleet', () => {
    const other = deriveChatKey(Buffer.from('another fleet key entirely 32bytes!!').toString('base64'));
    assert.notDeepEqual(deriveChatKey(FLEET_KEY), other);
  });

  it('refuses empty input', () => {
    assert.equal(deriveChatKey(''), null);
    assert.equal(deriveChatKey(null), null);
  });
});

describe('encrypt and decrypt', () => {
  it('round-trips text with a fresh IV each time', () => {
    const key = deriveChatKey(FLEET_KEY);
    const one = encryptChatText(key, 'hello fleet');
    const two = encryptChatText(key, 'hello fleet');
    assert.equal(one.ok, true);
    assert.equal(one.text === two.text, false, 'GCM needs a fresh IV, so ciphertext differs');
    assert.equal(isEncrypted(one), true);
    assert.deepEqual(decryptChatMessage(key, one), { ok: true, text: 'hello fleet' });
    assert.deepEqual(decryptChatMessage(deriveChatKey(FLEET_KEY), two), { ok: true, text: 'hello fleet' });
  });

  it('refuses to encrypt without a key or without text', () => {
    assert.equal(encryptChatText(null, 'x').code, 'CHAT_NO_KEY');
    assert.equal(encryptChatText(deriveChatKey(FLEET_KEY), '').code, 'CHAT_EMPTY_TEXT');
  });

  it('reads plaintext messages unchanged (backward compatibility)', () => {
    assert.deepEqual(decryptChatMessage(deriveChatKey(FLEET_KEY), { text: 'plain old message' }), { ok: true, text: 'plain old message' });
    assert.deepEqual(decryptChatMessage(null, { text: 'plain' }), { ok: true, text: 'plain' }, 'a reader with no key still reads plaintext');
  });

  it('reports no-key, unsupported cipher and tampering as values', () => {
    const key = deriveChatKey(FLEET_KEY);
    const encrypted = encryptChatText(key, 'secret');
    assert.equal(decryptChatMessage(null, encrypted).code, 'CHAT_NO_KEY');
    assert.equal(decryptChatMessage(key, { ...encrypted, enc: { ...encrypted.enc, alg: 'rot13' } }).code, 'CHAT_UNSUPPORTED_CIPHER');
    const tampered = { ...encrypted, text: Buffer.from('tampered', 'utf8').toString('base64') };
    assert.equal(decryptChatMessage(key, tampered).code, 'CHAT_DECRYPT_FAILED');
  });

  it('refuses a malformed iv or tag instead of trying', () => {
    const key = deriveChatKey(FLEET_KEY);
    const encrypted = encryptChatText(key, 'x');
    assert.equal(decryptChatMessage(key, { ...encrypted, enc: { ...encrypted.enc, iv: 'AAAA' } }).code, 'CHAT_BAD_ENCRYPTION');
    assert.equal(decryptChatMessage(key, { ...encrypted, enc: { ...encrypted.enc, tag: 'AAAA' } }).code, 'CHAT_BAD_ENCRYPTION');
  });
});
