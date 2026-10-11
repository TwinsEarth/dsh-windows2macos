/**
 * mDNS discovery suite: the responder, the record cache, the reassembly, and the rule.
 *
 * # What is tested, and what a pass here does *not* mean
 *
 * Three layers, and the boundary between them matters more than any single assertion:
 *
 *   1. **Hermetic.** The record cache, the reassembly, the candidate description and the dispatch rule
 *      are pure functions of records this file builds. Nothing here touches a socket, and these tests
 *      are the ones that would run identically on a machine with no network at all.
 *   2. **Loopback socket.** A responder and a scan are wired together over real UDP on `127.0.0.1`, with
 *      the multicast group replaced by a loopback address so that **no packet leaves this host**. This
 *      proves the query/response path, the reply addressing rules and the TTL=0 goodbye are real, and it
 *      is why these tests bind and send rather than mocking `dgram`.
 *   3. **Tool wiring.** `w2m_devices` is driven through `plugin.apply()` to prove the discovery block is
 *      actually exposed 鈥?and, on whatever network the machine happens to be on, that no candidate is
 *      ever presented as verified or as a dispatch target the relay has not listed.
 *
 * **A loopback socket is not evidence about a real LAN.** It says nothing about whether multicast works
 * on this host, whether a switch forwards 224.0.0.251, whether a corporate WLAN filters it, whether a
 * Wi-Fi access point rate-limits multicast, or whether a peer's mDNS responder answers our query shape.
 * A green run here means the code does what it says on one host; the only real evidence is a scan on the
 * network in question, and the honest place to look for it is `w2m_devices`'s `discovery` block on that
 * machine. The multicast membership test below asserts only that *both* outcomes are reported, because
 * on a real host either outcome is normal.
 *
 * Where a socket test cannot run (a sandbox that refuses UDP, a Windows policy, a container with no
 * loopback bind), it **skips with the reason** rather than passing vacuously: a test that asserts
 * nothing is worse than a test that is missing, because it reports success.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_SERVICE_TYPE,
  DEFAULT_TTL_SECONDS,
  GOODBYE_TTL,
  MDNS_GROUP,
  MDNS_PORT,
  buildServiceRecords,
  bindUdpSocket,
  closeSocket,
  createRecordCache,
  createResponder,
  discoverServices,
  listIPv4Interfaces,
  localHostLabel,
  parseServiceInstances,
  serviceFqdn,
  splitInstanceFqdn,
  toHostFqdn,
  txtMap,
} from '../src/agent/mdns.mjs';
import { RECORD_TYPE, decodeMessage, encodeMessage, encodeQuery } from '../src/agent/mdns-wire.mjs';
import {
  DISPATCH_REFUSAL,
  DISCOVERY_SOURCE,
  buildRelayIndex,
  createDiscoverySource,
  describeDiscovered,
  describeDiscoveredCandidate,
  dispatchRefusal,
  dispatchableCandidates,
  mayDispatchTo,
  mergeRosterView,
} from '../src/plugin/mdns-discover.mjs';
import * as plugin from '../src/plugin/tools.mjs';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const INSTANCE = 'mac-studio';
const INSTANCE_FQDN = serviceFqdn(INSTANCE, DEFAULT_SERVICE_TYPE);
const HOST = 'mac-studio.local';
const ADDRESS = '192.168.1.20';

/** The relay roster: one live machine, one expired, and one this host is. */
const RELAY_RECORDS = [
  { machine_id: 'aaa', machine_name: 'mac-studio', state: 'online', online: true },
  { machine_id: 'bbb', machine_name: 'win-laptop', state: 'expired', online: false },
];
const LOCAL_MACHINE_ID = 'zzz';

/**
 * The leading code of a refusal message, so the assertions compare against the module's own constants
 * rather than against a copy of the string that could drift away from them.
 */
function refusalCode(value) {
  return String(value ?? '').split(':')[0];
}

/**
 * A decoded record, in the shape the cache and the reassembly both take.
 *
 * The RDATA is the record's *identity* inside the cache, so a hand-built fixture has to carry a real
 * one: two A records for different addresses are two records, and a helper that gave them both an empty
 * RDATA would silently collapse them into one and hide the bug it was meant to catch (it did, once).
 */
function decoded(record, section = 'answer') {
  const merged = { section, ttl: 0, cache_flush: false, ...record };
  if (!Buffer.isBuffer(merged.rdata) || merged.rdata.length === 0) {
    merged.rdata = Buffer.from(
      JSON.stringify([
        merged.type,
        merged.port ?? null,
        merged.address ?? null,
        merged.target ?? null,
        merged.txt ?? null,
      ]),
    );
  }
  return merged;
}

/** A full announcement's records, as the wire carries them. */
function announcementRecords(overrides = {}) {
  return buildServiceRecords({
    instance: INSTANCE,
    host: HOST,
    servicePort: 8788,
    address: ADDRESS,
    machineId: 'aaa',
    machineName: 'mac-studio',
    ...overrides,
  });
}

/** Feed a set of encoded records through the codec, so the tests work on what a peer would see. */
function throughTheWire(records) {
  const bytes = encodeMessage({ flags: { qr: true, aa: true }, answers: records });
  const decodedMessage = decodeMessage(bytes);
  assert.equal(decodedMessage.ok, true, 'the fixture must be encodable');
  return decodedMessage.message.records;
}

/** One reassembled mDNS instance, in the shape `discoverServices` returns. */
function instanceView(overrides = {}) {
  return {
    instance: INSTANCE_FQDN,
    name: INSTANCE,
    service_type: DEFAULT_SERVICE_TYPE,
    host: HOST,
    port: 8788,
    priority: 0,
    weight: 0,
    addresses: [ADDRESS],
    observed_address: ADDRESS,
    txt: {
      raw: ['txtvers=1', 'mid=aaa', 'name=mac-studio'],
      map: { txtvers: '1', mid: 'aaa', name: 'mac-studio' },
    },
    ttl: { ptr: 4500, srv: 120, txt: 4500 },
    advertised_via_ptr: true,
    saw_srv: true,
    saw_txt: true,
    superseded_srv: 0,
    updated_at: 10,
    ...overrides,
  };
}

/** A free TCP/UDP port on loopback, found by binding and releasing it. */
async function freeLoopbackPort() {
  const socket = await bindUdpSocket({ address: '127.0.0.1', port: 0 });
  const port = socket.address().port;
  await closeSocket(socket);
  return port;
}

/** Sockets and responders a test opened, closed even when an assertion fails. */
const cleanup = [];
after(async () => {
  for (const entry of cleanup.splice(0)) {
    try {
      await entry();
    } catch {
      /* the assertion that failed is the one worth reporting */
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 1. The record cache: last writer wins, and every TTL is honoured            */
/* -------------------------------------------------------------------------- */

describe('record cache', () => {
  it('lets the later SRV win when a device moves during a scan', () => {
    let clock = 1_000;
    const cache = createRecordCache({ now: () => clock });
    const srv = (port) =>
      decoded({
        name: INSTANCE_FQDN,
        type: RECORD_TYPE.SRV,
        ttl: 120,
        port,
        target: HOST,
        cache_flush: true,
      });

    cache.apply(srv(8788), { at: 1_000 });
    clock = 1_100;
    cache.apply(srv(9999), { at: 1_100 });

    // The rule this replaces is "first writer wins" / "keep the first non-zero port", which would leave
    // a peer addressing the port the device had when the scan started. There is no such rule here: the
    // newer announcement replaces the older one, and the flush bit removes the RRset it belonged to.
    const instances = parseServiceInstances(cache.live(), { serviceType: DEFAULT_SERVICE_TYPE }).instances;
    assert.equal(instances.length, 1);
    assert.equal(instances[0].port, 9999);
    assert.equal(cache.live().filter((entry) => entry.record.type === RECORD_TYPE.SRV).length, 1);

    // Without the flush bit the same rule still holds, and the loser is *counted* rather than hidden.
    const loose = createRecordCache({ now: () => clock });
    loose.apply(srv(8788), { at: 1_000 });
    loose.apply({ ...srv(9999), cache_flush: false }, { at: 1_100 });
    const looseInstances = parseServiceInstances(loose.live(), {
      serviceType: DEFAULT_SERVICE_TYPE,
    }).instances;
    assert.equal(looseInstances[0].port, 9999);
    assert.equal(looseInstances[0].superseded_srv, 1);
  });

  it('takes the newest arrival in either order, with no first-wins special case', () => {
    const srv = (port, flush) =>
      decoded({
        name: INSTANCE_FQDN,
        type: RECORD_TYPE.SRV,
        ttl: 120,
        port,
        target: HOST,
        cache_flush: flush,
      });
    const forwards = createRecordCache({ now: () => 0 });
    forwards.apply(srv(8788, false), { at: 1 });
    forwards.apply(srv(9999, false), { at: 2 });
    assert.equal(parseServiceInstances(forwards.live(), {}).instances[0].port, 9999);

    const backwards = createRecordCache({ now: () => 0 });
    backwards.apply(srv(9999, false), { at: 1 });
    backwards.apply(srv(8788, false), { at: 2 });
    assert.equal(parseServiceInstances(backwards.live(), {}).instances[0].port, 8788);
  });

  it('honours each record TTL, so a moved device does not survive its own announcement', () => {
    let clock = 5_000;
    const cache = createRecordCache({ now: () => clock });
    const a = (address) => decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 120, address, cache_flush: true });
    cache.apply(a(ADDRESS), { at: 5_000 });
    assert.equal(cache.live().length, 1);

    clock = 5_000 + 119_000;
    assert.equal(cache.live().length, 1, 'still inside its TTL');
    clock = 5_000 + 120_001;
    assert.equal(cache.live().length, 0, 'one millisecond past its TTL and it is gone');
  });

  it('expires a one-second TTL in a single second', () => {
    let clock = 0;
    const cache = createRecordCache({ now: () => clock });
    cache.apply(decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 1, address: ADDRESS }), { at: 0 });
    clock = 999;
    assert.equal(cache.live().length, 1);
    clock = 1_001;
    assert.equal(cache.live().length, 0);
  });

  it('drops a record on a TTL=0 goodbye', () => {
    const cache = createRecordCache({ now: () => 0 });
    for (const record of throughTheWire(announcementRecords())) cache.apply(record, { at: 0 });
    assert.equal(cache.live().length, 4);

    const applied = cache.apply(
      decoded({ name: INSTANCE_FQDN, type: RECORD_TYPE.SRV, ttl: 0, port: 8788, target: HOST }),
      { at: 10 },
    );
    assert.equal(applied.action, 'goodbye');
    assert.ok(applied.flushed >= 1);
    assert.equal(
      cache.live().some((entry) => entry.record.type === RECORD_TYPE.SRV),
      false,
      'the SRV record is gone',
    );
    // The goodbye names one record set; the PTR and TXT for the same instance are untouched, which is
    // what makes a per-record goodbye a per-record statement.
    assert.equal(cache.live().length, 3);
  });

  it('clears an older address when a cache-flush record carries new rdata', () => {
    const cache = createRecordCache({ now: () => 0 });
    cache.apply(decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 120, address: ADDRESS, cache_flush: true }), {
      at: 0,
    });
    cache.apply(
      decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 120, address: '192.168.1.77', cache_flush: true }),
      { at: 1 },
    );
    const addresses = cache.live().map((entry) => entry.record.address);
    assert.deepEqual(addresses, ['192.168.1.77']);
  });

  it('keeps several addresses when the peer does not ask for a flush', () => {
    const cache = createRecordCache({ now: () => 0 });
    cache.apply(decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 120, address: ADDRESS }), { at: 0 });
    cache.apply(decoded({ name: HOST, type: RECORD_TYPE.A, ttl: 120, address: '10.0.0.9' }), { at: 1 });
    // A multi-homed host is a legitimate reason to publish two A records; only the cache-flush bit says
    // "this set is the whole truth".
    assert.deepEqual(
      cache
        .live()
        .map((entry) => entry.record.address)
        .sort(),
      [ADDRESS, '10.0.0.9'].sort(),
    );
  });

  it('stays inside its size cap', () => {
    const cache = createRecordCache({ now: () => 0, max: 4 });
    for (let index = 0; index < 20; index += 1) {
      cache.apply(
        decoded({ name: `h${index}.local`, type: RECORD_TYPE.A, ttl: 120, address: `10.0.0.${index + 1}` }),
        { at: index },
      );
    }
    assert.equal(cache.size, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Reassembly: records 鈫?instances, across packets                          */
/* -------------------------------------------------------------------------- */

describe('service instance reassembly', () => {
  it('assembles one instance from a four-record response', () => {
    const records = throughTheWire(announcementRecords());
    const { instances, counts } = parseServiceInstances(records, { serviceType: DEFAULT_SERVICE_TYPE });
    assert.equal(instances.length, 1);
    assert.equal(counts.ptr, 1);
    assert.equal(counts.srv, 1);
    assert.equal(counts.txt, 1);
    assert.deepEqual(
      {
        instance: instances[0].instance,
        name: instances[0].name,
        host: instances[0].host,
        port: instances[0].port,
        addresses: instances[0].addresses,
        mid: instances[0].txt.map.mid,
        ttl_srv: instances[0].ttl.srv,
      },
      {
        instance: INSTANCE_FQDN,
        name: INSTANCE,
        host: HOST,
        port: 8788,
        addresses: [ADDRESS],
        mid: 'aaa',
        ttl_srv: 120,
      },
    );
  });

  it('reassembles across packets, not within one', () => {
    // The PTR arrives in the first response, the SRV and TXT in a second, the address in a third: a
    // peer is allowed to split an answer this way, and the instance must survive the split.
    const all = throughTheWire(announcementRecords());
    const at = (record, when) => ({ record, at: when, observed_address: ADDRESS });
    const entries = [
      at(
        all.find((record) => record.type === RECORD_TYPE.PTR),
        0,
      ),
      at(
        all.find((record) => record.type === RECORD_TYPE.SRV),
        5,
      ),
      at(
        all.find((record) => record.type === RECORD_TYPE.TXT),
        6,
      ),
      at(
        all.find((record) => record.type === RECORD_TYPE.A),
        9,
      ),
    ];
    const { instances } = parseServiceInstances(entries, { serviceType: DEFAULT_SERVICE_TYPE });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].port, 8788);
    assert.deepEqual(instances[0].addresses, [ADDRESS]);
    assert.equal(instances[0].updated_at, 9);
  });

  it('reports an instance seen without its PTR, and marks it as such', () => {
    const all = throughTheWire(announcementRecords());
    const withoutPtr = all.filter((record) => record.type !== RECORD_TYPE.PTR);
    const { instances } = parseServiceInstances(withoutPtr, { serviceType: DEFAULT_SERVICE_TYPE });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].advertised_via_ptr, false);
    assert.equal(instances[0].port, 8788);
  });

  it('uses the observed source address when the peer publishes no address record', () => {
    const all = throughTheWire(announcementRecords({ address: null }));
    const entries = all.map((record) => ({ record, at: 1, observed_address: '10.1.2.3' }));
    const { instances } = parseServiceInstances(entries, { serviceType: DEFAULT_SERVICE_TYPE });
    assert.deepEqual(instances[0].addresses, []);
    assert.equal(instances[0].observed_address, '10.1.2.3');
  });

  it('counts a superseded SRV rather than reporting its port', () => {
    const srv = (port, at) => ({
      record: decoded({ name: INSTANCE_FQDN, type: RECORD_TYPE.SRV, ttl: 120, port, target: HOST }),
      at,
    });
    const ptr = {
      record: decoded({
        name: DEFAULT_SERVICE_TYPE,
        type: RECORD_TYPE.PTR,
        ttl: 4500,
        target: INSTANCE_FQDN,
      }),
      at: 0,
    };
    const { instances } = parseServiceInstances([ptr, srv(8788, 1), srv(9999, 2), srv(9100, 3)], {
      serviceType: DEFAULT_SERVICE_TYPE,
    });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].port, 9100);
    assert.equal(instances[0].superseded_srv, 2);
  });

  it('caps how many instances one scan will report', () => {
    const entries = [];
    for (let index = 0; index < 80; index += 1) {
      entries.push({
        record: decoded({
          name: DEFAULT_SERVICE_TYPE,
          type: RECORD_TYPE.PTR,
          ttl: 4500,
          target: `n${index}.${DEFAULT_SERVICE_TYPE}`,
        }),
        at: index,
      });
    }
    const { instances, truncated } = parseServiceInstances(entries, {
      serviceType: DEFAULT_SERVICE_TYPE,
      max: 10,
    });
    assert.equal(instances.length, 10);
    assert.equal(truncated, 70, 'a flood is reported as truncated, not silently accepted');
  });

  it('reads TXT strings the way RFC 6763 搂6.1 defines them', () => {
    assert.deepEqual(txtMap(['txtvers=1', 'mid=aaa', 'flag', 'k=v=w', 'mid=bbb']), {
      txtvers: '1',
      mid: 'aaa',
      flag: '',
      k: 'v=w',
    });
    assert.deepEqual(txtMap([]), {});
  });

  it('derives host and instance names from a label without inventing a dot-escaping parser', () => {
    assert.equal(toHostFqdn('desk'), 'desk.local');
    assert.equal(toHostFqdn('desk.local'), 'desk.local');
    assert.equal(toHostFqdn('desk.local.'), 'desk.local');
    assert.equal(serviceFqdn('mac-studio', DEFAULT_SERVICE_TYPE), INSTANCE_FQDN);
    assert.deepEqual(splitInstanceFqdn(INSTANCE_FQDN, DEFAULT_SERVICE_TYPE), {
      instance: INSTANCE_FQDN,
      name: INSTANCE,
    });
    assert.equal(localHostLabel('DESKTOP-ABC.example.com'), 'DESKTOP-ABC');
    assert.equal(localHostLabel('   '), 'w2m-host');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. THE RULE: discovery is a hint, never an authorisation                    */
/* -------------------------------------------------------------------------- */

describe('a discovered device is a candidate to ask, never an authorisation', () => {
  const relayIndex = buildRelayIndex(RELAY_RECORDS);

  it('refuses to dispatch to a discovered device the relay does not list', () => {
    const candidate = describeDiscoveredCandidate(
      instanceView({ txt: { raw: ['mid=ccc'], map: { mid: 'ccc' } } }),
      {
        relayIndex,
        localMachineId: LOCAL_MACHINE_ID,
      },
    );
    assert.equal(candidate.source, DISCOVERY_SOURCE);
    assert.equal(candidate.verified, false);
    assert.equal(candidate.known_to_relay, false);
    assert.equal(candidate.dispatchable, false);
    assert.equal(mayDispatchTo(candidate), false);
    assert.equal(refusalCode(dispatchRefusal(candidate)), DISPATCH_REFUSAL.UNPAIRED);
    assert.match(candidate.refusal, /pair/i, 'the refusal says what would change it');
  });

  it('does not promote a candidate on a matching service name alone', () => {
    // The advertisement names itself `mac-studio`, and the relay does list a `mac-studio`. That is a
    // coincidence of naming, not identity, and it must not be enough.
    const candidate = describeDiscoveredCandidate(
      instanceView({ txt: { raw: ['txtvers=1'], map: { txtvers: '1' } } }),
      { relayIndex, localMachineId: LOCAL_MACHINE_ID },
    );
    assert.equal(candidate.machine_id, null);
    assert.equal(candidate.known_to_relay, false);
    assert.equal(candidate.dispatchable, false);
    assert.equal(mayDispatchTo(candidate), false);
    assert.equal(refusalCode(candidate.refusal), DISPATCH_REFUSAL.IDENTITY_UNKNOWN);
    // The name match is still reported 鈥?a human can use it 鈥?but as a hint on its own field.
    assert.deepEqual(candidate.name_match, { machine_id: 'aaa', name: 'mac-studio', online: true });
  });

  it('does not dispatch to a machine the relay lists but whose lease is not live', () => {
    const candidate = describeDiscoveredCandidate(
      instanceView({ txt: { raw: ['mid=bbb'], map: { mid: 'bbb' } } }),
      {
        relayIndex,
        localMachineId: LOCAL_MACHINE_ID,
      },
    );
    assert.equal(candidate.known_to_relay, true);
    assert.equal(candidate.relay_online, false);
    assert.equal(candidate.dispatchable, false);
    assert.equal(refusalCode(candidate.refusal), DISPATCH_REFUSAL.RELAY_STALE);
  });

  it("refuses this machine's own advertisement, and one with no usable endpoint", () => {
    const own = describeDiscoveredCandidate(
      instanceView({ txt: { raw: ['mid=zzz'], map: { mid: 'zzz' } } }),
      {
        relayIndex: {
          ...relayIndex,
          byId: new Map([
            ...relayIndex.byId,
            ['zzz', { machine_id: 'zzz', name: 'here', online: true, state: 'online' }],
          ]),
        },
        localMachineId: LOCAL_MACHINE_ID,
      },
    );
    assert.equal(own.local, true);
    assert.equal(refusalCode(own.refusal), DISPATCH_REFUSAL.LOCAL_INSTANCE);

    const noPort = describeDiscoveredCandidate(
      instanceView({ port: null, txt: { raw: ['mid=aaa'], map: { mid: 'aaa' } } }),
      {
        relayIndex,
        localMachineId: LOCAL_MACHINE_ID,
      },
    );
    assert.equal(refusalCode(noPort.refusal), DISPATCH_REFUSAL.NO_ENDPOINT);

    const noAddress = describeDiscoveredCandidate(
      instanceView({ addresses: [], observed_address: null, txt: { raw: ['mid=aaa'], map: { mid: 'aaa' } } }),
      { relayIndex, localMachineId: LOCAL_MACHINE_ID },
    );
    assert.equal(refusalCode(noAddress.refusal), DISPATCH_REFUSAL.NO_ENDPOINT);
  });

  it('does dispatch to a paired, relay-listed, live candidate 鈥?the other direction', () => {
    // Without this half, a rule that returned `false` unconditionally would pass every test above while
    // making the feature useless. The pair of tests is the executable form of "the guard discriminates".
    const candidate = describeDiscoveredCandidate(instanceView(), {
      relayIndex,
      localMachineId: LOCAL_MACHINE_ID,
    });
    assert.equal(candidate.machine_id, 'aaa');
    assert.equal(candidate.known_to_relay, true);
    assert.equal(candidate.relay_online, true);
    assert.equal(candidate.relay_state, 'online');
    assert.equal(candidate.local, false);
    assert.equal(candidate.refusal, null);
    assert.equal(candidate.dispatchable, true);
    assert.equal(mayDispatchTo(candidate), true);
  });

  it('never offers an unpaired candidate in the dispatchable list', () => {
    const described = describeDiscovered({
      instances: [
        instanceView(),
        instanceView({
          name: 'rogue-box',
          instance: 'rogue-box._w2m._tcp.local',
          txt: { raw: ['mid=ccc'], map: { mid: 'ccc' } },
        }),
        instanceView({ name: 'no-mid', instance: 'no-mid._w2m._tcp.local', txt: { raw: [], map: {} } }),
      ],
      relayRecords: RELAY_RECORDS,
      localMachineId: LOCAL_MACHINE_ID,
      available: true,
      scannedAt: 1_000,
    });
    assert.equal(described.counts.instances, 3);
    assert.equal(described.counts.relay_listed, 1, 'only the one whose machine id the relay holds');
    assert.equal(
      described.counts.unpaired,
      2,
      'the unknown machine id and the one with no machine id at all',
    );
    assert.equal(described.counts.dispatchable, 1);
    assert.equal(described.counts.verified, 0, 'mDNS verifies nothing, ever');
    assert.deepEqual(
      dispatchableCandidates(described.candidates).map((candidate) => candidate.name),
      [INSTANCE],
    );
    for (const candidate of described.candidates) {
      assert.equal(candidate.verified, false);
      assert.equal(candidate.note, described.note);
    }
    assert.match(described.note, /hint, never an authorisation/);
  });

  it("shows both sources in one list, with provenance, and keeps the relay's own verdict for relay rows", () => {
    const described = describeDiscovered({
      instances: [
        instanceView(),
        instanceView({
          name: 'rogue-box',
          instance: 'rogue-box._w2m._tcp.local',
          txt: { raw: ['mid=ccc'], map: { mid: 'ccc' } },
        }),
      ],
      relayRecords: RELAY_RECORDS,
      localMachineId: LOCAL_MACHINE_ID,
      available: true,
    });
    const view = mergeRosterView({
      relayRecords: RELAY_RECORDS,
      candidates: described.candidates,
      localMachineId: LOCAL_MACHINE_ID,
    });

    assert.deepEqual(view.counts, {
      relay: 2,
      discovered: 2,
      dispatchable_relay: 1,
      dispatchable_discovered: 1,
      unpaired_discovered: 1,
    });
    const relayed = view.roster.filter((entry) => entry.source === 'relay');
    assert.equal(
      relayed.every((entry) => entry.verified === true),
      true,
    );
    assert.equal(relayed.find((entry) => entry.machine_id === 'bbb').dispatchable, false);
    const rogue = view.roster.find((entry) => entry.name === 'rogue-box');
    assert.deepEqual(
      {
        source: rogue.source,
        verified: rogue.verified,
        relay_listed: rogue.relay_listed,
        dispatchable: rogue.dispatchable,
      },
      { source: DISCOVERY_SOURCE, verified: false, relay_listed: false, dispatchable: false },
    );
    assert.equal(refusalCode(rogue.refusal), DISPATCH_REFUSAL.UNPAIRED);
  });

  it('refuses anything that is not a discovered candidate at all', () => {
    // The rule does not speak for the relay path, and it must not be usable to *grant* anything either:
    // a relay-shaped object does not become dispatchable by being handed to it.
    for (const value of [null, undefined, 42, 'aaa', {}, { source: 'relay', machine_id: 'aaa' }]) {
      assert.equal(mayDispatchTo(value), false);
      assert.equal(refusalCode(dispatchRefusal(value)), DISPATCH_REFUSAL.NOT_DISCOVERED);
    }
    assert.deepEqual(dispatchableCandidates(undefined), []);
    assert.deepEqual(dispatchableCandidates([null, undefined]), []);
  });

  it('reports "not asked" and "asked but unavailable" as different things', () => {
    const never = describeDiscovered({ instances: [], relayRecords: RELAY_RECORDS });
    assert.equal(never.available, null);
    assert.equal(never.scanned_at, null);
    assert.match(never.unavailable_note, /no scan has been asked for yet/);

    const unavailable = describeDiscovered({
      instances: [],
      relayRecords: RELAY_RECORDS,
      available: false,
      error: 'MDNS_UNAVAILABLE: no mDNS query could be sent',
      scannedAt: 10,
    });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.error, 'MDNS_UNAVAILABLE: no mDNS query could be sent');
    assert.match(unavailable.unavailable_note, /means "unknown", not "no devices on the LAN"/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Fail soft, never silent                                                  */
/* -------------------------------------------------------------------------- */

describe('a network without multicast', () => {
  it('returns a refusal instead of throwing when its bind address is not this host', async () => {
    // 203.0.113.0/24 is TEST-NET-3 (RFC 5737): a real, reproducible "this network will not let you"
    // without depending on the machine's own firewall settings.
    const result = await discoverServices({ bindAddress: '203.0.113.1', timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.match(result.error, /^MDNS_UNAVAILABLE: /);
    assert.deepEqual(result.instances, []);
    assert.equal(result.sent, 0);
    assert.equal(result.socket, null);
  });

  it('returns a refusal instead of throwing when the query cannot be sent', async () => {
    // A port the socket layer rejects, so the *send* fails rather than the bind: this is the shape a
    // container with no multicast route produces (`ENETUNREACH` instead), and the handling is the same
    // path — the failure is a value, the scan reports itself unavailable, and no candidate is invented.
    const result = await discoverServices({
      targets: [{ address: MDNS_GROUP, port: 0 }],
      bindAddress: '127.0.0.1',
      timeoutMs: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.equal(result.sent, 0);
    assert.match(result.error, /^MDNS_UNAVAILABLE: /);
    assert.equal(result.queries.length, 1);
    assert.equal(result.queries[0].ok, false);
    assert.match(result.queries[0].error, /ERR_SOCKET_BAD_PORT/);
    assert.deepEqual(result.instances, []);
  });

  it('logs one line, keeps working, and never reports an unavailable scan as a success', async () => {
    const lines = [];
    const source = createDiscoverySource({
      scan: async () => ({
        ok: false,
        available: false,
        error: 'MDNS_UNAVAILABLE: ENETUNREACH',
        instances: [],
      }),
      logger: { warn: (line) => lines.push(line) },
    });
    const first = await source.scan({ relayRecords: RELAY_RECORDS });
    assert.equal(first.available, false);
    assert.equal(first.error, 'MDNS_UNAVAILABLE: ENETUNREACH');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /LAN discovery is unavailable.*continuing without discovered candidates/);

    const second = await source.scan({ relayRecords: RELAY_RECORDS });
    assert.equal(second.available, false);
    assert.equal(lines.length, 1, 'the same failure is not logged again on every call');
    assert.equal(source.status().scans, 2);
    assert.equal(source.status().available, false);

    // A different failure is worth a new line: the operator needs to see that the reason changed.
    const changed = createDiscoverySource({
      scan: async () => ({
        ok: false,
        available: false,
        error: 'MDNS_UNAVAILABLE: EADDRNOTAVAIL',
        instances: [],
      }),
      logger: { warn: (line) => lines.push(line) },
    });
    await changed.scan({});
    assert.equal(lines.length, 2);
  });

  it('survives a scanner that throws, naming it as a scan failure', async () => {
    const lines = [];
    const source = createDiscoverySource({
      scan: async () => {
        throw new Error('socket exploded');
      },
      logger: { warn: (line) => lines.push(line) },
    });
    const result = await source.scan({ relayRecords: RELAY_RECORDS });
    assert.equal(result.available, false);
    assert.match(result.error, /^MDNS_SCAN_FAILED: socket exploded$/);
    assert.deepEqual(result.candidates, []);
    assert.equal(lines.length, 1);
  });

  it('survives a logger that throws', async () => {
    const source = createDiscoverySource({
      scan: async () => ({ ok: false, available: false, error: 'MDNS_UNAVAILABLE: nope', instances: [] }),
      logger: {
        warn: () => {
          throw new Error('the log sink is a hostile place');
        },
      },
    });
    const result = await source.scan({});
    assert.equal(result.available, false);
  });

  it('describes the last scan without scanning again', async () => {
    let scans = 0;
    const source = createDiscoverySource({
      scan: async () => {
        scans += 1;
        return { ok: true, available: true, instances: [instanceView()], elapsed_ms: 12 };
      },
    });
    const scanned = await source.scan({ relayRecords: RELAY_RECORDS, localMachineId: LOCAL_MACHINE_ID });
    assert.equal(scanned.counts.dispatchable, 1);
    const described = source.describe({ relayRecords: RELAY_RECORDS, localMachineId: LOCAL_MACHINE_ID });
    assert.equal(scans, 1, 'describe() must not open a socket');
    assert.equal(described.counts.instances, 1);
    // And a roster that has since lost the machine turns the cached candidate back into a non-target.
    const withoutRelay = source.describe({ relayRecords: [], localMachineId: LOCAL_MACHINE_ID });
    assert.equal(withoutRelay.counts.dispatchable, 0);
    assert.equal(withoutRelay.candidates[0].dispatchable, false);
  });

  it('does not advertise unless asked, and reports advertising failures without throwing', async () => {
    const idle = createDiscoverySource({ scan: async () => ({ ok: true, available: true, instances: [] }) });
    assert.equal(idle.status().advertising_requested, false);
    assert.equal((await idle.start()).advertising, false);
    assert.equal((await idle.stop()).advertising, false);

    // An advertise request that cannot bind is one log line, and the status says so.
    const lines = [];
    const advertising = createDiscoverySource({
      scan: async () => ({ ok: true, available: true, instances: [] }),
      logger: { warn: (line) => lines.push(line) },
      advertise: {
        servicePort: 8788,
        instance: 'w2m-selftest',
        bindAddress: '203.0.113.1',
        group: '127.0.0.1',
        mdnsPort: await freeLoopbackPort(),
        announceIntervalMs: 0,
      },
    });
    const started = await advertising.start();
    assert.equal(started.advertising, false);
    assert.equal(started.advertising_requested, true);
    // One line naming the failure (the responder's own note is a second, and both are wanted: one says
    // *why* the bind failed, the other says advertising is off).
    assert.ok(lines.length >= 1, 'an advertising failure must not be silent');
    assert.equal(
      lines.some((line) => /mDNS/.test(line)),
      true,
    );
    assert.equal(
      started.last_error === null,
      true,
      'the scan state is not polluted by an advertising failure',
    );
    await advertising.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The goodbye, at the packet level                                         */
/* -------------------------------------------------------------------------- */

describe('the TTL=0 goodbye on close', () => {
  it('sends every record back with TTL 0 and no cache-flush bit', async () => {
    const sent = [];
    const responder = createResponder({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      address: ADDRESS,
      machineId: 'aaa',
      sink: (bytes, target) => sent.push({ bytes, target }),
    });
    const announced = await responder.announce();
    assert.equal(announced.ok, true);
    const announcement = decodeMessage(sent.at(-1).bytes).message;
    assert.deepEqual(
      announcement.records.map((record) => record.ttl),
      [4500, 120, 4500, 120],
    );
    assert.deepEqual(
      announcement.records.map((record) => record.cache_flush),
      [false, true, true, true],
    );

    const closed = await responder.close();
    assert.equal(closed.ok, true);
    assert.equal(closed.goodbye, true);
    const goodbye = decodeMessage(sent.at(-1).bytes).message;
    // Same names, same rdata, TTL 0: RFC 6762 搂10.1's definition of a deletion.
    assert.deepEqual(
      goodbye.records.map((record) => record.ttl),
      [GOODBYE_TTL, GOODBYE_TTL, GOODBYE_TTL, GOODBYE_TTL],
    );
    assert.deepEqual(
      goodbye.records.map((record) => record.name),
      announcement.records.map((record) => record.name),
    );
    assert.deepEqual(
      goodbye.records.map((record) => record.rdata.toString('hex')),
      announcement.records.map((record) => record.rdata.toString('hex')),
    );
    assert.equal(
      goodbye.records.every((record) => record.goodbye === true),
      true,
    );
    assert.equal(
      goodbye.records.every((record) => record.cache_flush === false),
      true,
    );

    // A peer's cache, fed the announcement and then the goodbye, ends up empty.
    const cache = createRecordCache({ now: () => 0 });
    for (const record of announcement.records) cache.apply(record, { at: 0 });
    assert.equal(cache.live().length, 4);
    for (const record of goodbye.records) cache.apply(record, { at: 1 });
    assert.equal(cache.live().length, 0, 'the peers drop us immediately, not after 75 minutes');

    // Closing twice is not an error and does not send a second goodbye.
    const again = await responder.close();
    assert.equal(again.already_closed, true);
    assert.equal(sent.length, 2);
  });

  it('keeps the TTLs the RFC asks for: 120 s with a host name, 75 minutes without', () => {
    const records = buildServiceRecords({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      address: ADDRESS,
    });
    const ttlOf = (type) => records.find((record) => record.type === type).ttl;
    assert.equal(ttlOf(RECORD_TYPE.SRV), DEFAULT_TTL_SECONDS.srv);
    assert.equal(ttlOf(RECORD_TYPE.A), DEFAULT_TTL_SECONDS.address);
    assert.equal(ttlOf(RECORD_TYPE.PTR), DEFAULT_TTL_SECONDS.ptr);
    assert.equal(ttlOf(RECORD_TYPE.TXT), DEFAULT_TTL_SECONDS.txt);
    assert.equal(DEFAULT_TTL_SECONDS.srv, 120);
    assert.equal(DEFAULT_TTL_SECONDS.ptr, 4500);
  });

  it('puts no secret in a TXT record, and takes the machine id as its only identity field', () => {
    const records = buildServiceRecords({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      machineId: 'aaa',
      machineName: 'mac-studio',
    });
    const txt = records.find((record) => record.type === RECORD_TYPE.TXT).txt;
    assert.deepEqual(txt, ['txtvers=1', 'mid=aaa', 'name=mac-studio']);
    // The caller may add its own keys, and this is what they look like on the wire...
    const extended = buildServiceRecords({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      machineId: 'aaa',
      txt: { caps: 'posix' },
    });
    assert.deepEqual(extended.find((record) => record.type === RECORD_TYPE.TXT).txt, [
      'txtvers=1',
      'mid=aaa',
      'caps=posix',
    ]);
    // ...and the reason this test exists: `buildServiceRecords` has no parameter for a device token, a
    // pairing code or a key, because a TXT record is broadcast to every host on the link in cleartext.
    // The signature is the enforcement; this comment is the tripwire for whoever adds a fourth key.
    assert.deepEqual(Object.keys(txtMap(txt)), ['txtvers', 'mid', 'name']);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Socket tests, loopback-bound                                             */
/* -------------------------------------------------------------------------- */

describe('over real UDP sockets, bound to loopback', () => {
  it('answers a scan and stops answering after the goodbye', async (t) => {
    const port = await freeLoopbackPort().catch(() => null);
    if (port === null) {
      t.skip('this environment refuses to bind a UDP socket on 127.0.0.1');
      return;
    }
    const responder = createResponder({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      address: ADDRESS,
      machineId: 'aaa',
      machineName: 'mac-studio',
      // The group is replaced by loopback and `interfaces` is empty, so nothing here is multicast and
      // nothing leaves this host: this test is about the query/response path, not about a LAN.
      group: '127.0.0.1',
      mdnsPort: port,
      bindAddress: '127.0.0.1',
      interfaces: () => [],
      announceIntervalMs: 0,
    });
    cleanup.push(() => responder.close());
    const started = await responder.start();
    if (started.running !== true) {
      t.skip(`the responder could not bind 127.0.0.1:${port} (${started.last_error})`);
      return;
    }
    assert.equal(responder.status().bound.port, port);
    assert.equal(responder.status().service_type, DEFAULT_SERVICE_TYPE);

    const scanned = await discoverServices({
      targets: [{ address: '127.0.0.1', port }],
      bindAddress: '127.0.0.1',
      timeoutMs: 600,
    });
    if (!scanned.available) {
      t.skip(`this environment refuses a loopback scan (${scanned.error})`);
      return;
    }
    assert.equal(scanned.instances.length, 1, 'the responder must answer a one-shot query');
    const found = scanned.instances[0];
    assert.equal(found.name, INSTANCE);
    assert.equal(found.port, 8788);
    assert.equal(found.host, HOST);
    assert.deepEqual(found.addresses, [ADDRESS]);
    assert.equal(found.txt.map.mid, 'aaa');
    assert.equal(scanned.packets.received >= 1, true);
    assert.equal(scanned.packets.refused, 0);
    // RFC 6762 搂6.7: the query came from an ephemeral port, so the answer is a legacy unicast response
    // with the query id repeated and TTLs capped at ten seconds. Discovery reports what it saw, and the
    // TTL it reports is the capped one.
    assert.equal(found.ttl.ptr <= 10, true);
    assert.equal(responder.status().replies >= 1, true);

    const closed = await responder.close();
    assert.equal(closed.goodbye, true);

    const after = await discoverServices({
      targets: [{ address: '127.0.0.1', port }],
      bindAddress: '127.0.0.1',
      timeoutMs: 400,
    });
    assert.deepEqual(after.instances, [], 'a closed responder must not answer');
  });

  it('a silent socket is not a failure, and the note says so', async (t) => {
    let silent = null;
    try {
      silent = await bindUdpSocket({ address: '127.0.0.1', port: 0 });
    } catch (error) {
      t.skip(`this environment refuses to bind a UDP socket on 127.0.0.1 (${error.code ?? error.message})`);
      return;
    }
    const port = silent.address().port;
    cleanup.push(() => closeSocket(silent));
    const scanned = await discoverServices({
      targets: [{ address: '127.0.0.1', port }],
      bindAddress: '127.0.0.1',
      timeoutMs: 250,
    });
    assert.equal(scanned.available, true, 'the query was sent, so discovery is available');
    assert.equal(scanned.sent, 1);
    assert.deepEqual(scanned.instances, []);
    assert.match(scanned.note, /no peer answered - that is not evidence that none exists/);
  });

  it('reports a multicast membership that this host refuses instead of failing on it', async (t) => {
    const port = await freeLoopbackPort().catch(() => null);
    if (port === null) {
      t.skip('this environment refuses to bind a UDP socket on 127.0.0.1');
      return;
    }
    const responder = createResponder({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      group: '127.0.0.1',
      mdnsPort: port,
      bindAddress: '127.0.0.1',
      // Loopback is the one address a membership always fails on, which is exactly the case the
      // try/catch exists for. Both outcomes are asserted, so this test cannot pass vacuously on a host
      // where joining works either: what it pins is that the outcome is *reported*.
      interfaces: () => [{ name: 'loopback', address: '127.0.0.1', internal: false }],
      announceIntervalMs: 0,
    });
    cleanup.push(() => responder.close());
    const started = await responder.start();
    if (started.running !== true) {
      t.skip(`the responder could not bind 127.0.0.1:${port} (${started.last_error})`);
      return;
    }
    assert.equal(started.memberships.length, 1, 'every candidate interface is tried, not just the first');
    const membership = started.memberships[0];
    assert.equal(membership.address, '127.0.0.1');
    assert.equal(typeof membership.ok, 'boolean');
    if (membership.ok === false) {
      assert.match(membership.error, /\w+:/, 'a refused membership carries the platform reason');
    }
    // The multicast knobs are allowed to throw on some platforms; whichever happened is recorded.
    assert.equal(typeof started.knobs.multicast_loopback.ok, 'boolean');
    assert.equal(typeof started.knobs.multicast_ttl.ok, 'boolean');
  });

  it('keeps the list of interfaces honest about which ones are internal', () => {
    const all = listIPv4Interfaces();
    assert.equal(Array.isArray(all), true);
    for (const entry of all) {
      assert.equal(typeof entry.name, 'string');
      assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/);
      assert.equal(typeof entry.internal, 'boolean');
    }
    const external = listIPv4Interfaces({ includeInternal: false });
    assert.equal(
      external.every((entry) => entry.internal === false),
      true,
    );
    assert.ok(all.length >= external.length);
  });

  it('describes the responder, the group and the default port it would use', () => {
    const responder = createResponder({ instance: INSTANCE, host: HOST, servicePort: 8788, sink: () => {} });
    const status = responder.status();
    assert.equal(status.running, false);
    assert.equal(status.group, MDNS_GROUP);
    assert.equal(status.mdns_port, MDNS_PORT);
    assert.equal(status.instance_fqdn, INSTANCE_FQDN);
    assert.equal(status.service_port, 8788);
    assert.equal(responder.instanceFqdn, INSTANCE_FQDN);
    assert.deepEqual(
      responder.records().map((record) => record.type),
      [RECORD_TYPE.PTR, RECORD_TYPE.SRV, RECORD_TYPE.TXT],
    );
    assert.equal(MDNS_GROUP, '224.0.0.251');
    assert.equal(MDNS_PORT, 5353);
  });

  it('refuses a query it does not own, a response, and an unknown opcode, without throwing', async () => {
    const sent = [];
    const responder = createResponder({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      sink: (bytes, target) => sent.push({ bytes, target }),
      mdnsPort: 5353,
    });
    const foreign = decodeMessage(encodeQuery({ serviceType: '_other._tcp.local' }));
    assert.equal(foreign.ok, true);
    const ignored = responder.handleMessage(encodeQuery({ serviceType: '_other._tcp.local' }), {
      address: '10.0.0.9',
      port: 5353,
    });
    assert.equal(ignored.responded, false);
    assert.equal(ignored.reason, 'no_matching_question');

    const response = encodeMessage({ flags: { qr: true, aa: true }, answers: announcementRecords() });
    const seen = responder.handleMessage(response, { address: '10.0.0.9', port: 5353 });
    assert.equal(seen.responded, false);
    assert.equal(seen.reason, 'response');

    const oddOpcode = Buffer.from(encodeQuery({ serviceType: DEFAULT_SERVICE_TYPE }));
    oddOpcode.writeUInt16BE(0x0800, 2); // opcode 1 (IQUERY)
    const odd = responder.handleMessage(oddOpcode, { address: '10.0.0.9', port: 5353 });
    assert.equal(odd.reason, 'opcode');

    // A malformed packet is counted, never thrown, and never answered.
    const malformed = responder.handleMessage(Buffer.from([0x00, 0x01, 0x02]), {
      address: '10.0.0.9',
      port: 5353,
    });
    assert.equal(malformed.handled, false);
    assert.match(malformed.reason, /^MDNS_/);
    assert.equal(responder.status().refused_packets, 1);
    // Not one of the four produced a datagram.
    assert.equal(sent.length, 0);
  });

  it('answers over multicast to 5353 when the query came from 5353 without the QU bit', () => {
    const sent = [];
    const responder = createResponder({
      instance: INSTANCE,
      host: HOST,
      servicePort: 8788,
      sink: (bytes, target) => sent.push({ bytes, target }),
      mdnsPort: 5353,
    });
    const outcome = responder.handleMessage(encodeQuery({ serviceType: DEFAULT_SERVICE_TYPE }), {
      address: '10.0.0.9',
      port: 5353,
    });
    assert.equal(outcome.responded, true);
    assert.equal(outcome.unicast, false);
    assert.deepEqual(outcome.target, { address: MDNS_GROUP, port: MDNS_PORT });
    const reply = decodeMessage(sent.at(-1).bytes);
    assert.equal(reply.ok, true);
    assert.equal(reply.message.flags.qr, true);
    assert.equal(reply.message.flags.aa, true);
    assert.deepEqual(
      reply.message.records.map((record) => record.type_name),
      ['PTR', 'SRV', 'TXT'],
    );
    // A multicast reply keeps the real TTLs: it is going into peer caches, not to a legacy resolver.
    assert.equal(reply.message.records[0].ttl, DEFAULT_TTL_SECONDS.ptr);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. The tool surface                                                         */
/* -------------------------------------------------------------------------- */

/** Register the plugin against a fake context, exactly as `test/tools.test.mjs` does. */
async function registerPlugin(routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const parsed = new URL(url);
    calls.push({ method: String(init.method ?? 'GET').toUpperCase(), path: parsed.pathname });
    const route = routes.find((candidate) => candidate.path === parsed.pathname);
    if (!route) throw new Error(`test route missing: ${parsed.pathname}`);
    const text = JSON.stringify(route.body ?? {});
    return new Response(text, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  // The stub stays installed for the whole test body and is removed by the `after` hook: the tool makes
  // its call from the test, not from this helper.
  cleanup.push(() => {
    globalThis.fetch = previousFetch;
  });
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(tools.has(definition.name), false, `tool \`${definition.name}\` registered twice`);
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: (line) => warnings.push(String(line)), info: () => {} },
    inject(_names, callback) {
      callback(ctx);
    },
  };
  await plugin.apply(ctx, { p2pMode: 'relay', rabbitUrl: 'http://127.0.0.1:8787' });
  assert.equal(calls.length, 0, 'applying the plugin must not call the relay');
  return { tools, warnings };
}

describe('w2m_devices exposes the discovery block', () => {
  it('declares include_discovered as an optional boolean defaulting to false', async () => {
    const { tools } = await registerPlugin([{ path: '/v1/devices', body: { devices: RELAY_RECORDS } }]);
    const declaration = tools.get('w2m_devices').parameters.include_discovered;
    assert.equal(declaration.type, 'boolean');
    assert.equal(declaration.default, false);
    assert.notEqual(declaration.required, true);
    assert.match(declaration.description, /only a candidate the relay also lists/);
  });

  it('reports "not asked" rather than an empty LAN when the flag is absent', async () => {
    const { tools } = await registerPlugin([{ path: '/v1/devices', body: { devices: RELAY_RECORDS } }]);
    const value = JSON.parse(await tools.get('w2m_devices').execute({}, {}));
    assert.equal(value.discovery.source, DISCOVERY_SOURCE);
    assert.equal(value.discovery.available, null);
    assert.equal(value.discovery.scanned_at, null);
    assert.deepEqual(value.discovery.candidates, []);
    assert.match(value.discovery.note, /hint, never an authorisation/);
  });

  it('scans when asked, and still marks every candidate unverified and non-dispatchable unless the relay lists it', async () => {
    const { tools } = await registerPlugin([{ path: '/v1/devices', body: { devices: RELAY_RECORDS } }]);
    const value = JSON.parse(await tools.get('w2m_devices').execute({ include_discovered: true }, {}));
    const discovery = value.discovery;
    assert.equal(discovery.source, DISCOVERY_SOURCE);
    // Whatever this machine's network does, the shape and the posture are the same. The assertions
    // below are network-independent on purpose: a build agent with no multicast passes them too.
    assert.equal([true, false].includes(discovery.available), true);
    assert.equal(typeof discovery.scanned_at, 'number');
    assert.equal(Array.isArray(discovery.candidates), true);
    assert.equal(discovery.counts.verified, 0);
    for (const candidate of discovery.candidates) {
      assert.equal(candidate.source, DISCOVERY_SOURCE);
      assert.equal(candidate.verified, false);
      assert.equal(typeof candidate.known_to_relay, 'boolean');
      // The rule, on live data: nothing is dispatchable without the relay listing it.
      if (candidate.dispatchable === true) {
        assert.equal(candidate.known_to_relay, true);
        assert.equal(candidate.relay_online, true);
        assert.equal(candidate.local, false);
        assert.equal(candidate.refusal, null);
      } else {
        assert.match(candidate.refusal, /^(MDNS_|RELAY_)/);
      }
    }
    // The relay roster itself is untouched by the LAN layer: still one live machine, one expired.
    assert.equal(value.devices.length, 1);
    assert.equal(value.devices[0].machine_id, 'aaa');
  });
});
