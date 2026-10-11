/**
 * Multicast DNS wire codec --a bounded, hand-written DNS message encoder and decoder.
 *
 * # THE RULE
 *
 * **Discovery is a hint, never an authorisation.** A discovered device is a *candidate to ask*. It
 * never skips, weakens or short-circuits any existing gate --the device token, the per-machine
 * allow-list, the git anchors, the verdict model. Nothing in this file, in `src/agent/mdns.mjs`, or in
 * `src/plugin/mdns-discover.mjs` may treat "we saw it announce itself" as "we may run there". If a
 * future edit finds itself writing code where a discovered device is trusted *because it was
 * discovered*, stop: that is a defect, not an optimisation. mDNS carries no authentication of any
 * kind, so a record here is an unverified claim by whoever sent it, and every consumer must treat it
 * as such.
 *
 * # Clean room
 *
 * Written from the published rules --RFC 1035 --4.1 (message format, name compression), RFC 1035
 * --2.3.4 (the 255-octet name limit), RFC 1035 --3.1/--3.2.2 (record and type definitions), RFC 2782
 * (SRV), RFC 6763 (DNS-SD record layout, the TXT record's key=value convention), RFC 6762 --18
 * (mDNS message format) and RFC 6762 --10 (TTL values, goodbye packets). No third-party
 * implementation was consulted line by line and none was copied: this project is MIT and stays free of
 * third-party notice entanglement, and deriving from the specification is also what lets us *not*
 * reproduce the defects a studied implementation had.
 *
 * Two behaviours are deliberately not reproduced anywhere in this module, because they are how a
 * discovery layer goes stale:
 *
 *   * **first-writer-wins / keep-first-non-zero-port.** There is no such rule here. A record is
 *     identified by `(name, type, rdata)` and a later copy *replaces* an earlier one, at any TTL
 *     including zero: see `createRecordCache` in `src/agent/mdns.mjs`. A device that moves during a
 *     scan must be seen at its new address, not at the address it had when the scan began.
 *   * **a name as identity.** Nothing here decides identity at all; the codec only reports what the
 *     wire said, including the exact `name` bytes as written. Identity is decided in
 *     `src/plugin/mdns-discover.mjs`, by a `machine_id` the relay assigned --never by a matching
 *     service or host name.
 *
 * # What is implemented, and what is not
 *
 * Implemented: header, question section, and the answer/authority/additional sections for PTR, SRV,
 * TXT, A and AAAA. Name compression on **decode** (pointers are followed, with hardening below) and on
 * **encode** (a per-message suffix dictionary writes a pointer to an earlier occurrence).
 *
 * Not implemented, on purpose: NSEC/negative responses, OPT/EDNS0, DNSSEC, SVCB/HTTPS, and every
 * record type this layer does not read. An unknown record type decodes into `{type, rdata}` and is
 * ignored by the consumers rather than guessed at.
 *
 * # The hardening contract
 *
 * `decodeMessage` **never throws and never loops forever**, whatever bytes it is handed. Every read is
 * bounds-checked against the buffer, and every structural limit is a refusal with a stable code:
 *
 *   | guard                        | limit | refusal              |
 *   | ---------------------------- | ----- | -------------------- |
 *   | label length octet           | 63    | `MDNS_LABEL_TOO_LONG`|
 *   | unsupported label kind (01/10)| --   | `MDNS_LABEL_TYPE`    |
 *   | expanded name length         | 255   | `MDNS_NAME_TOO_LONG` |
 *   | compression pointer target   | must be strictly earlier in the message | `MDNS_POINTER_LOOP` |
 *   | compression pointer hops     | 128   | `MDNS_POINTER_HOPS`  |
 *   | records per message          | 256   | `MDNS_RECORD_COUNT`  |
 *   | message size                 | 9000  | `MDNS_MESSAGE_TOO_LARGE` |
 *   | any read past the end        | --    | `MDNS_TRUNCATED`     |
 *
 * The two pointer guards are both load-bearing, and neither is decoration:
 *
 *   * RFC 1035 --4.1.4 says a pointer refers to "a prior occurrence" of the name, i.e. to an offset
 *     *earlier* in the message. A pointer that does not point strictly backwards is the only way to
 *     build a cycle, so it is refused as a loop. This alone guarantees termination.
 *   * The hop counter (128, the conventional guard) is the bound on *work*, not just on loops: a
 *     hostile packet can chain 200 legal, strictly-backwards pointers into one name, which terminates
 *     but costs more than any honest message needs.
 *
 * The last line of defence is a `try/catch` around the whole decoder: a bug in the code below becomes
 * `MDNS_INTERNAL`, a refusal, not an exception escaping into a socket handler.
 */

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** DNS CLASS IN (RFC 1035 --3.2.4). */
export const DNS_CLASS_IN = 1;

/** DNS CLASS ANY (`*`), which mDNS queries use to ask for every type of a name (RFC 6762 --5). */
export const DNS_CLASS_ANY = 255;

/** Record types this layer reads. RFC 1035 --3.2.2, RFC 1035 --3.2.3 (AAAA is RFC 3596), RFC 2782. */
export const RECORD_TYPE = Object.freeze({
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  ANY: 255,
});

/** The same codes backwards, for diagnostics. An unknown code renders as `TYPE<n>`. */
const TYPE_NAME = Object.freeze({
  1: 'A',
  12: 'PTR',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  255: 'ANY',
});

/**
 * The most significant bit of the *rrclass* field in a response record.
 *
 * RFC 6762 --10.2: "this is not a record class 0x8001" --the bit means "the rest of this RRset is
 * replaced", and it must be masked off before the class is compared. It is the *same bit value* as
 * {@link UNICAST_RESPONSE} in a question, but a different field with a different meaning; the two
 * constants are separate so a future edit cannot conflate them.
 */
export const CACHE_FLUSH = 0x8000;

/** The most significant bit of the *qclass* field in a question (RFC 6762 --5.4, "QU" questions). */
export const UNICAST_RESPONSE = 0x8000;

/** RFC 1035 --2.3.4: a label is at most 63 octets, which is why the top two bits can be flags. */
export const MAX_LABEL_BYTES = 63;

/** RFC 1035 --2.3.4: a name (length octets, label octets and the terminating zero) is at most 255. */
export const MAX_NAME_BYTES = 255;

/**
 * Largest message this codec will parse or produce.
 *
 * RFC 6762 --17 asks that multicast messages fit in 1500 bytes "whenever possible" and caps them at
 * 9000 (`MAX_MESSAGE_BYTES` here). The cap is also a bound on parser work, which is the reason it is
 * enforced on *decode* as well: a datagram larger than this is refused before a single name is read.
 */
export const MAX_MESSAGE_BYTES = 9000;

/** The conventional bound on compression-pointer dereferences for one name. */
export const MAX_POINTER_HOPS = 128;

/** Upper bound on records in one message. A 9000-byte message cannot honestly hold more than a few. */
export const MAX_RECORDS = 256;

/** Upper bound on the encoder's suffix dictionary, so a huge message cannot grow it without limit. */
export const MAX_COMPRESSION_ENTRIES = 512;

/**
 * The two top bits of a length octet (RFC 1035 --4.1.4): `00` is a label length, `11` is a compression
 * pointer, `01` and `10` are reserved. The mask is one octet wide --the 16-bit form, `0xc000`, is what
 * the *writer* ORs into a pointer, and mixing the two up makes every pointer unreadable.
 */
const LABEL_KIND_MASK = 0xc0;

/** The 16-bit form the writer emits: `11` in the top two bits of the pointer word. */
const POINTER_WORD_MASK = 0xc000;

/**
 * RFC 6762 --6.7: a response to a query from a source port other than 5353 is a *legacy* unicast
 * response, and its TTLs "SHOULD NOT be greater than ten seconds" --the resolver that asked has no
 * cache-coherency protocol and would keep the record long after it stopped being true.
 */
export const LEGACY_UNICAST_TTL = 10;

/** 14 bits of pointer target, i.e. the largest offset a pointer can name. */
const MAX_POINTER_TARGET = 0x3fff;

/** Header size: ID, flags, and four section counts (RFC 1035 --4.1.1). */
const HEADER_BYTES = 12;

/** Flag bits of the second header word (RFC 1035 --4.1.1). */
export const FLAG = Object.freeze({
  QR: 0x8000,
  AA: 0x0400,
  TC: 0x0200,
  RD: 0x0100,
  RA: 0x0080,
});

/**
 * Every refusal this decoder can report, as a stable code.
 *
 * Codes are values, not exceptions: a caller can log "the LAN sent us 3 packets we refused, the last
 * one because a compression pointer did not point backwards" without a stack trace and without a
 * `try/catch` around a socket handler.
 */
export const REFUSAL = Object.freeze({
  NOT_A_MESSAGE: 'MDNS_NOT_A_MESSAGE',
  MESSAGE_TOO_LARGE: 'MDNS_MESSAGE_TOO_LARGE',
  TRUNCATED: 'MDNS_TRUNCATED',
  LABEL_TOO_LONG: 'MDNS_LABEL_TOO_LONG',
  LABEL_TYPE: 'MDNS_LABEL_TYPE',
  NAME_TOO_LONG: 'MDNS_NAME_TOO_LONG',
  POINTER_LOOP: 'MDNS_POINTER_LOOP',
  POINTER_HOPS: 'MDNS_POINTER_HOPS',
  RECORD_COUNT: 'MDNS_RECORD_COUNT',
  RDATA_LENGTH: 'MDNS_RDATA_LENGTH',
  INTERNAL: 'MDNS_INTERNAL',
});

/**
 * An invalid *argument* to an encoder.
 *
 * The decoder never throws --it refuses. The encoder does, because its input is our own data: writing
 * a packet we know to be malformed would put a lie on the wire where nobody is left to catch it.
 */
export class MdnsWireError extends Error {
  /**
   * @param {string} code Stable code, e.g. `MDNS_LABEL_TOO_LONG`.
   * @param {string} message What was wrong and, when known, which value.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'MdnsWireError';
    this.code = code;
  }
}

/** A refusal that the caller can branch on. Never thrown; always returned. */
function refuse(reason, detail = undefined) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

// ---------------------------------------------------------------------------------------------
// Name and address helpers
// ---------------------------------------------------------------------------------------------

/**
 * Lower-case a name and drop one trailing dot, for case-insensitive comparison.
 *
 * DNS names are case-insensitive (RFC 1035 --2.3.3) but the wire case is preserved everywhere else in
 * this module, because a DNS-SD *instance* name is a human-readable label and "Mac Studio" is not
 * "mac studio" to the person who reads it.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeName(name) {
  const text = typeof name === 'string' ? name : String(name ?? '');
  const trimmed = text.endsWith('.') ? text.slice(0, -1) : text;
  return trimmed.toLowerCase();
}

/**
 * Are these two names the same name, ignoring case and one trailing dot?
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function nameEquals(a, b) {
  return normalizeName(a) === normalizeName(b);
}

/** @param {number} type @returns {string} */
export function typeName(type) {
  return TYPE_NAME[type] ?? `TYPE${Number.isInteger(type) ? type : '?'}`;
}

/**
 * Split a dotted name into labels, refusing anything that cannot be encoded.
 *
 * Escape sequences (`\.`) are **not** parsed: a label containing a literal dot cannot be expressed by
 * this codec. See the module header of `src/agent/mdns.mjs` for why that is acceptable here and what
 * it costs.
 *
 * @param {unknown} name
 * @param {string} [what] What is being encoded, for the error message.
 * @returns {string[]} Labels, without the root label.
 */
export function splitName(name, what = 'name') {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new MdnsWireError(
      'MDNS_NAME_EMPTY',
      `${what} must be a non-empty string, got ${JSON.stringify(name)}`,
    );
  }
  const labels = (name.endsWith('.') ? name.slice(0, -1) : name).split('.');
  let encoded = 1; // the terminating zero octet
  for (const label of labels) {
    if (label === '') {
      throw new MdnsWireError('MDNS_NAME_EMPTY_LABEL', `${what} ${JSON.stringify(name)} has an empty label`);
    }
    const bytes = Buffer.byteLength(label, 'utf8');
    if (bytes > MAX_LABEL_BYTES) {
      throw new MdnsWireError(
        REFUSAL.LABEL_TOO_LONG,
        `${what} ${JSON.stringify(name)} has a ${bytes}-octet label; RFC 1035 --2.3.4 allows ${MAX_LABEL_BYTES}`,
      );
    }
    encoded += bytes + 1;
  }
  if (encoded > MAX_NAME_BYTES) {
    throw new MdnsWireError(
      REFUSAL.NAME_TOO_LONG,
      `${what} ${JSON.stringify(name)} encodes to ${encoded} octets; RFC 1035 --2.3.4 allows ${MAX_NAME_BYTES}`,
    );
  }
  return labels;
}

/**
 * `a.b.c.` --?encoded name, with no compression (a standalone helper for tests and for RDATA that must
 * not be compressed).
 *
 * @param {string} name
 * @param {{what?: string}} [options]
 * @returns {Buffer}
 */
export function encodeName(name, options = {}) {
  const labels = splitName(name, options.what);
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** `192.168.0.1` --?4 octets. Strict: four decimal octets, each 0-255, no shorthand. */
export function parseIpv4(text) {
  if (typeof text !== 'string')
    throw new MdnsWireError('MDNS_A_INVALID', `IPv4 address must be a string, got ${typeof text}`);
  const parts = text.trim().split('.');
  if (parts.length !== 4)
    throw new MdnsWireError('MDNS_A_INVALID', `${JSON.stringify(text)} is not four octets`);
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i]))
      throw new MdnsWireError('MDNS_A_INVALID', `${JSON.stringify(text)} has a non-numeric octet`);
    const value = Number(parts[i]);
    if (value > 255)
      throw new MdnsWireError('MDNS_A_INVALID', `${JSON.stringify(text)} has an octet above 255`);
    bytes[i] = value;
  }
  return bytes;
}

/** 4 octets --?dotted quad. */
export function formatIpv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/**
 * `2001:db8::1` --?16 octets, with `::` expansion and an embedded IPv4 tail.
 *
 * Hand-written rather than borrowed: `node:net` validates an IPv6 literal but does not hand back its
 * bytes, and the only other source of bytes would be a dependency this project does not take.
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function parseIpv6(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new MdnsWireError(
      'MDNS_AAAA_INVALID',
      `IPv6 address must be a non-empty string, got ${JSON.stringify(text)}`,
    );
  }
  let value = text.trim().toLowerCase();
  if (value.includes('%'))
    throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} carries a zone index, which is link-local only`);
  if (value.includes('.')) {
    // An embedded IPv4 tail (RFC 4291 --2.2): convert it to two groups and re-parse.
    const cut = value.lastIndexOf(':');
    if (cut === -1)
      throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} has an IPv4 tail but no IPv6 prefix`);
    const v4 = parseIpv4(value.slice(cut + 1));
    value = `${value.slice(0, cut)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} has more than one "::"`);
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  const groups = [];
  const push = (list) => {
    for (const group of list) {
      if (!/^[0-9a-f]{1,4}$/.test(group))
        throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} has a bad group ${JSON.stringify(group)}`);
      groups.push(Number.parseInt(group, 16));
    }
  };
  push(head);
  const headCount = groups.length;
  push(tail);
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1)
      throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} uses "::" but already has eight groups`);
    groups.splice(headCount, 0, ...new Array(missing).fill(0));
  }
  if (groups.length !== 8)
    throw new MdnsWireError('MDNS_AAAA_INVALID', `${text} has ${groups.length} groups, not eight`);
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

/**
 * 16 octets --?text, with the longest run of zero groups collapsed to `::` (RFC 5952 --4.2).
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function formatIpv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i));
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= 8; i += 1) {
    const isZero = i < 8 && groups[i] === 0;
    if (isZero && start === -1) start = i;
    if (!isZero && start !== -1) {
      const length = i - start;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }
  if (bestLength < 2) return groups.map((group) => group.toString(16)).join(':');
  const head = groups
    .slice(0, bestStart)
    .map((group) => group.toString(16))
    .join(':');
  const tail = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16))
    .join(':');
  return `${head}::${tail}`;
}

/** Does this IPv4 address look like something worth offering as a peer endpoint? */
export function isUsableUnicastIpv4(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    return false;
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224) return false; // this-network, loopback, multicast/reserved
  if (octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

/**
 * Read one (possibly compressed) name, with every guard the header documents.
 *
 * @param {Buffer} buffer Whole message; pointers are absolute offsets into it.
 * @param {number} start Offset of the first length octet.
 * @returns {{ok: true, name: string, next: number, hops: number, bytes: number}|{ok: false, reason: string, detail?: object}}
 *   `hops` is the number of compression pointers followed, which the caller folds into its counters.
 */
function readName(buffer, start) {
  const labels = [];
  let position = start;
  /** Offset just past the name in the *original* stream, which a pointer fixes once and for all. */
  let next = null;
  let hops = 0;
  let expanded = 1; // the terminating zero octet counts towards the 255 (RFC 1035 --2.3.4)

  for (;;) {
    if (position >= buffer.length) return refuse(REFUSAL.TRUNCATED, { at: position, reading: 'name' });
    const lengthByte = buffer[position];

    if ((lengthByte & LABEL_KIND_MASK) === LABEL_KIND_MASK) {
      if (position + 2 > buffer.length)
        return refuse(REFUSAL.TRUNCATED, { at: position, reading: 'pointer' });
      const target = ((lengthByte & 0x3f) << 8) | buffer[position + 1];
      if (next === null) next = position + 2;
      // The hop budget is checked before the backwards rule so that a *deep chain* of legal pointers
      // is refused as a budget overrun rather than being mistaken for a loop.
      if (hops >= MAX_POINTER_HOPS)
        return refuse(REFUSAL.POINTER_HOPS, { hops, target, limit: MAX_POINTER_HOPS });
      // RFC 1035 --4.1.4: a pointer names a *prior* occurrence. A pointer that does not go strictly
      // backwards is the only way to build a cycle, so it is refused as one. This is what makes
      // termination a property of the format rather than of the hop counter.
      if (target >= position) return refuse(REFUSAL.POINTER_LOOP, { target, position });
      hops += 1;
      position = target;
      continue;
    }

    // `01` and `10` are reserved label kinds (RFC 1035 --4.1.4 defines only `00` and `11`). A packet
    // using them is not something to guess at.
    if ((lengthByte & LABEL_KIND_MASK) !== 0)
      return refuse(REFUSAL.LABEL_TYPE, { octet: lengthByte, at: position });
    // Belt and braces: with the top two bits clear, `lengthByte` cannot exceed 63, so this branch is
    // unreachable today. It stays because the 63-octet label limit is a rule this decoder claims to
    // enforce, and a future edit that relaxes the mask above must not be able to relax this silently.
    if (lengthByte > MAX_LABEL_BYTES)
      return refuse(REFUSAL.LABEL_TOO_LONG, { labelBytes: lengthByte, at: position });
    if (lengthByte === 0) {
      if (next === null) next = position + 1;
      return { ok: true, name: labels.join('.'), next, hops, bytes: expanded };
    }
    if (position + 1 + lengthByte > buffer.length) {
      return refuse(REFUSAL.TRUNCATED, { at: position, labelBytes: lengthByte, reading: 'label' });
    }
    expanded += lengthByte + 1;
    if (expanded > MAX_NAME_BYTES) {
      return refuse(REFUSAL.NAME_TOO_LONG, { bytes: expanded, limit: MAX_NAME_BYTES, at: position });
    }
    labels.push(buffer.toString('utf8', position + 1, position + 1 + lengthByte));
    position += 1 + lengthByte;
  }
}

/**
 * Decode the RDATA of one record, by type.
 *
 * The caller has already checked that `rdata` is exactly `rdlength` octets and inside the buffer, so
 * every read here is bounded by construction; a *length* that does not match the type is still a
 * refusal, because a record we cannot read exactly is a record we must not report.
 *
 * @param {Buffer} buffer Whole message, for names inside RDATA.
 * @param {number} rdataStart
 * @param {number} rdataEnd
 * @param {number} type
 * @returns {{ok: true, value: object}|{ok: false, reason: string, detail?: object}}
 */
function readRdata(buffer, rdataStart, rdataEnd, type) {
  const length = rdataEnd - rdataStart;
  if (type === RECORD_TYPE.A) {
    if (length !== 4) return refuse(REFUSAL.RDATA_LENGTH, { type: 'A', length, expected: 4 });
    const bytes = buffer.subarray(rdataStart, rdataEnd);
    return { ok: true, value: { address: formatIpv4(bytes) } };
  }
  if (type === RECORD_TYPE.AAAA) {
    if (length !== 16) return refuse(REFUSAL.RDATA_LENGTH, { type: 'AAAA', length, expected: 16 });
    return { ok: true, value: { address: formatIpv6(buffer.subarray(rdataStart, rdataEnd)) } };
  }
  if (type === RECORD_TYPE.PTR) {
    if (length === 0) return refuse(REFUSAL.RDATA_LENGTH, { type: 'PTR', length, expected: 'a name' });
    const name = readName(buffer, rdataStart);
    if (!name.ok) return name;
    // RFC 1035 --4.1.4 permits PTR RDATA to be compressed, and mDNS implementations do it, so a
    // pointer is followed here (leniently) even though the encoder writes this name uncompressed.
    return { ok: true, value: { target: name.name } };
  }
  if (type === RECORD_TYPE.SRV) {
    if (length < 6) return refuse(REFUSAL.RDATA_LENGTH, { type: 'SRV', length, expected: 'at least 6' });
    const target = readName(buffer, rdataStart + 6);
    if (!target.ok) return target;
    if (target.next > rdataEnd)
      return refuse(REFUSAL.RDATA_LENGTH, { type: 'SRV', length, detail: 'target name runs past the rdata' });
    return {
      ok: true,
      value: {
        priority: buffer.readUInt16BE(rdataStart),
        weight: buffer.readUInt16BE(rdataStart + 2),
        port: buffer.readUInt16BE(rdataStart + 4),
        target: target.name,
      },
    };
  }
  if (type === RECORD_TYPE.TXT) {
    const strings = [];
    let position = rdataStart;
    while (position < rdataEnd) {
      const stringLength = buffer[position];
      position += 1;
      if (position + stringLength > rdataEnd)
        return refuse(REFUSAL.RDATA_LENGTH, { type: 'TXT', length, at: position });
      strings.push(buffer.toString('utf8', position, position + stringLength));
      position += stringLength;
    }
    return { ok: true, value: { txt: strings } };
  }
  return { ok: true, value: {} };
}

/**
 * Read one resource record.
 *
 * @param {Buffer} buffer
 * @param {number} offset Offset of the record's owner name.
 * @param {string} section `answer` | `authority` | `additional`.
 * @param {{stats: object}} context
 * @returns {{ok: true, record: object, next: number}|{ok: false, reason: string, detail?: object}}
 */
function readRecord(buffer, offset, section, context) {
  const name = readName(buffer, offset);
  if (!name.ok) return name;
  const fields = name.next;
  // NAME + TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2) = the 10 octets every record must have.
  if (fields + 10 > buffer.length)
    return refuse(REFUSAL.TRUNCATED, { at: fields, reading: `${section} record header` });
  const type = buffer.readUInt16BE(fields);
  const rrclass = buffer.readUInt16BE(fields + 2);
  const ttl = buffer.readUInt32BE(fields + 4);
  const rdlength = buffer.readUInt16BE(fields + 8);
  const rdataStart = fields + 10;
  const rdataEnd = rdataStart + rdlength;
  if (rdataEnd > buffer.length) {
    return refuse(REFUSAL.TRUNCATED, { at: rdataStart, rdlength, available: buffer.length - rdataStart });
  }

  const value = readRdata(buffer, rdataStart, rdataEnd, type);
  if (!value.ok) return value;

  context.stats.records_read += 1;
  context.stats.names_read += 1;
  if (name.hops > context.stats.pointer_hops_max) context.stats.pointer_hops_max = name.hops;
  return {
    ok: true,
    next: rdataEnd,
    record: {
      section,
      name: name.name,
      type,
      type_name: typeName(type),
      // RFC 6762 --10.2: the cache-flush bit is not part of the class and must be masked off.
      class: rrclass & 0x7fff,
      cache_flush: (rrclass & CACHE_FLUSH) !== 0,
      ttl,
      // TTL 0 is a goodbye (RFC 6762 --10.1), and it is a *value*, not an error: the consumers drop
      // the record when they see it.
      goodbye: ttl === 0,
      rdata: Buffer.from(buffer.subarray(rdataStart, rdataEnd)),
      offset,
      ...value.value,
    },
  };
}

/**
 * Decode one DNS/mDNS message.
 *
 * Never throws. A malformed, hostile or truncated packet is a refusal with a stable code.
 *
 * @param {unknown} buffer
 * @returns {{ok: true, message: object}|{ok: false, reason: string, detail?: object}}
 */
export function decodeMessage(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) return refuse(REFUSAL.NOT_A_MESSAGE, { got: typeof buffer });
    if (buffer.length < HEADER_BYTES)
      return refuse(REFUSAL.TRUNCATED, { bytes: buffer.length, reading: 'header' });
    if (buffer.length > MAX_MESSAGE_BYTES)
      return refuse(REFUSAL.MESSAGE_TOO_LARGE, { bytes: buffer.length, limit: MAX_MESSAGE_BYTES });

    const id = buffer.readUInt16BE(0);
    const flagsWord = buffer.readUInt16BE(2);
    const counts = {
      questions: buffer.readUInt16BE(4),
      answers: buffer.readUInt16BE(6),
      authorities: buffer.readUInt16BE(8),
      additionals: buffer.readUInt16BE(10),
    };
    const total = counts.questions + counts.answers + counts.authorities + counts.additionals;
    if (total > MAX_RECORDS) return refuse(REFUSAL.RECORD_COUNT, { total, limit: MAX_RECORDS });

    const context = { stats: { names_read: 0, records_read: 0, pointer_hops_max: 0 } };
    let offset = HEADER_BYTES;
    const questions = [];

    for (let index = 0; index < counts.questions; index += 1) {
      const name = readName(buffer, offset);
      if (!name.ok) return name;
      offset = name.next;
      if (offset + 4 > buffer.length) return refuse(REFUSAL.TRUNCATED, { at: offset, reading: 'question' });
      const qclass = buffer.readUInt16BE(offset + 2);
      questions.push({
        name: name.name,
        type: buffer.readUInt16BE(offset),
        class: qclass & 0x7fff,
        // RFC 6762 --5.4: the top bit of the class asks for a unicast reply ("QU").
        unicast_response: (qclass & UNICAST_RESPONSE) !== 0,
      });
      offset += 4;
      context.stats.names_read += 1;
      if (name.hops > context.stats.pointer_hops_max) context.stats.pointer_hops_max = name.hops;
    }

    const sections = [
      ['answer', counts.answers],
      ['authority', counts.authorities],
      ['additional', counts.additionals],
    ];
    const records = [];
    for (const [section, count] of sections) {
      for (let index = 0; index < count; index += 1) {
        const read = readRecord(buffer, offset, section, context);
        if (!read.ok) return read;
        offset = read.next;
        records.push(read.record);
      }
    }

    return {
      ok: true,
      message: {
        id,
        flags: {
          qr: (flagsWord & FLAG.QR) !== 0,
          opcode: (flagsWord >> 11) & 0x0f,
          aa: (flagsWord & FLAG.AA) !== 0,
          tc: (flagsWord & FLAG.TC) !== 0,
          rd: (flagsWord & FLAG.RD) !== 0,
          ra: (flagsWord & FLAG.RA) !== 0,
          rcode: flagsWord & 0x0f,
          word: flagsWord,
        },
        counts,
        questions,
        answers: records.filter((record) => record.section === 'answer'),
        authorities: records.filter((record) => record.section === 'authority'),
        additionals: records.filter((record) => record.section === 'additional'),
        records,
        // Bytes after the last record. Non-zero means the sender wrote something this parser does not
        // account for; it is reported rather than hidden, and never treated as a record.
        trailing_bytes: buffer.length - offset,
        stats: context.stats,
      },
    };
  } catch (error) {
    // The whole point of this decoder is that nothing escapes it. A bug below becomes a refusal.
    return refuse(REFUSAL.INTERNAL, { message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * {@link decodeMessage}, flattened to the message or `null`.
 *
 * @param {unknown} buffer
 * @returns {object|null}
 */
export function decodeMessageOrNull(buffer) {
  const decoded = decodeMessage(buffer);
  return decoded.ok ? decoded.message : null;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

/**
 * A message writer with a per-message name-compression suffix dictionary.
 *
 * Offsets are recorded for every suffix written at an offset a pointer could name (`<= 0x3fff`), which
 * is what makes the encoder compress the *owner names* and the PTR RDATA the way an mDNS peer expects
 * to receive them.
 *
 * @returns {object}
 */
function createWriter() {
  const parts = [];
  const suffixes = new Map();
  let length = 0;

  const push = (buffer) => {
    parts.push(buffer);
    length += buffer.length;
    return buffer;
  };

  return {
    get length() {
      return length;
    },
    writeUint8: (value) => push(Buffer.from([value & 0xff])),
    writeUint16: (value) => {
      const buffer = Buffer.alloc(2);
      buffer.writeUInt16BE(value & 0xffff, 0);
      return push(buffer);
    },
    writeUint32: (value) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(value >>> 0, 0);
      return push(buffer);
    },
    writeBytes: (buffer) => push(Buffer.from(buffer)),

    /**
     * Write one name, compressing from the dictionary when asked.
     *
     * @param {string} name
     * @param {{compress?: boolean, remember?: boolean, what?: string}} [options] `compress: false`
     *   writes every label (SRV RDATA must not be compressed); `remember: false` keeps the offsets out
     *   of the dictionary, so no later record can point *into* this name.
     */
    writeName(name, options = {}) {
      const compress = options.compress !== false;
      const remember = compress && options.remember !== false;
      const labels = splitName(name, options.what);
      for (let index = 0; index < labels.length; index += 1) {
        const suffix = labels.slice(index).join('.').toLowerCase();
        const known = compress ? suffixes.get(suffix) : undefined;
        if (known !== undefined && known <= MAX_POINTER_TARGET) {
          this.writeUint16(POINTER_WORD_MASK | known);
          return;
        }
        if (remember && length <= MAX_POINTER_TARGET && suffixes.size < MAX_COMPRESSION_ENTRIES) {
          suffixes.set(suffix, length);
        }
        const bytes = Buffer.from(labels[index], 'utf8');
        push(Buffer.from([bytes.length]));
        push(bytes);
      }
      push(Buffer.from([0]));
    },

    /** Write a length placeholder and hand back the buffer, so the caller can patch it. */
    reserveUint16() {
      return push(Buffer.alloc(2));
    },

    /** @param {Buffer} placeholder @param {number} value */
    patchUint16(placeholder, value) {
      placeholder.writeUInt16BE(value & 0xffff, 0);
    },

    toBuffer: () => Buffer.concat(parts, length),
  };
}

/**
 * Encode the RDATA of one record, either into the message or into a standalone buffer.
 *
 * Compression policy, and the reasoning behind it:
 *
 *   * **PTR RDATA is compressed.** It is a name, RFC 1035 --4.1.4 permits it, and every mDNS responder
 *     on a real LAN does it --a response that did not would be larger than the peers' own.
 *   * **SRV RDATA is not compressed.** RFC 1035 --4.1.4 lists the types whose RDATA may be compressed
 *     and SRV (RFC 2782) is not among them, which is the conservative reading every interoperating
 *     implementation follows. The *decoder* still follows a pointer there, because refusing a packet a
 *     peer legitimately built is worse than accepting one written in a style we would not choose.
 *
 * Two shapes come back, and the difference is not cosmetic: a name inside RDATA can only be compressed
 * against offsets that exist in the *message*, so PTR and SRV RDATA must be written straight into it
 * (`{inline: true}`) and A/AAAA/TXT/raw RDATA are built separately and appended.
 *
 * @param {object} writer
 * @param {object} record
 * @returns {{inline: true}|{bytes: Buffer}}
 */
function encodeRdata(writer, record) {
  const type = record.type;
  if (type === RECORD_TYPE.A) return { bytes: parseIpv4(record.address) };
  if (type === RECORD_TYPE.AAAA) return { bytes: parseIpv6(record.address) };
  if (type === RECORD_TYPE.PTR) {
    writer.writeName(record.target, { what: 'PTR target' });
    return { inline: true };
  }
  if (type === RECORD_TYPE.SRV) {
    writer.writeUint16(record.priority ?? 0);
    writer.writeUint16(record.weight ?? 0);
    writer.writeUint16(record.port ?? 0);
    writer.writeName(record.target, { compress: false, remember: false, what: 'SRV target' });
    return { inline: true };
  }
  if (type === RECORD_TYPE.TXT) return { bytes: encodeTxt(record) };
  if (Buffer.isBuffer(record.rdata)) return { bytes: record.rdata };
  throw new MdnsWireError(
    'MDNS_RDATA_UNSUPPORTED',
    `no encoder for ${typeName(type)} and no raw \`rdata\` was given`,
  );
}

/**
 * Encode a TXT RDATA: a sequence of length-prefixed character-strings, each at most 255 octets.
 *
 * An empty list is written as one zero-length string, which is the DNS-SD convention for "this service
 * has no attributes but does have a TXT record" (RFC 6763 --6.1).
 *
 * @param {object} record
 * @returns {Buffer}
 */
function encodeTxt(record) {
  const strings = Array.isArray(record.txt) ? record.txt.map((entry) => String(entry)) : [];
  const parts = [];
  for (const text of strings) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > 255)
      throw new MdnsWireError(
        'MDNS_TXT_TOO_LONG',
        `TXT string of ${bytes.length} octets; RFC 1035 --3.3.14 allows 255`,
      );
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  if (parts.length === 0) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * Build the second header word from a flags object.
 */
function encodeFlags(flags = {}) {
  let word = 0;
  if (flags.qr === true) word |= FLAG.QR;
  if (flags.aa === true) word |= FLAG.AA;
  if (flags.tc === true) word |= FLAG.TC;
  if (flags.rd === true) word |= FLAG.RD;
  if (flags.ra === true) word |= FLAG.RA;
  const opcode = Number.isInteger(flags.opcode) ? flags.opcode : 0;
  const rcode = Number.isInteger(flags.rcode) ? flags.rcode : 0;
  return word | ((opcode & 0x0f) << 11) | (rcode & 0x0f);
}

/**
 * Write one record into a message.
 *
 * @param {object} writer
 * @param {object} record
 * @param {string} section Section name, for diagnostics on a refusal.
 * @returns {void}
 */
function writeRecord(writer, record, section) {
  const type = typeof record.type === 'number' ? record.type : RECORD_TYPE[String(record.type).toUpperCase()];
  if (!Number.isInteger(type)) {
    throw new MdnsWireError(
      'MDNS_TYPE_UNKNOWN',
      `${section} record has no usable type: ${JSON.stringify(record.type)}`,
    );
  }
  const rrclass = Number.isInteger(record.class) ? record.class : DNS_CLASS_IN;
  const ttl = Number.isInteger(record.ttl) ? record.ttl : 0;
  if (ttl < 0 || ttl > 0xffffffff)
    throw new MdnsWireError('MDNS_TTL_RANGE', `ttl ${ttl} is outside 0..4294967295`);
  writer.writeName(record.name, { what: `${section} record owner` });
  writer.writeUint16(type);
  writer.writeUint16(rrclass | (record.cache_flush === true || record.cacheFlush === true ? CACHE_FLUSH : 0));
  writer.writeUint32(ttl);
  // The length has to precede the RDATA, but a compressed name inside the RDATA needs the offsets of
  // everything before it --so the RDATA is written into the message and the placeholder patched after.
  const placeholder = writer.reserveUint16();
  const before = writer.length;
  const rdata = encodeRdata(writer, { ...record, type });
  if (rdata.bytes !== undefined) writer.writeBytes(rdata.bytes);
  const length = writer.length - before;
  if (length > 0xffff)
    throw new MdnsWireError('MDNS_RDATA_TOO_LONG', `${section} record rdata is ${length} octets`);
  if (rdata.bytes !== undefined && rdata.bytes.length !== length) {
    throw new MdnsWireError(
      'MDNS_RDATA_MISCOUNT',
      `built ${rdata.bytes.length} octets of rdata but wrote ${length}`,
    );
  }
  writer.patchUint16(placeholder, length);
}

/**
 * Encode one DNS/mDNS message.
 *
 * @param {object} message `{id, flags, questions, answers, authorities, additionals}`.
 * @returns {Buffer}
 * @throws {MdnsWireError} When an argument cannot be encoded. Encoder input is our own data.
 */
export function encodeMessage(message = {}) {
  const writer = createWriter();
  const questions = Array.isArray(message.questions) ? message.questions : [];
  const sections = [
    ['answer', Array.isArray(message.answers) ? message.answers : []],
    ['authority', Array.isArray(message.authorities) ? message.authorities : []],
    ['additional', Array.isArray(message.additionals) ? message.additionals : []],
  ];
  writer.writeUint16(Number.isInteger(message.id) ? message.id : 0);
  writer.writeUint16(encodeFlags(message.flags));
  writer.writeUint16(questions.length);
  for (const [, records] of sections) writer.writeUint16(records.length);

  for (const question of questions) {
    writer.writeName(question.name, { what: 'question name' });
    writer.writeUint16(question.type ?? RECORD_TYPE.ANY);
    const qclass = Number.isInteger(question.class) ? question.class : DNS_CLASS_IN;
    writer.writeUint16(qclass | (question.unicast_response === true ? UNICAST_RESPONSE : 0));
  }
  for (const [section, records] of sections) {
    for (const record of records) writeRecord(writer, record, section);
  }

  const bytes = writer.toBuffer();
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new MdnsWireError(
      REFUSAL.MESSAGE_TOO_LARGE,
      `${bytes.length} octets; the cap is ${MAX_MESSAGE_BYTES}`,
    );
  }
  return bytes;
}

/**
 * Build a service-discovery query.
 *
 * RFC 6762 --5.1: a one-shot query MUST NOT be sent from source port 5353, because that port signals a
 * fully compliant querier. The caller owns the socket and therefore the source port; this function
 * only writes the message. RFC 6762 --18.1: the ID of a multicast query is zero.
 *
 * @param {{serviceType: string, type?: number, unicastResponse?: boolean, id?: number}} options
 * @returns {Buffer}
 */
export function encodeQuery(options) {
  const type = options.type ?? RECORD_TYPE.PTR;
  return encodeMessage({
    id: Number.isInteger(options.id) ? options.id : 0,
    // --18.3/--18.4/--18.5/--18.6: opcode 0, and the RD/RA/Z bits clear on transmission.
    flags: { qr: false, opcode: 0, aa: false, tc: false, rd: false, ra: false, rcode: 0 },
    questions: [
      {
        name: options.serviceType,
        type,
        class: DNS_CLASS_IN,
        unicast_response: options.unicastResponse === true,
      },
    ],
  });
}

/**
 * Build a response to a question, copying the question section.
 *
 * RFC 6762 --6.7: a response to a query from a source port other than 5353 ("legacy") MUST repeat the
 * query ID and the question. `legacy` therefore carries those two behaviours and the 10-second TTL cap
 * (see {@link capLegacyTtl}).
 *
 * @param {object} options
 * @param {object} options.query The decoded query.
 * @param {object[]} options.answers
 * @param {object[]} [options.additionals]
 * @param {boolean} [options.legacy]
 * @returns {Buffer}
 */
export function encodeResponse(options) {
  const { query, answers = [], additionals = [] } = options;
  const legacy = options.legacy === true;
  return encodeMessage({
    id: legacy && Number.isInteger(query?.id) ? query.id : 0,
    // --18.7: the AA bit is set on responses; there is no recursion and no error code in mDNS.
    flags: { qr: true, opcode: 0, aa: true, tc: false, rd: false, ra: false, rcode: 0 },
    questions:
      legacy && Array.isArray(query?.questions)
        ? query.questions.map((question) => ({ ...question, unicast_response: false }))
        : [],
    answers: answers.map((record) => withTtl(record, legacy)),
    // The additional section carries the records a peer needs next (SRV and TXT for a PTR answer, the
    // A record for an SRV answer). --10.2's cache-flush bit is *not* set for a legacy unicast response.
    additionals: additionals.map((record) => withTtl(record, legacy)),
  });
}

/**
 * Apply RFC 6762 --6.7's TTL cap and cache-flush rule to one record of a response.
 *
 * A legacy resolver is a plain DNS client with no cache-coherency protocol, so it must not be handed a
 * 75-minute TTL: "the resource record TTL given in a legacy unicast response SHOULD NOT be greater
 * than ten seconds". The cache-flush bit is meaningless there and MUST NOT be set.
 *
 * @param {object} record
 * @param {boolean} legacy
 * @returns {object}
 */
export function capLegacyTtl(record, legacy) {
  return withTtl(record, legacy);
}

/** @param {object} record @param {boolean} legacy @returns {object} */
function withTtl(record, legacy) {
  if (!legacy) return record;
  return { ...record, ttl: Math.min(Number(record.ttl) || 0, LEGACY_UNICAST_TTL), cache_flush: false };
}
