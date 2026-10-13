/**
 * Mounting the chat bridge into a DSH profile (v0.7.0).
 *
 * ## What this is for
 *
 * The seven modules before this one carry the safety properties. This is the seam that makes
 * them a plugin: it reads the row's config, builds the bridge, hands the host a listener for
 * `approval/request`, and owns its own lifetime so a reload disposes it.
 *
 * ## The two things it deliberately does not do
 *
 * **It does not install a channel for you.** There is no default channel and no `ilink` or
 * `feishu` adapter in this release, so a row with no channel enabled mounts a bridge that
 * refuses everything and says so in its log. That is a real state and it is reported as one
 * rather than papered over with a stub that would look like a working bot. Registering the
 * in-memory channel is supported and is how the integration test drives the real path.
 *
 * **It does not adopt an owner.** `policy.mjs` has no first-contact path at all, so a fresh
 * install is inert until the operator seeds `security.allowContacts` or redeems a pairing
 * code printed by `pair()`. That is the fix for the finding this work started from, and it
 * means a misconfigured install is silent rather than hijackable.
 *
 * ## Why `ctx.effect` and not a bare start
 *
 * A bridge holds timers — the approval deadline, every lane's throttle — and a map of pending
 * approvals. `dsh-chatops` 0.1.0 owned none of them with a disposer, so a reload left timers
 * firing at promises belonging to a fiber that no longer existed. Everything this module
 * starts is registered as a reversible effect, and when the host provides no `ctx.effect` the
 * gap is named rather than ignored.
 */

import { createBridge } from './bridge.mjs';
import { createPolicy } from './policy.mjs';
import { createConfigRoute } from './config-route.mjs';
import { createMemoryChannel, validateChannel, CHANNEL_STATE } from './channel.mjs';
import { createILinkChannel } from './ilink.mjs';
import { isAllowedApiUrl } from './ilink-protocol.mjs';
import { createFleetExecutor } from './fleet.mjs';
import { createChatopsActions } from './actions.mjs';
import { helpText, commandTable } from './commands.mjs';

/**
 * A fleet that refuses everything, for an install with no relay configured.
 *
 * Named refusals rather than an absent action, because `/machines` on a phone must say *why* it
 * has nothing — "no rabbitUrl is set" is actionable and "this install has no fleet" is not.
 */
function unreachableFleet() {
  const refuse = () => ({ ok: false, reason: 'no_relay', text: '这个安装没有配置 rabbitUrl，无法访问编队。' });
  return {
    run: async () => refuse(),
    wait: async () => refuse(),
    status: async () => refuse(),
    report: async () => refuse(),
    devices: async () => refuse(),
  };
}

/** Cordis service this plugin needs: none. The bridge is self-contained by construction. */
export const inject = [];

/** The config row's defaults, matching `cordis.patch.yml`. */
const DEFAULTS = Object.freeze({
  channels: [],
  channel: null,
  security: Object.freeze({ allowContacts: [], allowRooms: [], listenFilehelper: true, listenSelf: true }),
  push: Object.freeze({ onSessionComplete: true, onApproval: true, approvalTimeoutSec: 300 }),
  reply: Object.freeze({ maxChunkBytes: 6000, rateLimitMs: 1200, maxFileMB: 100 }),
  storagePath: '',
  projectRoot: '',
  operatorToken: '',
  enableMemoryChannel: false,
  /** The fleet. `rabbitUrl` is read from the same row the tools use, so there is one setting. */
  rabbitUrl: '',
  /** How long `/run` holds a chat reply before answering "still running". */
  fleetWaitMs: 90_000,
  /** Whether `/run` waits at all. A dispatch-only install answers with the task id instead. */
  fleetAutoWait: true,
});

/** Read the row into a shape the modules take, with every default stated once. */
export function readChatopsConfig(config = {}) {
  const security = { ...DEFAULTS.security, ...(config.security ?? {}) };
  const push = { ...DEFAULTS.push, ...(config.push ?? {}) };
  const reply = { ...DEFAULTS.reply, ...(config.reply ?? {}) };
  const channels = Array.isArray(config.channels) && config.channels.length > 0
    ? config.channels
    : config.channel
      ? [config.channel]
      : [...DEFAULTS.channels];
  const envToken = typeof process.env.W2M_OPERATOR_TOKEN === 'string' ? process.env.W2M_OPERATOR_TOKEN.trim() : '';
  return {
    channels,
    security,
    push,
    reply,
    storagePath: typeof config.storagePath === 'string' ? config.storagePath : DEFAULTS.storagePath,
    projectRoot: typeof config.projectRoot === 'string' ? config.projectRoot : DEFAULTS.projectRoot,
    // Resolution order matches the tools': the row, then the environment, then nothing. A
    // different order here would mean the chat layer and the tools disagree about which token
    // they hold, and only one of them would be refused.
    operatorToken:
      typeof config.operatorToken === 'string' && config.operatorToken.trim() !== ''
        ? config.operatorToken.trim()
        : envToken !== ''
          ? envToken
          : DEFAULTS.operatorToken,
    rabbitUrl:
      typeof config.rabbitUrl === 'string' && config.rabbitUrl.trim() !== ''
        ? config.rabbitUrl.trim()
        : typeof process.env.W2M_RABBIT_URL === 'string' && process.env.W2M_RABBIT_URL.trim() !== ''
          ? process.env.W2M_RABBIT_URL.trim()
          : DEFAULTS.rabbitUrl,
    fleetWaitMs: Number.isInteger(config.fleetWaitMs) ? config.fleetWaitMs : DEFAULTS.fleetWaitMs,
    fleetAutoWait: config.fleetAutoWait !== false,
    enableMemoryChannel: config.enableMemoryChannel === true,
  };
}

/**
 * Report what a row would do, without starting anything.
 *
 * Exposed because "why is my bot silent" should be answerable from a config dump rather than
 * by reading logs: an install with no channel enabled and no owner seeded is inert by design,
 * and that is worth saying out loud in a status line.
 */
export function describeChatopsConfig(config = {}) {
  const cfg = readChatopsConfig(config);
  const notes = [];
  if (cfg.channels.length === 0) {
    notes.push('no channel is enabled, so nothing will be received');
  }
  const owners = [...cfg.security.allowContacts];
  if (owners.length === 0) {
    notes.push(
      'no identity is seeded in security.allowContacts, so the bridge will refuse every message ' +
        'until an owner is established — there is no first-contact adoption',
    );
  }
  if (cfg.operatorToken === '') notes.push('no operatorToken, so the settings route will be disabled');
  return {
    channels: cfg.channels,
    owners,
    rooms: [...cfg.security.allowRooms],
    approvalTimeoutSec: cfg.push.approvalTimeoutSec,
    notes,
    commands: commandTable().map((c) => c.usage),
  };
}

/**
 * Register an in-memory channel under a name.
 *
 * The supported path for a dry run and for tests. It is checked by the same validator a real
 * adapter is, so it cannot drift from the contract.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string[]} options.prefixes
 */
export function defineChannel(options) {
  const verdict = validateChannel(options);
  if (!verdict.ok) throw new TypeError(`defineChannel: ${verdict.reason}`);
  return options;
}

/**
 * Cordis entry point.
 *
 * @param {object} ctx
 * @param {object} [config] The row's config.
 */
export async function apply(ctx, config = {}) {
  const cfg = readChatopsConfig(config);
  const log = {
    info: (m) => ctx?.logger?.info?.(`chatops: ${m}`),
    warn: (m) => ctx?.logger?.warn?.(`chatops: ${m}`),
  };

  const described = describeChatopsConfig(config);
  for (const note of described.notes) log.warn(note);
  if (cfg.channels.length === 0) {
    // Named, not silent. A bridge with no channel is a configuration, and a row that looks
    // enabled while receiving nothing is the failure mode this message exists to prevent.
    log.warn('no channel adapter is available in this release; the bridge mounts inert');
  }

  const channels = [];
  if (cfg.enableMemoryChannel) {
    channels.push(
      createMemoryChannel({
        name: 'memory',
        prefixes: ['mem'],
        onOutbound: (record) => log.info(`-> ${record.window}: ${String(record.text).slice(0, 80)}`),
      }),
    );
  }

  // The WeChat adapter, mounted when its row asks for it.
  if (cfg.channels.includes('ilink')) {
    const base = ctx?.chatopsIlinkBase ?? undefined;
    if (base !== undefined && !isAllowedApiUrl(base).ok) {
      // Refused before a token can go anywhere. Named rather than attempted.
      log.warn(`the ilink base url was refused: ${isAllowedApiUrl(base).reason}`);
    } else {
      const token = ctx?.chatopsIlinkToken ?? null;
      channels.push(
        createILinkChannel({
          // The host *may* supply a transport. In v0.7.0 that was the only option, which meant
          // the channel could never send a request at all, because nothing shipped one. The
          // adapter now builds a real HTTP transport itself and this only overrides it.
          transport: typeof ctx?.chatopsIlinkRequest === 'function' ? ctx.chatopsIlinkRequest : undefined,
          token,
          apiBase: base,
          audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
        }),
      );
      if (token === null || token === '') {
        // Neither an error nor silent: an install that has not scanned a QR yet is a normal
        // state, and saying so is what stops "the bot is broken" being the only conclusion
        // available to an operator.
        log.warn('the ilink channel is mounted with no bot token, so it will not poll until one is adopted');
      }
    }
  }

  // The bridge refuses to be built with no channel, which is right for the data path and
  // wrong for a configuration report. So an inert mount registers one that accepts nothing
  // and says so, rather than failing the whole profile on a row that is merely disabled.
  if (channels.length === 0) {
    if (cfg.channels.length > 0) {
      // Configured to receive, and cannot. This is the state worth being loudest about: the
      // row says the bot is on, so a silent bridge would read as a platform problem.
      log.warn(`channels ${cfg.channels.join(', ')} were requested but none could be mounted`);
    }
    const inert = createMemoryChannel({ name: 'memory', prefixes: ['mem'] });
    channels.push(inert);
    log.warn('mounted with an inert channel so the profile loads; enable a channel to receive anything');
  }

  // The policy is built here rather than inside `createBridge`, so the action set can share the
  // same one. Two policies would mean two answers to "who is trusted", and `/trust` would write
  // to the copy that admission does not read.
  const policy = createPolicy({
    trustedContacts: cfg.security.allowContacts,
    allowedRooms: cfg.security.allowRooms,
    audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
  });

  // The fleet half of the action set. This is what makes `/run` mean something: without it the
  // command could only ever answer "this install has no fleet", which is exactly what v0.7.1 and
  // earlier did.
  const fleet =
    cfg.rabbitUrl === ''
      ? null
      : createFleetExecutor({
          rabbitUrl: cfg.rabbitUrl,
          token: cfg.operatorToken === '' ? null : cfg.operatorToken,
          audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
        });
  if (fleet === null) log.warn('no rabbitUrl, so /run, /where, /report and /machines will refuse');

  const actions = createChatopsActions({
    executor: fleet ?? unreachableFleet(),
    policy,
    host: ctx?.chatopsHost ?? {},
    waitMs: cfg.fleetWaitMs,
    autoWait: cfg.fleetAutoWait,
    audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
  });

  const bridge = createBridge({
    channels,
    actions,
    // Passed in, not rebuilt: `/trust` must widen the list that admission actually consults.
    policy,
    chunkBytes: cfg.reply.maxChunkBytes,
    throttleMs: cfg.reply.rateLimitMs,
    projectRoot: cfg.projectRoot === '' ? undefined : cfg.projectRoot,
    maxFileBytes: cfg.reply.maxFileMB * 1024 * 1024,
    audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
  });

  // The approval seam, and the whole of the fix for the defect that reached beyond this
  // plugin: four lines, and the host's own answerers are reached on every path where this
  // bridge declines or runs out of time.
  ctx?.on?.('approval/request', (request, next) => {
    const windowKey = ctx?.chatopsWindowFor?.(request) ?? null;
    return bridge
      .offerApproval({
        request,
        windowKey,
        timeoutMs: cfg.push.onApproval ? cfg.push.approvalTimeoutSec * 1000 : 0,
        next,
      })
      .then((result) => (result.claimed ? result.outcome : undefined));
  });

  const route = cfg.operatorToken === ''
    ? null
    : createConfigRoute({
        token: cfg.operatorToken,
        read: () => ({ ...config }),
        write: async (next) => {
          if (typeof ctx?.chatopsWriteConfig !== 'function') {
            throw new Error('no config writer is registered');
          }
          await ctx.chatopsWriteConfig(next);
        },
        audit: (event, detail) => ctx?.logger?.debug?.(`chatops ${event} ${JSON.stringify(detail ?? {})}`),
      });
  if (route === null) log.warn('operatorToken is empty, so the settings route is disabled');

  if (typeof ctx?.effect !== 'function') {
    // Not started rather than started-and-leaked: a bridge whose timers nobody owns is the
    // leak this release exists to remove.
    log.warn('the context provides no ctx.effect, so the bridge was not started');
    return { started: false, reason: 'no_effect', ...described };
  }

  ctx.effect(() => {
    let stopped = false;
    bridge.start().catch((error) => log.warn(`start failed: ${error.message}`));
    return () => {
      if (stopped) return;
      stopped = true;
      return bridge.stop();
    };
  });

  return {
    started: true,
    help: helpText(),
    configRoute: route !== null,
    ...described,
  };
}

/** States a caller may ask about. Re-exported so a status surface need not import the module. */
export { CHANNEL_STATE };
