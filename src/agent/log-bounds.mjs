/**
 * Bounding unbounded writers: find what is growing, classify what may be removed, and never touch what cannot.
 *
 * ## The incidents this comes from, because the thresholds are not guesses
 *
 * 1. **2026-10-14, the Linux relay host.** Root filesystem reached 100% because a process wrote 14.7 GB/day
 *    with no cap. The recovery was `truncate`, **not** `rm` — rsyslog still held the file descriptor open, so
 *    removing the file freed nothing while appearing to succeed. That single fact is why this module
 *    distinguishes "remove" from "truncate" instead of offering one delete operation.
 * 2. **2026-10-11 → 10-12, MacMini.** `relay-test` and node logs grew by a factor of 40. A factor is the
 *    important part: the harm is not a file being large, it is a file being large *and still accelerating*,
 *    and a size threshold alone cannot see the difference.
 *
 * So there are two independent findings, and they need different responses:
 *
 *   * `absolute` — this file is already too big. Act now.
 *   * `rate` — this file grew this much between two samples. Act *before* it becomes the first kind.
 *
 * ## Why this module proposes rather than performs
 *
 * The same reason `src/agent/health.mjs` does. A component that decides a file is disposable *and* deletes it
 * is one bug away from deleting `memory.jsonl`, which is the only durable copy of what a command printed —
 * the relay keeps hashes and never the text. Every removal here is returned as a **proposal with a method**
 * (`truncate` or `remove`) and a reason, and the one function that does act refuses anything not marked
 * removable.
 *
 * ## What "removable" means here
 *
 * Only files that are **this machine's own disposable output**: logs, test artefacts, build output, temp
 * files. Never a repository, never a data directory, never a credential, never something a running process
 * is writing. The protected list is checked by resolved path prefix, so a temp directory under a protected
 * root is still protected.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Bytes in a gigabyte, because every threshold below is about disk. */
const GB = 1024 ** 3;

/** A single file this large is worth acting on by itself. */
export const FILE_WARN_BYTES = 256 * 1024 * 1024;

/** A single file this large is the incident, not a warning about it. */
export const FILE_CRITICAL_BYTES = 1 * GB;

/**
 * Growth per day that counts as unbounded.
 *
 * 1 GB/day is a tenth of the measured 14.7 GB/day that filled the relay host, so it is deliberately an early
 * warning rather than a late one: at this rate a machine has roughly ten days, which is enough time to act
 * without being urgent about it.
 */
export const RATE_WARN_BYTES_PER_DAY = 1 * GB;

/** A whole directory this large is reported even when no single file in it is remarkable. */
export const DIR_WARN_BYTES = 2 * GB;

/**
 * Paths whose contents may never be proposed for removal.
 *
 * This is a **prefix list checked against resolved paths**, not a set of names, because a name-based check is
 * defeated by putting the same file in another directory. The entries are the things whose loss is not
 * recoverable from anywhere else in this system:
 *
 *   * `.git` — the history. Removing it removes the only record of what was verified.
 *   * `memory.jsonl` lives under a profile directory; those directories are protected wholesale.
 *   * `node_modules` and `dist` are **not** here on purpose: they are rebuildable, which is exactly what
 *     makes them legitimate cleanup targets. They are separately flagged as `rebuildable` rather than
 *     `disposable`, so a caller can prefer them over anything unique.
 */
export const PROTECTED_PREFIXES = Object.freeze([
  '.git',
  'profiles',
  'lib',
  'src',
  'bin',
  'deploy',
]);

/** Names that are never a cleanup target wherever they appear. */
export const PROTECTED_NAMES = Object.freeze([
  'memory.jsonl',
  'memory.jsonl.1',
  'device.json',
  'device.key',
  'fleet-memory.md',
  'ledger.jsonl',
  'manifest.json',
  '.env',
  'id_rsa',
  'id_ed25519',
]);

/**
 * Whether a path is protected.
 *
 * @param {string} pathname
 * @param {string} root the directory the path is interpreted against
 * @returns {{protected: boolean, reason: string|null}}
 */
export function isProtected(pathname, root) {
  const base = String(pathname).split(/[/\\]/).pop() ?? '';
  if (PROTECTED_NAMES.includes(base)) return { protected: true, reason: `"${base}" is irreplaceable and is never a cleanup target` };
  const rel = resolve(root, pathname).slice(resolve(root).length).replace(/^[/\\]+/, '');
  const first = rel.split(/[/\\]/)[0];
  if (PROTECTED_PREFIXES.includes(first)) return { protected: true, reason: `"${first}/" is part of the tree or the data directory` };
  return { protected: false, reason: null };
}

/**
 * How a file should be dealt with, which is not always "delete it".
 *
 * `truncate` exists because of the 2026-10-14 recovery: removing a file a daemon still holds open frees
 * nothing, and the operation appears to succeed. For any log a process writes, truncation is the correct
 * method and removal is the wrong one.
 */
export const METHOD = Object.freeze({
  TRUNCATE: 'truncate',
  REMOVE: 'remove',
  ROTATE: 'rotate',
  REPORT_ONLY: 'report_only',
});

/** Normalise a path for matching: one separator, no trailing separator. */
const normalise = (pathname) => String(pathname).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** True when `segment` appears as a whole path segment, so `/x/dist` and `/x/dist/a` both match `dist`. */
function hasSegment(pathname, segment) {
  return normalise(pathname).split('/').includes(segment);
}

/**
 * Which method suits a path.
 *
 * A `*.log` (or `relay-test`, or a path under a `log` directory) is being written by something, so it is
 * truncated or rotated. A build artefact is not being written, so it is removed outright.
 *
 * Matching is on **whole path segments** rather than on substrings. The first version looked for `/dist/` and
 * `\dist\`, which failed for the directory itself — `/x/dist` has no trailing separator — so the single most
 * obvious cleanup target of all was classified `report_only`. Two tests caught it, one of them written for a
 * different purpose.
 */
export function methodFor(pathname) {
  const p = normalise(pathname);
  if (p.endsWith('.log') || p.endsWith('.err') || p.includes('relay-test') || hasSegment(p, 'log') || hasSegment(p, 'logs')) {
    return METHOD.TRUNCATE;
  }
  if (hasSegment(p, 'node_modules') || hasSegment(p, 'dist') || hasSegment(p, 'target') || hasSegment(p, 'build')) {
    return METHOD.REMOVE;
  }
  if (p.endsWith('.tmp') || hasSegment(p, 'tmp') || hasSegment(p, 'temp')) return METHOD.REMOVE;
  return METHOD.REPORT_ONLY;
}

/** Classify a cleanup target so a caller can prefer rebuildable things over anything unique. */
export function classFor(pathname) {
  const p = normalise(pathname);
  if (hasSegment(p, 'node_modules') || hasSegment(p, 'dist') || hasSegment(p, 'target') || hasSegment(p, 'build')) return 'rebuildable';
  if (p.endsWith('.log') || hasSegment(p, 'log') || hasSegment(p, 'logs') || p.includes('relay-test') || p.endsWith('.tmp')) return 'disposable';
  return 'unknown';
}

/**
 * Sample the size of every file under a path, recursively.
 *
 * Bounded by `maxFiles` on purpose. The first version of the health check walked a user's home directory and
 * made a health check that **timed out** — a monitoring tool too expensive to monitor. The same limit applies
 * here for the same reason, and `truncated: true` says so rather than reporting a partial scan as complete.
 *
 * @returns {Map<string, number>} absolute path -> bytes
 */
export function snapshot(root, { maxFiles = 20000 } = {}) {
  const sizes = new Map();
  if (!existsSync(root)) return sizes;
  const stack = [resolve(root)];
  let seen = 0;
  while (stack.length > 0 && seen < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (seen >= maxFiles) break;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        seen += 1;
        try { sizes.set(full, statSync(full).size); } catch { sizes.set(full, -1); }
      }
    }
  }
  return sizes;
}

/**
 * Compare two snapshots and report what grew.
 *
 * `elapsedMs` comes from the caller as the difference between the two sample times, not from file
 * modification times: `mtime` is rewritten by a rotation, a copy, or a `touch`, and a rate computed from it
 * would be a rate of the last *touch* rather than of the writing.
 *
 * @param {Map<string, number>} before
 * @param {Map<string, number>} after
 * @param {number} elapsedMs
 */
export function growth(before, after, elapsedMs, { warnBytesPerDay = RATE_WARN_BYTES_PER_DAY } = {}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return { findings: [], elapsed_ms: elapsedMs, unreadable: true };
  const perDay = (bytes) => Math.round((bytes / elapsedMs) * 86_400_000);
  const findings = [];
  for (const [path, size] of after) {
    const previous = before.get(path) ?? 0;
    const delta = size - previous;
    if (delta <= 0) continue;
    const rate = perDay(delta);
    if (rate < warnBytesPerDay) continue;
    findings.push({
      path,
      grew_bytes: delta,
      from_bytes: previous,
      to_bytes: size,
      bytes_per_day: rate,
      // A file that did not exist before is a new writer, which is a different diagnosis from one that was
      // always there and has started accelerating.
      new_file: previous === 0,
    });
  }
  findings.sort((a, b) => b.bytes_per_day - a.bytes_per_day);
  return { findings, elapsed_ms: elapsedMs, unreadable: false };
}

/**
 * Turn findings and sizes into proposals.
 *
 * Returns `{ proposals, protected, notes }`. A protected path that was found is listed under `protected`
 * **with its reason**, rather than dropped: a report that silently omits the database is one a reader cannot
 * tell from a report where the database was not found.
 */
export function plan({ root, sizes = new Map(), grown = [], fileWarn = FILE_WARN_BYTES, fileCritical = FILE_CRITICAL_BYTES } = {}) {
  const proposals = [];
  const protected_ = [];

  const consider = (pathname, reason, severity, bytes) => {
    const guard = isProtected(pathname, root ?? process.cwd());
    if (guard.protected) {
      protected_.push({ path: pathname, bytes, reason: guard.reason, triggered_by: reason });
      return;
    }
    proposals.push({
      path: pathname,
      bytes,
      severity,
      triggered_by: reason,
      method: methodFor(pathname),
      class: classFor(pathname),
    });
  };

  for (const [path, size] of sizes) {
    if (size < 0) continue;
    if (size >= fileCritical) consider(path, 'absolute', 'critical', size);
    else if (size >= fileWarn) consider(path, 'absolute', 'warn', size);
  }
  for (const g of grown) {
    consider(g.path, 'rate', g.bytes_per_day >= 10 * GB ? 'critical' : 'warn', g.to_bytes);
  }

  // Critical first, then by size: a caller working through the list top-down should reach the incident
  // before the tidying.
  proposals.sort((a, b) => (a.severity === b.severity ? b.bytes - a.bytes : a.severity === 'critical' ? -1 : 1));
  return { proposals, protected: protected_, notes: [] };
}

/**
 * A `logrotate` configuration for the files that need one.
 *
 * `copytruncate` is the important directive and it is not a default: without it, rotation renames the file
 * and the daemon keeps writing to the old descriptor, so the new file stays empty **and the disk stays
 * full** — the exact failure of 2026-10-14 in a different costume. `copytruncate` copies then truncates in
 * place, which works for a process nobody is going to signal.
 *
 * `maxsize` is set as well as `daily`, because a file that grows 40x in a day reaches its limit long before
 * the daily job looks at it.
 */
export function logrotateConfig(paths, options = {}) {
  const maxsize = options.maxsize ?? '256M';
  const rotate = options.rotate ?? 5;
  const frequency = options.frequency ?? 'daily';
  const header = [
    '# Generated by scripts/log-bounds.mjs --bounds.',
    '# copytruncate, not create: a daemon holding the old descriptor keeps the disk full otherwise.',
    '# maxsize as well as the schedule: a file growing 40x a day hits its cap before the timer notices.',
    '',
  ].join('\n');
  const body = paths.map((p) => [
    `${p} {`,
    `  ${frequency}`,
    `  maxsize ${maxsize}`,
    '  rotate ' + rotate,
    '  compress',
    '  delaycompress',
    '  missingok',
    '  notifempty',
    '  copytruncate',
    '}',
    '',
  ].join('\n')).join('\n');
  return header + body;
}

/**
 * Delete or truncate a single path, refusing anything protected.
 *
 * The only acting function here, and it re-checks the guard rather than trusting the caller's plan: a plan is
 * data that may have been filtered, sorted, serialised or hand-edited between being made and being applied.
 *
 * @returns {{ok: boolean, method: string, detail: string}}
 */
export function apply(pathname, root, { truncate } = {}) {
  const guard = isProtected(pathname, root);
  if (guard.protected) return { ok: false, method: METHOD.REPORT_ONLY, detail: `refused: ${guard.reason}` };
  const method = methodFor(pathname);
  if (method === METHOD.REPORT_ONLY) {
    return { ok: false, method, detail: 'not a log, a build artefact or a temp file; reported rather than acted on' };
  }
  if (typeof truncate !== 'function') return { ok: false, method, detail: 'no truncate function supplied; refusing to act without one' };
  try {
    return { ok: true, method, detail: truncate(pathname, method) };
  } catch (e) {
    return { ok: false, method, detail: `failed: ${e.message}` };
  }
}
