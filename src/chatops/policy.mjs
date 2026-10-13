/**
 * Who is allowed to command this machine (v0.7.0).
 *
 * ## The defect this file exists to make impossible
 *
 * `dsh-chatops` 0.1.0 adopts an owner from the first private message it receives on
 * Feishu, DingTalk or WeCom, before any authorisation runs:
 *
 *     if (windowKey.startsWith('fsu:') || … 'dsu:' || … 'wsu:') && !auth.hasOwners()) {
 *       auth.addOwner(msg.talkerId)        // no pairing code, no allow-list, no confirmation
 *     }
 *
 * and it ships with `channels: [ilink, feishu, dingtalk, wecom]` enabled by default.
 * `addOwner` persists to `bindings.json`, so the claim survives restarts and is
 * revoked only by deleting the file. Whoever messages the bot first — a colleague in
 * the tenant, a group guest — gets permanent remote control: every workspace and
 * session, arbitrary prompts, `/log` transcripts, `/send` for file exfiltration,
 * `/approve`, and `/policy 2` to `danger-full-access`.
 *
 * The rest of that plugin's authorisation is genuinely fail-closed — an unknown
 * sender matches no list and is dropped and audited. The adoption step is the one
 * hole, and it is unattended first-come-first-served by construction.
 *
 * ## The rule here
 *
 * **Nothing is trusted because it arrived.** An identity becomes trusted in exactly
 * two ways, both of which need something the sender must already possess:
 *
 *   1. it was seeded by the operator, in configuration, before the plugin started; or
 *   2. it redeemed a single-use pairing code that the operator read off their own
 *      screen — the same shape the relay half of this project already uses.
 *
 * A pairing code is single-use, expires, and is rate-limited per identity, so a
 * stranger cannot brute-force admission and cannot hold a slot. There is no path
 * that trusts a sender because no one else had spoken yet.
 *
 * ## Identity is (channel, id), never a bare id
 *
 * The 0.1.0 owner set was one flat `Set<string>` shared by five platforms, matched
 * after the channel prefix had been stripped — so a raw id colliding across two
 * platforms was silently cross-trusted. Hence a raw list rather than a per-channel
 * map of allowed rooms, and the reason there is no `allowRooms: string[]` input.
 *
 * ## Rooms are not people
 *
 * 0.1.0's `isRoomTalkerAllowed` returned `true` for **every** member of an allowed
 * room whenever `allowContacts` was empty, and for every future member forever. A
 * room grant here is always an intersection: the room must be allowed *and* the
 * speaker must be an individually trusted identity. "Anyone in this group" is an
 * authorisation nobody should be able to acquire by being added to a group.
 */

/** Why an inbound message was dropped. Reported, never thrown: a drop is normal. */
export const DENIAL = Object.freeze({
  /** The channel is not one the operator enabled. */
  CHANNEL_UNKNOWN: 'channel_unknown',
  /** No owner has been established yet, so nothing is trusted. */
  NOT_ADOPTED: 'not_adopted',
  /** The sender is not individually trusted. */
  SENDER_UNTRUSTED: 'sender_untrusted',
  /** The message is from a room that is not allowed. */
  ROOM_NOT_ALLOWED: 'room_not_allowed',
  /** A room message that did not address the bot. */
  NOT_ADDRESSED: 'not_addressed',
  /** The request was structurally unusable. */
  MALFORMED: 'malformed',
});

/**
 * Channels this feature knows about, and the window-key prefix each uses.
 *
 * This is the **single** registry. In 0.1.0 the same information lived in four
 * places that had to agree — `manager.ts:20`, two regexes in `auth.ts:61,68`, five
 * registration calls in `index.ts`, and the settings client — and a channel missing
 * from the authorisation regexes had every message from it silently dropped. One
 * table cannot disagree with itself.
 */
export const CHANNELS = Object.freeze({
  ilink: Object.freeze({ prefixes: Object.freeze(['user', 'contact']), supportsRooms: false, selfKey: 'filehelper' }),
  feishu: Object.freeze({ prefixes: Object.freeze(['fsu']), supportsRooms: true, roomPrefixes: Object.freeze(['fsc']) }),
  dingtalk: Object.freeze({ prefixes: Object.freeze(['dsu']), supportsRooms: true, roomPrefixes: Object.freeze(['dsc']) }),
  wecom: Object.freeze({ prefixes: Object.freeze(['wsu']), supportsRooms: true, roomPrefixes: Object.freeze(['wsc']) }),
  wechaty: Object.freeze({ prefixes: Object.freeze(['wx', 'room', 'self']), supportsRooms: true, roomPrefixes: Object.freeze(['room']) }),
  // The in-memory channel is a first-class member, not a test-only special case. Registering
  // it here is what lets a dry run and the integration suite exercise the *real* admission
  // and routing path rather than a bypass, and it is the worked example for what adding a
  // sixth channel now costs: one entry, in one table.
  memory: Object.freeze({ prefixes: Object.freeze(['mem']), supportsRooms: false, selfKey: 'mem' }),
});

/**
 * Prefix -> what it means, built once from {@link CHANNELS}.
 *
 * Derived rather than written a second time: two tables that must agree is the
 * defect this registry replaced.
 */
const PREFIX_INDEX = (() => {
  const index = new Map();
  for (const [channel, spec] of Object.entries(CHANNELS)) {
    for (const prefix of spec.prefixes) {
      index.set(prefix, { channel, kind: prefix === spec.selfKey ? 'self' : 'contact' });
    }
    for (const prefix of spec.roomPrefixes ?? []) {
      index.set(prefix, { channel, kind: 'room' });
    }
  }
  // A bare `filehelper` key rather than `filehelper:filehelper`, which is how the
  // personal-WeChat channel names the one window only its owner can see.
  index.set('filehelper', { channel: 'ilink', kind: 'self' });
  return index;
})();

/**
 * Classify a window key.
 *
 * Three outcomes rather than two, because "this key is malformed" and "this key is
 * well-formed but names a channel nobody enabled" are different reports and only one
 * of them is the operator's config being wrong. Returning `null` for both — the first
 * cut of this function — made the `CHANNEL_UNKNOWN` branch unreachable, which is the
 * kind of dead code that reads like an implemented feature.
 *
 * @returns {{state: 'known', channel: string, id: string, prefix: string, kind: 'self'|'contact'|'room', room: boolean}
 *          | {state: 'unknown-channel', prefix: string, id: string}
 *          | {state: 'malformed'}}
 */
export function classifyWindow(windowKey) {
  if (typeof windowKey !== 'string' || windowKey === '') return { state: 'malformed' };
  const i = windowKey.indexOf(':');
  if (i === -1) {
    const bare = PREFIX_INDEX.get(windowKey);
    if (!bare) return { state: 'unknown-channel', prefix: windowKey, id: '' };
    return { state: 'known', ...bare, id: windowKey, prefix: windowKey, room: bare.kind === 'room' };
  }
  if (i === 0 || i === windowKey.length - 1) return { state: 'malformed' };
  const prefix = windowKey.slice(0, i);
  const claimed = PREFIX_INDEX.get(prefix);
  if (!claimed) return { state: 'unknown-channel', prefix, id: windowKey.slice(i + 1) };
  return { state: 'known', ...claimed, id: windowKey.slice(i + 1), prefix, room: claimed.kind === 'room' };
}

/**
 * Parse a window key into its parts, or `null` when no channel claims it.
 *
 * Kept as the narrow form for callers that only need "did a channel claim this".
 */
export function parseWindowKey(windowKey) {
  const c = classifyWindow(windowKey);
  return c.state === 'known' ? c : null;
}

/** Canonical `channel\u0000id` form. The separator is a NUL so no id can forge another. */
function identityKey(channel, id) {
  return `${channel}\u0000${id}`;
}

/**
 * Create a policy.
 *
 * @param {object} [options]
 * @param {string[]} [options.trustedContacts] Pre-seeded `channel:id` entries, e.g. `feishu:ou_abc`.
 * @param {string[]} [options.allowedRooms] `channel:roomId` entries. Membership alone is never enough.
 * @param {string} [options.pairingCode] Optional fixed code, for scripted onboarding.
 * @param {() => number} [options.now]
 * @param {() => string} [options.mintCode] Source for generated pairing codes.
 * @param {number} [options.pairingTtlMs]
 * @param {number} [options.maxPairAttemptsPerIdentity]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createPolicy(options = {}) {
  const now = options.now ?? (() => Date.now());
  const mintCode = options.mintCode ?? (() => `PAIR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`);
  const audit = options.audit ?? (() => {});
  const pairingTtlMs = options.pairingTtlMs ?? 15 * 60_000;
  const maxAttempts = options.maxPairAttemptsPerIdentity ?? 5;

  const trusted = new Set();
  for (const entry of options.trustedContacts ?? []) {
    const parsed = splitEntry(entry);
    if (parsed) trusted.add(identityKey(parsed.channel, parsed.id));
  }
  const rooms = new Set();
  for (const entry of options.allowedRooms ?? []) {
    const parsed = splitEntry(entry);
    if (parsed) rooms.add(identityKey(parsed.channel, parsed.id));
  }

  /** identity -> { attempts, firstAt }. Bounded by eviction in `sweep()`. */
  const attempts = new Map();

  let pairing = null;
  if (typeof options.pairingCode === 'string' && options.pairingCode !== '') {
    pairing = { code: options.pairingCode, expiresAt: now() + pairingTtlMs, used: false };
  }

  /** Split a `channel:id` config entry, refusing the ambiguous forms. */
  function splitEntry(entry) {
    if (typeof entry !== 'string') return null;
    const i = entry.indexOf(':');
    if (i <= 0 || i === entry.length - 1) return null;
    return { channel: entry.slice(0, i).trim().toLowerCase(), id: entry.slice(i + 1).trim() };
  }

  /** Whether any owner exists. Until one does, the plugin is inert. */
  function hasOwners() {
    return trusted.size > 0;
  }

  /**
   * Mint a pairing code, invalidating any previous one.
   *
   * Rotating on issue is deliberate: a code that stays valid while a new one is
   * printed is a code nobody can reason about. Where the code is displayed — the
   * terminal, a QR page — is the transport's business, not this module's.
   */
  function openPairing() {
    pairing = { code: mintCode(), expiresAt: now() + pairingTtlMs, used: false };
    audit('pairing/opened', { expires_at: pairing.expiresAt });
    return { code: pairing.code, expires_at: pairing.expiresAt };
  }

  /** Redeem a code. Single-use, expiring, rate-limited per identity. */
  function redeemPairing(channel, id, code) {
    const key = identityKey(channel, id);
    const record = attempts.get(key);
    if (!record || now() - record.firstAt > pairingTtlMs) {
      attempts.set(key, { attempts: 0, firstAt: now() });
    }
    const entry = attempts.get(key);
    entry.attempts += 1;
    if (entry.attempts > maxAttempts) {
      audit('pairing/rate-limited', { channel, id });
      return { ok: false, reason: 'rate_limited' };
    }
    if (!pairing || pairing.used) return { ok: false, reason: 'no_open_pairing' };
    if (now() >= pairing.expiresAt) {
      pairing = null;
      return { ok: false, reason: 'expired' };
    }
    if (typeof code !== 'string' || code !== pairing.code) {
      audit('pairing/mismatch', { channel, id });
      return { ok: false, reason: 'mismatch' };
    }
    pairing.used = true;
    trusted.add(key);
    attempts.delete(key);
    audit('owner/adopted', { channel, id, via: 'pairing' });
    return { ok: true };
  }

  /** Add an identity without a code. Only the operator's own config path may call this. */
  function trust(channel, id, via = 'config') {
    const key = identityKey(channel, id);
    if (trusted.has(key)) return { ok: false, reason: 'already_trusted' };
    trusted.add(key);
    audit('owner/adopted', { channel, id, via });
    return { ok: true };
  }

  /** Remove an identity. 0.1.0 had no revocation short of deleting its state file. */
  function distrust(channel, id) {
    const key = identityKey(channel, id);
    if (!trusted.delete(key)) return { ok: false, reason: 'not_trusted' };
    audit('owner/revoked', { channel, id });
    return { ok: true };
  }

  /**
   * Decide one inbound message.
   *
   * @param {object} message
   * @param {string} message.windowKey
   * @param {string} [message.talkerId]
   * @param {boolean} [message.addressed] Whether a room message named the bot.
   * @returns {{allow: true, channel: string, id: string, kind: string}
   *          | {allow: false, reason: string, channel: string|null}}
   */
  function admit(message) {
    const classified = classifyWindow(message?.windowKey);
    if (classified.state === 'malformed') {
      audit('message/denied', { window: message?.windowKey ?? null, reason: DENIAL.MALFORMED });
      return { allow: false, reason: DENIAL.MALFORMED, channel: null };
    }
    // A well-formed key naming a channel nobody enabled. 0.1.0's prefix regexes did
    // this silently; a named reason is the difference between "nobody is talking to
    // me" and "my config is wrong", which is the diagnosis an operator actually needs.
    if (classified.state === 'unknown-channel') {
      audit('message/denied', { window: message?.windowKey ?? null, reason: DENIAL.CHANNEL_UNKNOWN });
      return { allow: false, reason: DENIAL.CHANNEL_UNKNOWN, channel: null };
    }
    const parsed = classified;

    // The speaker, for a room message, is the talker — not the room.
    const speakerId = message.talkerId ?? parsed.id;
    const speakerKey = identityKey(parsed.channel, speakerId);

    if (!hasOwners()) {
      // No owner yet: everything is refused until the operator seeds one or a pairing
      // code is redeemed. This single branch is the fix for the first-contact hole.
      audit('message/denied', { window: message.windowKey, reason: DENIAL.NOT_ADOPTED });
      return { allow: false, reason: DENIAL.NOT_ADOPTED, channel: parsed.channel };
    }

    if (parsed.kind === 'room') {
      if (!rooms.has(identityKey(parsed.channel, parsed.id))) {
        audit('message/denied', { window: message.windowKey, reason: DENIAL.ROOM_NOT_ALLOWED });
        return { allow: false, reason: DENIAL.ROOM_NOT_ALLOWED, channel: parsed.channel };
      }
      if (message.addressed !== true) {
        audit('message/denied', { window: message.windowKey, reason: DENIAL.NOT_ADDRESSED });
        return { allow: false, reason: DENIAL.NOT_ADDRESSED, channel: parsed.channel };
      }
      // Room allowed AND speaker individually trusted. Membership is not a grant.
      if (!trusted.has(speakerKey)) {
        audit('message/denied', { window: message.windowKey, reason: DENIAL.SENDER_UNTRUSTED });
        return { allow: false, reason: DENIAL.SENDER_UNTRUSTED, channel: parsed.channel };
      }
      audit('message/allowed', { window: message.windowKey, kind: 'room' });
      return { allow: true, channel: parsed.channel, id: speakerId, kind: 'room' };
    }

    if (!trusted.has(speakerKey)) {
      audit('message/denied', { window: message.windowKey, reason: DENIAL.SENDER_UNTRUSTED });
      return { allow: false, reason: DENIAL.SENDER_UNTRUSTED, channel: parsed.channel };
    }
    audit('message/allowed', { window: message.windowKey, kind: parsed.kind });
    return { allow: true, channel: parsed.channel, id: speakerId, kind: parsed.kind };
  }

  /** Drop rate-limit bookkeeping that can no longer matter. */
  function sweep() {
    const cutoff = now() - pairingTtlMs;
    let dropped = 0;
    for (const [key, record] of attempts) {
      if (record.firstAt < cutoff) {
        attempts.delete(key);
        dropped += 1;
      }
    }
    return { dropped };
  }

  return {
    admit,
    redeemPairing,
    openPairing,
    trust,
    distrust,
    hasOwners,
    sweep,
    get ownerCount() {
      return trusted.size;
    },
    /** For diagnostics and tests. */
    _internals: { trusted, rooms, attempts, get pairing() { return pairing; } },
  };
}
