/** 密封对象单测：压缩→加密→签名，反序校验；篡改/换钥/超限/炸弹均拒绝。 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { createRecipientKeys, createSigningKeys, openObject, sealObject } from '../src/util/sealed-object.mjs';

const recipient = createRecipientKeys();
const signer = createSigningKeys();

const seal = (bytes, over = {}) => sealObject({
  bytes, taskId: 'task-1', sink: 'github',
  recipientPublicKeyPem: recipient.publicKeyPem,
  signerPrivateKeyPem: signer.privateKeyPem,
  ...over,
});

const open = (sealed, over = {}) => openObject(sealed, {
  recipientPrivateKeyPem: recipient.privateKeyPem,
  signerPublicKeyPem: signer.publicKeyPem,
  ...over,
});

describe('密封对象：顺序与往返', () => {
  it('小对象不压缩，往返一致', () => {
    const bytes = Buffer.from('hello joint dev');
    const sealed = seal(bytes);
    assert.equal(sealed.comp, 'none');
    assert.equal(sealed.alg, 'x25519-hkdf-sha256-aes-256-gcm-v1');
    assert.deepEqual(open(sealed).bytes, bytes);
  });
  it('大文本压缩后往返一致（zstd 或 gzip）', () => {
    const bytes = Buffer.from(randomBytes(100 * 1024).toString('hex'));
    const sealed = seal(bytes);
    assert.notEqual(sealed.comp, 'none');
    assert.ok(sealed.body.length < bytes.length);
    assert.deepEqual(open(sealed).bytes, bytes);
  });
  it('AAD 绑定 task/sink：换 task_id 解密失败', () => {
    const sealed = seal(Buffer.from('x'.repeat(100)));
    const tampered = { ...sealed, task_id: 'task-2' };
    assert.throws(() => open(tampered), /OBJECT_SIGNATURE_INVALID/);
  });
});

describe('完整性', () => {
  it('篡改密文 → AEAD 失败', () => {
    const sealed = seal(Buffer.from('payload'));
    const body = Buffer.from(sealed.body, 'base64');
    body[0] ^= 0xff;
    assert.throws(() => open({ ...sealed, body: body.toString('base64') }), /./);
  });
  it('篡改签名 → OBJECT_SIGNATURE_INVALID', () => {
    const sealed = seal(Buffer.from('payload'));
    assert.throws(() => open({ ...sealed, sig: Buffer.alloc(64, 1).toString('base64') }), /OBJECT_SIGNATURE_INVALID/);
  });
  it('错误接收方私钥 → 解封装失败', () => {
    const sealed = seal(Buffer.from('payload'));
    const other = createRecipientKeys();
    assert.throws(() => open(sealed, { recipientPrivateKeyPem: other.privateKeyPem }), /./);
  });
});

describe('限额', () => {
  it('超过对象上限 → OBJECT_TOO_LARGE', () => {
    assert.throws(() => seal(Buffer.from('x'), { maxBytes: 0 }), /OBJECT_TOO_LARGE/);
  });
  it('伪造超大声明 → 解压前拒绝', () => {
    const sealed = seal(Buffer.from('A'.repeat(10 * 1024)));
    const forged = { ...sealed, plain: { ...sealed.plain, bytes: 64 * 1024 * 1024 } };
    assert.throws(() => open(forged), /OBJECT_SIGNATURE_INVALID/);
  });
});
