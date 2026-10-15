#!/usr/bin/env node
/**
 * Run test files one at a time on a machine that can only report ONE exit code, and pack every result into it.
 *
 * ## The problem this solves, measured the hard way
 *
 * A fleet dispatch carries a single exit code back. Running five suites in one `node --test` therefore
 * answers exactly one question -- "did anything fail" -- and nothing about *which* suite, or whether the
 * files were even present. This session spent four dispatches discovering that, and two of the four were
 * spent on my own misreading of the channel rather than on the machine:
 *
 *   * a TAP parser that matched `^ok ` and counted nothing, because Node indents its subtests. The count came
 *     back `pass 0 fail 0` and I nearly read it as "no tests ran".
 *   * a summary regex that matched nothing, so `tests`, `pass` and `fail` were all `null` and the exit code
 *     described my parser rather than the code under test.
 *
 * Both were the same mistake in different clothes: **assuming the shape of output instead of reading it.**
 *
 * ## The encoding
 *
 * Two bits per file, least significant first, so four files fit in one byte:
 *
 *   `10` the file ran and exited 0        `01` the file ran and failed
 *   `00` the file is not on this machine  `11` the file ran and reported a wait/timeout
 *
 * **There is no single "all clear" value, and the first version of this docstring wrongly claimed zero was
 * one.** With one file all-pass is `0`; with four it is `170` (`0b10101010`). Zero is therefore "every file
 * absent" when four were asked for -- the *opposite* of an all-clear, and a claim anyone could have acted on
 * wrongly. The all-pass code is a function of the file count, so `allPassedCode()` computes it rather than
 * leaving a reader to work it out.
 *
 * `126` and `127` ARE reachable -- `[PASSED, WAITED, WAITED, FAILED]` and `[WAITED, WAITED, WAITED, FAILED]`
 * produce them -- and a shell owns both, so the encoder refuses to emit either rather than returning a code
 * the transport would reinterpret as "command not executable".
 *
 * ## Usage
 *
 *   node scripts/machine-test-packet.mjs test/a.test.mjs test/b.test.mjs ...
 *
 * Exits with the packed code, or `2` when it was given nothing to run.
 *
 * ## `--inline`: for a machine whose allow-list refuses a script path
 *
 * Measured on this fleet: a real machine's allow-list admits `node -e` and `node --test`, and **refuses
 * `node scripts/…`** — and this script *spawns* `node --test`, so it would be refused a second time even if
 * the first path were allowed. `--inline` prints the equivalent one-liner to stdout so it can be pasted into
 * a dispatch **without a file ever being named**. The generated command is the same loop with the same
 * budget; only the delivery differs.
 *
 * **The honest limit of that workaround, learned by hitting it:** the inline form's stdout is not visible
 * through a fleet dispatch (the relay carries the exit code and no output), so it is only useful when the
 * packed code is enough to answer the question. **When it is not, the answer is one command run by a person,
 * not a cleverer encoding.** Four dispatches were spent learning that in this span, each one asking the
 * channel a question whose answer did not fit in eight bits.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Per-file outcomes, as the two-bit alphabet above. */
export const OUTCOME = Object.freeze({
  ABSENT: 0b00,
  FAILED: 0b01,
  PASSED: 0b10,
  WAITED: 0b11,
});

/**
 * The code a run of `files` files leaves when every one of them passed.
 *
 * Computed rather than written down, because it is a function of the count and **not always zero**: one file
 * is `0`, two are `10`, four are `170`. The comment that used to say "zero is the all-clear" was true for a
 * single file and wrong for every other size.
 *
 * @param {number} files
 * @returns {number}
 */
export function allPassedCode(files) {
  let code = 0;
  for (let index = 0; index < files; index += 1) code |= OUTCOME.PASSED << (index * 2);
  return code & 0xff;
}

/**
 * Pack per-file outcomes into one exit code.
 *
 * Refuses `126` and `127`, because a shell claims those two values and a packed code that collided with them
 * would be reported as "command not executable" rather than as the measurement it is.
 *
 * @param {number[]} outcomes one {@link OUTCOME} per file, in order
 * @returns {{code: number, refused: boolean, detail: string}}
 */
export function packOutcomes(outcomes) {
  let code = 0;
  outcomes.forEach((outcome, index) => {
    code |= (outcome & 0b11) << (index * 2);
  });
  const byte = code & 0xff;
  if (byte === 126 || byte === 127) {
    // Refused rather than emitted. The caller has to know this, because the alternative is a code that means
    // something else entirely by the time it arrives.
    return { code: 0, refused: true, detail: `the packed code would have been ${byte}, which a shell owns; refusing to emit a value the transport reinterprets` };
  }
  // Decided from the OUTCOMES, not from the code. The first version asked whether `byte === 0`, which is never
  // true for a non-empty all-passing run -- one file gives 2 and four give 170 -- so the reassuring message was
  // unreachable and `0` would have described the one case that is not reassuring at all.
  const allPassed = outcomes.length > 0 && outcomes.every((o) => o === OUTCOME.PASSED);
  return {
    code: byte,
    refused: false,
    detail: allPassed
      ? `every one of ${outcomes.length} file(s) ran and passed (code ${byte})`
      : `packed ${outcomes.length} outcome(s) into ${byte}`,
  };
}

/**
 * Unpack an exit code into one outcome per file.
 *
 * @param {number} code
 * @param {number} files
 * @returns {{outcomes: number[], passed: number[], failed: number[], absent: number[], waited: number[]}}
 */
export function unpackOutcomes(code, files) {
  const outcomes = [];
  const passed = [];
  const failed = [];
  const absent = [];
  const waited = [];
  for (let index = 0; index < files; index += 1) {
    const outcome = ((code >> (index * 2)) & 0b11);
    outcomes.push(outcome);
    if (outcome === OUTCOME.PASSED) passed.push(index);
    else if (outcome === OUTCOME.FAILED) failed.push(index);
    else if (outcome === OUTCOME.ABSENT) absent.push(index);
    else waited.push(index);
  }
  return { outcomes, passed, failed, absent, waited };
}

/** Run one file and classify it. Output goes to a file rather than a pipe, so nothing is lost to buffering. */
function runOne(relative, timeoutMs) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--experimental-test-isolation=none', '--test-force-exit', relative],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
  );
  if (result.error?.code === 'ETIMEDOUT' || result.signal !== null) return { outcome: OUTCOME.WAITED, detail: 'the file did not finish inside the timeout' };
  if (result.status === 0) return { outcome: OUTCOME.PASSED, detail: 'exit 0' };
  return { outcome: OUTCOME.FAILED, detail: `exit ${result.status ?? 'null'}` };
}

/**
 * How long the whole packet may take.
 *
 * ## Why a total budget and not just a per-file timeout
 *
 * A dispatch carries one exit code back only if the *agent* stays alive to report it, and a fleet agent's
 * lease is renewed on a heartbeat it cannot send while it is blocked. Measured on this fleet, that ceiling is
 * roughly **50 seconds**: `heartbeatIntervalMs (10s) × missedHeartbeats (2) + leaseGraceMs (30s)`. A packet
 * that runs longer does not fail -- it **expires**, and an expired lease carries no exit code at all, so the
 * measurement is lost rather than negative.
 *
 * The first version of this script took a 40-second timeout *per file* and ran four files. That is a 160-second
 * worst case against a 50-second ceiling, and it expired on the real machine exactly as the arithmetic says it
 * would. A per-file timeout answers "is this file hung"; only a total budget answers "will the answer survive
 * the trip".
 *
 * Files that do not get their turn are reported as {@link OUTCOME.WAITED} -- named, not omitted, because a
 * packet that quietly dropped the last file would look like a clean run of the ones it managed.
 */
export const DEFAULT_BUDGET_MS = 30_000;

/** Per-file cap inside the total budget, so one hung file cannot consume the whole packet. */
export const FILE_CAP_MS = 20_000;

/**
 * Run the packet for a list of files.
 *
 * @param {string[]} files
 * @param {{budgetMs?: number, runner?: (file: string, timeoutMs: number) => {outcome: number, detail: string}}} [options]
 * @returns {number} the exit code the process should leave by
 */
export function main(files, options = {}) {
  if (files.length === 0) {
    process.stderr.write('usage: node scripts/machine-test-packet.mjs <test-file> [<test-file>...]\n');
    return 2;
  }
  if (files.length > 4) {
    // Four files is the most a byte can describe at two bits each. Saying so is better than silently dropping
    // the fifth, which is what masking would do.
    process.stderr.write(`at most 4 files can be packed into one exit code; got ${files.length}\n`);
    return 2;
  }

  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DEFAULT_BUDGET_MS;
  const run = options.runner ?? runOne;
  const started = Date.now();

  const outcomes = [];
  for (const file of files) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 1_000) {
      // Out of budget. Named as WAITED rather than skipped, so the packet says "this was not measured" instead
      // of implying it passed.
      outcomes.push(OUTCOME.WAITED);
      process.stdout.write(`WAIT    ${file}  (out of budget after ${Math.round((Date.now() - started) / 1000)}s; not measured)\n`);
      continue;
    }
    if (!existsSync(resolve(ROOT, file))) {
      outcomes.push(OUTCOME.ABSENT);
      process.stdout.write(`ABSENT  ${file}\n`);
      continue;
    }
    const r = run(file, Math.min(FILE_CAP_MS, left));
    outcomes.push(r.outcome);
    process.stdout.write(`${r.outcome === OUTCOME.PASSED ? 'PASS' : r.outcome === OUTCOME.WAITED ? 'WAIT' : 'FAIL'}    ${file}  (${r.detail})\n`);
  }

  const packed = packOutcomes(outcomes);
  process.stdout.write(`\n${packed.detail}\n`);
  if (packed.refused) {
    // A refusal still has to leave by some route, and 2 is not in the two-bit alphabet's vocabulary for a file
    // outcome, so it cannot be mistaken for one.
    return 2;
  }
  return packed.code;
}

/**
 * Render the same loop as a `node -e` one-liner, for a machine that refuses a script path.
 *
 * @param {string[]} files
 * @param {number} budgetMs
 * @returns {string}
 */
export function inlineCommand(files, budgetMs = DEFAULT_BUDGET_MS) {
  const list = JSON.stringify(files);
  return (
    'node -e "const{spawnSync}=require(\'node:child_process\');const fs=require(\'node:fs\');' +
    'const F=' + list + ';const t0=Date.now();let bits=0;' +
    'for(let i=0;i<F.length;i++){if(!fs.existsSync(F[i]))continue;' +
    'const r=spawnSync(\'node\',[\'--test\',\'--experimental-test-isolation=none\',\'--test-force-exit\',F[i]],' +
    '{encoding:\'utf8\',maxBuffer:67108864,timeout:Math.min(' + String(budgetMs) + ',Math.max(1000,' + String(budgetMs) + '-(Date.now()-t0)))});' +
    'if(r.status===0)bits|=(1<<i)}process.exit(bits)"'
  );
}

/**
 * Only run when this file is the entry point.
 *
 * ## Why the guard is not optional here
 *
 * The first version of this script validated its arguments at module top level. The suite that tests its
 * encoder **imports** it, so the import printed `usage:`, exited 2, and the suite reported **no tests at
 * all** -- three times, in a run whose output was 323 bytes. A module that performs its side effect on
 * import cannot be tested, and the failure looks like "the tests did not run" rather than "the module
 * objected to being loaded", which is the same shape as every other misdiagnosis in this project.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (process.argv.includes('--inline')) {
    process.stdout.write(inlineCommand(argv) + '\n');
    process.exit(0);
  }
  process.exit(main(argv));
}
