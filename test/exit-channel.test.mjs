/**
 * Exit-channel suite: the encoding, and the three ways a message can end.
 *
 * What these tests protect, said once: this channel exists because **no text channel works**, so a bug in it
 * is not a degraded diagnostic — it is no diagnostic, and worse, a *wrong* one. The failure that matters
 * most is a truncated message being read as a complete one, because that turns "the machine stopped talking"
 * into "the machine said this", and the reader has no way to tell.
 *
 * So the round-trip is one test and the endings are the rest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DONE,
  FRAME,
  SYMBOL_COUNT,
  codeForSymbol,
  costOf,
  decodeBytes,
  encodeBytes,
  fromExitCodes,
  symbolForCode,
  toExitCodes,
} from '../src/agent/exit-channel.mjs';

describe('exit channel: bytes survive the encoding', () => {
  it('round-trips an empty message', () => {
    assert.deepEqual(encodeBytes(Buffer.alloc(0)), []);
    assert.equal(decodeBytes([]).length, 0);
  });

  it('round-trips every byte shape that UTF-8 text actually produces', () => {
    // The property that matters: every string the channel will carry survives byte-for-byte, including text
    // whose UTF-8 encoding contains a zero byte *inside* it -- the case where a naive high-order trim would
    // silently truncate.
    const cases = [
      'A', 'z', '0', '\u0001\u0000', '\u00ff\u0080', 'e\u0301',
      '\u4e2d\u6587\u62a5\u544a',
      '\u{1F600}\u{1F680}',
      'mixed \u4e2d\u6587 and \u2014 punctuation',
      'the quick brown fox jumps over the lazy dog',
      'first',
      '{"severity":"warn","findings":["DISK_WARN: / is 87% used"],"at":"2026-10-15T02:00:00Z"}',
      JSON.stringify({ nested: { deep: ['\u4e2d', '\u{1F600}'] } }),
    ];
    for (const text of cases) {
      const bytes = Buffer.from(text, 'utf8');
      const back = decodeBytes(encodeBytes(bytes));
      assert.deepEqual([...back], [...bytes], `bytes must match for ${JSON.stringify(text)}`);
      assert.equal(back.toString('utf8'), text, `text must match for ${JSON.stringify(text)}`);
    }
  });

  it('reverses order correctly, which is the bug this suite was written around', () => {
    // `encodeBytes` emits least significant first and the decoder consumes most significant first, so the
    // digits must be reversed on the way in. Getting that wrong inverts the message, and it looks like
    // byte-order corruption rather than a reversal: "first" came back as "Y~\u0010\u0018\u00fc".
    //
    // Asserted directly, because every longer case above would also fail for other reasons and this one
    // names the actual fault.
    assert.equal(decodeBytes(encodeBytes(Buffer.from('first', 'utf8'))).toString('utf8'), 'first');
    assert.deepEqual(encodeBytes(Buffer.from('first', 'utf8')), [96, 210, 161, 205, 110]);
  });

  it('is explicit about what is not recoverable, rather than pretending it is', () => {
    // Leading NUL bytes do not change the number, so `[0, 0, 1]` and `[1]` are the same value and the same
    // digit list. Recovering them would need a length declared on the wire, and this channel carries text.
    // Asserted rather than left implicit, because a future reader will otherwise treat it as a bug and add a
    // length prefix that changes the wire format for every existing message.
    assert.deepEqual(encodeBytes(Buffer.from([0x00, 0x00, 0x01])), encodeBytes(Buffer.from([0x01])));
    assert.deepEqual(encodeBytes(Buffer.from([0])), []);
    assert.deepEqual(encodeBytes(Buffer.alloc(0)), []);
    // A zero byte that is *not* leading is preserved, which is the case that must work.
    assert.deepEqual([...decodeBytes(encodeBytes(Buffer.from([0x01, 0x00])))], [0x01, 0x00]);
  });

  it('keeps every digit inside the payload alphabet', () => {
    // The alphabet is what makes framing unambiguous. A digit of 251 or more would collide with a frame code
    // and be read as an ending.
    const bytes = Buffer.from('x'.repeat(200), 'utf8');
    for (const digit of encodeBytes(bytes)) {
      assert.ok(digit >= 0 && digit < SYMBOL_COUNT, `digit ${digit} outside 0..${SYMBOL_COUNT - 1}`);
    }
  });
});

describe('exit channel: every code is a legal exit status', () => {
  it('emits only codes a shell will not produce on its own, plus the end frame', () => {
    // Exit code 0 must never carry data -- a successful command returns it, so it has to mean "finished".
    // And 126/127 must never carry data: a shell writes them for "not executable" and "not found", so a real
    // 127 and a data 127 would be indistinguishable and the reader would investigate the wrong failure.
    const codes = toExitCodes('a report with enough length to produce several codes, repeated: ' + 'y'.repeat(60));
    assert.ok(codes.length > 2, 'the fixture should produce more than a terminator');
    for (const code of codes.slice(0, -1)) {
      assert.ok(code >= 1 && code <= 253, `payload code ${code} must be in 1..253`);
      assert.notEqual(code, 0, 'zero means success and may not carry data');
      assert.notEqual(code, 126, '126 is a shell code and must not appear as data');
      assert.notEqual(code, 127, '127 is a shell code and must not appear as data');
      assert.notEqual(code, 254, '254 is the end frame and must not appear as data');
    }
    assert.equal(codes[codes.length - 1], DONE);
  });

  it('covers every payload code exactly once, so no symbol is unreachable', () => {
    // The mapping skips two codes; a mapping that also skipped a symbol would make some byte values
    // unencodable, and the failure would appear as a corrupted long report rather than as an error.
    const seen = new Set();
    for (let symbol = 0; symbol < SYMBOL_COUNT; symbol += 1) {
      const code = codeForSymbol(symbol);
      assert.equal(seen.has(code), false, `code ${code} used twice`);
      seen.add(code);
      assert.equal(symbolForCode(code), symbol, `code ${code} must map back to ${symbol}`);
    }
    assert.equal(seen.size, SYMBOL_COUNT);
    for (const shellCode of [0, 126, 127, 254, 255]) {
      assert.equal(symbolForCode(shellCode), null, `${shellCode} must not be a payload code`);
    }
    assert.throws(() => codeForSymbol(SYMBOL_COUNT), RangeError);
    assert.throws(() => codeForSymbol(-1), RangeError);
  });
});

describe('exit channel: the three endings are distinguishable', () => {
  it('reads a complete message back', () => {
    const text = 'severity=warn disk=87%';
    const decoded = fromExitCodes(toExitCodes(text));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.text, text);
  });

  it('refuses to call a truncated message complete, and returns what arrived', () => {
    // The failure that matters most. A channel that stops mid-message must not be read as a whole message,
    // because that turns "the machine stopped talking" into "the machine said this".
    const codes = toExitCodes('a long enough report that it spans many codes '.repeat(4));
    const truncated = codes.slice(0, 5);
    const decoded = fromExitCodes(truncated);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason_code, 'TRUNCATED');
    assert.match(decoded.detail, /must not be read as a whole/);
    assert.ok(decoded.text !== null, 'what did arrive is still worth returning');
  });

  it('distinguishes a sender that reported its own error from one that stopped', () => {
    // "The sender failed and said so" and "the channel died" need different responses: the first means read
    // the partial text, the second means re-dispatch.
    const decoded = fromExitCodes([1, 2, 3, FRAME.ERROR]);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason_code, 'SENDER_REPORTED_ERROR');
    assert.match(decoded.detail, /said so/);
  });

  it('ignores anything after the end frame rather than appending it', () => {
    const codes = [...toExitCodes('first'), 50, 51, 52];
    const decoded = fromExitCodes(codes);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.text, 'first');
  });

  it('rejects a code outside the alphabet instead of decoding it', () => {
    const decoded = fromExitCodes([1, 300]);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason_code, 'EXIT_CODE_OUT_OF_ALPHABET');
    assert.match(decoded.detail, /position 1/);
  });

  it('rejects a frame code appearing where a digit belongs', () => {
    // 126 is what a shell writes when a command never ran. It is reported as such rather than as a bad
    // digit, because the two diagnoses lead somewhere different.
    const decoded = fromExitCodes([1, FRAME.SHELL_NOT_FOUND]);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason_code, 'EXIT_CODE_OUT_OF_ALPHABET');
    assert.match(decoded.detail, /never ran/);
  });

  it('rejects code 0 as data rather than treating it as zero', () => {
    const decoded = fromExitCodes([0, DONE]);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason_code, 'EXIT_CODE_OUT_OF_ALPHABET');
  });

  it('reports an empty channel as truncated, not as an empty message', () => {
    // No codes at all is "nothing arrived", which is not the same as "the message was empty" -- an empty
    // message is encoded as the end frame alone.
    assert.equal(fromExitCodes([]).ok, false);
    assert.equal(fromExitCodes([]).reason_code, 'TRUNCATED');
    const empty = fromExitCodes([DONE]);
    assert.equal(empty.ok, true);
    assert.equal(empty.text, '');
  });
});

describe('exit channel: the cost is reported so a caller can decide', () => {
  it('says how many dispatches a report would take', () => {
    const small = costOf('ok');
    const large = costOf('x'.repeat(1000));
    assert.ok(small.exit_codes >= 1);
    assert.ok(large.exit_codes > small.exit_codes * 10, 'a large payload must be visibly more expensive');
    assert.equal(small.bytes, 2);
  });

  it('is honest that a log file is not worth sending', () => {
    // The channel is for a verdict, not for output. A caller that sees this number should fix the real
    // channel rather than use this one.
    const cost = costOf('l'.repeat(10_000));
    assert.ok(cost.exit_codes > 1000, `10000 bytes should cost thousands of dispatches, got ${cost.exit_codes}`);
  });
});
