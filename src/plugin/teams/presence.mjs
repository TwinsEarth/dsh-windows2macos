/**
 * Team presence: who is in the room, and how fresh that claim is.
 *
 * The relay already records device liveness (`last_seen`, `silent_ms`); what a team surface needs
 * on top is the human behind the machine and a single `online`/`stale` judgement that two callers
 * cannot disagree about. This module is that judgement. It is pure, so a test can advance the clock
 * instead of waiting ninety seconds.
 *
 * Presence is a control-plane fact and is carried by heartbeat over TCP relay, never inferred from
 * a P2P socket: a machine whose UDP path is blocked is still present and still able to receive a
 * relay command.
 */

/** A machine that has not been seen for this long is stale, not offline. */
export const TEAM_PRESENCE_DEFAULT_STALE_MS = 90_000;

/** Lower bound, because a zero threshold would mark every roster stale. */
const MIN_STALE_MS = 1_000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerce a timestamp to milliseconds. ISO strings, epoch ms, and epoch seconds are accepted; a
 * malformed value becomes null rather than `NaN`, because `NaN` comparisons all return false and
 * would silently present an unknown machine as fresh.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toTeamTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return numeric < 1e11 ? Math.round(numeric * 1_000) : Math.round(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Keep only the fields a roster should show. `undefined` is dropped so JSON output does not carry
 * empty keys a caller has to special-case.
 *
 * @param {unknown} value
 * @returns {{id: string|null, name: string|null}|string|null}
 */
function normalizeUser(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (!isRecord(value)) return null;
  const id =
    typeof value.id === 'string' && value.id.trim() !== ''
      ? value.id.trim()
      : typeof value.user_id === 'string' && value.user_id.trim() !== ''
        ? value.user_id.trim()
        : null;
  const name =
    typeof value.name === 'string' && value.name.trim() !== ''
      ? value.name.trim()
      : typeof value.display_name === 'string' && value.display_name.trim() !== ''
        ? value.display_name.trim()
        : null;
  if (id === null && name === null) return null;
  return { id, name };
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>|null}
 */
function normalizeCaps(value) {
  return isRecord(value) ? value : null;
}

/**
 * In-memory roster with a clock injected.
 */
export class TeamPresence {
  /**
   * @param {{now?: () => number, staleAfterMs?: number}} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    const raw = Number(options.staleAfterMs);
    this.staleAfterMs =
      Number.isFinite(raw) && raw >= MIN_STALE_MS
        ? Math.min(24 * 60 * 60 * 1_000, Math.round(raw))
        : TEAM_PRESENCE_DEFAULT_STALE_MS;
    /** @type {Map<string, object>} */
    this.entries = new Map();
  }

  /**
   * Record a heartbeat. The user is optional because a machine may heartbeat before anyone signs
   * in; an existing user is retained rather than erased by a later blank beat.
   *
   * @param {{machine_id?: string, user?: unknown, role?: string, caps?: unknown,
   *   last_seen_ms?: number}} input
   * @returns {object} the stored entry
   */
  heartbeat(input = {}) {
    const machineId = typeof input?.machine_id === 'string' ? input.machine_id.trim() : '';
    if (machineId === '') {
      const error = new Error('team presence heartbeat requires a machine_id');
      error.code = 'TEAM_PRESENCE_MACHINE_ID_REQUIRED';
      throw error;
    }
    const at = toTeamTimestampMs(input?.last_seen_ms) ?? this.now();
    const previous = this.entries.get(machineId);
    const user = normalizeUser(input?.user) ?? previous?.user ?? null;
    const caps = normalizeCaps(input?.caps) ?? previous?.caps ?? null;
    const entry = {
      machine_id: machineId,
      user,
      role:
        typeof input?.role === 'string' && input.role.trim() !== ''
          ? input.role.trim()
          : (previous?.role ?? 'member'),
      caps,
      last_seen_ms: at,
      first_seen_ms: previous?.first_seen_ms ?? at,
      heartbeats: (previous?.heartbeats ?? 0) + 1,
      source: 'heartbeat',
    };
    this.entries.set(machineId, entry);
    return { ...entry };
  }

  /**
   * @param {string} machineId
   * @returns {boolean}
   */
  forget(machineId) {
    return this.entries.delete(String(machineId));
  }

  /**
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }

  /**
   * @param {{now?: number, staleAfterMs?: number}} [options]
   * @returns {{count: number, online: number, stale: number, stale_after_ms: number,
   *   evaluated_at: string, members: object[]}}
   */
  snapshot(options = {}) {
    const at = toTeamTimestampMs(options.now) ?? this.now();
    const raw = Number(options.staleAfterMs);
    const staleAfterMs = Number.isFinite(raw) && raw >= MIN_STALE_MS ? Math.round(raw) : this.staleAfterMs;
    const members = [...this.entries.values()]
      .map((entry) => describeEntry(entry, at, staleAfterMs))
      .sort((a, b) => a.machine_id.localeCompare(b.machine_id));
    return {
      count: members.length,
      online: members.filter((member) => member.online).length,
      stale: members.filter((member) => member.state === 'stale').length,
      stale_after_ms: staleAfterMs,
      evaluated_at: new Date(at).toISOString(),
      members,
    };
  }
}

/**
 * @param {object} entry
 * @param {number} at
 * @param {number} staleAfterMs
 * @returns {object}
 */
function describeEntry(entry, at, staleAfterMs) {
  const ageMs = entry.last_seen_ms === null ? null : Math.max(0, at - entry.last_seen_ms);
  const online = ageMs !== null && ageMs <= staleAfterMs;
  return {
    machine_id: entry.machine_id,
    user: entry.user ?? null,
    role: entry.role ?? 'member',
    caps: entry.caps ?? null,
    state: ageMs === null ? 'offline' : online ? 'online' : 'stale',
    online,
    last_seen_ms: entry.last_seen_ms ?? null,
    last_seen: entry.last_seen_ms === null ? null : new Date(entry.last_seen_ms).toISOString(),
    age_ms: ageMs,
    heartbeats: entry.heartbeats ?? 0,
    source: entry.source ?? 'heartbeat',
  };
}

/**
 * Map the relay's device list to the same roster shape. This is what `w2m_team_status` shows when
 * it has a token but no local heartbeat buffer: the relay's own liveness record, not a second
 * opinion.
 *
 * @param {unknown[]} devices
 * @param {{now?: number, staleAfterMs?: number}} [options]
 * @returns {object}
 */
export function presenceFromDevices(devices, options = {}) {
  const at = toTeamTimestampMs(options.now) ?? Date.now();
  const raw = Number(options.staleAfterMs);
  const staleAfterMs =
    Number.isFinite(raw) && raw >= MIN_STALE_MS
      ? Math.min(24 * 60 * 60 * 1_000, Math.round(raw))
      : TEAM_PRESENCE_DEFAULT_STALE_MS;
  const list = Array.isArray(devices) ? devices : [];
  const members = [];
  for (const device of list) {
    if (!isRecord(device)) continue;
    const machineId = typeof device.machine_id === 'string' ? device.machine_id.trim() : '';
    if (machineId === '') continue;
    const lastSeen = toTeamTimestampMs(
      device.last_seen_ms ?? device.last_seen_at ?? device.last_seen ?? device.updated_at,
    );
    const ageMs = lastSeen === null ? null : Math.max(0, at - lastSeen);
    const declaredOnline = device.online === true || device.state === 'online' || device.connected === true;
    const online = lastSeen === null ? declaredOnline : ageMs <= staleAfterMs && device.online !== false;
    members.push({
      machine_id: machineId,
      name:
        typeof device.machine_name === 'string'
          ? device.machine_name
          : typeof device.name === 'string'
            ? device.name
            : null,
      user: normalizeUser(device.user ?? device.owner ?? device.user_info ?? device.operator ?? null),
      role: typeof device.role === 'string' && device.role.trim() !== '' ? device.role.trim() : 'member',
      caps: normalizeCaps(device.caps),
      state: lastSeen === null ? (declaredOnline ? 'online' : 'offline') : online ? 'online' : 'stale',
      online,
      last_seen_ms: lastSeen,
      last_seen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      age_ms: ageMs,
      heartbeats: null,
      source: 'relay',
    });
  }
  members.sort((a, b) => a.machine_id.localeCompare(b.machine_id));
  return {
    count: members.length,
    online: members.filter((member) => member.online).length,
    stale: members.filter((member) => member.state === 'stale').length,
    stale_after_ms: staleAfterMs,
    evaluated_at: new Date(at).toISOString(),
    members,
  };
}
