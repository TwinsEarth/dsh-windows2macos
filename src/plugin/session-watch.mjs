/**
 * Reading the user's own messages out of DSH's session transcript, without touching it.
 *
 * ## What this is for
 *
 * The operator wants the fleet chat panel to show what each machine's owner typed into DSH **in that session**, and to
 * leave the session itself alone: no injection, no rewriting, no added rows. So this module only READS.
 *
 * ## The transcript is a concatenation of zstd frames
 *
 * DSH appends to \`session.v4.jsonl.zstd\` as it goes, which means one file holds many zstd frames. Node's
 * \`zstdDecompressSync\` stops at the end of the first frame -- measured: a 37 KB file that plainly holds a session
 * decodes to 187 bytes -- so the file is split on the zstd magic number and each frame is decoded on its own.
 *
 * ## What is extracted, and what is deliberately not
 *
 * Only messages with role \`user\`: that is what the operator asked to broadcast ("只同步用户发给 DSH 的话"). Assistant
 * replies, tool calls and tool results are not read out -- they are the widest part of a session and the operator did not
 * ask for them.
 */
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

/** The zstd frame magic number, little-endian bytes 28 B5 2F FD. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * @param {Buffer} buffer the concatenated frames
 * @returns {Buffer[]} one slice per frame, in file order
 */
export function splitZstdFrames(buffer) {
  const starts = [];
  let at = buffer.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) { starts.push(at); at = buffer.indexOf(ZSTD_MAGIC, at + 1); }
  if (starts.length === 0) return [];
  return starts.map((start, i) => buffer.subarray(start, i + 1 < starts.length ? starts[i + 1] : buffer.length));
}

/**
 * Decode every frame and parse the JSONL events they contain.
 *
 * A frame that fails to decode is skipped rather than aborting the read: the newest frame can be half-written while the
 * session is live, and one truncated tail must not hide the whole history.
 *
 * @param {Buffer} buffer
 * @returns {object[]} parsed events, oldest first
 */
export function decodeTranscript(buffer) {
  const events = [];
  for (const frame of splitZstdFrames(buffer)) {
    let text;
    try { text = zstdDecompressSync(frame).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try { events.push(JSON.parse(line)); } catch { /* a partial trailing line is expected in a live file */ }
    }
  }
  return events;
}

/** The text of one user message, or null when the event is not one. */
function userTextOf(event) {
  if (event === null || typeof event !== 'object') return null;
  const role = event.role ?? event.type ?? null;
  if (role !== 'user' && role !== 'prompt') return null;
  const payload = event.content ?? event.text ?? event.message ?? null;
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    const text = payload.filter((p) => p && (p.type === 'text' || typeof p.text === 'string')).map((p) => p.text ?? '').join('');
    return text === '' ? null : text;
  }
  if (payload !== null && typeof payload === 'object' && typeof payload.text === 'string') return payload.text;
  return null;
}

/**
 * Only the user's own messages: that is the operator's scope, and it is the narrowest thing that answers the request.
 *
 * @param {object[]} events
 * @returns {{at_ms: number|null, text: string}[]}
 */
export function extractUserMessages(events) {
  const out = [];
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const text = userTextOf(event);
    if (text === null || text.trim() === '') continue;
    const at = Number.isFinite(event.createdAt) ? event.createdAt : (Number.isFinite(event.at_ms) ? event.at_ms : null);
    out.push({ at_ms: at, text });
  }
  return out;
}

/**
 * Which conversation a machine's session belongs to.
 *
 * The operator's rule: **account + project directory name**, so two machines with the same project name are the same
 * conversation and nothing has to be configured. The full path is deliberately not used -- \`E:\\GPT\` and
 * \`/Users/fang/GPT\` are the same project, and keying on the path would split them.
 *
 * @param {string} accountFingerprint
 * @param {string} cwd absolute working directory of the session
 * @returns {string} 64 hex characters
 */
export function conversationKey(accountFingerprint, cwd) {
  if (typeof accountFingerprint !== 'string' || accountFingerprint === '') throw new TypeError('accountFingerprint is required');
  if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd is required');
  const normalised = cwd.replace(/[\\/]+$/, '');
  const parts = normalised.split(/[\\/]/).filter(Boolean);
  const project = (parts.length > 0 ? parts[parts.length - 1] : normalised).toLowerCase();
  return createHash('sha256').update('w2m-conversation-v1').update('\u0000').update(accountFingerprint).update('\u0000').update(project).digest('hex');
}

/**
 * The directory name DSH uses for a cwd, so the right transcript can be found without guessing.
 *
 * Measured on this machine: \`E:\\GPT\` is stored as \`--E-GPT--\`. The rule below reproduces it: drop the drive colon,
 * turn separators into \`-\`, wrap in \`--\`.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function sessionDirName(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd is required');
  const body = cwd.replace(/[\\/]+/g, '-').split('').filter((ch) => ch !== ':').join('');
  return '--' + body.replace(/^-+|-+$/g, '') + '--';
}
