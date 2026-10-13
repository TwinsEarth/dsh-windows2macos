/**
 * The pipeline: one inbound message in, one action out (v0.7.0).
 *
 * ## What this replaces
 *
 * `dsh-chatops` 0.1.0's `SessionBridge` was 1,060 lines carrying ten to eleven
 * responsibilities — the session catalogue, title resolution through three fallbacks,
 * command parsing, eleven command implementations, prompt delivery, agent-event mirroring,
 * the approval answerer, vendor card probing, file delivery, direct reads of the host's
 * on-disk state, and an import of a vendor's view module. Its longest function was 87 lines
 * of session-catalog work living inside a chat bridge, and it held ten mutable maps with no
 * disposer owning any of them.
 *
 * Here the responsibilities are already elsewhere, and this file is the order they run in:
 *
 *     admit (policy) -> route (commands) -> deliver (outbound queue)
 *                            |
 *                            +-> dispatch (the fleet, injected)
 *                            +-> approvals (the broker)
 *                            +-> files (the reader and the fan-out)
 *
 * The whole of it is one function per direction, and the interesting content is the refusal
 * handling rather than the happy path.
 *
 * ## Two rules this file exists to enforce
 *
 * **A refusal is a reply, not silence.** Every dropped message produces something the
 * operator can see — but only for identities that were admitted at least once, because
 * replying to a stranger confirms the bot exists and spends the rate limit on them. The
 * distinction is deliberate and the tests assert both halves.
 *
 * **Nothing is trusted because it arrived** is `policy.mjs`'s rule; this file's rule is that
 * a failure anywhere in the pipeline still produces a reply. A bridge that goes quiet on an
 * exception is indistinguishable from a bridge that is not running.
 */

import { createPolicy, DENIAL } from './policy.mjs';
import { route, commandTable, OWNER_CAPABILITIES } from './commands.mjs';
import { createOutboundQueue } from './outbound-queue.mjs';
import { createApprovalBroker } from './approval-broker.mjs';
import { createFileReader, createFileSender, fanOutFile } from './file-safety.mjs';
import { validateChannel, CHANNEL_FEATURE, CHANNEL_STATE } from './channel.mjs';

/** Prefixes the registry declares, derived so the two cannot disagree. */
import { CHANNELS as CHANNEL_REGISTRY } from './policy.mjs';

function declaredPrefixes() {
  const all = [];
  for (const spec of Object.values(CHANNEL_REGISTRY)) {
    all.push(...spec.prefixes, ...(spec.roomPrefixes ?? []));
  }
  all.push('filehelper');
  return all;
}

/**
 * Build the bridge.
 *
 * @param {object} options
 * @param {object[]} options.channels Channel implementations. Each is validated at construction.
 * @param {object} options.actions The injected action set `commands.mjs` calls.
 * @param {object} [options.policy] Overrides for `createPolicy`.
 * @param {number} [options.chunkBytes]
 * @param {number} [options.throttleMs]
 * @param {string} [options.projectRoot] Root the file fence is anchored to.
 * @param {number} [options.maxFileBytes]
 * @param {() => number} [options.now]
 * @param {(event: string, detail?: object) => void} [options.audit]
 * @param {object} [options.broker] Overrides for `createApprovalBroker`.
 */
export function createBridge(options) {
  const audit = options.audit ?? (() => {});
  const channels = options.channels ?? [];
  if (channels.length === 0) throw new TypeError('createBridge needs at least one channel');

  // A channel that does not satisfy the contract is a startup error, not a runtime surprise
  // discovered the first time someone tries to send a file.
  const known = declaredPrefixes();
  for (const channel of channels) {
    const verdict = validateChannel(channel, known);
    if (!verdict.ok) throw new TypeError(`invalid channel: ${verdict.reason}`);
  }
  // Two maps, not one. `owners` records who claimed a prefix so a duplicate is a startup
  // error; `byPrefix` is the prefix -> channel-name lookup routing uses. Folding them into a
  // single map looks tidy and is wrong: the duplicate check writes `channel.name` while the
  // routing lookup needs the channel *itself*, so whichever read happens second gets the
  // other one's value and every reply silently resolves to no channel.
  const owners = new Map();
  const byPrefix = new Map();
  for (const channel of channels) {
    for (const prefix of channel.prefixes) {
      if (owners.has(prefix)) {
        throw new TypeError(`prefix ${prefix} is claimed by both ${owners.get(prefix)} and ${channel.name}`);
      }
      owners.set(prefix, channel.name);
      byPrefix.set(prefix, channel);
    }
  }

  const policy = createPolicy({ audit, ...options.policy });
  const commands = commandTable();
  const broker = createApprovalBroker({
    now: options.now,
    audit,
    ...options.broker,
  });

  const queues = new Map();
  function queueFor(channel) {
    let queue = queues.get(channel.name);
    if (!queue) {
      queue = createOutboundQueue({
        // Two parameters, not one destructured object: the queue hands over a chunk plus
        // its metadata, and the window is in the metadata. Reading `{window, text}` off a
        // single argument yields `undefined` for both, which fails silently — every reply
        // is "sent" and the channel receives nothing.
        send: async (chunk, meta) => channel.send({ window: meta.window, text: chunk }),
        chunkBytes: options.chunkBytes,
        throttleMs: options.throttleMs,
        now: options.now,
        audit,
      });
      queues.set(channel.name, queue);
    }
    return queue;
  }

  const reader =
    options.projectRoot !== undefined
      ? createFileReader({
          projectRoot: options.projectRoot,
          maxBytes: options.maxFileBytes,
          audit,
          // Injectable so a caller can test the routing and the counting without a real
          // filesystem — the fence's own symlink behaviour is proven in its own suite, and a
          // bridge test that needs POSIX links on a Windows host cannot run there at all.
          ...options.readerIo,
        })
      : null;

  const started = [];

  /** Which channel owns a window key. Resolved from the registry, never from a hard-coded prefix. */
  function channelFor(windowKey) {
    const key = String(windowKey ?? '');
    const prefix = key.split(':')[0];
    return byPrefix.get(prefix) ?? byPrefix.get(key) ?? null;
  }

  /** Reply on whichever channel the message came from. Best effort, and never throws. */
  async function reply(windowKey, text, lane = 'interactive') {
    const channel = channelFor(windowKey) ?? auditChannel();
    if (!channel) {
      audit('reply/no-channel', { window: windowKey });
      return { sent: 0, failed: 0 };
    }
    return queueFor(channel).enqueue({ window: windowKey, text, lane });
  }

  /**
   * Where a reply goes when the window names no channel at all.
   *
   * A malformed or unregistered window is an operator's configuration being wrong, and
   * answering it is the difference between "my bot is broken" and "my bot told me what is
   * wrong". It is **not** routed by guessing a channel from the key — that would let a
   * message choose its own reply path — so it goes to the first channel that started, with
   * the reason named in the text.
   */
  function auditChannel() {
    return started[0] ?? channels[0] ?? null;
  }

  /**
   * Handle one inbound message.
   *
   * @param {{windowKey: string, talkerId?: string, text: string, addressed?: boolean}} message
   * @returns {Promise<{action: string, [k: string]: unknown}>}
   */
  async function handleInbound(message) {
    const windowKey = message?.windowKey;
    // Admission first, and before anything else — including before deciding whether to
    // reply, because whether we reply depends on what admission concluded.
    const admitted = policy.admit(message);

    if (!admitted.allow) {
      // A stranger gets silence: replying confirms the bot exists and spends the
      // anti-flood budget on someone who will never be admitted. An identity that has been
      // admitted before gets the reason, because for them a silent drop is a bug report.
      if (admitted.reason === DENIAL.NOT_ADOPTED || admitted.reason === DENIAL.SENDER_UNTRUSTED) {
        audit('inbound/ignored', { window: windowKey, reason: admitted.reason });
        return { action: 'ignored', reason: admitted.reason };
      }
      const text = `这条消息没有被处理：${admitted.reason}`;
      await reply(windowKey, text);
      return { action: 'refused', reason: admitted.reason };
    }

    const caps = new Set(OWNER_CAPABILITIES);
    let routed;
    try {
      routed = await route(message.text, {
        capabilities: caps,
        identity: { channel: admitted.channel, id: admitted.id, window: windowKey },
        policyModes: options.policyModes ?? ['read-only', 'ask', 'danger-full-access'],
        actions: actionsFor(windowKey),
        commands,
      });
    } catch (error) {
      // Unreachable through `route`, which catches its own handler failures. Kept because a
      // bridge that goes quiet on an exception looks exactly like a bridge that is not
      // running, and that is the failure this whole file is written against.
      audit('inbound/error', { window: windowKey, detail: String(error) });
      await reply(windowKey, `处理失败：${error instanceof Error ? error.message : String(error)}`);
      return { action: 'error' };
    }

    if (routed.kind === 'prompt') {
      if (typeof options.actions.prompt !== 'function') {
        await reply(windowKey, '这台机器没有接入会话，无法发送 prompt。');
        return { action: 'unavailable' };
      }
      // The window's bound session is resolved by the injected action, not here: binding is
      // session-catalogue work and does not belong in the transport layer.
      const delivered = await options.actions.prompt(windowKey, routed.text);
      await reply(windowKey, delivered?.ack ?? '已收到。');
      return { action: 'prompt' };
    }

    await reply(windowKey, routed.text);
    return { action: routed.kind, name: routed.name, refusal: routed.refusal, taskId: routed.taskId };
  }

  /** The action set the command table sees, with the window bound in. */
  function actionsFor(windowKey) {
    const injected = options.actions ?? {};
    return {
      ...injected,
      pending: (window) => broker.listFor(window),
      decideApproval: (id, outcome) => broker.decide(id, outcome),
    };
  }

  /**
   * Offer an approval to the bridge, as the host's answerer would.
   *
   * The four-line wiring this module exists to make readable. `next` is called exactly when
   * the bridge declines or its deadline passes, and **never** when it answers — so the
   * host's own answerers are reached in every case where this bridge has nothing to say.
   */
  async function offerApproval({ request, windowKey, timeoutMs, next }) {
    const offered = broker.offer({ request, windowKey, timeoutMs, delegate: next });
    if (!offered.claim) return { claimed: false, reason: offered.reason };
    return { claimed: true, id: offered.id, outcome: await offered.promise };
  }

  /** Send one project file to every window bound to a session. */
  async function sendFile({ relPath, windows, caption = '' }) {
    if (!reader) return { ok: false, reason: 'no_project_root' };
    const file = await reader.read(relPath);
    if (!file.ok) return { ok: false, reason: file.reason, detail: file.detail };

    const outcome = await fanOutFile({
      file,
      caption,
      targets: windows.map((w) => {
        const channel = channelFor(w);
        if (!channel || !channel.capabilities?.[CHANNEL_FEATURE.FILES]) {
          return { window: w, deliver: async () => ({ ok: false, reason: 'channel_cannot_send_files' }) };
        }
        const sender = createFileSender({ send: async (f, c) => channel.send({ window: w, text: c, file: f }), audit });
        return { window: w, deliver: sender.deliver };
      }),
    });
    // The count the caller reports must come from here, not from `windows.length`.
    return { ok: outcome.allSent, ...outcome, name: file.name, bytes: file.bytes };
  }

  async function start() {
    for (const channel of channels) {
      try {
        await channel.start((message) => handleInbound(message));
        started.push(channel);
        audit('channel/started', { channel: channel.name });
      } catch (error) {
        // One channel failing to start must not take the others down — 0.1.0 got this right
        // and it is kept. What it got wrong was staying silent about it: the state is
        // recorded, and `status()` reports it rather than leaving `online: false` to mean
        // four different things.
        channel.setState?.(CHANNEL_STATE.UNCONFIGURED);
        audit('channel/start-failed', { channel: channel.name, detail: String(error) });
      }
    }
    return { started: started.length, total: channels.length };
  }

  async function stop() {
    for (const queue of queues.values()) await queue.dispose();
    queues.clear();
    for (const channel of [...started].reverse()) {
      try {
        await channel.stop();
      } catch {
        /* a channel that cannot stop cleanly is not worth failing a shutdown over */
      }
    }
    broker.dispose();
    started.length = 0;
  }

  /** What is running, told apart rather than collapsed into a boolean. */
  function status() {
    return {
      channels: channels.map((c) => ({ name: c.name, state: c.state ?? 'unknown' })),
      pendingApprovals: broker.size,
      owners: policy.ownerCount,
      admitted: policy.hasOwners(),
    };
  }

  return {
    start,
    stop,
    handleInbound,
    offerApproval,
    sendFile,
    status,
    // Exposed for the integration suite and for wiring the host's own surfaces.
    policy,
    broker,
    commands,
    channelFor,
  };
}
