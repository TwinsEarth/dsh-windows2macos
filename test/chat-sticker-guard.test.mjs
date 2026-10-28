/** v1.9.18: chat is text plus slash commands; image payloads never enter the relay. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFleetMessages } from '../src/relay/fleet-messages.mjs';

const chat = () => createFleetMessages({ now: () => 1_700_000_000_000 });
const msg = (text, extra = {}) => ({ session_id: 's-1', machine_id: 'm-1', text, ...extra });

describe('chat text-only guard', () => {
  it('accepts slash commands as plain text', () => {
    const store = chat();
    const posted = store.post(msg('/微笑'));
    assert.equal(posted.ok, true, posted.code);
    assert.equal(posted.message.bytes, 7);
    assert.equal(store.list({ session_id: 's-1' }).messages[0].text, '/微笑');
  });

  it('refuses a data: image URI in the text', () => {
    const store = chat();
    const posted = store.post(msg('data:image/png;base64,AAAA'));
    assert.equal(posted.ok, false);
    assert.equal(posted.code, 'TEXT_IMAGE_FORBIDDEN');
    assert.equal(store.list({ session_id: 's-1' }).count, 0);
  });

  it('refuses a markdown image embed', () => {
    const posted = chat().post(msg('look ![x](https://example.test/a.png)'));
    assert.equal(posted.ok, false);
    assert.equal(posted.code, 'TEXT_IMAGE_FORBIDDEN');
  });

  it('refuses a large base64 block that decodes to a PNG', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString('base64');
    const posted = chat().post(msg(png));
    assert.equal(posted.ok, false);
    assert.equal(posted.code, 'TEXT_BINARY_FORBIDDEN');
  });

  it('refuses media fields on the message body', () => {
    const posted = chat().post(msg('hi', { image: 'x' }));
    assert.equal(posted.ok, false);
    assert.equal(posted.code, 'CHAT_FIELD_FORBIDDEN');
    assert.equal(posted.detail.field, 'image');
  });

  it('does not inspect ciphertext: encrypted text is base64 by design', () => {
    const cipher = Buffer.alloc(400, 7).toString('base64');
    const posted = chat().post(msg(cipher, { enc: { v: 1, alg: 'aes-256-gcm', iv: 'aa', tag: 'bb' } }));
    assert.equal(posted.ok, true, posted.code);
    assert.equal(posted.message.enc.alg, 'aes-256-gcm');
  });
});
