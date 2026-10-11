/**
 * Multicast DNS responder and single-shot discovery for the W2M LAN hint layer.
 *
 * # THE RULE
 *
 * **Discovery is a hint, never an authorisation.** A discovered device is a *candidate to ask*. It
 * never skips, weakens or short-circuits any existing gate — the device token, the per-machine
 * allow-list, the git anchors, the verdict model. If you find yourself writing code where a discovered
 * device is trusted because it was discovered, stop: that is the mistake, and it is why nothing in
 * this file decides identity. This module reports what the LAN said; `src/plugin/mdns-discover.mjs`
 * decides what may be *offered*, and even there the answer is "ask the relay".
 *
 * Concretely, and on purpose: mDNS has no authentication, no integrity and no confidentiality. Any
 * host on the link can claim any name, and an off-path attacker can spray answers at a port it can
 * guess. That is why the responder here never advertises a secret (a device token, a pairing code or a
 * key of any kind must never go into a TXT record) and why the discovery source marks everything it
 * finds `verified: false`.
 *
 * # Clean room
 *
 * Written from RFC 6762 (Multicast DNS), RFC 6763 (DNS-Based Service Discovery), RFC 2782 (SRV) and
 * RFC 1035 §4.1 (message format). See `src/agent/mdns-wire.mjs` for the two studied-implementation
 * behaviours this layer deliberately does *not* reproduce (first-writer-wins record updates, and a name
 * treated as identity).
 *
 * # What this implements, exactly
 *
 *   * `buildServiceRecords` — the four records a W2M service instance publishes: a shared PTR under
 *     `_w2m._tcp.local`, and unique SRV + TXT + A records. TTLs follow RFC 6762 §10: 120 s for records
 *     naming or containing a host name (SRV, A), 75 minutes for the others (PTR, TXT).
 *   * `createResponder` — announces on start, answers matching questions, re-announces on a timer, and
 *     sends a TTL=0 goodbye on close (RFC 6762 §10.1) so peers drop us immediately instead of waiting
 *     out a 75-minute TTL.
 *   * `discoverServices` — one bounded scan with a fresh socket per call, which is what RFC 6762 §5.1
 *     describes ("one-shot" queries from an ephemeral source port; §5.1 is also why the socket is
 *     never bound to 5353).
 *
 * # Scope, stated rather than glossed
 *
 *   * **IPv4 only.** `224.0.0.251` and the `udp4` socket family. IPv6 (`ff02::fb`) is not half-built
 *     here; it would need its own socket, its own interface enumeration and its own tests.
 *   * **No probing or conflict resolution** (RFC 6762 §8.1, §9). A responder here announces its
 *     records immediately and does not defend them. Two machines configured with the same instance
 *     name would both answer. That is a real limitation, and it is acceptable *only* because of the
 *     rule above: a discovered name is a hint, and the pairing that actually authorises anything is
 *     keyed by machine id, not by the name two machines might collide on.
 *   * **No known-answer suppression** (RFC 6762 §7.1) and no negative responses (NSEC). A scan is one
 *     query; nothing here is a long-lived browsing client.
 *   * **The 10-second re-announce is a deliberate deviation.** RFC 6762 §8.3 says a responder "MUST NOT
 *     send regular periodic announcements as a matter of course" and asks for at least two
 *     announcements one second apart with the interval doubling. The periodic re-announce exists here
 *     because this is a small, fixed set of records on a tool that expects peers to appear and vanish,
 *     and because a peer that joined the link after our announcement would otherwise wait for its own
 *     query to find us. It is a knob (`announceIntervalMs`, `0` disables it), and the traffic is four
 *     records on a 10-second period.
 *   * **Name escapes are not parsed.** DNS-SD instance names may contain an escaped dot (`\.`); this
 *     codec would split it. Nothing in W2M's own names contains one, and identity does not come from
 *     the name, so the cost is a mis-split display name for a third-party service — not a wrong peer.
 */

import dgram from 'node:dgram';
import os from 'node:os';

import {
  RECORD_TYPE,
  decodeMessage,
  encodeQuery,
  encodeResponse,
  isUsableUnicastIpv4,
  nameEquals,
  normalizeName,
} from './mdns-wire.mjs';

/** The IPv4 link-local multicast address every mDNS name resolves through (RFC 6762 §3). */
export const MDNS_GROUP = '224.0.0.251';

/** The mDNS UDP port (RFC 6762 §5). A source port of 5353 means "fully compliant querier". */
export const MDNS_PORT = 5353;

/** The service type W2M instances advertise under. */
export const DEFAULT_SERVICE_TYPE = '_w2m._tcp.local';

/** Default window for one scan. RFC 6762 §5.2 expects responses within about a second. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;

/** Default re-announce period. See the header: this is a deliberate deviation from RFC 6762 §8.3. */
export const DEFAULT_ANNOUNCE_INTERVAL_MS = 10_000;

/** RFC 6762 §10: 120 s where a host name is involved, 75 minutes (4500 s) for everything else. */
export const DEFAULT_TTL_SECONDS = Object.freeze({ ptr: 4500, srv: 120, txt: 4500, address: 120 });

/** RFC 6762 §10.1: a goodbye is the same record with an RR TTL of zero. */
export const GOODBYE_TTL = 0;

/** Upper bound on instances one scan will report, so a flooding peer cannot grow this without limit. */
export const MAX_SCAN_INSTANCES = 64;

/** The first TXT string DNS-SD asks for (RFC 6763 §6.1). */
export const TXT_VERSION = 'txtvers=1';

/** TXT keys this layer reads. `mid` is the *only* one that can carry identity, and it is the relay's. */
export const TXT_KEYS = Object.freeze({ machineId: 'mid', machineName: 'name', version: 'v' });

// ---------------------------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------------------------

/**
 * Every IPv4 address this host has, internal ones included.
 *
 * The internal ones are *reported* rather than filtered out here, because "why is this machine not
 * joining the group" is answered by the list, and the caller that decides is one call away. Joining
 * `127.0.0.1` is what makes a loopback test possible, so the filter is a caller's policy, not a
 * property of this function.
 *
 * @param {{includeInternal?: boolean}} [options]
 * @returns {Array<{name: string, address: string, netmask: string|null, cidr: string|null, internal: boolean}>}
 */
export function listIPv4Interfaces(options = {}) {
  const includeInternal = options.includeInternal !== false;
  const out = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // A platform that cannot enumerate interfaces is a machine with no LAN hint layer, not a crash.
    return out;
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${entry.family}`;
      const internal = entry.internal === true;
      if (family !== 'IPv4') continue;
      if (internal && !includeInternal) continue;
      out.push({
        name,
        address: entry.address,
        netmask: entry.netmask ?? null,
        cidr: entry.cidr ?? null,
        internal,
      });
    }
  }
  return out;
}

/** `name._w2m._tcp.local` from an instance label and a service type. */
export function serviceFqdn(instance, serviceType = DEFAULT_SERVICE_TYPE) {
  const label = String(instance ?? '').trim();
  if (label === '') throw new TypeError('serviceFqdn: an instance name is required');
  return `${label}.${serviceType}`;
}

/** Split an instance FQDN back into `{instance, name}` (the first label, and the rest). */
export function splitInstanceFqdn(fqdn, serviceType = DEFAULT_SERVICE_TYPE) {
  const text = String(fqdn ?? '');
  const suffix = `.${serviceType}`;
  const name = normalizeName(text).endsWith(normalizeName(suffix))
    ? text.slice(0, text.length - suffix.length)
    : text;
  return { instance: text, name };
}

/** `mac-studio` → `mac-studio.local`; an already-qualified `a.local` is left alone. */
export function toHostFqdn(host) {
  const text = String(host ?? '')
    .trim()
    .replace(/\.$/, '');
  if (text === '') throw new TypeError('toHostFqdn: a host name is required');
  return normalizeName(text).endsWith('.local') ? text : `${text}.local`;
}

/**
 * A host name this host can call its own: the machine name, first label only, sanitised.
 *
 * `os.hostname()` may carry dots, spaces or non-ASCII on some platforms, none of which survive a DNS
 * label intact. This is a *display* name in the mDNS sense; identity travels in the TXT `mid` key.
 *
 * @param {string} [hostname]
 * @returns {string}
 */
export function localHostLabel(hostname = os.hostname()) {
  const first = String(hostname).split('.')[0];
  const cleaned = first
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned === '' ? 'w2m-host' : cleaned;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/**
 * The records one W2M service instance publishes.
 *
 * Layout follows DNS-SD (RFC 6763 §4–§6) with W2M's own keys in the TXT record:
 *
 *   `_w2m._tcp.local` PTR → `<instance>._w2m._tcp.local`            shared,   TTL 4500
 *   `<instance>._w2m._tcp.local` SRV → `<host>.local` port          unique,   TTL 120
 *   `<instance>._w2m._tcp.local` TXT → txtvers=1, mid=…, name=…     unique,   TTL 4500
 *   `<host>.local` A → the advertised IPv4 address                  unique,   TTL 120
 *
 * The TXT record carries the machine id the *relay* assigned (`mid=`). That is the only field in this
 * whole layer that can be matched against the roster, and even then it is a claim: anyone on the link
 * can put any `mid` in a TXT record. It buys the ability to *ask the relay about that machine*, which
 * is exactly the amount of trust a hint deserves — see `src/plugin/mdns-discover.mjs`.
 *
 * @param {object} options
 * @param {string} options.instance Instance label.
 * @param {string} [options.serviceType]
 * @param {string} options.host Host name (a `.local` name, or a bare label).
 * @param {number} options.servicePort The TCP port a peer would connect to.
 * @param {string|null} [options.address] IPv4 address to publish, or null for no A record.
 * @param {Record<string, string>|string[]} [options.txt] Extra TXT strings or key/value pairs.
 * @param {string|null} [options.machineId] The relay's machine id, published as `mid=`.
 * @param {string|null} [options.machineName] Display name, published as `name=`.
 * @param {object} [options.ttl] Overrides for {@link DEFAULT_TTL_SECONDS}.
 * @param {boolean} [options.goodbye] Emit the same records with TTL 0 (RFC 6762 §10.1).
 * @returns {object[]}
 */
export function buildServiceRecords(options) {
  const serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
  const ttl = { ...DEFAULT_TTL_SECONDS, ...(options.ttl ?? {}) };
  const goodbye = options.goodbye === true;
  const at = (value) => (goodbye ? GOODBYE_TTL : value);
  const instanceFqdn = serviceFqdn(options.instance, serviceType);
  const hostFqdn = toHostFqdn(options.host ?? localHostLabel());
  const port = Number(options.servicePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(
      `buildServiceRecords: servicePort must be an integer in 1..65535, got ${JSON.stringify(options.servicePort)}`,
    );
  }

  const txt = [TXT_VERSION];
  if (typeof options.machineId === 'string' && options.machineId !== '') {
    txt.push(`${TXT_KEYS.machineId}=${options.machineId}`);
  }
  if (typeof options.machineName === 'string' && options.machineName !== '') {
    txt.push(`${TXT_KEYS.machineName}=${options.machineName}`);
  }
  const extra = Array.isArray(options.txt)
    ? options.txt.map((entry) => String(entry)).filter(Boolean)
    : Object.entries(options.txt ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const entry of extra) if (!txt.includes(entry)) txt.push(entry);

  const records = [
    // Shared: many responders may publish a PTR for the same service type, so no cache-flush bit.
    { name: serviceType, type: RECORD_TYPE.PTR, ttl: at(ttl.ptr), target: instanceFqdn },
    // Unique: exactly one owner, so the cache-flush bit tells peers to drop older SRV/TXT/A records
    // for these names (RFC 6762 §10.2). This is what stops a peer that moved from keeping the old
    // address: the new record *replaces* rather than joins.
    {
      name: instanceFqdn,
      type: RECORD_TYPE.SRV,
      ttl: at(ttl.srv),
      port,
      priority: 0,
      weight: 0,
      target: hostFqdn,
      cache_flush: !goodbye,
    },
    { name: instanceFqdn, type: RECORD_TYPE.TXT, ttl: at(ttl.txt), txt, cache_flush: !goodbye },
  ];
  if (typeof options.address === 'string' && options.address !== '') {
    records.push({
      name: hostFqdn,
      type: RECORD_TYPE.A,
      ttl: at(ttl.address),
      address: options.address,
      cache_flush: !goodbye,
    });
  }
  // A goodbye is a *deletion*. RFC 6762 §10.1 has the TTL alone carry that meaning, and §10.2's
  // cache-flush bit must not be set on it: a cooperating responder's own records for the same name
  // must not be flushed along with ours.
  return goodbye ? records.map((record) => ({ ...record, cache_flush: false })) : records;
}

// ---------------------------------------------------------------------------------------------
// The observation cache: last-writer-wins per record, TTL honoured
// ---------------------------------------------------------------------------------------------

/**
 * A short-lived record cache for one scan (or one long-lived querier).
 *
 * The update rule is the one thing this layer gets to choose, and it is chosen against the defect a
 * studied implementation has: **there is no first-writer-wins and no "keep the first non-zero port".**
 *
 *   * A record is identified by `(name, type, rdata)`. A later copy of the same record *replaces* the
 *     earlier one and restarts its TTL — the definition of a cache update (RFC 1035 §3.2.1, RFC 6762
 *     §10).
 *   * A record carrying the cache-flush bit replaces the whole RRset of that `(name, type)`: other
 *     RDATA for the same name and type is dropped. RFC 6762 §10.2 gives other members one second of
 *     grace for the multi-packet case; this cache has no second consumer and no peer reading it, so it
 *     drops them immediately, which is the *safe* direction — a stale address never survives.
 *   * A record with TTL 0 is a goodbye (RFC 6762 §10.1) and deletes every record with that
 *     `(name, type)` at once. RFC 6762 suggests a long-lived querier record TTL 1 and delete a second
 *     later, to give cooperating responders a chance to rescue the records; for a bounded scan the
 *     honest reading is "the peer said this is gone", and keeping it for a second would mean reporting
 *     a device that has already said goodbye.
 *   * Every entry carries `expires_at` from its own TTL, so a record whose TTL runs out mid-scan stops
 *     being reported the moment it expires.
 *
 * @param {{now?: () => number, max?: number}} [options]
 * @returns {object}
 */
export function createRecordCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 512;
  /** @type {Map<string, {record: object, at: number, observed_address: string|null, expires_at: number}>} */
  const entries = new Map();

  const nameTypeKey = (record) => `${normalizeName(record.name)}|${record.type}`;
  const recordKey = (record) => `${nameTypeKey(record)}|${record.rdata.toString('hex')}`;

  /**
   * Apply one decoded record.
   *
   * @param {object} record A record from {@link decodeMessage}.
   * @param {{at?: number, observed_address?: string|null}} [context]
   * @returns {{action: 'set'|'goodbye', key: string, flushed: number, entries: number}}
   */
  function apply(record, context = {}) {
    const at = Number.isFinite(context.at) ? context.at : now();
    const observed = typeof context.observed_address === 'string' ? context.observed_address : null;
    const setKey = nameTypeKey(record);
    let flushed = 0;

    for (const [key, entry] of entries) {
      if (!key.startsWith(`${setKey}|`)) continue;
      if (record.ttl === 0 || record.cache_flush === true) {
        entries.delete(key);
        flushed += 1;
      } else if (entry.expires_at <= at) {
        // Expired on arrival: dropping it keeps "the cache is what is still true" a property of this
        // structure rather than of everyone who reads it.
        entries.delete(key);
      }
    }

    if (record.ttl === 0) return { action: 'goodbye', key: setKey, flushed, entries: entries.size };

    entries.set(recordKey(record), {
      record,
      at,
      observed_address: observed,
      expires_at: at + record.ttl * 1000,
    });
    while (entries.size > max) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
    return { action: 'set', key: recordKey(record), flushed, entries: entries.size };
  }

  /**
   * Every record still true, oldest observation first.
   *
   * @param {{at?: number}} [context]
   * @returns {Array<{record: object, at: number, observed_address: string|null, expires_at: number}>}
   */
  function live(context = {}) {
    const at = Number.isFinite(context.at) ? context.at : now();
    const out = [];
    for (const [key, entry] of entries) {
      if (entry.expires_at <= at) {
        entries.delete(key);
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  return {
    apply,
    live,
    get size() {
      return entries.size;
    },
    clear: () => entries.clear(),
  };
}

// ---------------------------------------------------------------------------------------------
// Reassembly: records → service instances
// ---------------------------------------------------------------------------------------------

/**
 * Assemble decoded records into service instances.
 *
 * An mDNS answer for one service arrives as several records — often across several packets — and the
 * only thing that ties them together is the *name*: the PTR names the instance, the SRV and TXT are
 * owned by that instance name, and the A record is owned by the SRV target. Reassembly therefore
 * follows names, never packet boundaries, and picks the **latest** record of each `(name, type)` when
 * several are present. That is the same rule as {@link createRecordCache}'s, applied a second time so
 * that a caller handing this function a flat list of records (as a test does) gets the same answer as
 * a caller handing it a cache snapshot.
 *
 * @param {Array<object|{record: object, at?: number, observed_address?: string|null}>} input
 * @param {{serviceType?: string, max?: number, now?: () => number}} [options]
 * @returns {{instances: object[], truncated: number, counts: object}}
 */
export function parseServiceInstances(input, options = {}) {
  const serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : MAX_SCAN_INSTANCES;
  const entries = (Array.isArray(input) ? input : [])
    .map((entry, index) =>
      entry && typeof entry === 'object' && entry.record
        ? { ...entry, index }
        : { record: entry, at: 0, observed_address: null, index },
    )
    .filter((entry) => entry.record && typeof entry.record === 'object');
  const live = entries.filter((entry) => entry.record.ttl !== 0);

  /** Keep the latest entry per key: last writer wins, ties broken by arrival order. */
  const latestBy = (filter, keyOf) => {
    const kept = new Map();
    for (const entry of live) {
      if (!filter(entry.record)) continue;
      const key = keyOf(entry.record);
      if (key === null) continue;
      const previous = kept.get(key);
      if (
        previous === undefined ||
        entry.at > previous.at ||
        (entry.at === previous.at && entry.index >= previous.index)
      ) {
        kept.set(key, entry);
      }
    }
    return [...kept.values()];
  };

  const ptrs = latestBy(
    (record) =>
      record.type === RECORD_TYPE.PTR &&
      nameEquals(record.name, serviceType) &&
      typeof record.target === 'string',
    (record) => normalizeName(record.target),
  );
  const srvs = latestBy(
    (record) => record.type === RECORD_TYPE.SRV,
    (record) => normalizeName(record.name),
  );
  const txts = latestBy(
    (record) => record.type === RECORD_TYPE.TXT,
    (record) => normalizeName(record.name),
  );
  const addresses = new Map();
  for (const entry of live) {
    const record = entry.record;
    if (record.type !== RECORD_TYPE.A && record.type !== RECORD_TYPE.AAAA) continue;
    const key = normalizeName(record.name);
    if (!addresses.has(key)) addresses.set(key, new Map());
    addresses.get(key).set(record.address, entry);
  }
  // Count SRV records that lost the latest-writer comparison, so a caller can see that a device moved
  // during the scan rather than having to infer it.
  const srvCounts = new Map();
  for (const entry of live) {
    if (entry.record.type !== RECORD_TYPE.SRV) continue;
    const key = normalizeName(entry.record.name);
    srvCounts.set(key, (srvCounts.get(key) ?? 0) + 1);
  }

  const srvsByName = new Map(srvs.map((entry) => [normalizeName(entry.record.name), entry]));
  const txtsByName = new Map(txts.map((entry) => [normalizeName(entry.record.name), entry]));
  // A PTR names its instance in its *target*; an SRV or TXT names it in its *owner*. An instance seen
  // without a PTR (a peer that answered with only SRV/TXT, or a scan that started mid-answer) is still
  // the same instance, so it is assembled the same way and merely flagged `advertised_via_ptr: false`.
  const ordered = ptrs.map((entry) => ({ entry, instanceFqdn: entry.record.target, viaPtr: true }));
  for (const entry of srvs) {
    if (ptrs.some((ptr) => nameEquals(ptr.record.target, entry.record.name))) continue;
    ordered.push({ entry, instanceFqdn: entry.record.name, viaPtr: false });
  }
  ordered.sort((a, b) =>
    a.entry.at === b.entry.at ? a.entry.index - b.entry.index : a.entry.at - b.entry.at,
  );

  const instances = [];
  for (const item of ordered) {
    const { entry: ptr, instanceFqdn, viaPtr } = item;
    const key = normalizeName(instanceFqdn);
    const srv = srvsByName.get(key) ?? null;
    const txt = txtsByName.get(key) ?? null;
    const host = srv?.record.target ?? null;
    const addressEntries = host === null ? [] : [...(addresses.get(normalizeName(host))?.values() ?? [])];
    const txtStrings = Array.isArray(txt?.record.txt) ? txt.record.txt : [];
    instances.push({
      instance: instanceFqdn,
      name: splitInstanceFqdn(instanceFqdn, serviceType).name,
      service_type: serviceType,
      host,
      port: srv?.record.port ?? null,
      priority: srv?.record.priority ?? null,
      weight: srv?.record.weight ?? null,
      addresses: addressEntries.map((entry) => entry.record.address),
      // Where the packet that named this instance actually came from. A hint about the address that
      // is independent of the A record, and often the more useful one on a link where peers do not
      // publish address records at all.
      observed_address: srv?.observed_address ?? ptr.observed_address ?? null,
      txt: { raw: txtStrings, map: txtMap(txtStrings) },
      ttl: {
        ptr: ptr.record.ttl,
        srv: srv?.record.ttl ?? null,
        txt: txt?.record.ttl ?? null,
      },
      advertised_via_ptr: viaPtr,
      saw_srv: srv !== null,
      saw_txt: txt !== null,
      // How many SRV records for this instance arrived before the winning one. A device that moved
      // during the scan leaves a trail here; it does not leave a stale port in `port`.
      superseded_srv: Math.max(0, (srvCounts.get(key) ?? 1) - 1),
      // The newest record of any kind that belongs to this instance, address records included: an
      // instance whose address is the only thing that changed is still an instance that changed.
      updated_at: Math.max(ptr.at, srv?.at ?? 0, txt?.at ?? 0, ...addressEntries.map((entry) => entry.at)),
    });
    if (instances.length >= max) break;
  }

  return {
    instances,
    truncated: Math.max(0, ordered.length - instances.length),
    counts: {
      records: entries.length,
      ptr: ptrs.length,
      srv: srvs.length,
      txt: txts.length,
      addresses: [...addresses.values()].reduce((total, set) => total + set.size, 0),
    },
  };
}

/**
 * TXT character-strings → a key/value map.
 *
 * RFC 6763 §6.1: a string with no `=` is a key with an empty value; a duplicate key keeps the first
 * occurrence (the RFC's rule for its own keys).
 *
 * @param {string[]} strings
 * @returns {Record<string, string>}
 */
export function txtMap(strings) {
  const map = {};
  for (const text of Array.isArray(strings) ? strings : []) {
    const index = text.indexOf('=');
    const key = index === -1 ? text : text.slice(0, index);
    const value = index === -1 ? '' : text.slice(index + 1);
    if (key === '' || Object.prototype.hasOwnProperty.call(map, key)) continue;
    map[key] = value;
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Socket plumbing
// ---------------------------------------------------------------------------------------------

/**
 * Bind a `udp4` socket, resolving with it or rejecting with the platform's error.
 *
 * `reuseAddr` is set because on a machine where another mDNS responder (Bonjour, systemd-resolved,
 * avahi) already holds 5353 the bind must still succeed: sharing the port is the normal case for mDNS,
 * and refusing to start because someone else is also listening would make this layer useless on
 * exactly the machines that need it most.
 *
 * @param {{address?: string, port?: number, reuseAddr?: boolean}} [options]
 * @returns {Promise<import('node:dgram').Socket>}
 */
export function bindUdpSocket(options = {}) {
  const address = options.address ?? '0.0.0.0';
  const port = Number.isInteger(options.port) ? options.port : 0;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: options.reuseAddr !== false });
    const onError = (error) => {
      socket.removeListener('listening', onListening);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(error);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, address);
  });
}

/**
 * Send one datagram, resolving with a report instead of rejecting.
 *
 * Every send in this module goes through here for one reason: a locked-down network, a container with
 * no multicast route, or an interface that vanished mid-scan must produce a *reported* failure, never
 * an unhandled rejection and never a silent success.
 *
 * @param {import('node:dgram').Socket} socket
 * @param {Buffer} bytes
 * @param {{address: string, port: number}} target
 * @returns {Promise<{ok: boolean, target: object, bytes: number, error: string|null, code: string|null}>}
 */
export function sendDatagram(socket, bytes, target) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ ok: false, target, bytes: bytes.length, error: 'no socket', code: 'MDNS_NO_SOCKET' });
      return;
    }
    try {
      socket.send(bytes, target.port, target.address, (error) => {
        resolve({
          ok: !error,
          target,
          bytes: bytes.length,
          error: error ? `${error.code ?? 'ERROR'}: ${error.message}` : null,
          code: error ? (error.code ?? 'MDNS_SEND_FAILED') : null,
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        target,
        bytes: bytes.length,
        error: `${error?.code ?? 'ERROR'}: ${error?.message ?? String(error)}`,
        code: error?.code ?? 'MDNS_SEND_FAILED',
      });
    }
  });
}

/** Close a socket without ever throwing: closing twice is a no-op. */
export function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve();
      return;
    }
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------------------------

/**
 * An mDNS responder for one W2M service instance.
 *
 * @param {object} options
 * @param {string} options.servicePort The TCP port a peer would connect to. Required.
 * @param {string} [options.instance] Instance label; defaults to this host's name.
 * @param {string} [options.host] Host label for the SRV target and the A record.
 * @param {string} [options.serviceType]
 * @param {string|null} [options.address] IPv4 address to advertise. Defaults to the first usable
 *   non-internal address at `start()` time.
 * @param {string|null} [options.machineId] Published as `mid=` in TXT. Never a secret.
 * @param {string|null} [options.machineName] Published as `name=` in TXT.
 * @param {Record<string, string>} [options.txt]
 * @param {string} [options.group]
 * @param {number} [options.mdnsPort] The port queried and the port a "legacy" reply is recognised by.
 * @param {string} [options.bindAddress]
 * @param {number} [options.announceIntervalMs] `0` disables the re-announce timer.
 * @param {boolean} [options.multicastLoopback] Passed to `setMulticastLoopback`, in a try/catch.
 * @param {number} [options.multicastTtl] Passed to `setMulticastTTL`, in a try/catch.
 * @param {() => Array<object>} [options.interfaces] Injectable interface list, for tests.
 * @param {(bytes: Buffer, target: {address: string, port: number}) => void} [options.sink] Where
 *   datagrams go. Defaults to the socket; a test passes one to exercise the packet path with no socket.
 * @param {(line: string) => void} [options.logger] One-line diagnostics. Never fatal.
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createResponder(options = {}) {
  const group = options.group ?? MDNS_GROUP;
  const mdnsPort = Number.isInteger(options.mdnsPort) ? options.mdnsPort : MDNS_PORT;
  const serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
  const instance = String(options.instance ?? localHostLabel());
  const host = toHostFqdn(options.host ?? localHostLabel());
  const bindAddress = options.bindAddress ?? '0.0.0.0';
  const announceIntervalMs = Number.isInteger(options.announceIntervalMs)
    ? options.announceIntervalMs
    : DEFAULT_ANNOUNCE_INTERVAL_MS;
  const listInterfaces = typeof options.interfaces === 'function' ? options.interfaces : listIPv4Interfaces;
  const sink = typeof options.sink === 'function' ? options.sink : null;
  const log = typeof options.logger === 'function' ? options.logger : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const instanceFqdn = serviceFqdn(instance, serviceType);

  /** @type {import('node:dgram').Socket|null} */
  let socket = null;
  let timer = null;
  let startedAt = null;
  let closed = false;
  let goodbyeSent = false;
  let announcedCount = 0;
  let lastAnnounceAt = null;
  let replies = 0;
  let lastError = null;
  let lastRefusal = null;
  let refusedPackets = 0;
  let ignoredResponses = 0;
  let ignoredOpcode = 0;
  let unanswered = 0;
  let advertisedAddress =
    typeof options.address === 'string' && options.address !== '' ? options.address : null;
  const memberships = [];
  const knobs = { multicast_loopback: null, multicast_ttl: null };
  const errors = [];

  const note = (line) => {
    lastError = line;
    errors.push({ at: now(), line });
    if (errors.length > 20) errors.shift();
    try {
      log?.(line);
    } catch {
      /* a logger that throws must not take the responder with it */
    }
  };

  /** The records this responder owns right now. */
  function records() {
    return buildServiceRecords({
      instance,
      serviceType,
      host,
      servicePort: options.servicePort,
      address: advertisedAddress,
      machineId: options.machineId ?? null,
      machineName: options.machineName ?? null,
      txt: options.txt ?? {},
      ttl: options.ttl,
    });
  }

  /** Where a datagram goes: the injected sink when there is one, the socket otherwise. */
  async function send(bytes, target) {
    if (sink) {
      try {
        sink(bytes, target);
        return { ok: true, target, bytes: bytes.length, error: null, code: null };
      } catch (error) {
        return {
          ok: false,
          target,
          bytes: bytes.length,
          error: String(error?.message ?? error),
          code: 'MDNS_SINK_FAILED',
        };
      }
    }
    return sendDatagram(socket, bytes, target);
  }

  /**
   * Multicast our records (RFC 6762 §8.3), or the TTL=0 goodbye when `goodbye` is set (§10.1).
   *
   * @param {{goodbye?: boolean}} [announceOptions]
   * @returns {Promise<object>}
   */
  async function announce(announceOptions = {}) {
    const goodbye = announceOptions.goodbye === true;
    let bytes;
    try {
      bytes = encodeResponse({
        query: null,
        answers: buildServiceRecords({
          instance,
          serviceType,
          host,
          servicePort: options.servicePort,
          address: advertisedAddress,
          machineId: options.machineId ?? null,
          machineName: options.machineName ?? null,
          txt: options.txt ?? {},
          ttl: options.ttl,
          goodbye,
        }),
      });
    } catch (error) {
      note(`mDNS: could not build the ${goodbye ? 'goodbye' : 'announcement'}: ${error?.message ?? error}`);
      return { ok: false, bytes: 0, error: String(error?.message ?? error) };
    }
    const result = await send(bytes, { address: group, port: mdnsPort });
    if (!result.ok)
      note(`mDNS: ${goodbye ? 'goodbye' : 'announcement'} to ${group}:${mdnsPort} failed (${result.error})`);
    if (goodbye) goodbyeSent = result.ok;
    else {
      announcedCount += 1;
      lastAnnounceAt = now();
    }
    return result;
  }

  /**
   * Match a query's questions against our records.
   *
   * The whole rule, stated once: answer a question about *our* service type, *our* instance, or *our*
   * host, for a type we have; carry the rest of the set in the additional section so a peer does not
   * have to ask a second time.
   *
   * @param {object[]} questions
   * @returns {{answers: object[], additionals: object[], matched: number, unicast_requested: boolean}}
   */
  function matchQuestions(questions) {
    const owned = records();
    const byKey = new Map(owned.map((record) => [`${normalizeName(record.name)}|${record.type}`, record]));
    const answers = [];
    const additionals = [];
    let matched = 0;
    let unicastRequested = false;

    const want = (name, type) => {
      const wanted = type === RECORD_TYPE.ANY ? null : type;
      const found = [];
      for (const [key, record] of byKey) {
        if (!key.startsWith(`${normalizeName(name)}|`)) continue;
        if (wanted !== null && record.type !== wanted) continue;
        found.push(record);
      }
      return found;
    };

    for (const question of questions ?? []) {
      if (question.unicast_response === true) unicastRequested = true;
      const aboutService = nameEquals(question.name, serviceType);
      const aboutInstance = nameEquals(question.name, instanceFqdn);
      const aboutHost = nameEquals(question.name, host);
      if (!aboutService && !aboutInstance && !aboutHost) continue;

      const direct = want(question.name, question.type);
      if (direct.length === 0) continue;
      matched += 1;
      for (const record of direct) if (!answers.includes(record)) answers.push(record);

      // The "additional" records a peer needs next: PTR → SRV + TXT, SRV → A.
      const extras = aboutService
        ? [
            ...want(instanceFqdn, RECORD_TYPE.SRV),
            ...want(instanceFqdn, RECORD_TYPE.TXT),
            ...want(host, RECORD_TYPE.A),
          ]
        : aboutInstance
          ? [...want(host, RECORD_TYPE.A)]
          : [];
      for (const record of extras) {
        if (answers.includes(record) || additionals.includes(record)) continue;
        additionals.push(record);
      }
    }
    return { answers, additionals, matched, unicast_requested: unicastRequested };
  }

  /**
   * Handle one received datagram: decode, filter, match, reply.
   *
   * Never throws: a malformed packet is counted and a query we do not answer is counted, and both are
   * values on this object rather than exceptions in a socket callback.
   *
   * @param {Buffer} bytes
   * @param {{address?: string, port?: number, family?: string}} rinfo
   * @returns {object}
   */
  function handleMessage(bytes, rinfo = {}) {
    const outcome = {
      handled: false,
      reason: null,
      responded: false,
      legacy: false,
      unicast: false,
      answers: 0,
      additionals: 0,
      bytes: 0,
    };
    let decoded;
    try {
      decoded = decodeMessage(bytes);
    } catch (error) {
      // decodeMessage refuses rather than throwing, but a responder must not be the one place that
      // trusts that claim enough to skip the catch.
      refusedPackets += 1;
      lastRefusal = 'MDNS_INTERNAL';
      outcome.reason = `internal: ${error?.message ?? error}`;
      return outcome;
    }
    if (!decoded.ok) {
      refusedPackets += 1;
      lastRefusal = decoded.reason;
      outcome.reason = decoded.reason;
      return outcome;
    }
    const message = decoded.message;
    outcome.handled = true;

    // RFC 6762 §18.3: an opcode other than zero is not a standard query and must be ignored.
    if (message.flags.opcode !== 0) {
      ignoredOpcode += 1;
      outcome.reason = 'opcode';
      return outcome;
    }
    // A response. We implement no conflict detection, so nothing here reacts to a peer's answer; it is
    // counted, because "someone on this link is announcing something" is worth being able to see.
    if (message.flags.qr) {
      ignoredResponses += 1;
      outcome.reason = 'response';
      return outcome;
    }

    const match = matchQuestions(message.questions);
    if (match.matched === 0) {
      unanswered += 1;
      outcome.reason = 'no_matching_question';
      return outcome;
    }

    // RFC 6762 §6.7: a query whose source port is not 5353 comes from a one-shot resolver, and MUST be
    // answered directly, with the query id and question repeated and short TTLs. §5.4: a question with
    // the unicast-response bit asks for the same treatment.
    const legacy = rinfo.port !== mdnsPort;
    const unicast = legacy || match.unicast_requested;
    let reply;
    try {
      reply = encodeResponse({
        query: message,
        answers: match.answers,
        additionals: match.additionals,
        legacy,
      });
    } catch (error) {
      note(`mDNS: could not build a reply: ${error?.message ?? error}`);
      outcome.reason = 'reply_failed';
      return outcome;
    }

    const target = unicast
      ? { address: rinfo.address ?? group, port: Number.isInteger(rinfo.port) ? rinfo.port : mdnsPort }
      : { address: group, port: mdnsPort };
    outcome.legacy = legacy;
    outcome.unicast = unicast;
    outcome.answers = match.answers.length;
    outcome.additionals = match.additionals.length;
    outcome.bytes = reply.length;
    outcome.target = target;
    // Fire and forget on purpose: a responder must not queue behind a slow send, and a failed send is
    // reported through `last_error` rather than thrown into an event handler.
    send(reply, target)
      .then((result) => {
        if (result.ok) replies += 1;
        else note(`mDNS: reply to ${target.address}:${target.port} failed (${result.error})`);
      })
      .catch(() => {});
    outcome.responded = true;
    return outcome;
  }

  /**
   * Bind, join, announce, and start re-announcing.
   *
   * @returns {Promise<object>} {@link createResponder}'s `status()`.
   */
  async function start() {
    if (socket !== null && !closed) return status();
    if (startedAt === null) startedAt = now();
    try {
      socket = await bindUdpSocket({ address: bindAddress, port: mdnsPort, reuseAddr: true });
    } catch (error) {
      // Bind failure is reported, not thrown: on a container with no multicast the caller logs one
      // line and carries on. (`EADDRINUSE` is rare here because of `reuseAddr`, but `EACCES` on a
      // locked-down host is not.)
      note(
        `mDNS: cannot bind ${bindAddress}:${mdnsPort} (${error?.code ?? 'ERROR'}: ${error?.message ?? error})`,
      );
      socket = null;
      return status();
    }
    socket.on('error', (error) =>
      note(`mDNS: socket error (${error?.code ?? 'ERROR'}: ${error?.message ?? error})`),
    );
    socket.on('message', (bytes, rinfo) => handleMessage(bytes, rinfo));

    // Both of these throw on some platforms (and on some interfaces), and neither is essential: a
    // responder that cannot set its multicast TTL still answers unicast and still announces.
    try {
      socket.setMulticastLoopback(options.multicastLoopback !== false);
      knobs.multicast_loopback = { ok: true, value: options.multicastLoopback !== false, error: null };
    } catch (error) {
      knobs.multicast_loopback = {
        ok: false,
        value: null,
        error: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`,
      };
    }
    const ttl = Number.isInteger(options.multicastTtl) ? options.multicastTtl : 255;
    try {
      socket.setMulticastTTL(ttl);
      knobs.multicast_ttl = { ok: true, value: ttl, error: null };
    } catch (error) {
      knobs.multicast_ttl = {
        ok: false,
        value: null,
        error: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`,
      };
    }

    // Every non-internal IPv4 interface, not just the first: a laptop on Wi-Fi and Ethernet at once is
    // on two links, and joining one of them makes the responder invisible on the other.
    const candidates = listInterfaces({ includeInternal: options.includeInternalInterfaces === true });
    for (const entry of candidates) {
      if (entry.internal === true && options.includeInternalInterfaces !== true) continue;
      try {
        socket.addMembership(group, entry.address);
        memberships.push({ interface: entry.name, address: entry.address, ok: true, error: null });
      } catch (error) {
        memberships.push({
          interface: entry.name,
          address: entry.address,
          ok: false,
          error: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`,
        });
      }
    }
    if (memberships.length > 0 && memberships.every((entry) => !entry.ok)) {
      note(
        `mDNS: no interface accepted a membership in ${group} (${memberships.length} tried); ` +
          'announcements will go out the default route only, if at all',
      );
    }
    if (advertisedAddress === null) {
      const usable = candidates.find((entry) => !entry.internal && isUsableUnicastIpv4(entry.address));
      advertisedAddress = usable?.address ?? null;
    }

    await announce();
    if (announceIntervalMs > 0) {
      timer = setInterval(() => {
        announce().catch(() => {});
      }, announceIntervalMs);
      // A responder must never be the reason a CLI process will not exit.
      if (typeof timer.unref === 'function') timer.unref();
    }
    return status();
  }

  /**
   * Send the TTL=0 goodbye, stop the timer, and close the socket.
   *
   * The goodbye is awaited before the socket closes: a goodbye that never left the machine is worse
   * than none, because the log would say the peers were told.
   *
   * @returns {Promise<object>}
   */
  async function close() {
    if (closed) return { ok: true, goodbye: goodbyeSent, already_closed: true };
    closed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const goodbye =
      socket === null && sink === null
        ? { ok: false, error: 'never started' }
        : await announce({ goodbye: true });
    await closeSocket(socket);
    socket = null;
    return { ok: goodbye.ok === true, goodbye: goodbye.ok === true, error: goodbye.error ?? null };
  }

  /** A snapshot for `w2m_status`-style surfaces and for tests. */
  function status() {
    const bound = socket === null ? null : safeAddress(socket);
    return {
      running: socket !== null && !closed,
      closed,
      instance,
      instance_fqdn: instanceFqdn,
      host,
      service_type: serviceType,
      service_port: Number.isInteger(options.servicePort) ? options.servicePort : null,
      address: advertisedAddress,
      group,
      mdns_port: mdnsPort,
      bind_address: bindAddress,
      bound,
      memberships,
      knobs,
      announce_interval_ms: announceIntervalMs,
      announcements: announcedCount,
      last_announce_at: lastAnnounceAt,
      replies,
      refused_packets: refusedPackets,
      last_refusal: lastRefusal,
      ignored: { responses: ignoredResponses, opcode: ignoredOpcode, unanswered },
      goodbye_sent: goodbyeSent,
      last_error: lastError,
      errors,
      started_at: startedAt,
    };
  }

  return {
    start,
    close,
    announce,
    handleMessage,
    records,
    matchQuestions,
    status,
    /** The instance FQDN this responder answers for. */
    get instanceFqdn() {
      return instanceFqdn;
    },
  };
}

/** `socket.address()` throws once the socket is closed; a status read must not. */
function safeAddress(socket) {
  try {
    const value = socket.address();
    return { address: value.address, port: value.port, family: value.family };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

/** Wait, or give up early when the caller aborts. */
function waitFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve('elapsed');
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve('aborted');
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * One bounded mDNS scan for W2M service instances.
 *
 * A fresh socket per call, bound to an ephemeral port: RFC 6762 §5.1 requires a one-shot query *not*
 * to come from port 5353, and a fresh socket also means a scan cannot be poisoned by the previous
 * scan's socket state. The socket is closed on every path, including a throw from a caller's abort
 * signal, and the whole function resolves — it never rejects.
 *
 * What comes back is *evidence*, not a verdict: records as the wire carried them, reassembled into
 * instances, with the address each packet was observed to come from. Nothing here is verified, and
 * nothing here may be dispatched to without the gates in `src/plugin/mdns-discover.mjs`.
 *
 * @param {object} [options]
 * @param {string} [options.serviceType]
 * @param {number} [options.timeoutMs] Window, clamped to 50..10000 ms.
 * @param {string} [options.group]
 * @param {number} [options.mdnsPort]
 * @param {Array<{address: string, port: number}>} [options.targets] Where the query goes. Defaults to
 *   the multicast group:5353. A test, or a network where multicast is filtered, can name a unicast
 *   target instead — the query is identically shaped either way.
 * @param {string} [options.bindAddress]
 * @param {boolean} [options.unicastResponse] Set the QU bit (RFC 6762 §5.4).
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.now]
 * @returns {Promise<object>}
 */
export async function discoverServices(options = {}) {
  const serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
  const group = options.group ?? MDNS_GROUP;
  const mdnsPort = Number.isInteger(options.mdnsPort) ? options.mdnsPort : MDNS_PORT;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const requested = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const timeoutMs = Math.min(10_000, Math.max(50, Math.round(requested)));
  const targets =
    Array.isArray(options.targets) && options.targets.length > 0
      ? options.targets.map((target) => ({ address: target.address, port: Number(target.port) }))
      : [{ address: group, port: mdnsPort }];

  const startedAt = now();
  const cache = createRecordCache({ now });
  const queries = [];
  const packets = { received: 0, refused: 0, ignored: 0, answers: 0, answers_without_records: 0 };
  const refusals = [];
  /** @type {import('node:dgram').Socket|null} */
  let bound = null;
  let boundTo = null;
  let lastRefusal = null;
  let socketError = null;
  let outcome = 'elapsed';

  try {
    // `encodeQuery` can only throw on our own arguments, and a bad service type is a caller bug worth
    // reporting as a failed scan rather than an exception out of a tool.
    const query = encodeQuery({ serviceType, unicastResponse: options.unicastResponse === true });
    try {
      bound = await bindUdpSocket({ address: options.bindAddress ?? '0.0.0.0', port: 0 });
      boundTo = safeAddress(bound);
    } catch (error) {
      socketError = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`;
    }

    if (bound !== null) {
      bound.on('error', (error) => {
        socketError = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`;
      });
      // Responses to a one-shot query are unicast back to this socket (§5.1/§6.7), but a responder on
      // the same link may also multicast its answer, which arrives here too because the socket joined
      // nothing and is simply addressed. Both are handled the same way, and both are hints.
      bound.on('message', (bytes, rinfo) => {
        packets.received += 1;
        const decoded = decodeMessage(bytes);
        if (!decoded.ok) {
          packets.refused += 1;
          lastRefusal = decoded.reason;
          if (refusals.length < 10) refusals.push({ reason: decoded.reason, from: rinfo?.address ?? null });
          return;
        }
        if (!decoded.message.flags.qr) {
          // Another host's query. Nothing in a bounded scan needs to read it.
          packets.ignored += 1;
          return;
        }
        const records = decoded.message.records;
        if (records.length === 0) {
          packets.answers_without_records += 1;
          return;
        }
        packets.answers += 1;
        const at = now();
        for (const record of records) {
          cache.apply(record, { at, observed_address: rinfo?.address ?? null });
        }
      });
      for (const target of targets) {
        const sent = await sendDatagram(bound, query, target);
        queries.push({ ...sent, at: now() });
      }
      outcome = await waitFor(timeoutMs, options.signal);
    }
  } catch (error) {
    socketError = socketError ?? `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`;
  } finally {
    await closeSocket(bound);
    bound = null;
  }

  const live = cache.live();
  const assembled = parseServiceInstances(live, { serviceType });
  const sentOk = queries.filter((query) => query.ok);
  const available = sentOk.length > 0;
  const elapsedMs = now() - startedAt;
  let error = null;
  if (!available) {
    error =
      socketError !== null
        ? `MDNS_UNAVAILABLE: no mDNS query could be sent (${socketError})`
        : 'MDNS_UNAVAILABLE: no mDNS query could be sent to any target';
  }

  return {
    ok: available,
    available,
    error,
    service_type: serviceType,
    group,
    mdns_port: mdnsPort,
    socket: boundTo,
    targets,
    queries,
    sent: sentOk.length,
    elapsed_ms: elapsedMs,
    aborted: outcome === 'aborted',
    timeout_ms: timeoutMs,
    instances: assembled.instances,
    truncated: assembled.truncated,
    records: live.map((entry) => entry.record),
    packets,
    refusals,
    last_refusal: lastRefusal,
    counts: {
      instances: assembled.instances.length,
      records: live.length,
      refused_packets: packets.refused,
      ...assembled.counts,
    },
    note: available
      ? `queried ${serviceType} on ${targets.map((target) => `${target.address}:${target.port}`).join(', ')} for ${elapsedMs} ms` +
        (assembled.instances.length === 0 ? '; no peer answered - that is not evidence that none exists' : '')
      : error,
  };
}
