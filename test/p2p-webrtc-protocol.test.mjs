/**
 * `webrtc-v1` wire protocol: frame codec, fragmentation and reassembly bounds.
 *
 * These are the claims that make the transport safe to put behind a lossy/ordered DataChannel:
 *
 *   1. a frame is exactly `kind | session | body`, and an unknown kind is refused rather than
 *      treated as DATA;
 *   2. a small payload stays one DATA frame, while a large one becomes bounded CHUNK frames;
 *   3. reassembly refuses a duplicate with different bytes, an oversized message, and a stale set;
 *   4. the reassembly table is bounded, so a peer cannot grow it without limit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_HEADER_BYTES,
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  Fragmenter,
  MAX_MESSAGE_BYTES,
  Reassembler,
  decodeFrame,
  decodeJsonFrame,
  encodeChunk,
  encodeFrame,
  encodeJsonFrame,
  stringifyBounded,
  WebRtcProtocolError,
} from '../src/agent/webrtc/protocol.mjs';

describe('frame codec', () => {
  it('round-trips a frame and keeps the 5-byte header', () => {
    const body = Buffer.from('hello');
    const frame = encodeFrame(FRAME_KIND.DATA, 0x01020304, body);
    assert.equal(frame.length, FRAME_HEADER_BYTES + body.length);
    const parsed = decodeFrame(frame);
    assert.equal(parsed.kind, FRAME_KIND.DATA);
    assert.equal(parsed.session, 0x01020304);
    assert.equal(parsed.body.toString(), 'hello');
  });

  it('refuses an unknown kind instead of treating it as DATA', () => {
    assert.throws(
      () => decodeFrame(encodeFrame(0xff, 1, Buffer.alloc(0))),
      (error) => {
        assert.ok(error instanceof WebRtcProtocolError);
        assert.equal(error.code, 'WEBRTC_UNKNOWN_KIND');
        return true;
      },
    );
  });

  it('round-trips JSON control frames', () => {
    const encoded = encodeJsonFrame(FRAME_KIND.PING, 7, { token: 'x' });
    const decoded = decodeJsonFrame(encoded.frame);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.kind, FRAME_KIND.PING);
    assert.deepEqual(decoded.value, { token: 'x' });
  });

  it('bounds a JSON message before it reaches a socket', () => {
    const ok = stringifyBounded({ value: 'x'.repeat(10) }, 1024);
    assert.equal(ok.ok, true);
    const tooBig = stringifyBounded({ value: 'x'.repeat(2048) }, 1024);
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.code, 'WEBRTC_SIGNAL_TOO_LARGE');
  });
});

describe('fragmentation', () => {
  it('keeps a small payload as one DATA frame', () => {
    const fragmenter = new Fragmenter();
    const frames = fragmenter.split(Buffer.from('small'));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, FRAME_KIND.DATA);
    assert.equal(frames[0].body.toString(), 'small');
  });

  it('splits a large payload into CHUNK frames that reassemble byte-for-byte', () => {
    const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));
    const fragmenter = new Fragmenter({ maxFragmentBytes: 16 * 1024, idSource: () => 42 });
    const frames = fragmenter.split(payload);
    assert.equal(frames.length, 4);
    for (const frame of frames) {
      assert.equal(frame.kind, FRAME_KIND.CHUNK);
      assert.ok(frame.body.length <= 16 * 1024 + CHUNK_HEADER_BYTES);
    }
    const reassembler = new Reassembler();
    let result = null;
    for (const frame of frames) {
      const pushed = reassembler.push(frame.body);
      if (pushed.ok === true) result = pushed.payload;
      else assert.equal(pushed.code, 'WEBRTC_MESSAGE_INCOMPLETE', JSON.stringify(pushed));
    }
    assert.ok(result !== null, 'the final fragment must complete the message');
    assert.equal(result.length, payload.length);
    assert.deepEqual(result, payload);
  });

  it('refuses a duplicate fragment with different bytes', () => {
    const first = encodeChunk(7, 0, 2, Buffer.from('aaaa'));
    const second = encodeChunk(7, 1, 2, Buffer.from('bbbb'));
    const conflicting = encodeChunk(7, 0, 2, Buffer.from('cccc'));
    const reassembler = new Reassembler();
    assert.equal(reassembler.push(first).ok, false);
    const conflict = reassembler.push(conflicting);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'WEBRTC_MESSAGE_CORRUPT');
    assert.equal(reassembler.push(second).ok, false); // the set was discarded
    assert.equal(reassembler.size(), 1);
  });

  it('drops a stale incomplete set instead of pinning it forever', () => {
    let now = 1000;
    const reassembler = new Reassembler({ ttlMs: 100, now: () => now });
    const first = encodeChunk(8, 0, 2, Buffer.from('aaaa'));
    assert.equal(reassembler.push(first).ok, false);
    assert.equal(reassembler.size(), 1);
    now += 500;
    const second = encodeChunk(8, 1, 2, Buffer.from('bbbb'));
    assert.equal(reassembler.push(second).ok, false);
    assert.equal(reassembler.size(), 1); // a new set, the stale one was pruned
    assert.equal(reassembler.dropped, 1);
  });

  it('refuses a payload over the logical message cap', () => {
    const fragmenter = new Fragmenter();
    const tooBig = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
    assert.throws(
      () => fragmenter.split(tooBig),
      (error) => {
        assert.equal(error.code, 'WEBRTC_MESSAGE_TOO_LARGE');
        return true;
      },
    );
  });

  it('bounds the number of incomplete messages', () => {
    const reassembler = new Reassembler({ maxEntries: 2, ttlMs: 10_000 });
    // Three 2-fragment messages; each first fragment creates an entry.
    for (let id = 1; id <= 3; id += 1) {
      const pushed = reassembler.push(encodeChunk(id, 0, 2, Buffer.from('x')));
      assert.equal(pushed.ok, false);
    }
    assert.ok(reassembler.size() <= 2);
    assert.ok(reassembler.dropped >= 1);
  });
});
