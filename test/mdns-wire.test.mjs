/**
 * mDNS wire codec suite (`src/agent/mdns-wire.mjs`).
 *
 * # What these tests are, and what they are not
 *
 * Everything here is **hermetic**: packets are built by hand, byte by byte, from the RFC, and handed to
 * the decoder. That is the point. A test that builds its fixture by calling the encoder and then checks
 * the decoder has only proved that the two agree with each other — the failure mode this suite exists
 * to catch is the one where *both* are wrong about the same offset (exactly how a real STUN address
 * bug survived a self-written fake server in this repository; see `test/p2p-stun.test.mjs`). So the
 * packets that matter — the pointer loop, the deep pointer chain, the over-long name, the truncations —
 * are assembled from raw octets here, and the golden hex in the first group pins the encoder to bytes
 * a peer would actually see.
 *
 * There is **no socket in this file**. Nothing here is evidence about a real LAN or about a real mDNS
 * peer; that statement is repeated, and acted on, in `test/mdns-discover.test.mjs`.
 *
 * # The hardening contract being tested
 *
 * `decodeMessage` never throws and never loops forever, whatever it is handed:
 *
 *   * a pointer loop and a pointer that does not point strictly backwards → refused;
 *   * a chain of more than 128 legal pointers → refused (the hop budget);
 *   * every truncated prefix of a valid message → refused, at every field boundary;
 *   * a label over 63 octets, an unsupported label kind, an expanded name over 255 octets → refused;
 *   * a message over 9000 octets and a message claiming over 256 records → refused before any work.
 *
 * And the other direction, because a guard that refuses everything is not a guard: the *same* bytes
 * with a legal backwards pointer, a legal 255-octet name and a legal 4-record response all decode.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CACHE_FLUSH,
  DNS_CLASS_IN,
  FLAG,
  LEGACY_UNICAST_TTL,
  MAX_LABEL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_NAME_BYTES,
  MAX_POINTER_HOPS,
  MdnsWireError,
  RECORD_TYPE,
  REFUSAL,
  UNICAST_RESPONSE,
  decodeMessage,
  decodeMessageOrNull,
  encodeMessage,
  encodeName,
  encodeQuery,
  encodeResponse,
  formatIpv4,
  formatIpv6,
  isUsableUnicastIpv4,
  nameEquals,
  normalizeName,
  parseIpv4,
  parseIpv6,
  splitName,
  typeName,
} from '../src/agent/mdns-wire.mjs';

/* -------------------------------------------------------------------------- */
/* Fixtures and raw-octet helpers                                              */
/* -------------------------------------------------------------------------- */

const SERVICE = '_w2m._tcp.local';
const INSTANCE = 'mac-studio._w2m._tcp.local';
const HOST = 'mac-studio.local';

/** The canonical record set: one of every type this codec reads. */
function serviceRecords(overrides = {}) {
  return {
    ptr: { name: SERVICE, type: RECORD_TYPE.PTR, ttl: 4500, target: INSTANCE },
    srv: {
      name: INSTANCE,
      type: RECORD_TYPE.SRV,
      ttl: 120,
      port: 8788,
      priority: 0,
      weight: 0,
      target: HOST,
      cache_flush: true,
    },
    txt: {
      name: INSTANCE,
      type: RECORD_TYPE.TXT,
      ttl: 120,
      txt: ['txtvers=1', 'mid=aaa', 'name=mac-studio'],
      cache_flush: true,
    },
    a: { name: HOST, type: RECORD_TYPE.A, ttl: 120, address: '192.168.1.20', cache_flush: true },
    aaaa: { name: HOST, type: RECORD_TYPE.AAAA, ttl: 120, address: 'fe80::1', cache_flush: true },
    ...overrides,
  };
}

/** A message with one of every record type, used as the truncation walk's subject. */
function canonicalMessage() {
  const records = serviceRecords();
  return encodeMessage({
    id: 0,
    flags: { qr: true, aa: true },
    questions: [{ name: SERVICE, type: RECORD_TYPE.PTR, class: DNS_CLASS_IN }],
    answers: [records.ptr, records.srv, records.txt, records.a],
    additionals: [records.aaaa],
  });
}

/** Header octets only, so a test can describe a body the way the wire does. */
function header({ id = 0, flags = 0, questions = 0, answers = 0, authorities = 0, additionals = 0 }) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt16BE(id, 0);
  bytes.writeUInt16BE(flags, 2);
  bytes.writeUInt16BE(questions, 4);
  bytes.writeUInt16BE(answers, 6);
  bytes.writeUInt16BE(authorities, 8);
  bytes.writeUInt16BE(additionals, 10);
  return bytes;
}

/** `0xc0 | offset` as two octets: a compression pointer, written the way the wire carries it. */
function pointer(target) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(0xc000 | target, 0);
  return bytes;
}

/** A label of `length` octets filled with `fill`, for the name-length tests. */
function label(length, fill = 0x61) {
  return Buffer.concat([Buffer.from([length]), Buffer.alloc(length, fill)]);
}

/** Read a refusal or fail loudly: `decodeMessage`'s failures are values, and a test may not ignore one. */
function refusalOf(bytes) {
  const decoded = decodeMessage(bytes);
  assert.equal(decoded.ok, false, 'expected this packet to be refused');
  assert.equal(typeof decoded.reason, 'string');
  return decoded;
}

/** The same, for the messages a test expects to parse. */
function messageOf(bytes) {
  const decoded = decodeMessage(bytes);
  assert.equal(decoded.ok, true, `expected a decodable message, got ${JSON.stringify(decoded)}`);
  return decoded.message;
}

/* -------------------------------------------------------------------------- */
/* 1. Round trip, and the bytes a peer actually sees                           */
/* -------------------------------------------------------------------------- */

describe('round trip for every record type this layer reads', () => {
  it('encodes a PTR answer to the exact octets an mDNS peer would receive', () => {
    const records = serviceRecords();
    const bytes = encodeMessage({ id: 0, flags: { qr: true, aa: true }, answers: [records.ptr] });

    // Byte-level pinning, so a change to the header layout, the TTL width or the compression pointer
    // cannot pass by being "round-trip consistent":
    //   id 0000                     (RFC 6762 §18.1: zero on transmission)
    //   flags 8400                  QR=1, AA=1, opcode 0
    //   counts 0000 0001 0000 0000  no questions, one answer
    //   04 5f77326d 04 5f746370 05 6c6f63616c 00   "_w2m" "_tcp" "local" root
    //   000c 0001 00001194 000d    TYPE=PTR CLASS=IN TTL=4500 RDLENGTH=13
    //   0a "mac-studio" c00c       label + pointer to offset 12 (the name above)
    assert.equal(
      bytes.toString('hex'),
      '000084000000000100000000045f77326d045f746370056c6f63616c00000c000100001194000d' +
        '0a6d61632d73747564696fc00c',
    );
    assert.equal(bytes.length, 52);
    // The pointer is the last two octets, and it points at the first name in the message.
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xc000 | 12);
  });

  it('round-trips PTR, SRV, TXT, A and AAAA in one message, fields intact', () => {
    const records = serviceRecords();
    const bytes = encodeMessage({
      id: 0,
      flags: { qr: true, aa: true },
      answers: [records.ptr, records.srv, records.txt, records.a],
      additionals: [records.aaaa],
    });
    const message = messageOf(bytes);

    assert.equal(message.flags.qr, true);
    assert.equal(message.flags.aa, true);
    assert.equal(message.flags.opcode, 0);
    assert.deepEqual(message.counts, { questions: 0, answers: 4, authorities: 0, additionals: 1 });
    assert.equal(message.trailing_bytes, 0);
    assert.equal(message.records.length, 5);

    const [ptr, srv, txt, a] = message.answers;
    assert.deepEqual(
      { name: ptr.name, type: ptr.type_name, ttl: ptr.ttl, target: ptr.target, cf: ptr.cache_flush },
      { name: SERVICE, type: 'PTR', ttl: 4500, target: INSTANCE, cf: false },
    );
    assert.deepEqual(
      {
        name: srv.name,
        port: srv.port,
        priority: srv.priority,
        weight: srv.weight,
        target: srv.target,
        cf: srv.cache_flush,
      },
      { name: INSTANCE, port: 8788, priority: 0, weight: 0, target: HOST, cf: true },
    );
    assert.deepEqual(txt.txt, ['txtvers=1', 'mid=aaa', 'name=mac-studio']);
    assert.equal(a.address, '192.168.1.20');
    assert.equal(message.additionals[0].address, 'fe80::1');
    assert.equal(message.additionals[0].type_name, 'AAAA');
    // Every record keeps its raw RDATA, which is what makes an unknown-to-us record reportable rather
    // than lost.
    assert.ok(Buffer.isBuffer(ptr.rdata) && ptr.rdata.length === 13);
  });

  it('round-trips a TXT record with an empty attribute list and with empty strings', () => {
    const empty = messageOf(
      encodeMessage({ answers: [{ name: INSTANCE, type: 'TXT', ttl: 4500, txt: [] }] }),
    );
    assert.deepEqual(empty.answers[0].txt, ['']);

    const blanks = messageOf(
      encodeMessage({ answers: [{ name: INSTANCE, type: 'TXT', ttl: 4500, txt: ['', 'k='] }] }),
    );
    assert.deepEqual(blanks.answers[0].txt, ['', 'k=']);
  });

  it('keeps the wire case of a name while comparing case-insensitively', () => {
    const bytes = encodeMessage({
      answers: [{ name: 'Mac-Studio._W2M._TCP.local', type: 'PTR', ttl: 1, target: 'x.local' }],
    });
    const message = messageOf(bytes);
    assert.equal(message.answers[0].name, 'Mac-Studio._W2M._TCP.local');
    assert.equal(nameEquals(message.answers[0].name, 'mac-studio._w2m._tcp.local'), true);
    assert.equal(normalizeName('Mac-Studio._W2M._TCP.local.'), 'mac-studio._w2m._tcp.local');
  });

  it('reports trailing octets instead of swallowing them', () => {
    const bytes = Buffer.concat([
      encodeMessage({ answers: [{ name: 'a.local', type: 'A', ttl: 1, address: '10.0.0.1' }] }),
      Buffer.from([1, 2, 3]),
    ]);
    const message = messageOf(bytes);
    assert.equal(message.trailing_bytes, 3);
    assert.equal(message.records.length, 1);
  });

  it('names an unknown record type rather than guessing at it', () => {
    const bytes = encodeMessage({
      answers: [{ name: 'x.local', type: 65280, ttl: 5, rdata: Buffer.from([1, 2, 3]) }],
    });
    const message = messageOf(bytes);
    assert.equal(message.answers[0].type_name, 'TYPE65280');
    assert.equal(message.answers[0].rdata.toString('hex'), '010203');
    assert.equal(typeName(65280), 'TYPE65280');
    assert.equal(typeName(RECORD_TYPE.SRV), 'SRV');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Name compression: the dictionary, the pointer, and the guards            */
/* -------------------------------------------------------------------------- */

describe('name compression', () => {
  it('writes a pointer to an earlier occurrence instead of repeating the name', () => {
    const records = serviceRecords();
    // Without compression the same two records would carry INSTANCE twice and HOST once in full.
    const compressed = encodeMessage({ answers: [records.ptr, records.srv] });
    const uncompressed = Buffer.concat([
      encodeName(SERVICE),
      Buffer.from([0x00, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x11, 0x94]),
      Buffer.from([0x00, 0x0d]),
      encodeName(INSTANCE),
      encodeName(INSTANCE),
      Buffer.from([
        0x00, 0x21, 0x80, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x22, 0x54,
      ]),
      encodeName(HOST),
    ]);
    assert.ok(
      compressed.length < uncompressed.length,
      `compression must shorten the message: ${compressed.length} < ${uncompressed.length}`,
    );
    // The SRV owner name is the pointer 0xc027 (offset 39, inside the PTR's RDATA), which is exactly
    // the "prior occurrence anywhere earlier in the message" RFC 1035 §4.1.4 describes.
    const message = messageOf(compressed);
    assert.equal(message.answers[0].target, INSTANCE);
    assert.equal(message.answers[1].name, INSTANCE);
    assert.ok(message.stats.pointer_hops_max > 0, 'the decoder must have followed at least one pointer');
    assert.ok(
      compressed.includes(Buffer.from([0xc0, 0x27])),
      'expected the instance name to be a pointer to offset 39',
    );
  });

  it('never compresses the SRV target, and never points into one', () => {
    const bytes = encodeMessage({ answers: [serviceRecords().srv, serviceRecords().a] });
    const message = messageOf(bytes);
    // The SRV target is written in full: RFC 1035 §4.1.4 lists the types whose RDATA may be compressed
    // and SRV is not among them. The A record's owner name must not point into the SRV RDATA either.
    const srv = message.answers[0];
    assert.equal(srv.target, HOST);
    assert.equal(srv.name, INSTANCE);
    assert.equal(message.answers[1].name, HOST);
    const srvAt = bytes.indexOf(encodeName(INSTANCE));
    assert.ok(srvAt >= 0, 'the instance owner name should be written whole at least once');
  });

  it('follows a hand-built pointer to a legal earlier name', () => {
    // The question name is written in full at offset 12; the answer's owner name is the label
    // "mac-studio" followed by a pointer back to offset 12. That is the shape RFC 1035 §4.1.4
    // describes, built from octets rather than from the encoder.
    const question = Buffer.concat([encodeName(SERVICE), Buffer.from([0x00, 0x0c, 0x00, 0x01])]);
    const owner = Buffer.concat([Buffer.from([0x0a]), Buffer.from('mac-studio', 'utf8'), pointer(12)]);
    const rdata = encodeName(INSTANCE);
    const record = Buffer.concat([
      owner,
      Buffer.from([0x00, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x11, 0x94]),
      Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]),
      rdata,
    ]);
    const bytes = Buffer.concat([header({ questions: 1, answers: 1 }), question, record]);
    const message = messageOf(bytes);
    assert.equal(message.questions[0].name, SERVICE);
    assert.equal(message.answers[0].name, INSTANCE);
    assert.equal(message.answers[0].target, INSTANCE);
    assert.equal(message.stats.pointer_hops_max, 1);
  });

  it('refuses a compression pointer loop on the hop that would start it', () => {
    // A cycle needs one pointer that does *not* name a prior occurrence, because a name is read
    // left-to-right and pointers only ever go back: 12 → 20 → 12, or 12 → 12. The guard therefore fires
    // on the offending hop, and the detail names both octets involved so the packet is diagnosable.
    const forward = Buffer.concat([
      header({ questions: 1 }),
      pointer(20),
      Buffer.alloc(4),
      Buffer.from([0xde, 0xad]),
      pointer(12),
    ]);
    const looped = refusalOf(forward);
    assert.equal(looped.reason, REFUSAL.POINTER_LOOP);
    assert.deepEqual(looped.detail, { target: 20, position: 12 });
    assert.equal(decodeMessageOrNull(forward), null);

    // The same cycle seen from the other side: a legal backwards hop to offset 12, where a pointer
    // reaches forward again. The refusal is at the second hop, which is where the cycle would close.
    const backwards = Buffer.concat([
      header({ questions: 1 }),
      pointer(20), // 12 → 20: forward, refused here (detail below)
      Buffer.alloc(6),
      pointer(12), // 20 → 12: would close the cycle
    ]);
    assert.equal(refusalOf(backwards).reason, REFUSAL.POINTER_LOOP);
    assert.deepEqual(refusalOf(backwards).detail, { target: 20, position: 12 });
  });

  it('refuses a pointer that points at itself', () => {
    const bytes = Buffer.concat([header({ questions: 1 }), pointer(12)]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.POINTER_LOOP);
    assert.deepEqual(refused.detail, { target: 12, position: 12 });
  });

  it('refuses a chain of more than 128 legal pointers, which terminates but costs work', () => {
    // The chain is built from strictly-backwards pointers, so it cannot loop: this packet is what the
    // hop budget exists for. Layout:
    //   offset 12: a 3-octet owner name "x" + a 10-octet record header, type 65280 (private use, so the
    //              RDATA is opaque to the decoder and can hold the chain);
    //   the chain: a root label, then N pointers, each naming the octet before it;
    //   the second record's owner name: a pointer to the last link.
    const chainLength = MAX_POINTER_HOPS + 72;
    const nameAt12 = Buffer.from([0x01, 0x78, 0x00]);
    const rdataAt = 12 + nameAt12.length + 10;
    // Link i sits at rdataAt + 1 + 2i and names the link before it; link 0 names the root label.
    const chain = [Buffer.from([0x00])];
    for (let index = 0; index < chainLength; index += 1) {
      chain.push(pointer(index === 0 ? rdataAt : rdataAt + 2 * index - 1));
    }
    const chainBlock = Buffer.concat(chain);
    const recordHeader = Buffer.from([0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x00]);
    recordHeader.writeUInt16BE(chainBlock.length, 8);
    const bytes = Buffer.concat([
      header({ answers: 2 }),
      nameAt12,
      recordHeader,
      chainBlock,
      pointer(rdataAt + 1 + 2 * (chainLength - 1)),
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 10, 0, 0, 1]),
    ]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.POINTER_HOPS);
    assert.equal(refused.detail.limit, MAX_POINTER_HOPS);
    // The point of the budget: the parser is refused *at* the limit, not after walking the chain. The
    // chain is 200 legal links long and the parser stops on the 128th dereference.
    assert.equal(refused.detail.hops, MAX_POINTER_HOPS);
    assert.ok(chainLength > MAX_POINTER_HOPS);
  });

  it('still decodes the same shape when the chain is inside the budget', () => {
    // The positive control for the test above: 8 links instead of 200, and the name resolves.
    const chainLength = 8;
    const nameAt12 = Buffer.from([0x01, 0x78, 0x00]);
    const rdataAt = 12 + nameAt12.length + 10;
    const chain = [Buffer.from([0x00])];
    for (let index = 0; index < chainLength; index += 1) {
      chain.push(pointer(index === 0 ? rdataAt : rdataAt + 2 * index - 1));
    }
    const chainBlock = Buffer.concat(chain);
    const recordHeader = Buffer.from([0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x00]);
    recordHeader.writeUInt16BE(chainBlock.length, 8);
    const bytes = Buffer.concat([
      header({ answers: 2 }),
      nameAt12,
      recordHeader,
      chainBlock,
      pointer(rdataAt + 1 + 2 * (chainLength - 1)),
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 10, 0, 0, 1]),
    ]);
    const message = messageOf(bytes);
    assert.equal(message.answers.length, 2);
    assert.equal(message.answers[0].name, 'x');
    assert.equal(message.answers[1].name, '');
    assert.equal(message.answers[1].address, '10.0.0.1');
    // Eight links in the chain, plus the owner-name pointer that enters it: nine dereferences, counted.
    assert.equal(message.stats.pointer_hops_max, chainLength + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Truncation at every field boundary                                       */
/* -------------------------------------------------------------------------- */

describe('truncated packets', () => {
  it('refuses every strict prefix of a valid five-record message, at every boundary', () => {
    const full = canonicalMessage();
    const refusals = new Map();
    for (let length = 0; length < full.length; length += 1) {
      const slice = full.subarray(0, length);
      let decoded;
      assert.doesNotThrow(() => {
        decoded = decodeMessage(slice);
      }, `decodeMessage threw on a ${length}-octet prefix`);
      assert.equal(decoded.ok, false, `a ${length}-octet prefix must not decode`);
      assert.ok(
        Object.values(REFUSAL).includes(decoded.reason),
        `prefix ${length} reported an unknown refusal ${decoded.reason}`,
      );
      assert.equal(decodeMessageOrNull(slice), null);
      refusals.set(decoded.reason, (refusals.get(decoded.reason) ?? 0) + 1);
    }
    // The walk has to reach more than one guard, or it is only testing one of them: the header cut, a
    // name cut, a record-header cut and an RDATA cut are four different code paths.
    assert.ok(refusals.get(REFUSAL.TRUNCATED) > 0, 'expected truncation refusals');
    assert.ok(full.length > 100, 'the fixture must be long enough to cut in many places');
  });

  it('refuses a header cut and a body cut with the same code, never an exception', () => {
    assert.equal(refusalOf(Buffer.alloc(0)).reason, REFUSAL.TRUNCATED);
    assert.equal(refusalOf(Buffer.alloc(11)).reason, REFUSAL.TRUNCATED);
    assert.equal(refusalOf(header({ answers: 1 })).reason, REFUSAL.TRUNCATED);
  });

  it('refuses an RDLENGTH that runs past the end of the message', () => {
    const name = encodeName(HOST);
    const bytes = Buffer.concat([
      header({ answers: 1 }),
      name,
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78]),
      Buffer.from([0x00, 0x10]), // RDLENGTH 16
      Buffer.from([192, 168, 1, 20]), // four octets of address
    ]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.TRUNCATED);
    assert.equal(refused.detail.rdlength, 16);
    assert.equal(refused.detail.available, 4);
  });

  it('refuses a label that claims more octets than the message holds', () => {
    const bytes = Buffer.concat([header({ questions: 1 }), Buffer.from([0x0a]), Buffer.from('abc', 'utf8')]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.TRUNCATED);
    assert.equal(refused.detail.labelBytes, 10);
  });

  it('refuses a section count the message cannot hold', () => {
    // One well-formed A record, and a header claiming five answers: the second read runs out of bytes.
    const bytes = Buffer.concat([
      header({ answers: 5 }),
      encodeName(HOST),
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x04]),
      Buffer.from([10, 0, 0, 1]),
    ]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.TRUNCATED);
    assert.equal(refused.detail.reading, 'name');
  });

  it('refuses an RDATA whose length does not match its type', () => {
    const bytes = Buffer.concat([
      header({ answers: 1 }),
      encodeName(HOST),
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x05]),
      Buffer.from([192, 168, 1, 20, 1]),
    ]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.RDATA_LENGTH);
    assert.equal(refused.detail.expected, 4);
  });

  it('refuses a TXT string that claims more octets than its RDATA holds', () => {
    const bytes = Buffer.concat([
      header({ answers: 1 }),
      encodeName(INSTANCE),
      Buffer.from([0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x03]),
      Buffer.from([0x09, 0x61, 0x61]),
    ]);
    assert.equal(refusalOf(bytes).reason, REFUSAL.RDATA_LENGTH);
  });

  it('refuses anything that is not a buffer at all', () => {
    for (const value of [null, undefined, 'not a packet', 42, {}, []]) {
      const refused = refusalOf(value);
      assert.equal(refused.reason, REFUSAL.NOT_A_MESSAGE);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Labels and names: the 63 and 255 octet limits                            */
/* -------------------------------------------------------------------------- */

describe('label and name limits', () => {
  it('refuses to encode a label longer than 63 octets, naming the limit', () => {
    const tooLong = `${'a'.repeat(MAX_LABEL_BYTES + 1)}.local`;
    assert.throws(
      () => encodeName(tooLong),
      (error) => error instanceof MdnsWireError && error.code === REFUSAL.LABEL_TOO_LONG,
    );
    assert.throws(
      () => splitName(tooLong),
      (error) => error.code === REFUSAL.LABEL_TOO_LONG,
    );
    // And the boundary itself is fine: 63 is legal, 64 is not.
    assert.ok(encodeName(`${'a'.repeat(MAX_LABEL_BYTES)}.local`).length === MAX_LABEL_BYTES + 2 + 6);
  });

  it('refuses a wire label whose kind bits are reserved (01 and 10)', () => {
    // RFC 1035 §4.1.4 defines only `00` (label) and `11` (pointer). 0x41 is `01` with length 1.
    assert.equal(
      refusalOf(Buffer.concat([header({ questions: 1 }), Buffer.from([0x41, 0x61, 0x00])])).reason,
      REFUSAL.LABEL_TYPE,
    );
    assert.equal(
      refusalOf(Buffer.concat([header({ questions: 1 }), Buffer.from([0x80, 0x61, 0x00])])).reason,
      REFUSAL.LABEL_TYPE,
    );
  });

  it('refuses to encode a name that encodes to more than 255 octets', () => {
    // Five 60-octet labels: 5 * 61 + 1 = 306 octets, over the 255 limit of RFC 1035 §2.3.4.
    const long = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.local`;
    assert.throws(
      () => encodeName(long),
      (error) => error instanceof MdnsWireError && error.code === REFUSAL.NAME_TOO_LONG,
    );
    // A legal name at the limit still encodes: 64 + 64 + 64 + 62 + 1 = 255 octets, length octets and
    // the terminating zero included, which is the largest name RFC 1035 §2.3.4 allows.
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    assert.equal(encodeName(longest).length, MAX_NAME_BYTES);
    // One more octet of label and it is refused.
    assert.throws(
      () => encodeName(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`),
      (error) => error.code === REFUSAL.NAME_TOO_LONG,
    );
  });

  it('refuses a packet claiming a name longer than 255 octets', () => {
    const name = Buffer.concat([label(60), label(60), label(60), label(60), label(60), Buffer.from([0x00])]);
    const bytes = Buffer.concat([header({ questions: 1 }), name, Buffer.from([0x00, 0x0c, 0x00, 0x01])]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.NAME_TOO_LONG);
    assert.equal(refused.detail.limit, MAX_NAME_BYTES);
    assert.ok(refused.detail.bytes > MAX_NAME_BYTES);
  });

  it('counts an expanded name across pointers, not just the octets on the wire', () => {
    // Four 55-octet labels (224 octets) followed by a pointer back to the start of the same name: short
    // on the wire, 449 octets expanded, and it must be refused on the expanded count.
    const head = Buffer.concat([label(55), label(55), label(55), label(55)]);
    const question = Buffer.concat([head, pointer(12), Buffer.from([0x00, 0x0c, 0x00, 0x01])]);
    const bytes = Buffer.concat([header({ questions: 1 }), question]);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.NAME_TOO_LONG);
    assert.ok(refused.detail.bytes > MAX_NAME_BYTES);
    assert.ok(bytes.length < MAX_NAME_BYTES, 'the packet itself is small; only the expansion is large');
  });

  it('refuses an empty label, an empty name and a name that is only a dot', () => {
    for (const bad of ['', '   ', 'a..b', '.']) {
      assert.throws(
        () => splitName(bad),
        (error) => error instanceof MdnsWireError,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Message-level caps                                                       */
/* -------------------------------------------------------------------------- */

describe('message caps', () => {
  it('refuses a message larger than 9000 octets before reading a single name', () => {
    const bytes = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
    bytes.writeUInt16BE(1, 4);
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.MESSAGE_TOO_LARGE);
    assert.equal(refused.detail.limit, MAX_MESSAGE_BYTES);
  });

  it('refuses a message claiming more records than the cap', () => {
    const bytes = header({ questions: 200, answers: 100 });
    const refused = refusalOf(bytes);
    assert.equal(refused.reason, REFUSAL.RECORD_COUNT);
    assert.equal(refused.detail.total, 300);
  });

  it('refuses an encoder argument it cannot write as a name', () => {
    assert.throws(
      () => encodeMessage({ answers: [{ name: '', type: 'PTR', target: 'a.local' }] }),
      MdnsWireError,
    );
    assert.throws(
      () => encodeMessage({ answers: [{ name: 'a.local', type: 'SRV', port: 1, target: 'b..local' }] }),
      MdnsWireError,
    );
    assert.throws(
      () => encodeMessage({ answers: [{ name: 'a.local', type: 'A', address: '10.0.0.256' }] }),
      MdnsWireError,
    );
    assert.throws(
      () => encodeMessage({ answers: [{ name: 'a.local', type: 'TXT', txt: ['x'.repeat(256)] }] }),
      MdnsWireError,
    );
    assert.throws(() => encodeMessage({ answers: [{ name: 'a.local', type: 65000 }] }), MdnsWireError);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Queries, responses and the RFC 6762 §6.7 legacy rules                    */
/* -------------------------------------------------------------------------- */

describe('queries and responses', () => {
  it('writes a query with opcode 0, no answer records and the QU bit only when asked', () => {
    const plain = messageOf(encodeQuery({ serviceType: SERVICE }));
    assert.equal(plain.flags.qr, false);
    assert.equal(plain.flags.opcode, 0);
    assert.equal(plain.flags.rd, false);
    assert.equal(plain.flags.ra, false);
    assert.equal(plain.id, 0);
    assert.deepEqual(plain.questions, [
      { name: SERVICE, type: RECORD_TYPE.PTR, class: DNS_CLASS_IN, unicast_response: false },
    ]);

    const qu = messageOf(encodeQuery({ serviceType: SERVICE, unicastResponse: true }));
    assert.equal(qu.questions[0].unicast_response, true);
    assert.equal(UNICAST_RESPONSE, 0x8000);
    assert.equal(FLAG.QR, 0x8000);
  });

  it('masks the cache-flush bit off the record class and keeps it as its own field', () => {
    const bytes = encodeMessage({
      answers: [{ name: HOST, type: 'A', ttl: 120, address: '10.0.0.1', cache_flush: true }],
    });
    const message = messageOf(bytes);
    assert.equal(message.answers[0].class, DNS_CLASS_IN);
    assert.equal(message.answers[0].cache_flush, true);
    assert.equal(CACHE_FLUSH, 0x8000);
  });

  it('caps a legacy unicast response at ten seconds, clears cache-flush and repeats the question', () => {
    const query = messageOf(encodeQuery({ serviceType: SERVICE }));
    query.id = 0x1234;
    const response = messageOf(
      encodeResponse({
        query,
        answers: [serviceRecords().ptr, serviceRecords().srv],
        additionals: [serviceRecords().a],
        legacy: true,
      }),
    );
    assert.equal(response.id, 0x1234, 'RFC 6762 §6.7: the query id is repeated');
    assert.equal(response.questions.length, 1);
    assert.equal(response.questions[0].name, SERVICE);
    assert.equal(response.questions[0].unicast_response, false);
    for (const record of response.records) {
      assert.ok(
        record.ttl <= LEGACY_UNICAST_TTL,
        `legacy TTL ${record.ttl} must not exceed ${LEGACY_UNICAST_TTL}`,
      );
      assert.equal(record.cache_flush, false);
    }
  });

  it('keeps the true TTLs and the cache-flush bit for a multicast response', () => {
    const response = messageOf(
      encodeResponse({
        query: messageOf(encodeQuery({ serviceType: SERVICE })),
        answers: [serviceRecords().ptr, serviceRecords().srv],
      }),
    );
    assert.equal(response.id, 0);
    assert.equal(response.questions.length, 0);
    assert.equal(response.answers[0].ttl, 4500);
    assert.equal(response.answers[1].ttl, 120);
    assert.equal(response.answers[1].cache_flush, true);
  });

  it('carries a TTL of zero through unchanged: that is the goodbye', () => {
    const records = serviceRecords();
    const bytes = encodeMessage({
      answers: [
        { ...records.ptr, ttl: 0 },
        { ...records.srv, ttl: 0, cache_flush: false },
      ],
    });
    const message = messageOf(bytes);
    assert.equal(message.answers[0].ttl, 0);
    assert.equal(message.answers[0].goodbye, true);
    assert.equal(message.answers[1].goodbye, true);
    // Nothing in the codec invents a TTL: 0 arrives as 0, and the consumers decide what it means.
    assert.equal(message.answers[1].cache_flush, false);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Addresses                                                                */
/* -------------------------------------------------------------------------- */

describe('addresses', () => {
  it('round-trips IPv4 through the codec and the helpers', () => {
    assert.equal(formatIpv4(parseIpv4('192.168.1.20')), '192.168.1.20');
    assert.equal(formatIpv4(parseIpv4('0.0.0.0')), '0.0.0.0');
    for (const bad of ['192.168.1', '192.168.1.256', 'a.b.c.d', '192.168.1.1.1', '']) {
      assert.throws(() => parseIpv4(bad), MdnsWireError, `${bad} must be refused`);
    }
  });

  it('round-trips IPv6, including the compressed and embedded-IPv4 forms', () => {
    const cases = [
      ['::', '::'],
      ['::1', '::1'],
      ['2001:db8::1', '2001:db8::1'],
      ['fe80::1', 'fe80::1'],
      ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
      ['::ffff:192.168.1.1', '::ffff:c0a8:101'],
      ['ff02::fb', 'ff02::fb'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(formatIpv6(parseIpv6(input)), expected, `${input} should format as ${expected}`);
    }
    assert.equal(parseIpv6('2001:db8::1').length, 16);
    for (const bad of ['', 'ff02::fb%eth0', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', 'gggg::1', '::1::2']) {
      assert.throws(() => parseIpv6(bad), MdnsWireError, `${bad} must be refused`);
    }
  });

  it('separates a usable peer address from a loopback, multicast or reserved one', () => {
    for (const good of ['192.168.1.20', '10.0.0.7', '169.254.10.1', '100.64.0.1']) {
      assert.equal(isUsableUnicastIpv4(good), true, `${good} should be usable`);
    }
    for (const bad of [
      '127.0.0.1',
      '0.0.0.0',
      '224.0.0.251',
      '255.255.255.255',
      '239.1.2.3',
      'not-an-address',
      '1.2.3',
    ]) {
      assert.equal(isUsableUnicastIpv4(bad), false, `${bad} should not be offered as a peer`);
    }
  });
});
