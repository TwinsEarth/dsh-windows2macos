/**
 * Reading `node --test`'s summary, without assuming its shape.
 *
 * ## Why this module exists, told plainly because it cost three rounds
 *
 * Several rounds of this project were spent believing a suite *failed on macOS*. It had not. The parser was
 * looking for lines beginning `# tests 17`, and node v24 writes them beginning `ℹ tests 17`:
 *
 *     ℹ tests 17      not      # tests 17
 *     ℹ pass 17                # pass 17
 *     ℹ fail 0                 # fail 0
 *
 * **The `#` form was an assumption that was never checked.** It produced "UNREADABLE" for suites that had
 * passed, and — worse — it produced a *wrong diagnosis*: because no `# fail` line could ever be found, and
 * because no test *names* appeared either, the absence of both was read as "the process crashed before
 * printing anything", which pointed at module scope and sent the investigation somewhere the fault was not.
 * The actual fault was a regex.
 *
 * So the contract is written down here, parsed defensively, and tested against both forms. The one thing
 * this module must never do is answer "unreadable" when the answer was merely "in a shape I did not expect".
 *
 * ## The two streams
 *
 * `node --test` writes its report to **stdout** on every version measured so far, and writes *diagnostics*
 * to stderr. But "on every version measured so far" is exactly the kind of claim that ages badly, so the
 * parser reads **both** streams and says which one it used. A caller that cannot tell which stream answered
 * is a caller that will misread the next version change the same way.
 */

/** Summary labels, as node has spelled them. Both are accepted; neither is assumed. */
export const LABELS = Object.freeze(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo', 'duration_ms']);

/** The prefixes node has used for summary lines. `ℹ` is what v24 writes; `#` is what earlier TAP-shaped output used. */
export const PREFIXES = Object.freeze(['\u2139', '#']);

/**
 * Strip a summary prefix and return `{label, value}`, or `null`.
 *
 * Tolerant on purpose: leading whitespace is allowed (node indents nested summaries), and the prefix may be
 * followed by a space or not. A strict pattern here is what caused the original fault, and a strict pattern
 * is not made safer by being strict in a different way.
 */
export function parseSummaryLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  let body = null;
  for (const prefix of PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      body = trimmed.slice(prefix.length).trim();
      break;
    }
  }
  // A bare `tests 17` with no prefix is also accepted, because "no prefix" is a shape node has not used yet
  // and refusing it would be the same mistake in a new costume.
  if (body === null) body = trimmed;
  const match = /^([a-z_]+)\s+(\d+(?:\.\d+)?)$/.exec(body);
  if (match === null) return null;
  const label = match[1];
  if (!LABELS.includes(label)) return null;
  return { label, value: Number(match[2]) };
}

/**
 * Parse a full report.
 *
 * @param {string|{stdout?: string, stderr?: string}} input text, or the two streams separately
 * @returns {{
 *   ok: boolean, source: 'stdout'|'stderr'|'both'|'none', format: 'info'|'hash'|'bare'|'unknown',
 *   tests: number|null, pass: number|null, fail: number|null, skipped: number|null,
 *   detail: string
 * }}
 */
export function parseTestReport(input) {
  const stdout = typeof input === 'string' ? input : String(input?.stdout ?? '');
  const stderr = typeof input === 'string' ? '' : String(input?.stderr ?? '');

  const scan = (text) => {
    const found = new Map();
    let format = 'unknown';
    for (const line of text.split('\n')) {
      const parsed = parseSummaryLine(line);
      if (parsed === null) continue;
      // Record the shape that actually matched, so a future format change is reported rather than silently
      // tolerated.
      if (format === 'unknown') {
        const trimmed = line.trim();
        if (trimmed.startsWith('\u2139')) format = 'info';
        else if (trimmed.startsWith('#')) format = 'hash';
        else format = 'bare';
      }
      found.set(parsed.label, parsed.value);
    }
    return { found, format };
  };

  const out = scan(stdout);
  const err = scan(stderr);
  const fromStdout = out.found.size > 0;
  const fromStderr = err.found.size > 0;
  const source = fromStdout && fromStderr ? 'both' : fromStdout ? 'stdout' : fromStderr ? 'stderr' : 'none';
  // stdout wins when both carry a summary, because that is where node has always put the report.
  const chosen = fromStdout ? out : err;
  const format = fromStdout ? out.format : fromStderr ? err.format : 'unknown';

  if (!fromStdout && !fromStderr) {
    return {
      ok: false, source: 'none', format: 'unknown',
      tests: null, pass: null, fail: null, skipped: null,
      detail: 'no summary line found in either stream -- this is NOT the same as a failing suite, and the caller must not treat it as one',
    };
  }

  const get = (label) => (chosen.found.has(label) ? chosen.found.get(label) : null);
  const tests = get('tests');
  const fail = get('fail');
  return {
    ok: true,
    source,
    format,
    tests,
    pass: get('pass'),
    fail,
    skipped: get('skipped'),
    detail: tests === null
      ? `read from ${source} (${format}) but no test count was present`
      : `${tests} test(s), ${fail ?? '?'} failed, read from ${source} (${format})`,
  };
}

/**
 * Whether a report says the suite passed.
 *
 * **Three-valued on purpose.** `true`, `false`, and `null` for "the report could not be read" — because
 * collapsing `null` into either boolean is exactly how an unread report becomes a pass or a phantom failure.
 * The original bug turned unreadable reports into "failed", which is the safer of the two directions to be
 * wrong in and was still wrong enough to waste rounds.
 */
export function verdict(report) {
  if (report === null || report === undefined || report.ok !== true) return null;
  if (report.fail === null) return null;
  return report.fail === 0;
}
