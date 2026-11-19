/**
 * Relay state — members, pairing, presence/RTT and the §6.1 capability/version gate.
 *
 * Split out of `state.mjs` (P1 refactor slice S5). Every function takes the owning
 * `RabbitState` as its first argument (the pure version/gate helpers do not need it), so
 * there is exactly one copy of every field and no duplicated state. No module-level mutable
 * state, no timers, no network, no filesystem.
 */

import { deviceFleetFields } from '../../chatops/fleet-wiring.mjs';
import { planJoin } from '../../chatops/fleet-join.mjs';
import { buildMembers, setMemberRole as applyMemberRole } from '../fleet-members.mjs';
import { MAX_RTT_MS, PROTOCOL_VERSION, ProtocolError, rfc3339 } from './shared.mjs';

/* ------------------------------------------------------------------ */
/* Version / capability gate (§6.1)                                    */
/* ------------------------------------------------------------------ */

function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver-range check used by the §6.1 capability gate.
 * Supports bare versions and comma/space separated `>= > <= < = ==` conjunctions.
 * Unparseable ranges are treated as NOT satisfied (never silently pass).
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (v === null) return false;
  if (typeof range !== 'string') return false;
  const parts = range.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const m = part.match(/^(>=|<=|==|=|>|<)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const target = parseVersion(m[2]);
    if (target === null) return false;
    const c = cmpVersion(v, target);
    if (op === '>=' && c < 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<' && c >= 0) return false;
    if ((op === '=' || op === '==') && c !== 0) return false;
  }
  return true;
}

function machineWritable(caps) {
  if (!caps || typeof caps !== 'object') return false;
  if (caps.write === false || caps.writable === false || caps.write_allowed === false) return false;
  if (caps.read_only === true || caps.readonly === true || caps.ro_mount === true) return false;
  return true;
}

/**
 * §6.1 capability gate, evaluated per machine BEFORE dispatch.
 * @returns {null | {status:'refused', refusal_reason:string, detail:object}}
 */
export function gateMachine(task, machine) {
  const caps = machine?.caps ?? {};
  const req = task.requirements ?? {};

  if (req.platform && Array.isArray(req.platform) && req.platform.length > 0) {
    const os = String(machine?.platform?.os ?? '').toLowerCase();
    if (!req.platform.map((p) => String(p).toLowerCase()).includes(os)) {
      return { status: 'refused', refusal_reason: 'PLATFORM_MISMATCH', detail: { os, want: req.platform } };
    }
  }

  const toolchain = req.toolchain ?? {};
  for (const [tool, range] of Object.entries(toolchain)) {
    const declared = caps[tool];
    if (declared === null || declared === undefined || declared === '') {
      return {
        status: 'refused',
        refusal_reason: `MISSING_${String(tool).toUpperCase()}`,
        detail: { tool, want: range, have: declared ?? null },
      };
    }
    if (typeof range === 'string' && !satisfiesRange(declared, range)) {
      return {
        status: 'refused',
        refusal_reason: `MISSING_${String(tool).toUpperCase()}`,
        detail: { tool, want: range, have: declared },
      };
    }
  }

  if (task.write === true && !machineWritable(caps)) {
    return { status: 'refused', refusal_reason: 'READ_ONLY_MACHINE', detail: { caps } };
  }

  return null;
}

/* ---------------- pairing (§2) ---------------- */

/**
 * Mint a pairing code.
 *
 * **v0.7.7: the code carries the relay's fleet.** This is the link that makes the scheme work,
 * and it is easy to leave out: `pair()` reads the fleet *from the code*, so a code with no
 * fleet pairs a device into no fleet -- and a device in no fleet reaches nothing on a scoped
 * relay. `--fleet X` would then have had no effect on anything, silently.
 *
 * Defaulting to `state.fleetId` rather than requiring the caller to pass it means there is no
 * path that mints a fleetless code on a scoped relay. An explicit `fleetId` overrides, which
 * is what a relay serving several fleets would need.
 */
export function createPairingCode(state, { ttlMs = state.pairingTtlMs, fleetId = state.fleetId } = {}) {
  let code;
  do { code = `PAIR-${state._randomChars(8)}`; } while (state.pairingCodes.has(code));
  const now = state.nowMs();
  state.pairingCodes.set(code, {
    code,
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    used: false,
    // Present as an explicit key even when null, so a code dump shows whether a fleet was
    // attached rather than leaving it to be inferred from an absent field.
    fleet_id: typeof fleetId === 'string' && fleetId !== '' ? fleetId : null,
  });
  return code;
}

/** Revoke every outstanding code and mint a new one. */
export function rotatePairingCode(state, opts) {
  for (const rec of state.pairingCodes.values()) rec.used = true;
  return state.createPairingCode(opts);
}

/**
 * Register an externally supplied code (`--pairing-code <c>`).
 *
 * v0.1.2 BUG-1: assigning the code to `relay.pairingCode` without registering it
 * advertised a code that `/v1/pair` then rejected with PAIRING_INVALID, so every
 * documented scripted-onboarding flow failed. "Which code do we use" and "is the
 * code registered" are two different questions; this answers the second.
 */
export function registerPairingCode(state, code, { ttlMs = state.pairingTtlMs } = {}) {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ProtocolError('BAD_REQUEST', 'pairing code must be a non-empty string', { pairing_code: code });
  }
  const value = code.trim();
  const now = state.nowMs();
  state.pairingCodes.set(value, { code: value, created_at_ms: now, expires_at_ms: now + ttlMs, used: false });
  return value;
}

/** §2.2 step 3: validate a one-time code. */
/**
 * The account fingerprint -> public key registry (v1.1.6).
 *
 * Keyed by the FINGERPRINT, not by machine: every machine on one account shares the derived keypair, and the point of
 * the registry is to answer "which key speaks for this account", once, for all of them.
 *
 * @returns {{registered: boolean, reason?: string}}
 */
export function registerAccountKey(state, fingerprint, publicKeyPem) {
  if (typeof fingerprint !== 'string' || fingerprint === '') return { registered: false, reason: 'BAD_FINGERPRINT' };
  if (typeof publicKeyPem !== 'string' || publicKeyPem === '') return { registered: false, reason: 'BAD_PUBLIC_KEY' };
  state.accountKeys ??= new Map();
  const existing = state.accountKeys.get(fingerprint);
  if (existing !== undefined) {
    return { registered: false, reason: existing === publicKeyPem ? 'ALREADY_REGISTERED' : 'KEY_MISMATCH' };
  }
  state.accountKeys.set(fingerprint, publicKeyPem);
  return { registered: true };
}

/** @returns {string|null} the key that speaks for this account, or null if no machine ever paired for it. */
export function accountKeyFor(state, fingerprint) {
  return state.accountKeys?.get(fingerprint) ?? null;
}

export function validatePairingCode(state, code) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new ProtocolError('PAIRING_INVALID', 'pairing_code is required');
  }
  const rec = state.pairingCodes.get(code);
  if (!rec) throw new ProtocolError('PAIRING_INVALID', 'unknown pairing code', { pairing_code: code });
  if (rec.used) throw new ProtocolError('PAIRING_INVALID', 'pairing code already used', { pairing_code: code });
  if (state.nowMs() >= rec.expires_at_ms) {
    throw new ProtocolError('PAIRING_EXPIRED', 'pairing code expired', { pairing_code: code, expired_at: rfc3339(rec.expires_at_ms) });
  }
  return rec;
}

/** §2.2: exchange a one-time code for a device_token. §1: idempotent. */
export function pair(state, request = {}) {
  /**
   * v0.8.1: a pairing code **or** an account-derived fleet key.
   *
   * The code path is unchanged. The key path is what lets a second machine on one account join
   * with no human step and no relay configuration — the gap that left a new PC invisible beside
   * its own fleet.
   *
   * ## Why a key may stand in for a code
   *
   * They authorise different things. A **code** is the operator saying *"let this machine in"*,
   * and it is the only way to place a device in a fleet the device could not compute for itself.
   * A **key** is the account saying *"this machine is mine"*, and it can only ever place the
   * device in the fleet derived from that key — so it cannot be used to reach a fleet its holder
   * is not already entitled to.
   *
   * ## Why a malformed key refuses rather than falling back
   *
   * A request with a `fleet_key` is a request that *meant* to join by account. Quietly demanding a
   * code instead would surface at the client as an unexplained `PAIRING_INVALID`, which is the
   * silent-wrong-answer shape this codebase keeps producing; the reason is named instead.
   */
  const hasKey = typeof request.fleet_key === 'string' && request.fleet_key !== '';
  let rec = null;
  if (hasKey) {
    const join = planJoin({ fleetKeyEncoded: request.fleet_key });
    if (!join.ok) {
      throw new ProtocolError('PAIRING_INVALID', join.text, { reason: join.reason });
    }
    // A synthetic code record so the fleet binding below reads from one place. `fleet_id` is the
    // DERIVED value, never anything the request claimed.
    rec = { code: null, fleet_id: join.fleetId, from_fleet_key: true };
  } else {
    rec = state.validatePairingCode(request.pairing_code);
  }

  const machineId = request.machine_id;
  if (typeof machineId !== 'string' || machineId.length === 0) {
    throw new ProtocolError('BAD_REQUEST', 'machine_id is required');
  }
  const now = state.nowMs();
  const token = state.newToken();
  const existing = state.devices.get(machineId);
  if (existing?.device_token) state.tokens.delete(existing.device_token);

  const device = {
    machine_id: machineId,
    machine_name: typeof request.machine_name === 'string' && request.machine_name
      ? request.machine_name : machineId.slice(0, 12),
    platform: request.platform ?? {},
    caps: request.caps ?? {},
    user_id: request.user_id ?? null,
      // v0.7.7: which fleet this device belongs to, and where that fact came from.
      //
      // **The fleet comes from the pairing code, not from the request.** A device that could
      // name its own fleet would join any fleet, and every signature would faithfully attest
      // to it. `deviceFleetFields` is the single place that binding is made, and it records
      // its provenance so a fleet that arrived from a request is visible as such in
      // `devices.json` rather than looking identical to one that came from a code.
      //
      // v0.8.1 adds the third source: an account-derived `fleet_key`. That is what lets a second
      // machine on one account join with **no human step and no relay configuration** -- the gap
      // that left a new PC invisible beside its own fleet. The relay does not trust a claimed
      // fleet id; it *derives* one from the key, so a device can only land in the fleet whose key
      // it holds and anything else forms a separate, empty fleet.
      ...deviceFleetFields({
        codeRecord: rec,
        fleetKeyEncoded: typeof request.fleet_key === 'string' ? request.fleet_key : null,
        requestedFleet: null,
      }),
      /**
       * v0.7.10: the device's Ed25519 public key, if it offered one.
       *
       * A public key is not a secret, so storing it costs nothing and it is the whole basis of
       * per-device verification: the relay can then check a signature only *this* machine could
       * have made, rather than a shared secret every machine holds.
       *
       * Not validated here, deliberately. A malformed key fails at verification with a named
       * reason, while rejecting a pairing over it would lock out every existing device the
       * moment this field was added -- and devices that send no key keep working, with
       * `public_key: null` meaning "signs with the shared secret or not at all".
       */
      public_key: typeof request.public_key === 'string' && request.public_key !== '' ? request.public_key : null,
    device_token: token,
    paired_at_ms: now,
    re_paired: Boolean(existing),
    last_seen_at_ms: now,
    online: true,
    streams: existing?.streams ?? 0,
    // v0.3.0 RTT: starts unknown. `null` is "never measured"; 0 would mean "instant".
    rtt_ms: null,
    rtt_at_ms: null,
    last_heartbeat_at_ms: null,
    stream_connects: existing?.stream_connects ?? 0,
  };
  state.devices.set(machineId, device);
  state.tokens.set(token, machineId);

  /**
   * v1.1.6: register the account's signing key while we have proof of the account.
   *
   * A machine that failed the old joining path must later prove the account to the relay. It can only do that against
   * a key the relay already trusts, and the only moment the relay has real proof ("this machine holds the account
   * material") is a successful pairing. So this is the trust anchor, and it is written HERE rather than at
   * registration time to keep the two paths honest: no pairing, no key.
   *
   * Idempotent on purpose: the first machine to pair for a fingerprint fixes the key. A second machine claiming the
   * same fingerprint with a DIFFERENT key is not silently accepted -- the registration is refused and reported, and
   * changing a key needs the fleet vote the removal flow already provides.
   */
  const accountFingerprint = typeof request.account_fingerprint === 'string' ? request.account_fingerprint : '';
  const accountPublicKey = typeof request.account_public_key === 'string' ? request.account_public_key : '';
  const accountKey = accountFingerprint !== '' && accountPublicKey !== ''
    ? state.registerAccountKey(accountFingerprint, accountPublicKey)
    : null;
  // Recorded on the device, not just discarded: a second machine claiming the same account with a different key is
  // refused, and the refusal must be visible in devices.json rather than looking like a successful registration.
  device.account_key = accountKey;
  rec.used = true;

  // A group has more than one machine, and a single-use code would leave the
  // operator unable to pair the second one without restarting the relay. So
  // consuming a code immediately mints the next one and announces it: the
  // operator pairs machine A, sees a fresh code, and pairs machine B with it.
  // `pairingCodeReusable` keeps one code alive for the whole window instead,
  // for scripted onboarding where nobody is watching stdout.
  let nextCode = null;
  const reusable = state.pairingCodeReusable === true;
  if (reusable) {
    rec.used = false;
  } else {
    nextCode = state.rotatePairingCode();
  }

  state.emit('peer.hello', {
    machine_id: machineId,
    machine_name: device.machine_name,
    platform: device.platform,
  });

  if (nextCode) {
    state.emit('notice', {
      level: 'info',
      code: 'PAIRING_CODE_ROTATED',
      message: 'pairing code consumed; a new one is available',
      pairing_code: nextCode,
    });
  }

  // §7: a device change is snapshotted immediately.
  state._saveDevices();
  state._ledger({
    type: 'device.paired',
    machine_id: machineId,
    machine_name: device.machine_name,
    re_paired: device.re_paired,
  });

  return {
    device_token: token,
    protocol_version: PROTOCOL_VERSION,
    rabbit_time: rfc3339(now),
    ...(nextCode ? { next_pairing_code: nextCode } : {}),
  };
}

/** @returns {object|null} device for a bearer token. */
export function authenticate(state, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const machineId = state.tokens.get(token);
  if (!machineId) return null;
  return state.devices.get(machineId) ?? null;
}

export function touchDevice(state, machineId, { online = true } = {}) {
  const device = state.devices.get(machineId);
  if (!device) return null;
  device.last_seen_at_ms = state.nowMs();
  if (online) device.online = true;
  return device;
}

export function setOnline(state, machineId, online, reason = null) {
  const device = state.devices.get(machineId);
  if (!device) return null;
  if (device.online === online) return device;
  device.online = online;
  if (online) {
    state.touchDevice(machineId);
    state.emit('peer.hello', {
      machine_id: machineId,
      machine_name: device.machine_name,
      platform: device.platform,
    });
  } else {
    state.emit('peer.bye', { machine_id: machineId, reason: reason ?? 'stream_closed' });
  }
  return device;
}

/* ---------------- RTT (v0.3.0 §R) ---------------- */

/**
 * Validate an inbound `rtt_ms`.
 *
 * The contract is deliberately liberal: a MISSING or INVALID value must never
 * reject the heartbeat and must never clobber a previously known good value.
 * RTT is a diagnostic; it must not be able to break lease renewal.
 *
 * Sanity ceiling: anything above `MAX_RTT_MS` (24h) is treated as invalid. A
 * single garbage value would otherwise poison the fleet aggregate.
 */
export function normalizeRtt(value) {
  if (value === undefined) return { provided: false, valid: false };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { provided: true, valid: false };
  }
  if (value > MAX_RTT_MS) return { provided: true, valid: false };
  return { provided: true, valid: true, value };
}

/**
 * RTT is a VOLATILE diagnostic: it is intentionally NOT written to
 * `devices.json` and NOT replayed from the ledger, so a restarted relay reports
 * `rtt_ms: null` until a machine heartbeats again. A persisted value would be
 * indistinguishable from a fresh one and would let the relay claim knowledge it
 * lost when the process died.
 */
export function rttStaleAfterMs(state) { return state.rttStaleMs; }

/**
 * v0.3.0: absorb the optional `rtt_ms` carried by a heartbeat.
 *
 * Deliberately liberal, because RTT is a diagnostic and must never be able to
 * break lease renewal:
 *   - the field is optional; a v0.2.3 agent never sends it
 *   - a MISSING or INVALID value is IGNORED, keeping the previous value, and the
 *     heartbeat still succeeds
 *   - unknown extra fields are ignored entirely (forward compatibility)
 *
 * `last_heartbeat_at` advances on EVERY accepted heartbeat, with or without a
 * usable RTT: it answers "is the machine alive", while `rtt_at` answers "when
 * was this number measured". Keeping them separate is what lets a reader tell a
 * genuinely slow machine from one that is simply gone.
 */
export function recordHeartbeatMetrics(state, machineId, input = {}, nowMs = state.nowMs()) {
  const device = state.devices.get(machineId);
  if (!device) return null;
  device.last_heartbeat_at_ms = nowMs;
  const rtt = normalizeRtt(input.rtt_ms);
  if (rtt.valid) {
    device.rtt_ms = rtt.value;
    device.rtt_at_ms = nowMs;
  }
  return device;
}

/** True when there is no value, or the value is older than the staleness window. */
export function isRttStale(state, device, nowMs = state.nowMs()) {
  if (!device || device.rtt_ms === null || device.rtt_ms === undefined) return true;
  if (device.rtt_at_ms === null || device.rtt_at_ms === undefined) return true;
  return nowMs - device.rtt_at_ms > state.rttStaleMs;
}

/** How old the RTT measurement is, in ms; null when there is none. */
export function rttAgeMs(state, device, nowMs = state.nowMs()) {
  if (!device || device.rtt_at_ms === null || device.rtt_at_ms === undefined) return null;
  return Math.max(0, nowMs - device.rtt_at_ms);
}

/** Record that a machine attached a stream (a reconnect is any attach after the first). */
export function noteStreamConnect(state, machineId) {
  const device = state.devices.get(machineId);
  if (!device) return null;
  device.stream_connects = (device.stream_connects ?? 0) + 1;
  return device.stream_connects;
}

/**
 * v0.3.0 aggregate for `/healthz`.
 *
 * Only FRESH measurements count. A machine that has been gone for a day must not
 * drag min/max/avg around, and with no fresh data every numeric field is null --
 * never 0, which would read as "instantaneous".
 */
export function rttSummary(state, nowMs = state.nowMs()) {
  const fresh = [];
  let stale = 0;
  let unknown = 0;
  for (const device of state.devices.values()) {
    if (device.rtt_ms === null || device.rtt_ms === undefined) { unknown += 1; continue; }
    if (state.isRttStale(device, nowMs)) { stale += 1; continue; }
    fresh.push(device.rtt_ms);
  }
  if (fresh.length === 0) {
    return {
      machines_reporting: 0,
      min_ms: null,
      max_ms: null,
      avg_ms: null,
      machines_stale: stale,
      machines_unknown: unknown,
    };
  }
  const sum = fresh.reduce((a, b) => a + b, 0);
  return {
    machines_reporting: fresh.length,
    min_ms: Math.min(...fresh),
    max_ms: Math.max(...fresh),
    avg_ms: Math.round((sum / fresh.length) * 10) / 10,
    machines_stale: stale,
    machines_unknown: unknown,
  };
}

/**
 * v0.9.1: how long since this device last made any contact, or null when it never has.
 *
 * `last_seen_at_ms` is the right field rather than `last_heartbeat_at_ms`: `touchDevice` advances it
 * on every contact the relay accepts — a heartbeat, a task poll, a lease renewal — so it measures
 * "is anything there", while `last_heartbeat_at_ms` measures "has it ever heartbeated", which is
 * null for an agent old enough not to send them.
 *
 * Falls back to `paired_at_ms` so that a device which paired but has not spoken since is judged
 * from the moment it arrived rather than from `null`, which would have read as "silent forever" and
 * marked it offline the instant it appeared.
 *
 * @param {object} device
 * @param {number} nowMs
 * @returns {number|null}
 */
export function silenceAgeMs(state, device, nowMs = state.nowMs()) {
  const seen = device.last_seen_at_ms ?? device.last_heartbeat_at_ms ?? device.paired_at_ms ?? null;
  if (seen === null || seen === undefined) return null;
  return Math.max(0, nowMs - seen);
}

/**
 * v0.9.1 §4.3 companion: declare a device silent once nothing has contacted the relay for
 * {@link DEFAULT_SILENCE_MS}.
 *
 * ## Why this exists next to `sweepExpired`
 *
 * `sweepExpired` writes off lease *holds*; this writes off *presence*. Both are expiry, and they
 * were conflated: a machine that stopped existing was only noticed when its SSE stream actually
 * detached, so a half-open stream — a killed process, a pulled cable, a laptop lid — left it
 * `online: true` and selectable for as long as the socket stayed open, which can be hours or
 * indefinitely.
 *
 * Going through {@link setOnline} is the point rather than an implementation detail: it flips the
 * flag **and emits `peer.bye`**, which is what tells every other machine in the fleet. Fixing only
 * the flag would correct `/v1/devices` on the relay while leaving every agent's own view — and
 * therefore every machine picker — still showing a departed machine.
 *
 * @param {number} [nowMs]
 * @returns {Array<{machine_id: string, machine_name: string, silent_ms: number}>} what was swept
 */
export function sweepSilentDevices(state, nowMs = state.nowMs()) {
  const went = [];
  for (const device of state.devices.values()) {
    if (device.online !== true) continue;
    const age = state.silenceAgeMs(device, nowMs);
    if (age === null || age < state.silenceMs) continue;
    state.emit('notice', {
      level: 'info',
      code: 'DEVICE_SILENT',
      message: `machine ${device.machine_name} (${device.machine_id}) stopped making contact; marking it offline`,
      machine_id: device.machine_id,
      silent_ms: age,
    });
    state.setOnline(device.machine_id, false, 'silent');
    went.push({ machine_id: device.machine_id, machine_name: device.machine_name, silent_ms: age });
  }
  return went;
}

/**
 * v0.3.0 single-machine status view.
 *
 * `last_heartbeat_at` and `rtt_at` answer different questions, and the gap
 * between them is the whole point: a machine can be heartbeating (alive) while
 * its RTT number is old (a v0.2.3 agent that never sends `rtt_ms`), and a
 * machine can be gone while a plausible-looking RTT is still on file.
 *
 * v0.9.1: `online` is additionally cross-checked against silence, so a direct call to this method
 * (a test, or a caller that never runs the sweep) cannot report a departed machine as present.
 * The sweep is still what fixes the flag and broadcasts; this only refuses to repeat a stale `true`.
 */
/**
 * Whether this device is usable right now: its flag is set AND it is not silent.
 *
 * \`device.online === true\` alone is not the answer -- the flag stays true until the sweep runs, so a machine whose
 * agent stopped heartbeating was still a dispatch target. The same expression appeared in \`deviceStatus\`,
 * \`publicDevice\` and (v1.1.2) the default target list; one definition keeps the list and the dispatch from
 * disagreeing about which machines exist.
 *
 * \`silentMs === null\` means no contact has ever been observed, and that is NOT silent.
 */
export function isOnlineDevice(state, device, nowMs = state.nowMs()) {
  if (!device || device.online !== true) return false;
  const silentMs = state.silenceAgeMs(device, nowMs);
  return !(silentMs !== null && silentMs >= state.silenceMs);
}

export function deviceStatus(state, machineId, nowMs = state.nowMs()) {
  const device = state.devices.get(machineId);
  if (!device) return null;
  const rttAt = device.rtt_at_ms ?? null;
  const lastHeartbeat = device.last_heartbeat_at_ms ?? null;
  const silentMs = state.silenceAgeMs(device, nowMs);
  const silent = device.online === true && silentMs !== null && silentMs >= state.silenceMs;
  return {
    machine_id: device.machine_id,
    machine_name: device.machine_name,
    relay_id: state.relayId,
    connected: (device.streams ?? 0) > 0,
    streams: device.streams ?? 0,
    online: state.isOnlineDevice(device),
    /**
     * Why this machine is not usable, when it is not. `null` for a healthy one.
     *
     * Added because "offline" without a reason is exactly the shape that made this defect hard to
     * see: a machine that had been powered off for hours was listed `online`, and a machine that is
     * correctly offline still gives no clue whether it is gone or merely quiet.
     *
     * `silent` first, for the same reason as in `publicDevice`: the stored flag is `true` in the
     * half-open case, so the silence is the finding.
     */
    offline_reason: silent ? 'silent' : (device.online !== true ? 'stream_closed' : null),
    silent_ms: silentMs,
    rtt_ms: device.rtt_ms ?? null,
    rtt_at: rttAt === null ? null : rfc3339(rttAt),
    rtt_age_ms: state.rttAgeMs(device, nowMs),
    rtt_stale: state.isRttStale(device, nowMs),
    last_heartbeat_at: lastHeartbeat === null ? null : rfc3339(lastHeartbeat),
    last_seen_at: device.last_seen_at_ms === null || device.last_seen_at_ms === undefined
      ? null : rfc3339(device.last_seen_at_ms),
    reconnect_attempts: Math.max(0, (device.stream_connects ?? 0) - 1),
    stream_connects: device.stream_connects ?? 0,
    paired_at: device.paired_at_ms === null || device.paired_at_ms === undefined
      ? null : rfc3339(device.paired_at_ms),
    platform: device.platform,
    caps: device.caps,
    user_id: device.user_id ?? null,
    now: rfc3339(nowMs),
  };
}

/** Public device view — never leaks device_token. */
export function publicDevice(state, device) {
  // Computed once, so the three fields below cannot disagree with each other.
  const silentMs = state.silenceAgeMs(device);
  const silent = silentMs !== null && silentMs >= state.silenceMs;
  return {
    machine_id: device.machine_id,
    machine_name: device.machine_name,
    platform: device.platform,
    caps: device.caps,
    user_id: device.user_id,
      /**
       * v0.7.7: the fleet this device belongs to, and where the fact came from.
       *
       * **Carried in the public shape on purpose, and it has to be**, because `devices.json`
       * is written from this shape -- a fleet that lived only on the in-memory record would
       * vanish on the next restart, which is precisely when an operator is looking at it. A
       * first version omitted these and the live test caught the fleet disappearing from
       * `listDevices()`.
       *
       * Safe to expose: `fleet_id` is a truncated hash of the account id, not the account id,
       * and devices on one relay can already enumerate each other. Narrowing `/v1/devices` to
       * a device's own fleet is a further step, recorded as such rather than implied.
       */
      fleet_id: device.fleet_id ?? null,
      fleet_source: device.fleet_source ?? null,
      // v0.7.10: a boolean rather than the key itself. The key is not a secret, but a device
      // list is read by every device, and there is no reason to hand every machine every other
      // machine's key when the verification happens relay-side.
      public_key_present: typeof device.public_key === 'string' && device.public_key !== '',
    /**
     * v0.9.1: `online` is derived, not just read.
     *
     * It used to be the raw stored flag, which is only ever written by the SSE stream attaching or
     * detaching. A half-open stream therefore reported `online: true` for a machine that was gone,
     * and `/v1/devices` handed that to every machine picker in the fleet. The sweep is what flips
     * the stored flag and broadcasts `peer.bye`; this expression makes the read agree with it even
     * between sweeps, so no caller can observe the stale value at all.
     */
    online: state.isOnlineDevice(device),
    streams: device.streams,
    /**
     * v0.9.1: why this machine is not usable, when it is not.
     *
     * `silent` is tested FIRST, and that order is the whole subtlety: a half-open stream leaves the
     * stored `online` flag `true`, so testing `device.online !== true` first reported
     * `stream_closed` for a machine whose stream was precisely the thing still attached. The
     * reported defect in one line -- the flag says connected, the truth says gone, and the reason
     * has to name the truth.
     */
    offline_reason: silent ? 'silent' : (device.online !== true ? 'stream_closed' : null),
    silent_ms: silentMs,
    paired_at: rfc3339(device.paired_at_ms),
    last_seen_at: rfc3339(device.last_seen_at_ms),
    // v0.3.0: `null` means "never measured", which is NOT the same as 0ms.
    rtt_ms: device.rtt_ms ?? null,
    rtt_at: device.rtt_at_ms === null || device.rtt_at_ms === undefined ? null : rfc3339(device.rtt_at_ms),
    rtt_age_ms: state.rttAgeMs(device),
    rtt_stale: state.isRttStale(device),
    last_heartbeat_at: device.last_heartbeat_at_ms === null || device.last_heartbeat_at_ms === undefined
      ? null : rfc3339(device.last_heartbeat_at_ms),
    reconnect_attempts: Math.max(0, (device.stream_connects ?? 0) - 1),
  };
}

export function listDevices(state) { return [...state.devices.values()].map((d) => state.publicDevice(d)); }

/** v1.2.6: the role this machine holds, for the permission matrix. Unknown means worker, never owner. */
export function roleOf(state, machineId) {
  return typeof machineId === 'string' ? (state.roles.get(machineId) ?? null) : null;
}

/** v1.2.5: the fleet's members, with the role each holds and when it joined. */
export function listMembers(state) {
  return buildMembers({ devices: state.devices, roles: state.roles });
}

/** v1.2.5: an operator decision about one machine. Refused by name, never silently ignored. */
export function setMemberRole(state, machineId, role) {
  const result = applyMemberRole({ machineId, role, devices: state.devices, roles: state.roles });
  if (result.ok === true) {
    state.emit('notice', { level: 'info', code: 'MEMBER_ROLE_SET', message: `${machineId} is now ${role}`, machine_id: machineId });
    state._ledger({ type: 'member.role', machine_id: machineId, role });
  }
  return result;
}

/**
 * v1.2.5: record that a machine has read a session up to a marker.
 *
 * Only forward: a stale marker arriving after a newer one must not move the watermark backwards, or the unread count would
 * grow for messages the machine has already seen.
 */
export function markRead(state, sessionId, machineId, marker = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'BAD_SESSION' };
  if (typeof machineId !== 'string' || machineId === '') return { ok: false, code: 'BAD_MACHINE' };
  const atMs = Number.isFinite(marker.at_ms) ? Math.floor(marker.at_ms) : state.nowMs();
  const messageId = typeof marker.message_id === 'string' && marker.message_id !== '' ? marker.message_id : null;
  if (!state.readMarks.has(sessionId)) state.readMarks.set(sessionId, new Map());
  const perSession = state.readMarks.get(sessionId);
  const previous = perSession.get(machineId) ?? null;
  if (previous !== null && previous.at_ms > atMs) return { ok: true, mark: { ...previous }, advanced: false };
  const mark = { at_ms: atMs, message_id: messageId };
  perSession.set(machineId, mark);
  return { ok: true, mark: { ...mark }, advanced: true };
}

/** v1.2.5: this machine's watermark for one session (null when it never read it). */
export function readMark(state, sessionId, machineId) {
  const perSession = state.readMarks.get(sessionId) ?? null;
  if (perSession === null) return null;
  const mark = perSession.get(machineId) ?? null;
  return mark === null ? null : { ...mark };
}
