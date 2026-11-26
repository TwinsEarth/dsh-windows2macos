/**
 * Remote-view quality tiers: which widths a frame may be downscaled to, and how many bytes the
 * channel tolerates.
 *
 * The rule the tiers encode is the product's, not the transport's: a picture is looked at, not
 * watched. So there is no video codec anywhere, one JPEG per second is the frame, and the only
 * question a tier answers is "how big may that JPEG be on this path".
 *
 * - `relay` carries 360P..540P only, capped at 100 KiB **including the AES-GCM envelope**, because
 *   the relay is a blind forwarder that bills every byte and cannot afford a 4K still.
 * - `p2p` may carry 720P / 2K / 4K, because a DataChannel is the fleet's own wire; the cap there
 *   exists only to keep a 4K JPEG from starving the same transport that Teams and tasks use.
 *
 * Widths are the long edge; height follows the screen's aspect ratio inside `capture.mjs`.
 */

/**
 * The bytes AES-256-GCM adds to a sealed frame: a 12-byte IV plus a 16-byte auth tag.
 *
 * The relay's cap is stated on the ciphertext — that is what it stores and forwards — so the
 * capture budget is `tier.maxBytes - VIEW_ENVELOPE_BYTES`, never `tier.maxBytes` itself.
 */
export const VIEW_ENVELOPE_BYTES = 12 + 16;

export const VIEW_TIER = Object.freeze({
  RELAY: 'relay',
  P2P: 'p2p',
});

/** @type {Record<string, {channel: string, widths: number[], qualities: number[], maxBytes: number}>} */
export const VIEW_TIERS = Object.freeze({
  relay: Object.freeze({
    channel: VIEW_TIER.RELAY,
    // 960x540 and 640x360 at the common 16:9; a 4:3 screen keeps the long edge and grows shorter.
    widths: Object.freeze([960, 640]),
    // Tried widest first: the first frame that fits the byte cap wins, so a quiet desktop still
    // lands on 540P while a busy one falls to 360P instead of failing.
    qualities: Object.freeze([60, 40]),
    maxBytes: 100 * 1024,
  }),
  p2p: Object.freeze({
    channel: VIEW_TIER.P2P,
    // 4K -> 2K -> 720P. Only reached on a DataChannel; the relay never sees these widths.
    widths: Object.freeze([3840, 2560, 1280]),
    qualities: Object.freeze([70, 65, 55]),
    maxBytes: 2 * 1024 * 1024,
  }),
});

/**
 * Map the transport the viewer actually got to the tier the target must render.
 *
 * @param {string|null|undefined} channel `webrtc`, `p2p`, `relay` or null.
 * @returns {'relay'|'p2p'}
 */
export function tierForChannel(channel) {
  return channel === 'webrtc' || channel === 'p2p' ? VIEW_TIER.P2P : VIEW_TIER.RELAY;
}

/**
 * A named tier, defaulting to `relay`: an unknown or missing name must never widen the budget a
 * relay path was given.
 *
 * @param {string|null|undefined} name
 */
export function tierPreset(name) {
  return name === VIEW_TIER.P2P ? VIEW_TIERS.p2p : VIEW_TIERS.relay;
}

/**
 * The cap a channel tolerates, for the checks that only need the number.
 *
 * @param {string|null|undefined} channel
 */
export function maxBytesForChannel(channel) {
  return tierPreset(tierForChannel(channel)).maxBytes;
}
