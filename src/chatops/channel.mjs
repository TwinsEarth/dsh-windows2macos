/**
 * The contract every IM channel implements (v0.7.0).
 *
 * ## What this replaces
 *
 * `dsh-chatops` 0.1.0 had three overlapping shapes — a `BridgeChannel`, a `ManagedChannel`,
 * and the types in a file named after one vendor — and none of them was the real contract.
 * The bridge was typed against one, handed another, and reached past its own type with
 * three `as any` casts to call `channelFor`. Beyond the declared members it also *probed*
 * for `statusSnapshot`, `sendFile`, `sendApprovalCard`, `sendProgressCard`,
 * `completeProgressCard` and `onCardAction`, each on an `any`, so a channel missing one
 * failed only at runtime and only once the feature was used.
 *
 * A channel whose prefix was missing from the authorisation regexes had every message from
 * it silently dropped. Adding a fifth channel meant touching nine places, four of them
 * duplicated prefix tables that had to agree.
 *
 * ## The shape here
 *
 * One interface, five members, and a **capabilities** descriptor instead of method
 * sniffing: a channel that cannot send cards says so, and the caller asks rather than
 * probing. The registry in `policy.mjs` is the single source of channel identity, so a
 * channel cannot exist in one table and be missing from another.
 *
 * A channel never decides who may speak. That is `policy.mjs`, and keeping it out of the
 * channel is what stops a vendor from quietly becoming part of the authorisation path —
 * which is exactly what a hard-coded `fsu:` prefix inside the approval broker was.
 */

/** What a channel can do, asked instead of guessed. */
export const CHANNEL_FEATURE = Object.freeze({
  /** Messages longer than the platform budget must be split. */
  CHUNKING: 'chunking',
  /** Can carry a file or image. */
  FILES: 'files',
  /** Can render an interactive approval card. */
  CARDS: 'cards',
  /** Can edit or complete a message already sent. */
  EDIT: 'edit',
  /** Group conversations reach this channel. */
  ROOMS: 'rooms',
});

/** Channel lifecycle states, reported rather than inferred from a boolean. */
export const CHANNEL_STATE = Object.freeze({
  /** Not started, or deliberately off. */
  IDLE: 'idle',
  /** Credentials missing or refused; the channel will not take work. */
  UNCONFIGURED: 'unconfigured',
  /** Trying. Not yet able to send. */
  CONNECTING: 'connecting',
  READY: 'ready',
  /** Was ready, lost it, retrying. The state 0.1.0 collapsed into `online: false`. */
  DEGRADED: 'degraded',
  STOPPED: 'stopped',
});

/**
 * Validate that an object satisfies the channel contract, and say what is missing.
 *
 * Called at construction rather than on first use. The failure this prevents is the one
 * that plugin had: a channel that starts, reports itself registered, accepts routed
 * messages, and throws only when a feature is first exercised.
 *
 * @param {object} channel
 * @param {string[]} [declaredPrefixes] The prefixes `policy.mjs` claims for this channel.
 * @returns {{ok: true} | {ok: false, missing: string[], reason: string}}
 */
export function validateChannel(channel, declaredPrefixes) {
  if (!channel || typeof channel !== 'object') {
    return { ok: false, missing: [], reason: 'channel is not an object' };
  }
  const missing = [];
  if (typeof channel.name !== 'string' || channel.name === '') missing.push('name');
  if (typeof channel.start !== 'function') missing.push('start()');
  if (typeof channel.stop !== 'function') missing.push('stop()');
  if (typeof channel.send !== 'function') missing.push('send()');
  if (!Array.isArray(channel.prefixes) || channel.prefixes.length === 0) missing.push('prefixes[]');

  if (missing.length > 0) {
    return { ok: false, missing, reason: `channel is missing: ${missing.join(', ')}` };
  }

  // A channel whose prefixes the registry does not know would have every message from it
  // refused as `channel_unknown` -- silently, from the operator's point of view. Naming it
  // here turns a dead channel into a startup error.
  if (Array.isArray(declaredPrefixes) && declaredPrefixes.length > 0) {
    const unknown = channel.prefixes.filter((p) => !declaredPrefixes.includes(p));
    if (unknown.length > 0) {
      return {
        ok: false,
        missing: [],
        reason:
          `channel ${channel.name} claims prefix(es) ${unknown.join(', ')} that the channel registry ` +
          `does not declare, so every message from it would be refused as channel_unknown`,
      };
    }
  }

  const features = channel.capabilities ?? {};
  const badFeature = Object.values(CHANNEL_FEATURE).find((f) => features[f] !== undefined && typeof features[f] !== 'boolean');
  if (badFeature) {
    return { ok: false, missing: [], reason: `capability ${badFeature} must be a boolean, not ${typeof features[badFeature]}` };
  }

  return { ok: true };
}

/**
 * A channel that exists in memory, for tests and for a dry run.
 *
 * It is a **first-class implementation**, not a mock: the same object is what a real
 * adapter is checked against, and what the integration suite drives end to end. A test
 * double that diverges from the interface is how an interface stops meaning anything, so
 * this one is validated by the same `validateChannel` a real channel is.
 *
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {string[]} [options.prefixes]
 * @param {object} [options.capabilities]
 * @param {(message: object) => void} [options.onOutbound] Called for each send; the test's
 *        window into what the bridge tried to say.
 * @param {() => boolean} [options.failWhen] Return true to make the next send reject.
 */
export function createMemoryChannel(options = {}) {
  const name = options.name ?? 'memory';
  const prefixes = options.prefixes ?? ['mem'];
  const capabilities = {
    [CHANNEL_FEATURE.CHUNKING]: true,
    [CHANNEL_FEATURE.FILES]: true,
    [CHANNEL_FEATURE.CARDS]: false,
    [CHANNEL_FEATURE.EDIT]: false,
    [CHANNEL_FEATURE.ROOMS]: false,
    ...options.capabilities,
  };

  /** window -> [{ text, at }]. */
  const sent = [];
  let state = CHANNEL_STATE.IDLE;
  let handlers = null;
  const log = [];

  // Built by assignment rather than returned as an object literal: an object literal with
  // `...spread` **evaluates** an accessor instead of copying it, so a `sent` getter written
  // that way silently becomes a snapshot taken at construction.
  const channel = {
    name,
    prefixes,
    capabilities,

    async start(inbound) {
      if (typeof inbound !== 'function') throw new TypeError('start() needs an inbound handler');
      handlers = inbound;
      state = CHANNEL_STATE.READY;
      log.push('start');
    },

    async stop() {
      state = CHANNEL_STATE.STOPPED;
      handlers = null;
      log.push('stop');
    },

    async send({ window, text }) {
      if (state !== CHANNEL_STATE.READY) {
        throw new Error(`channel ${name} is ${state}, not ready`);
      }
      if (options.failWhen?.(text)) throw new Error('scripted send failure');
      const record = { window, text, at: Date.now() };
      sent.push(record);
      options.onOutbound?.(record);
    },

    /** Deliver a message as if it arrived from the platform. */
    async receive(message) {
      if (typeof handlers !== 'function') throw new Error(`channel ${name} was never started`);
      return handlers(message);
    },

    setState(next) {
      state = next;
    },
  };

  Object.defineProperty(channel, 'state', { get: () => state, enumerable: true });
  // Read-only views for tests and for a dry run. Named so it is obvious they are not part of
  // the contract a real channel implements.
  Object.defineProperty(channel, 'sent', { get: () => sent, enumerable: false });
  Object.defineProperty(channel, 'log', { get: () => log, enumerable: false });

  return channel;
}
