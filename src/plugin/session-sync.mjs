/**
 * The decision layer for mirroring a machine's own prompts into the fleet panel.
 *
 * Reading the transcript and posting to the relay are someone else's job; what belongs here is the two things that are
 * easy to get wrong and impossible to see in a smoke test:
 *
 * 1. **Only the new messages.** The transcript grows while the session runs, and a naive reader republishes the whole
 *    history on every tick. This keeps a high-water mark and returns only what appeared after it.
 *
 * 2. **Never echo our own broadcasts back.** Every machine reads its own transcript, so the panel would show each local
 *    message once as "from session" and again as "remote" without a rule saying which arrivals are ours.
 *
 * The messages carry \`origin: 'session'\` so the panel can colour them differently from messages typed into the fleet chat
 * box, and \`conversation_key\` so only machines in the same project conversation show them.
 */

/**
 * @param {{conversationKey: string, machineId: string, machineName: string|null}} identity
 */
export function createSessionSync(identity) {
  if (typeof identity?.conversationKey !== 'string' || identity.conversationKey === '') {
    throw new TypeError('conversationKey is required');
  }
  if (typeof identity?.machineId !== 'string' || identity.machineId === '') {
    throw new TypeError('machineId is required');
  }

  /** How far into the message list we have already published. */
  let highWater = 0;
  /** Fingerprints of what we published, so a transcript that is re-read from the start cannot duplicate. */
  const published = new Set();

  const fingerprint = (message) => (message.at_ms === null ? 't:' : 'a:' + message.at_ms) + '|' + message.text;

  /**
   * Take the messages read from the transcript and return the ones that still have to be broadcast.
   *
   * @param {{at_ms: number|null, text: string}[]} messages oldest first, as the reader returned them
   * @returns {{conversation_key: string, machine_id: string, machine_name: string|null, origin: 'session',
   *            at_ms: number|null, text: string}[]}
   */
  function pending(messages) {
    if (!Array.isArray(messages)) return [];
    const fresh = messages.slice(highWater);
    highWater = messages.length;
    const out = [];
    for (const message of fresh) {
      if (message === null || typeof message.text !== 'string' || message.text.trim() === '') continue;
      const key = fingerprint(message);
      if (published.has(key)) continue;
      published.add(key);
      out.push({
        conversation_key: identity.conversationKey,
        machine_id: identity.machineId,
        machine_name: identity.machineName ?? null,
        origin: 'session',
        at_ms: message.at_ms ?? null,
        text: message.text,
      });
    }
    return out;
  }

  return { pending, highWater: () => highWater };
}

/**
 * Whether an arriving fleet message should be shown as "remote".
 *
 * A message this machine published comes back over the relay; showing it as remote would duplicate every local prompt in
 * the panel, which is the failure this rule exists for.
 *
 * @param {{machine_id?: string, origin?: string}} message
 * @param {string} machineId this machine
 * @returns {boolean}
 */
export function isRemoteBroadcast(message, machineId) {
  if (message === null || typeof message !== 'object') return false;
  if (typeof message.machine_id !== 'string') return false;
  return message.machine_id !== machineId;
}

/**
 * The colour class the panel uses: 'session' (this machine's prompt), 'chat' (typed into the fleet box here) or 'remote'.
 *
 * @param {{machine_id?: string, origin?: string}} message
 * @param {string} machineId
 * @returns {'session'|'chat'|'remote'}
 */
export function displayKind(message, machineId) {
  if (isRemoteBroadcast(message, machineId)) return 'remote';
  return message?.origin === 'session' ? 'session' : 'chat';
}

/** A stable index into the palette for one machine, so a machine keeps its colour across sessions and restarts. */
export function avatarColorIndex(machineId, paletteSize) {
  const size = Number.isInteger(paletteSize) && paletteSize > 0 ? paletteSize : 8;
  const s = String(machineId ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % size;
}
