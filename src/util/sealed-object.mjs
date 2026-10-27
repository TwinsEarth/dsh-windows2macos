/**
 * 数据面密封对象：压缩 → AES-256-GCM → X25519 封装内容密钥 → Ed25519 签名。
 * 顺序固定：compress → encrypt → sign；校验顺序固定：验签 → 解密 → 解压 → sha。
 * relay 永不接触明文、内容密钥或私钥。
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, verify as edVerify,
} from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';

// zstd landed in Node 22.15/23.8 while engines allow Node 20: feature-detect instead of importing
// the name, because a named ESM import of a missing export fails at link time on the older runtime.
const require = createRequire(import.meta.url);
let zstdCompressSync = null;
let zstdDecompressSync = null;
try {
  const zlib = require('node:zlib');
  if (typeof zlib.zstdCompressSync === 'function') {
    zstdCompressSync = zlib.zstdCompressSync;
    zstdDecompressSync = zlib.zstdDecompressSync;
  }
} catch { /* older Node: gzip only */ }

export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const COMPRESS_THRESHOLD = 4 * 1024;
export const MAX_RATIO = 100;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const aadOf = ({ taskId, plainSha256, sink }) => Buffer.from(taskId + '|' + plainSha256 + '|' + sink, 'utf8');

function compress(bytes) {
  if (bytes.length <= COMPRESS_THRESHOLD) return { alg: 'none', body: bytes };
  const zstd = typeof zstdCompressSync === 'function';
  try {
    const body = zstd ? zstdCompressSync(bytes) : gzipSync(bytes, { level: 6 });
    if (body.length >= bytes.length * 0.95) return { alg: 'none', body: bytes };
    return { alg: zstd ? 'zstd' : 'gzip', body };
  } catch {
    return { alg: 'none', body: bytes };
  }
}

function decompress(alg, body, declaredBytes) {
  if (alg === 'none') return body;
  const out = alg === 'zstd' ? zstdDecompressSync(body) : gunzipSync(body);
  if (out.length > declaredBytes) throw new Error('DECOMPRESSION_LIMIT');
  return out;
}

/** 生成接收方 X25519 密钥对（PEM）。 */
export function createRecipientKeys() {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 生成签名密钥对（Ed25519 PEM）。 */
export function createSigningKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * @param {{bytes: Buffer, taskId: string, sink: string, recipientPublicKeyPem: string, signerPrivateKeyPem: string, maxBytes?: number}} input
 */
export function sealObject(input) {
  const { bytes, taskId, sink, recipientPublicKeyPem, signerPrivateKeyPem } = input;
  const maxBytes = Number.isInteger(input.maxBytes) ? input.maxBytes : MAX_OBJECT_BYTES;
  if (!Buffer.isBuffer(bytes)) throw new Error('OBJECT_NOT_BYTES');
  if (bytes.length > maxBytes) throw new Error('OBJECT_TOO_LARGE');
  if (typeof taskId !== 'string' || taskId === '' || typeof sink !== 'string' || sink === '') throw new Error('OBJECT_META_INVALID');

  const plainSha256 = sha256(bytes);
  const zip = compress(bytes);
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const aad = aadOf({ taskId, plainSha256, sink });
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(zip.body), cipher.final()]);
  const tag = cipher.getAuthTag();

  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey(recipientPublicKeyPem) });
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.from(plainSha256.slice(0, 32), 'hex'), Buffer.from('w2m-sealed-v1', 'utf8'), 32));
  const wrapIv = randomBytes(12);
  const wrapCipher = createCipheriv('aes-256-gcm', kek, wrapIv);
  const wrapped = Buffer.concat([wrapCipher.update(cek), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  const signature = edSign(null, Buffer.from(plainSha256 + '|' + bytes.length + '|' + sink + '|' + taskId, 'utf8'), signerPrivateKeyPem);
  return {
    v: 1,
    alg: 'x25519-hkdf-sha256-aes-256-gcm-v1',
    comp: zip.alg,
    sink,
    task_id: taskId,
    plain: { sha256: plainSha256, bytes: bytes.length },
    cipher: { bytes: ciphertext.length + tag.length },
    aad_sha256: sha256(aad),
    epk: eph.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    wrap: { iv: wrapIv.toString('base64'), tag: wrapTag.toString('base64'), value: wrapped.toString('base64') },
    body: ciphertext.toString('base64'),
    sig: signature.toString('base64'),
  };
}

/** 验签 → 解封装 → 解密 → 解压 → sha 复核。 */
export function openObject(sealed, { recipientPrivateKeyPem, signerPublicKeyPem, maxBytes }) {
  const limit = Number.isInteger(maxBytes) ? maxBytes : MAX_OBJECT_BYTES;
  const expected = sealed?.plain?.sha256;
  if (typeof expected !== 'string') throw new Error('OBJECT_INVALID');
  const ok = edVerify(null, Buffer.from(expected + '|' + sealed.plain.bytes + '|' + sealed.sink + '|' + sealed.task_id, 'utf8'), signerPublicKeyPem, Buffer.from(sealed.sig, 'base64'));
  if (ok !== true) throw new Error('OBJECT_SIGNATURE_INVALID');
  if (sealed.plain.bytes > limit) throw new Error('OBJECT_TOO_LARGE');

  const aad = aadOf({ taskId: sealed.task_id, plainSha256: expected, sink: sealed.sink });
  const shared = diffieHellman({ privateKey: createPrivateKey(recipientPrivateKeyPem), publicKey: createPublicKey(sealed.epk) });
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.from(expected.slice(0, 32), 'hex'), Buffer.from('w2m-sealed-v1', 'utf8'), 32));
  const unwrap = createDecipheriv('aes-256-gcm', kek, Buffer.from(sealed.wrap.iv, 'base64'));
  unwrap.setAuthTag(Buffer.from(sealed.wrap.tag, 'base64'));
  const cek = Buffer.concat([unwrap.update(Buffer.from(sealed.wrap.value, 'base64')), unwrap.final()]);

  const decipher = createDecipheriv('aes-256-gcm', cek, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const zipBody = Buffer.concat([decipher.update(Buffer.from(sealed.body, 'base64')), decipher.final()]);
  const plain = decompress(sealed.comp, zipBody, sealed.plain.bytes);
  if (plain.length !== sealed.plain.bytes) throw new Error('OBJECT_SIZE_MISMATCH');
  if (sha256(plain) !== expected) throw new Error('OBJECT_HASH_MISMATCH');
  return { bytes: plain, sha256: expected };
}
