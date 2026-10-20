/**
 * Output redaction: secrets a command prints are replaced before they leave this machine.
 *
 * ## Why a replacement, not a deletion
 *
 * Deleting the line would keep the secret out of the envelope and also destroy the evidence: line numbers and structure are
 * what make a failure reproducible. So each match becomes [redacted:class] in place.
 *
 * ## Why nothing here touches a hash
 *
 * stdout_sha256 and stdout_bytes cover the RAW bytes and are computed by the executor. Redacting the text must not feed back
 * into them: the envelope's hashes stay evidence, and only the human-readable heads/tails are filtered. The same is true of
 * blobs -- a blob's name is the hash of its bytes, and rewriting them would make the name a lie.
 *
 * ## Why it can be turned off
 *
 * An operator debugging a credential problem needs the original. Turning it off is allowed and SAYS SO (unredacted: true in the
 * envelope), because a redaction that silently does nothing is worse than no redaction at all.
 */

/** Each rule: a class name and the pattern that finds it. Order matters only for the private-key block. */
const RULES = Object.freeze([
  { cls: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { cls: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { cls: 'api-key', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { cls: 'api-key', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { cls: 'api-key', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { cls: 'api-key', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { cls: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
]);

/**
 * @param {string} text
 * @returns {{text: string, replaced: Array<{cls: string, count: number}>}}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', replaced: [] };
  let out = text;
  const counts = new Map();
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.pattern, () => { hits += 1; return '[redacted:' + rule.cls + ']'; });
    if (hits > 0) counts.set(rule.cls, (counts.get(rule.cls) ?? 0) + hits);
  }
  return { text: out, replaced: [...counts.entries()].map(([cls, count]) => ({ cls, count })) };
}

/** The envelope fields that carry command output and are therefore filtered. */
export const REDACTABLE_FIELDS = Object.freeze(['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail']);

/**
 * @param {object} envelope
 * @param {{enabled?: boolean}} [options]
 * @returns {{envelope: object, redacted: Array<{field: string, cls: string, count: number}>}}
 */
export function redactEnvelope(envelope, { enabled = true } = {}) {
  if (envelope === null || typeof envelope !== 'object') return { envelope, redacted: [] };
  if (enabled !== true) return { envelope: { ...envelope, unredacted: true }, redacted: [] };
  const next = { ...envelope };
  const redacted = [];
  for (const field of REDACTABLE_FIELDS) {
    const value = next[field];
    if (typeof value !== 'string' || value === '') continue;
    const result = redactText(value);
    next[field] = result.text;
    for (const hit of result.replaced) redacted.push({ field, ...hit });
  }
  if (redacted.length > 0) next.redacted = redacted;
  return { envelope: next, redacted };
}
