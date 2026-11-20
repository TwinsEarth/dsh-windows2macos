/**
 * Chunked sealed format v2 for `old/` full copies (P2/O1) and verify's chunk-by-chunk reader (P2/O2).
 *
 * The format's whole reason to exist is a **memory** property, so this suite tests three things and refuses to
 * conflate them:
 *
 *   1. **Byte layout and roundtrip** -- magic, plaintext header, `nonce | ciphertext | tag` records, the AAD string,
 *      the default/ceiling chunk sizes, and every plaintext length class (0 bytes, 1 byte, an exact multiple of the
 *      chunk size, a partial last chunk).
 *   2. **Refusals are named, never averaged away** -- a flipped ciphertext byte is `AUTH_FAILED`, a short file is
 *      `TRUNCATED`, a swapped or duplicated record is `ORDER`, a broken header/magic/version is `HEADER_INVALID`, and
 *      the identity in the AAD is what makes "this copy belongs to another version" provable.
 *   3. **The peak is one chunk** -- a 32 MiB copy is sealed and re-opened in a child process capped at a 64 MiB V8
 *      heap, and the child reports the largest record it held. That number is the streaming evidence; the file's
 *      size never appears in it.
 *
 * The last group is the integration half: a repository with a real `oldFormat: 'full'` record is converted to a v2
 * copy, verified (still `old_copies: {checked, ok, failed, missing}` and still `BACKUP_VERIFY_OLD_COPY_FAILED` on
 * damage), and the untouched v1 copy is verified the old way -- including the v1-only size bound, so "v1 behaves
 * exactly as before" is asserted rather than assumed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHUNKED_AAD_PREFIX,
  CHUNKED_CODES,
  CHUNKED_FORMAT,
  CHUNKED_MAGIC,
  DEFAULT_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  chunkedAad,
  isChunkedV2,
  measureChunkedFile,
  openChunkedBuffer,
  openChunkedStream,
  resolveChunkBytes,
  sealChunked,
  sealChunkedToFile,
  sealChunkedToSink,
} from '../src/backup/chunked.mjs';
import { OLD_COPY_KIND, randomDek, sealObject } from '../src/backup/crypto.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import { openRepoKey } from '../src/backup/keystore.mjs';
import { rebuildFile } from '../src/backup/materialize.mjs';
import { framesFor, header, runtimeValidHome, tempDir } from './helpers/backup-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNKED_MODULE = pathToFileURL(path.join(ROOT, 'src', 'backup', 'chunked.mjs')).href;
const CRYPTO_MODULE = pathToFileURL(path.join(ROOT, 'src', 'backup', 'crypto.mjs')).href;
const SESSION = 'session-aaaaaaaa-0001';
const WORKSPACE = '--E-GPT--';

/** A deterministic plaintext of `size` bytes (the pattern matters only for tamper tests). */
function plaintextOf(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

/** The sha256 of a buffer as lowercase hex. */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Seal a deterministic plaintext and return both the bytes and the identity they were sealed under. */
function sealedFor(size, chunkBytes, dek = randomDek()) {
  const plaintext = plaintextOf(size);
  const sha256 = sha256Hex(plaintext);
  const sealed = sealChunked(plaintext, { dek, sha256, size, chunkBytes });
  return { plaintext, sha256, sealed, dek, chunkBytes, size };
}

/** The offset just past the newline-terminated header (the magic is asserted, so a bad fixture fails loudly). */
function headerEndOf(sealed) {
  assert.ok(sealed.subarray(0, CHUNKED_MAGIC.length).equals(CHUNKED_MAGIC), 'the fixture must start with the v2 magic');
  const found = sealed.indexOf(0x0a, CHUNKED_MAGIC.length);
  assert.ok(found !== -1, 'the fixture must carry a newline-terminated header');
  return found + 1;
}

/** Every record's byte range, given equal-length chunks (the fixtures below use full chunks throughout). */
function recordRange(sealed, index, chunkBytes) {
  const recordLength = 12 + chunkBytes + 16;
  const start = headerEndOf(sealed) + recordLength * index;
  return { start, end: start + recordLength, length: recordLength };
}

/** Run `fn` and return the named code it refused with; fail if it does not throw. */
function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code ?? null;
  }
  assert.fail('expected a named refusal, but the operation succeeded');
  return null;
}

/** Replace the header of a sealed buffer with another JSON object, keeping the rest of the file intact. */
function withHeader(sealed, mutate) {
  const end = headerEndOf(sealed);
  const parsed = JSON.parse(sealed.subarray(CHUNKED_MAGIC.length, end - 1).toString('utf8'));
  const next = mutate({ ...parsed });
  const header = Buffer.from(`${JSON.stringify(next)}\n`, 'utf8');
  return { sealed: Buffer.concat([sealed.subarray(0, CHUNKED_MAGIC.length), header, sealed.subarray(end)]), header };
}

/** Swap two equal-length records in place. */
function withRecordsSwapped(sealed, first, second, chunkBytes) {
  const swapped = Buffer.from(sealed);
  const a = recordRange(swapped, first, chunkBytes);
  const b = recordRange(swapped, second, chunkBytes);
  const aBytes = Buffer.from(swapped.subarray(a.start, a.end));
  const bBytes = Buffer.from(swapped.subarray(b.start, b.end));
  bBytes.copy(swapped, a.start);
  aBytes.copy(swapped, b.start);
  return swapped;
}

describe('chunked v2: byte layout', () => {
  it('declares the format the plan proposed, and a default 4 MiB chunk with a 16 MiB ceiling', () => {
    assert.equal(CHUNKED_MAGIC.length, 8);
    assert.equal(CHUNKED_MAGIC.toString('ascii'), 'W2MOLD2\n');
    assert.equal(CHUNKED_FORMAT, 'chunked-v2');
    assert.equal(DEFAULT_CHUNK_BYTES, 4 * 1024 * 1024);
    assert.equal(MAX_CHUNK_BYTES, 16 * 1024 * 1024);
    assert.equal(CHUNKED_AAD_PREFIX, 'w2m-session-backup/old-chunked');
    assert.deepEqual(Object.keys(CHUNKED_CODES).sort(), [
      'ARGUMENT_INVALID',
      'AUTH_FAILED',
      'HEADER_INVALID',
      'ORDER',
      'READ_FAILED',
      'TRAILING',
      'TRUNCATED',
      'WRITE_FAILED',
    ]);
  });

  it('writes magic | plaintext header | one record per chunk, with the header naming the plaintext identity', () => {
    const { sealed, plaintext, sha256, dek, chunkBytes, size } = sealedFor(3 * 64 + 17, 64);
    assert.ok(sealed.subarray(0, 8).equals(Buffer.from('W2MOLD2\n', 'ascii')), 'the first 8 bytes are the magic');
    const end = headerEndOf(sealed);
    assert.equal(sealed[end - 1], 0x0a, 'the header is newline terminated');
    const parsed = JSON.parse(sealed.subarray(8, end - 1).toString('utf8'));
    assert.deepEqual(parsed, {
      v: 2,
      alg: 'aes-256-gcm',
      chunkBytes,
      size,
      sha256,
    });
    assert.deepEqual(Object.keys(parsed), ['v', 'alg', 'chunkBytes', 'size', 'sha256'], 'the field order is fixed');
    // 4 chunks: three full, one of 17 bytes; every record is 12 + plaintext + 16 bytes.
    assert.equal(sealed.length, end + (64 + 28) * 3 + (17 + 28));
    const opened = openChunkedBuffer(sealed, { dek });
    assert.ok(opened.bytes.equals(plaintext), 'the layout is what the reader parses back');
  });

  it('binds each chunk to its index with the documented AAD string', () => {
    assert.equal(
      chunkedAad({ sha256: 'a'.repeat(64), size: 128, chunkIndex: 2 }),
      `w2m-session-backup/old-chunked|${'a'.repeat(64)}|128|2`,
    );
  });

  it('uses the default chunk size when none is given, and refuses any chunk size above the ceiling', () => {
    const dek = randomDek();
    const plaintext = plaintextOf(1000);
    const sealed = sealChunked(plaintext, { dek });
    const parsed = JSON.parse(sealed.subarray(8, headerEndOf(sealed) - 1).toString('utf8'));
    assert.equal(parsed.chunkBytes, DEFAULT_CHUNK_BYTES);
    assert.equal(resolveChunkBytes(undefined), DEFAULT_CHUNK_BYTES);
    assert.equal(resolveChunkBytes(MAX_CHUNK_BYTES), MAX_CHUNK_BYTES);
    for (const bad of [MAX_CHUNK_BYTES + 1, 0, -1, 1.5, '64', Number.NaN]) {
      assert.equal(codeOf(() => resolveChunkBytes(bad)), CHUNKED_CODES.ARGUMENT_INVALID, `chunkBytes ${String(bad)} must be refused`);
      assert.equal(codeOf(() => sealChunked(plaintext, { dek, chunkBytes: bad })), CHUNKED_CODES.ARGUMENT_INVALID);
    }
  });

  it('refuses to seal a copy under an identity the plaintext does not have', () => {
    const dek = randomDek();
    const plaintext = plaintextOf(32);
    const digest = sha256Hex(plaintext);
    assert.equal(codeOf(() => sealChunked(plaintext, { dek, sha256: 'f'.repeat(64) })), CHUNKED_CODES.ARGUMENT_INVALID);
    assert.equal(codeOf(() => sealChunked(plaintext, { dek, size: plaintext.length + 1 })), CHUNKED_CODES.ARGUMENT_INVALID);
    const accepted = openChunkedBuffer(sealChunked(plaintext, { dek, sha256: digest, size: plaintext.length }), { dek });
    assert.equal(accepted.sha256, digest);
  });
});

describe('chunked v2: roundtrip', () => {
  const CASES = [
    { name: 'a 0-byte file', size: 0, chunks: 0 },
    { name: 'a 1-byte file', size: 1, chunks: 1 },
    { name: 'exactly one full chunk', size: 64, chunks: 1 },
    { name: 'an exact multiple of the chunk size', size: 128, chunks: 2 },
    { name: 'three and a half chunks', size: 224, chunks: 4 },
  ];
  for (const testCase of CASES) {
    it(`round-trips ${testCase.name} and reports the plaintext digest and size`, () => {
      const { sealed, plaintext, sha256, dek, chunkBytes, size } = sealedFor(testCase.size, 64);
      const streamed = openChunkedStream(sealed, { dek });
      assert.equal(streamed.ok, true);
      assert.equal(streamed.format, CHUNKED_FORMAT);
      assert.equal(streamed.sha256, sha256);
      assert.equal(streamed.size, size);
      assert.equal(streamed.chunkBytes, chunkBytes);
      assert.equal(streamed.chunks, testCase.chunks);
      assert.equal(streamed.bytesRead, sealed.length, 'the reader consumes exactly the file');
      // The peak is the largest record: a full chunk (64 + 28), or the whole plaintext when it is smaller.
      assert.equal(streamed.peakChunkBytes, size === 0 ? 0 : Math.min(64, size) + 28);
      const whole = openChunkedBuffer(sealed, { dek });
      assert.equal(whole.sha256, sha256);
      assert.equal(whole.size, size);
      assert.ok(whole.bytes.equals(plaintext), 'the decrypted bytes are the sealed bytes');
    });
  }

  it('streams the chunks to a sink in order, one magic + header + record each', () => {
    const { plaintext, sha256, dek, chunkBytes, size } = sealedFor(3 * 64 + 5, 64);
    const pieces = [];
    const report = sealChunkedToSink(plaintext, { dek, sha256, size, chunkBytes, sink: { write: (buffer) => pieces.push(Buffer.from(buffer)) } });
    assert.equal(report.ok, true);
    assert.equal(report.file, null);
    assert.equal(report.chunks, 4);
    assert.equal(pieces.length, 2 + report.chunks, 'magic, header, then one buffer per record');
    assert.ok(pieces[0].equals(CHUNKED_MAGIC));
    assert.equal(pieces[0].length + pieces[1].length + pieces.slice(2).reduce((total, piece) => total + piece.length, 0), report.byteLength);
    const opened = openChunkedBuffer(Buffer.concat(pieces), { dek });
    assert.ok(opened.bytes.equals(plaintext));
    assert.equal(opened.sha256, sha256);
  });

  it('writes a file atomically through a temp sibling, and reading from the path agrees with the bytes', () => {
    const { dir, cleanup } = tempDir('w2m-chunked-file-');
    try {
      const { plaintext, sha256, dek, chunkBytes, size } = sealedFor(2 * 64 + 9, 64);
      const target = path.join(dir, 'nested', '20260101T000000Z-aaaaaaaaaaaa.json.enc');
      const report = sealChunkedToFile(plaintext, { dek, sha256, size, chunkBytes, writeToFile: target });
      assert.equal(report.ok, true);
      assert.equal(report.file, path.resolve(target));
      assert.equal(report.byteLength, fs.statSync(target).size);
      assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)], 'the temp file was renamed, not left behind');
      assert.equal(isChunkedV2(target), true);
      const fromPath = openChunkedStream(target, { dek });
      assert.equal(fromPath.ok, true);
      assert.equal(fromPath.sha256, sha256);
      assert.equal(fromPath.size, size);
      assert.equal(fromPath.chunks, 3);
      const whole = openChunkedBuffer(target, { dek });
      assert.ok(whole.bytes.equals(plaintext));
      // The same plaintext sealed twice differs only in nonces: the header bytes are deterministic.
      const again = sealChunkedToFile(plaintext, { dek, sha256, size, chunkBytes, writeToFile: `${target}.2` });
      assert.equal(again.ok, true);
      const first = fs.readFileSync(target);
      const second = fs.readFileSync(`${target}.2`);
      assert.ok(first.subarray(0, headerEndOf(first)).equals(second.subarray(0, headerEndOf(second))), 'the header is deterministic');
      assert.equal(isChunkedV2(path.join(dir, 'missing.enc')), false, 'a missing path is not v2, and sniffing never throws');
      assert.equal(isChunkedV2(Buffer.from('nope')), false);
    } finally {
      cleanup();
    }
  });

  it('measures the declared layout of a file without decrypting it (the completeness check old-backfill uses)', () => {
    const { dir, cleanup } = tempDir('w2m-chunked-measure-');
    try {
      const { plaintext, sha256, dek, size } = sealedFor(2 * 64 + 7, 64);
      const target = path.join(dir, 'copy.json.enc');
      sealChunkedToFile(plaintext, { dek, sha256, size, chunkBytes: 64, writeToFile: target });
      const layout = measureChunkedFile(target);
      assert.equal(layout.ok, true);
      assert.equal(layout.sha256, sha256);
      assert.equal(layout.size, size);
      assert.equal(layout.chunkBytes, 64);
      assert.equal(layout.chunks, 3);
      assert.equal(layout.fileBytes, fs.statSync(target).size);
      assert.equal(layout.expectedBytes, layout.fileBytes, 'a complete file is exactly the length its framing implies');
      assert.equal(layout.complete, true);
      // The v1 arithmetic a pre-v2 reader would apply is wrong by construction, which is why this exists.
      assert.notEqual(layout.expectedBytes, size + 28);
      // A torn file is measured, not mistaken for complete (and no decryption is attempted).
      const bytes = fs.readFileSync(target);
      fs.writeFileSync(target, bytes.subarray(0, bytes.length - 1));
      const torn = measureChunkedFile(target);
      assert.equal(torn.complete, false);
      assert.equal(torn.fileBytes, torn.expectedBytes - 1);
      assert.equal(codeOf(() => measureChunkedFile(path.join(dir, 'missing.enc'))), CHUNKED_CODES.READ_FAILED);
      assert.equal(codeOf(() => measureChunkedFile(Buffer.from('NOTMAGIC\n'))), CHUNKED_CODES.HEADER_INVALID);
    } finally {
      cleanup();
    }
  });

  it('does not treat a v1 sealed object as v2, and refuses it by name if asked to open it', () => {
    const dek = randomDek();
    const plaintext = plaintextOf(40);
    const v1 = sealObject(plaintext, dek, { sha256: sha256Hex(plaintext), length: plaintext.length, kind: OLD_COPY_KIND });
    assert.equal(isChunkedV2(v1), false);
    const v1FileDir = tempDir('w2m-chunked-v1-');
    try {
      const file = path.join(v1FileDir.dir, 'copy.json.enc');
      fs.writeFileSync(file, v1);
      assert.equal(isChunkedV2(file), false);
      assert.equal(codeOf(() => openChunkedStream(v1, { dek })), CHUNKED_CODES.HEADER_INVALID);
    } finally {
      v1FileDir.cleanup();
    }
  });
});

describe('chunked v2: damage is named, not averaged away', () => {
  const CHUNK_BYTES = 64;

  it('refuses a flipped ciphertext byte with BACKUP_CHUNKED_AUTH_FAILED', () => {
    const { sealed, dek } = sealedFor(3 * CHUNK_BYTES, CHUNK_BYTES);
    const tampered = Buffer.from(sealed);
    tampered[headerEndOf(tampered) + 12 + 5] ^= 0x01;
    assert.equal(codeOf(() => openChunkedStream(tampered, { dek })), CHUNKED_CODES.AUTH_FAILED);
  });

  it('refuses a file that ends inside or before its last record with BACKUP_CHUNKED_TRUNCATED', () => {
    const { sealed, dek } = sealedFor(3 * CHUNK_BYTES, CHUNK_BYTES);
    assert.equal(codeOf(() => openChunkedStream(sealed.subarray(0, sealed.length - 1), { dek })), CHUNKED_CODES.TRUNCATED);
    const lastRecord = recordRange(sealed, 2, CHUNK_BYTES);
    assert.equal(codeOf(() => openChunkedStream(sealed.subarray(0, lastRecord.start), { dek })), CHUNKED_CODES.TRUNCATED);
    assert.equal(codeOf(() => openChunkedStream(sealed.subarray(0, headerEndOf(sealed)), { dek })), CHUNKED_CODES.TRUNCATED);
  });

  it('refuses swapped records with BACKUP_CHUNKED_ORDER, adjacent or not', () => {
    const { sealed, dek } = sealedFor(4 * CHUNK_BYTES, CHUNK_BYTES);
    assert.equal(codeOf(() => openChunkedStream(withRecordsSwapped(sealed, 0, 1, CHUNK_BYTES), { dek })), CHUNKED_CODES.ORDER);
    assert.equal(codeOf(() => openChunkedStream(withRecordsSwapped(sealed, 1, 3, CHUNK_BYTES), { dek })), CHUNKED_CODES.ORDER);
    assert.equal(codeOf(() => openChunkedStream(withRecordsSwapped(sealed, 3, 0, CHUNK_BYTES), { dek })), CHUNKED_CODES.ORDER);
  });

  it('refuses a duplicated record with BACKUP_CHUNKED_ORDER (the nonce is already at another index)', () => {
    const { sealed, dek } = sealedFor(3 * CHUNK_BYTES, CHUNK_BYTES);
    const duplicated = Buffer.from(sealed);
    const first = recordRange(duplicated, 0, CHUNK_BYTES);
    const second = recordRange(duplicated, 1, CHUNK_BYTES);
    duplicated.copy(duplicated, second.start, first.start, first.end);
    assert.equal(codeOf(() => openChunkedStream(duplicated, { dek })), CHUNKED_CODES.ORDER);
  });

  it('refuses a header whose JSON, magic or version is wrong with BACKUP_CHUNKED_HEADER_INVALID', () => {
    const { sealed, dek } = sealedFor(2 * CHUNK_BYTES, CHUNK_BYTES);
    const end = headerEndOf(sealed);
    const brokenJson = Buffer.concat([sealed.subarray(0, 8), Buffer.from('{not json\n'), sealed.subarray(end)]);
    assert.equal(codeOf(() => openChunkedStream(brokenJson, { dek })), CHUNKED_CODES.HEADER_INVALID);
    const badMagic = Buffer.from(sealed);
    badMagic[0] = 0x58;
    assert.equal(codeOf(() => openChunkedStream(badMagic, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(sealed.subarray(0, 4), { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, v: 3 })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, alg: 'aes-128-gcm' })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, extra: 1 })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, chunkBytes: MAX_CHUNK_BYTES + 1 })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, size: -1 })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, (parsed) => ({ ...parsed, sha256: 'XYZ' })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(withHeader(sealed, () => ({ v: 2 })).sealed, { dek })), CHUNKED_CODES.HEADER_INVALID);
    const noTerminator = sealed.subarray(0, end - 1);
    assert.equal(codeOf(() => openChunkedStream(noTerminator, { dek })), CHUNKED_CODES.HEADER_INVALID);
  });

  it('refuses a different DEK with BACKUP_CHUNKED_AUTH_FAILED (GCM cannot say which of the two it is)', () => {
    const { sealed } = sealedFor(128, CHUNK_BYTES);
    assert.equal(codeOf(() => openChunkedStream(sealed, { dek: randomDek() })), CHUNKED_CODES.AUTH_FAILED);
  });

  it('binds the copy to the identity in its AAD: it cannot be opened as another sha256 or size', () => {
    const { sealed, dek, sha256, size } = sealedFor(2 * CHUNK_BYTES, CHUNK_BYTES);
    // The caller's expected identity is checked against the header before a byte is decrypted.
    assert.equal(codeOf(() => openChunkedStream(sealed, { dek, sha256: 'b'.repeat(64) })), CHUNKED_CODES.HEADER_INVALID);
    assert.equal(codeOf(() => openChunkedStream(sealed, { dek, size: size + CHUNK_BYTES })), CHUNKED_CODES.HEADER_INVALID);
    // Changing the header's identity does not re-bind the chunks: every chunk's AAD still names the old one.
    const retargeted = withHeader(sealed, (parsed) => ({ ...parsed, sha256: 'b'.repeat(64) }));
    assert.equal(codeOf(() => openChunkedStream(retargeted.sealed, { dek })), CHUNKED_CODES.AUTH_FAILED);
    const resized = withHeader(sealed, (parsed) => ({ ...parsed, size: parsed.size + 1 }));
    assert.equal(codeOf(() => openChunkedStream(resized.sealed, { dek })), CHUNKED_CODES.AUTH_FAILED);
    // ...and the genuine identity still opens it.
    assert.equal(openChunkedStream(sealed, { dek, sha256, size }).sha256, sha256);
  });

  it('refuses bytes after the declared chunks with BACKUP_CHUNKED_TRAILING', () => {
    const { sealed, dek } = sealedFor(128, CHUNK_BYTES);
    const padded = Buffer.concat([sealed, Buffer.from('junk-after-the-last-record')]);
    assert.equal(codeOf(() => openChunkedStream(padded, { dek })), CHUNKED_CODES.TRAILING);
  });
});

describe('chunked v2: the peak is one chunk', () => {
  it('seals and re-opens a 32 MiB copy in a child capped at a 64 MiB V8 heap, reporting a one-chunk peak', () => {
    const { dir, cleanup } = tempDir('w2m-chunked-memory-');
    try {
      const chunkBytes = 4 * 1024 * 1024;
      const totalBytes = 32 * 1024 * 1024;
      const plaintextFile = path.join(dir, 'plaintext.bin');
      const sealedFile = path.join(dir, 'copy.json.enc');
      fs.writeFileSync(plaintextFile, Buffer.alloc(totalBytes, 0x5a));
      const script = path.join(dir, 'seal-child.mjs');
      fs.writeFileSync(
        script,
        [
          `import fs from 'node:fs';`,
          `import { createHash } from 'node:crypto';`,
          `import { sealChunkedToFile, openChunkedStream } from ${JSON.stringify(CHUNKED_MODULE)};`,
          `import { randomDek } from ${JSON.stringify(CRYPTO_MODULE)};`,
          'const plaintext = fs.readFileSync(process.argv[2]);',
          'const dek = randomDek();',
          "const sha256 = createHash('sha256').update(plaintext).digest('hex');",
          `const sealed = sealChunkedToFile(plaintext, { dek, sha256, size: plaintext.length, chunkBytes: ${chunkBytes}, writeToFile: process.argv[3] });`,
          'const opened = openChunkedStream(process.argv[3], { dek });',
          'process.stdout.write(JSON.stringify({',
          '  ok: opened.ok === true && opened.sha256 === sha256 && opened.size === plaintext.length,',
          '  chunks: opened.chunks,',
          '  peak: opened.peakChunkBytes,',
          '  seal_peak: sealed.peakChunkBytes,',
          '  byte_length: sealed.byteLength,',
          '  file_bytes: fs.statSync(process.argv[3]).size,',
          '  heap_used: process.memoryUsage().heapUsed,',
          '}) + "\\n");',
        ].join('\n'),
      );
      const child = spawnSync(process.execPath, ['--max-old-space-size=64', script, plaintextFile, sealedFile], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(child.status, 0, `the child died instead of streaming: ${child.stderr}`);
      const report = JSON.parse(child.stdout.trim().split('\n').pop());
      assert.equal(report.ok, true, 'the child sealed and re-opened the copy');
      assert.equal(report.chunks, totalBytes / chunkBytes, '32 MiB at 4 MiB per chunk is 8 records');
      // Exactly one record: nonce (12) + a full ciphertext chunk + tag (16). Not the 32 MiB file, not "about a
      // chunk" -- the number the reader reports is the allocation it made.
      assert.equal(report.peak, chunkBytes + 28, `the reader held ${report.peak} bytes, not one ${chunkBytes}-byte record`);
      assert.equal(report.seal_peak, chunkBytes + 28, `the writer held ${report.seal_peak} bytes, not one record`);
      assert.equal(report.file_bytes, report.byte_length, 'the on-disk file is exactly what the writer reported');
      assert.ok(report.byte_length > totalBytes, 'the sealed file is larger than the plaintext (header and record overhead)');
      assert.ok(report.byte_length < totalBytes + 4096, 'the overhead is one header plus 28 bytes per record');
      assert.ok(report.heap_used < 64 * 1024 * 1024, `the child heap stayed under its cap (${report.heap_used} bytes)`);
    } finally {
      cleanup();
    }
  });
});

/** Write a session log whose bytes differ from the fixture's, so the next run rotates the previous version. */
function changeSessionLog(homeDir) {
  fs.writeFileSync(
    path.join(homeDir, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'),
    framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1794842804377, data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  );
}

/** A repository holding one rotated `full` version: a version record plus its v1 sealed `.json.enc`. */
function repoWithFullCopy(homeDir) {
  const repo = tempDir('w2m-chunked-repo-');
  const first = runBackup({ root: repo.dir, dshHome: homeDir, platform: 'linux', machineKey: false });
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.encryption, 'none', 'the fixture repository is unencrypted, so resealing costs no KDF');
  changeSessionLog(homeDir);
  const second = runBackup({
    root: repo.dir,
    dshHome: homeDir,
    platform: 'linux',
    machineKey: false,
    oldFormat: 'full',
  });
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.rotated, 1, 'the fixture must rotate the previous version into old/');
  return repo;
}

/** Every regular file under `<root>/old`, recursively. */
function oldFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(path.join(root, 'old'));
  return out.sort();
}

/** The repository DEK. The fixtures are unencrypted, so the `open` envelope supplies it with no credential. */
function repositoryDek(root, homeDir) {
  const key = openRepoKey({ root, dshHome: homeDir, platform: 'linux', machineKey: false });
  assert.equal(key.ok, true, key.detail);
  return key.dek;
}

/**
 * Replace the rotation-written `.json.enc` with the historical **v1** sealed object (one whole-file AEAD).
 *
 * Rotation writes chunked v2 since O3, so the v1 path needs an explicit fixture: the plaintext is rebuilt from the
 * record's own blocks (the reader restore uses), so this v1 copy really is the superseded bytes -- not a
 * hand-written object that could disagree with the record.
 */
function convertCopyToV1(root, homeDir) {
  const recordFile = oldFiles(root).find((file) => file.endsWith('.json'));
  assert.ok(recordFile, 'the fixture must hold a version record');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.ok(record.full_copy, 'the fixture must hold a sealed full copy');
  const copyFile = path.join(root, ...record.full_copy.file.split('/'));
  const dek = repositoryDek(root, homeDir);
  const rebuilt = rebuildFile({ root, entry: record, dek });
  assert.equal(rebuilt.ok, true, rebuilt.detail);
  assert.equal(sha256Hex(rebuilt.buffer), record.sha256, 'the rebuilt bytes are the version the record names');
  fs.writeFileSync(
    copyFile,
    sealObject(rebuilt.buffer, dek, { sha256: record.sha256, length: record.size, kind: OLD_COPY_KIND }),
  );
  return { recordFile, record, copyFile, dek };
}

/**
 * Re-seal the rotation-written v2 copy with a smaller chunk size.
 *
 * The plaintext is rebuilt from the record's own blocks (the same reader restore uses), so the v2 copy really is
 * the superseded bytes the record claims -- not a hand-written fixture that could disagree with it.
 */
function convertCopyToChunked(root, homeDir, chunkBytes = 64 * 1024) {
  const recordFile = oldFiles(root).find((file) => file.endsWith('.json'));
  assert.ok(recordFile, 'the fixture must hold a version record');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.ok(record.full_copy, 'the fixture must hold a sealed full copy');
  const copyFile = path.join(root, ...record.full_copy.file.split('/'));
  const dek = repositoryDek(root, homeDir);
  const rebuilt = rebuildFile({ root, entry: record, dek });
  assert.equal(rebuilt.ok, true, rebuilt.detail);
  assert.equal(sha256Hex(rebuilt.buffer), record.sha256, 'the rebuilt bytes are the version the record names');
  const written = sealChunkedToFile(rebuilt.buffer, {
    dek,
    sha256: record.sha256,
    size: record.size,
    chunkBytes,
    writeToFile: copyFile,
  });
  assert.equal(written.ok, true);
  return { recordFile, record, copyFile, dek, written };
}

describe('verify: a chunked-v2 old/ full copy is checked chunk by chunk (O2)', () => {
  it('keeps a v1 copy on exactly the path it had, including the v1-only size bound', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      // Rotation writes v2 since O3; this fixture rewrites that copy as the pre-O3 v1 object, so the v1 path
      // (and its whole-file bound) stays covered rather than disappearing from the suite.
      const { copyFile } = convertCopyToV1(repo.dir, home.home);
      assert.equal(isChunkedV2(copyFile), false);
      const result = verifyRepo({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.deepEqual(result.old_copies, { checked: 1, ok: 1, failed: 0, missing: 0 });
      // The v1 bound is what a v2 copy must escape, so assert it is still applied to a v1 copy.
      const bounded = verifyRepo({
        root: repo.dir,
        dshHome: home.home,
        platform: 'linux',
        machineKey: false,
        oldCopyMaxBytes: 1,
      });
      assert.equal(bounded.ok, false);
      assert.ok(bounded.problems.some((problem) => problem.code === 'BACKUP_VERIFY_OLD_COPY_TOO_LARGE'), JSON.stringify(bounded.problems));
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('verifies the chunked copy rotation writes by default, without the v1-only size bound (O3)', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const copyFile = oldFiles(repo.dir).find((file) => file.endsWith('.json.enc'));
      assert.ok(copyFile, 'the fixture must hold the copy rotation wrote');
      assert.equal(isChunkedV2(copyFile), true, 'rotation writes chunked v2 for every new full copy');
      const recordFile = oldFiles(repo.dir).find((file) => file.endsWith('.json'));
      assert.equal(JSON.parse(fs.readFileSync(recordFile, 'utf8')).full_copy.format, CHUNKED_FORMAT);
      // `oldCopyMaxBytes: 1` refuses any v1 copy on sight; a copy rotation just wrote is v2, so verify streams it.
      const result = verifyRepo({
        root: repo.dir,
        dshHome: home.home,
        platform: 'linux',
        machineKey: false,
        oldCopyMaxBytes: 1,
      });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.deepEqual(result.old_copies, { checked: 1, ok: 1, failed: 0, missing: 0 });
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('verifies a v2 copy with 0 problems and the same old_copies counters, even under a 1-byte v1 limit', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const { copyFile, written } = convertCopyToChunked(repo.dir, home.home);
      assert.equal(isChunkedV2(copyFile), true, 'the fixture replaced the v1 object with a v2 file');
      assert.equal(written.chunks, 1, 'the fixture copy fits one 64 KiB chunk');
      const result = verifyRepo({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.deepEqual(result.old_copies, { checked: 1, ok: 1, failed: 0, missing: 0 });
      // `oldCopyMaxBytes: 1` refuses any v1 copy on sight; a v2 copy is streamed, so the limit does not apply.
      const streamed = verifyRepo({
        root: repo.dir,
        dshHome: home.home,
        platform: 'linux',
        machineKey: false,
        oldCopyMaxBytes: 1,
      });
      assert.equal(streamed.ok, true, streamed.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.deepEqual(streamed.old_copies, { checked: 1, ok: 1, failed: 0, missing: 0 });
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a tampered v2 copy as BACKUP_VERIFY_OLD_COPY_FAILED with the chunked code in the detail', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const { copyFile, recordFile } = convertCopyToChunked(repo.dir, home.home);
      const sealed = fs.readFileSync(copyFile);
      sealed[headerEndOf(sealed) + 12 + 3] ^= 0x01;
      fs.writeFileSync(copyFile, sealed);
      const result = verifyRepo({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, false);
      assert.deepEqual(result.old_copies, { checked: 1, ok: 0, failed: 1, missing: 0 });
      const problem = result.problems.find((row) => row.code === 'BACKUP_VERIFY_OLD_COPY_FAILED');
      assert.ok(problem, JSON.stringify(result.problems));
      assert.equal(problem.file, recordFile, 'the problem names the version record');
      assert.match(problem.detail, /BACKUP_CHUNKED_AUTH_FAILED/u);
      assert.match(problem.detail, new RegExp(CHUNKED_FORMAT, 'u'), 'the detail says which format failed');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a truncated v2 copy as BACKUP_VERIFY_OLD_COPY_FAILED with BACKUP_CHUNKED_TRUNCATED', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const { copyFile } = convertCopyToChunked(repo.dir, home.home);
      fs.truncateSync(copyFile, fs.statSync(copyFile).size - 1);
      const result = verifyRepo({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, false);
      assert.deepEqual(result.old_copies, { checked: 1, ok: 0, failed: 1, missing: 0 });
      const problem = result.problems.find((row) => row.code === 'BACKUP_VERIFY_OLD_COPY_FAILED');
      assert.ok(problem, JSON.stringify(result.problems));
      assert.match(problem.detail, /BACKUP_CHUNKED_TRUNCATED/u);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a v2 copy that belongs to another version instead of decrypting it blindly', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const { copyFile, record } = convertCopyToChunked(repo.dir, home.home);
      // Re-target the header at another identity of the same length: the AAD makes the chunks fail, and the
      // deliberate header-mismatch check would also have named it.
      const sealed = fs.readFileSync(copyFile);
      const end = headerEndOf(sealed);
      const parsed = JSON.parse(sealed.subarray(8, end - 1).toString('utf8'));
      assert.equal(parsed.sha256, record.sha256);
      const other = (parsed.sha256[0] === 'a' ? 'b' : 'a').repeat(64);
      const retargeted = Buffer.concat([
        sealed.subarray(0, 8),
        Buffer.from(`${JSON.stringify({ ...parsed, sha256: other })}\n`, 'utf8'),
        sealed.subarray(end),
      ]);
      fs.writeFileSync(copyFile, retargeted);
      const result = verifyRepo({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, false);
      const problem = result.problems.find((row) => row.code === 'BACKUP_VERIFY_OLD_COPY_FAILED');
      assert.ok(problem, JSON.stringify(result.problems));
      assert.match(problem.detail, /BACKUP_CHUNKED_(HEADER_INVALID|AUTH_FAILED)/u);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});

