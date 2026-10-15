/**
 * A result channel over exit codes, for machines whose text cannot be read back.
 *
 * ## The problem this solves, stated honestly
 *
 * The relay carries a per-machine `exit_code` faithfully and carries **no stdout at all** — that is a
 * deliberate property of the ledger, not a bug, and it is the right design for a system whose job is to say
 * whether machines agree. The consequence is that an orchestrator can learn *that* a task failed and never
 * *why*, and on this fleet that cost several rounds: a health check that returned a real verdict was
 * indistinguishable from one that crashed, because both produce a number and nothing else.
 *
 * The channels that would carry text are all unavailable here: the relay host's SSH and its sink are
 * refused, an inbound receiver on the orchestrator never received a single connection, and a machine's
 * `allowedCommands` may permit only a narrow set of commands. What is left is the one thing that has worked
 * on every machine every time: **the exit status**.
 *
 * So this encodes bytes into exit codes. It is slow and it is ugly, and both of those are the point — it is
 * the channel of last resort, and a diagnostic that arrives slowly is worth more than a diagnostic that
 * never arrives.
 *
 * ## Why base 251 and not base 256
 *
 * Exit codes are unsigned bytes *in principle* and considerably less than that in practice. `0` is taken:
 * it is what a successful command returns, so it must mean "the message is finished" rather than "the byte
 * is zero". Codes above 125 are unreliable — `126` and `127` are written by shells for "not executable"
 * and "not found", and a value that collides with a shell's own error is a diagnostic that reads as a
 * different failure. So the payload alphabet is **1..251**, which is 251 symbols, and a byte is carried as
 * `value + 1`.
 *
 * That leaves `252..255` free for framing, and they are used as unambiguous terminators, because "the
 * channel stopped" and "the message ended" must not look alike. A truncated report read as a complete one
 * is the failure mode that makes a diagnostic worse than none.
 *
 * ## What is deliberately absent
 *
 * No compression, no encryption, no resumption. Each would be a way to make the transport cleverer than the
 * thing it transports, and the whole reason this exists is that the clever transports were the ones that
 * did not work. A caller with a large payload should fix the real channel instead of using this one.
 */

/**
 * The payload alphabet: 251 symbols, carried by the 253 exit codes that are safe to write.
 *
 * Codes `1..125` and `128..253` carry data; `126`, `127`, `254` and `255` do not. The two omissions are
 * deliberate and are the whole reason this is a mapping rather than a constant offset:
 *
 *   * **`126` and `127` are written by shells** for "not executable" and "not found". If they could carry
 *     data, a real 127 from a missing interpreter and a data 127 would be indistinguishable and the reader
 *     would investigate the wrong failure. The first version of this module used `value + 1` across the
 *     whole range and its own test caught the collision.
 *   * **`254` and `255` carry the framing** that makes "the message ended" distinguishable from "the channel
 *     died", and `0` is reserved because a successful command returns it.
 */
export const SYMBOL_COUNT = 251;

/** Exit code for symbol `value`: skip the two shell-owned codes. */
export function codeForSymbol(value) {
  if (!Number.isInteger(value) || value < 0 || value >= SYMBOL_COUNT) {
    throw new RangeError(`symbol ${value} is outside 0..${SYMBOL_COUNT - 1}`);
  }
  const code = value + 1;
  return code < 126 ? code : code + 2;
}

/** Symbol carried by an exit code, or `null` when the code is not a payload digit. */
export function symbolForCode(code) {
  if (!Number.isInteger(code)) return null;
  if (code >= 1 && code <= 125) return code - 1;
  if (code >= 128 && code <= 253) return code - 3;
  return null;
}

/** Frame codes, chosen from the exit codes that carry no payload. */
export const FRAME = Object.freeze({
  /** The message ended cleanly. */
  END: 254,
  /** The sender failed and is saying so rather than ending. */
  ERROR: 255,
  /** Written by a shell for "not executable"; never emitted as data. */
  SHELL_NOT_EXECUTABLE: 126,
  /** Written by a shell for "not found"; never emitted as data. */
  SHELL_NOT_FOUND: 127,
});

/** Exit code used by a sender that finished the whole message. */
export const DONE = FRAME.END;

/**
 * Split bytes into base-251 digits, least significant first.
 *
 * A big integer would be the obvious representation and is the wrong one: `BigInt` arithmetic over a
 * multi-kilobyte payload is slower than the digit loop and produces a value whose length is not obviously
 * related to the input's. Here each output digit carries a known amount of text, so a truncated message is
 * detectable by counting.
 *
 * The loop below is long division of `input` (read as a base-256 number) by 251, repeated until the
 * quotient is zero, collecting remainders least-significant first. Each pass builds a **new** quotient array
 * and rebinds it, rather than clearing and refilling the array being iterated -- the first version of this
 * function did the latter, and mutating a collection while iterating it produced nine failing round-trips
 * out of eighteen, including single bytes.
 *
 * @param {Buffer} bytes
 * @returns {number[]} values in `0..250`
 */
export function encodeBytes(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const digits = [];
  let current = Array.from(input);
  while (!(current.length === 0 || (current.length === 1 && current[0] === 0))) {
    const quotient = [];
    let remainder = 0;
    for (const byte of current) {
      const value = remainder * 256 + byte;
      const q = Math.floor(value / SYMBOL_COUNT);
      remainder = value % SYMBOL_COUNT;
      // Leading zeros in the quotient are dropped, because the divisor never produces a meaningful one and
      // keeping them would make the loop's termination depend on the input's length rather than its value.
      if (quotient.length > 0 || q > 0) quotient.push(q);
    }
    digits.push(remainder);
    current = quotient;
  }
  return digits;
}

/**
 * Rebuild bytes from base-251 digits, least significant first.
 *
 * ## The direction mismatch that made this wrong three times
 *
 * `encodeBytes` emits remainders as it divides, so its output is **least significant first**. The
 * accumulator below is Horner's rule, which consumes digits **most significant first**. Feeding one into the
 * other directly inverts the message, and it does so in a way that looks like byte-order corruption rather
 * than a reversal: `"first"` came back as `"Y~\u0010\u0018\u00fc"`, the right multiset of bytes in the wrong
 * order.
 *
 * Two attempts to fix that failed because they were fixing the wrong half -- first a stray `.reverse()` on
 * the *output* buffer was added and removed, and then it was removed again, while the actual problem was
 * that the *input* needed reversing. The reference check that settled it was computing the digits with
 * `BigInt` and comparing: `encodeBytes` matched the reference exactly, which located the fault on the decode
 * side and in the input order rather than the output.
 *
 * @param {number[]} digits least significant first, as `encodeBytes` produces
 * @returns {Buffer}
 */
export function decodeBytes(digits) {
  let current = [0];
  for (const digit of [...digits].reverse()) {
    let carry = digit;
    const next = [];
    for (const value of current) {
      const total = value * SYMBOL_COUNT + carry;
      next.push(total % 256);
      carry = Math.floor(total / 256);
    }
    while (carry > 0) {
      next.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
    current = next;
  }
  // Trim high-order zero bytes, which the multiplication produces for any value that does not fill its last
  // limb. This is also why leading NUL bytes are not recoverable: a leading zero does not change the number,
  // so `[0, 0, 1]` and `[1]` are the same value and the same digit list. Recovering them would need a length
  // declared on the wire, and this channel carries text.
  while (current.length > 1 && current[current.length - 1] === 0) current.pop();
  if (current.length === 1 && current[0] === 0) return Buffer.alloc(0);
  // Little-endian in, little-endian out: reverse once, here, at the boundary.
  return Buffer.from(current.reverse());
}

/**
 * Turn a report into the exit codes that carry it, ending with the end frame.
 *
 * The terminator is part of the encoding rather than a convention the caller remembers, because a caller
 * who forgets it produces a receiver that waits forever for a message that already finished.
 *
 * @param {string|Buffer} report
 * @returns {number[]} exit codes, in order
 */
export function toExitCodes(report) {
  return [...encodeBytes(report).map(codeForSymbol), DONE];
}

/**
 * Decode exit codes back into a report.
 *
 * Distinguishes three outcomes, because they need different responses: a complete message, a message that
 * stopped early, and a sender that reported its own failure. Collapsing them is how "truncated" is read as
 * "complete" and a half-answer is believed.
 *
 * @param {number[]} codes
 * @returns {{ok: true, text: string, bytes: number} | {ok: false, reason_code: string, text: string|null, detail: string}}
 */
export function fromExitCodes(codes) {
  const digits = [];
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === FRAME.END) {
      // Everything after a clean end is ignored rather than appended: a sender that emitted more than one
      // terminator is confused, and guessing which message was intended is not this function's job.
      const bytes = decodeBytes(digits);
      return { ok: true, text: bytes.toString('utf8'), bytes: bytes.length };
    }
    if (code === FRAME.ERROR) {
      const partial = digits.length > 0 ? decodeBytes(digits).toString('utf8') : null;
      return { ok: false, reason_code: 'SENDER_REPORTED_ERROR', text: partial, detail: 'the sender stopped and said so rather than ending the message' };
    }
    const symbol = symbolForCode(code);
    if (symbol === null) {
      // A code outside the alphabet. `126` and `127` land here, and naming them matters: they are what a
      // shell writes when the command never ran at all, which is a different diagnosis from a bad digit.
      const why = code === FRAME.SHELL_NOT_EXECUTABLE
        ? 'exit code 126 is written by a shell for "not executable": the command never ran'
        : code === FRAME.SHELL_NOT_FOUND
          ? 'exit code 127 is written by a shell for "not found": the command never ran'
          : `exit code ${code} at position ${i} is outside the payload alphabet`;
      return { ok: false, reason_code: 'EXIT_CODE_OUT_OF_ALPHABET', text: null, detail: why };
    }
    digits.push(symbol);
  }
  // Ran out of codes without a terminator. This is the case worth being loud about.
  const partial = digits.length > 0 ? decodeBytes(digits).toString('utf8') : null;
  return {
    ok: false,
    reason_code: 'TRUNCATED',
    text: partial,
    detail: `the channel ended after ${codes.length} code(s) with no end frame; the message is incomplete and must not be read as a whole`,
  };
}

/**
 * How many dispatches a report costs.
 *
 * Reported rather than estimated at the call site, because the honest answer is what decides whether this
 * channel is usable for a given payload: a one-line verdict is a handful of codes, and a log file is not
 * worth sending this way at all.
 */
export function costOf(report) {
  const codes = toExitCodes(report);
  return { exit_codes: codes.length, bytes: Buffer.byteLength(String(report), 'utf8') };
}
