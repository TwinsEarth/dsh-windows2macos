/**
 * Localside agent test suite (task-8).
 *
 * Everything runs against real processes, a real git repository and a real
 * HTTP server: the failure modes this file exists to catch (argv smuggling,
 * index-lock contention, SSE framing, lease cancellation) do not reproduce
 * against mocks.
 *
 * Run:  node --test w2m/test/agent.test.mjs
 */

import { describe, it, before, after } from 'node:test';

const WS_FIXTURES = [];
after(() => { for (const dir of WS_FIXTURES) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } } });

/**
 * v1.1.6: `autoStartAgent` defaults to true. Cases in this file are about something else, so the harness pins it off
 * once; call sites were renamed first, so this wrapper's own `plugin.apply` is still a real call.
 */
function applyPinned(ctx, config = {}) {
  return plugin.apply(ctx, { autoStartAgent: false, ...config });
}
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
// v0.5.10: `publishState()`'s retry and cleanup can only be observed by injecting a rename
// failure, and the agent binds `renameSync` as a named import of the builtin. `fs` (default) is the
// mutable view, `syncBuiltinESMExports()` is the documented way to make that named import follow it.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  SAMPLE_BYTES,
  WARN_OUTPUT_TRUNCATED,
  WARN_PATH_INVALID,
  classifyExit,
  normalizeOutput,
  runArgv,
  sha256Hex,
} from '../src/agent/exec.mjs';
import {
  CAPS_KEYS,
  detectPlatform,
  probeCaps,
  probeCapsDetailed,
  probeFilesystemCaps,
  findExecutable,
} from '../src/agent/caps.mjs';
import {
  FINGERPRINT_ALGO,
  FINGERPRINT_ERRORS,
  collectPreAnchors,
  commandHash,
  envelopeSha256,
  gitRun,
  isDirty,
  jcs,
  jcsSha256,
  normalizeRelPath,
  resolveGit,
  resolveProjectCwd,
  treeFingerprint,
  untrackedFiles,
} from '../src/agent/git.mjs';
import { createSpool } from '../src/agent/spool.mjs';
import {
  DEVICE_FILE_MODE,
  defaultMachineName,
  deviceFilePath,
  loadIdentity,
  loadOrCreateIdentity,
  newMachineId,
  saveDeviceToken,
  validateIdentity,
} from '../src/agent/identity.mjs';
import {
  AGENT_STATE_FILE,
  AGENT_STATE_SCHEMA_VERSION,
  BACKOFF_MS,
  ENVELOPE_VERSION,
  HEARTBEAT_INTERVAL_MS,
  Heartbeat,
  IDLE_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_RTT_MS,
  PROTOCOL_VERSION,
  RECONNECT_DELAY_AFTER_STABLE_MS,
  REFUSAL,
  REQUIRED_ENVELOPE_FIELDS,
  RTT_WINDOW,
  SHELL_ID,
  STABLE_STREAM_MS,
  SseParser,
  backoffDelay,
  buildEnvelope,
  createAgent,
  cursorUsableFor,
  evaluateGate,
  heartbeatDiagnostics,
  matchAllowedCommand,
  parseAllowedCommands,
  satisfiesVersion,
  summarizeRtt,
  verifyEnvelope,
} from '../src/agent/agent.mjs';
import { verifyEnvelopeSignature } from '../src/util/envelope-signature.mjs';
import { MATCH_REFUSAL } from '../src/agent/allowed-commands.mjs';
// `resolve.mjs` is the canonical owner of the executable search order; `caps.mjs` re-exports
// `resolveCommand` for callers that have always imported it from there (see its own note). Imported
// once, from the owner, so the module never has two bindings for one function.
import { hasPathSeparator, resolveCommand } from '../src/agent/resolve.mjs';
import { endpointUrl, joinUrl, resolveBaseUrl } from '../src/agent/url.mjs';
import { createRelayServer } from '../src/relay/server.mjs';
import * as plugin from '../src/plugin/tools.mjs';
import {
  NONCE_HEADER,
  NonceCache,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalString,
  signRequest,
  verifyRequest,
} from '../src/signing.mjs';

const HAS_GIT = resolveGit() !== null;
const IS_WINDOWS = process.platform === 'win32';
const NODE = process.execPath;
/** The real CLI, spawned as a separate process in the task-16 integration test. */
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'w2m-localside.mjs');

/** @type {string} */
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'w2m-agent-test-'));
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** @param {string} name */
function scratch(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run git in a directory and return the trimmed stdout. */
async function git(cwd, args) {
  const result = await gitRun(args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Create a git repository with one commit and one tracked file.
 *
 * `-c core.autocrlf=false` keeps the fixture byte-exact regardless of the
 * machine's global git config.
 */
async function makeRepo(name, { commits = 1 } = {}) {
  const dir = scratch(name);
  await git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'tracked.txt'), 'line one\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
  await git(dir, ['add', '-A']);
  if (commits > 0) {
    await git(dir, [
      '-c', 'user.name=w2m-test',
      '-c', 'user.email=w2m@test.invalid',
      '-c', 'core.autocrlf=false',
      'commit', '-m', 'base',
    ]);
  }
  return dir;
}

/** Poll until `fn()` is truthy, or fail. */
async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Wait for a spawned child to close -- including one that has *already* closed.
 *
 * `child.on('close', resolve)` never settles for a child that has already exited: `close` is a
 * one-shot event, the work it was waiting for has already succeeded, and the promise it was going
 * to resolve simply never resolves. The test body then hangs forever with no output, which is the
 * worst possible shape for a failure. Caught once in three loaded runs of the task-16 test, where
 * the child had finished long before the listener was attached (`exitCode=0 signalCode=null`).
 *
 * So the exit state is read *first* -- `exitCode` and `signalCode` are set as soon as the process
 * ends -- and the listener is only for the still-running case. `timeoutMs` is deliberately part of
 * the helper: a wait that can outlive its child is exactly the bug being fixed, and a bounded wait
 * turns it into a named failure instead of a hung suite.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{timeoutMs?: number, label?: string}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, alreadyExited: boolean, waitedMs: number}>}
 */
function waitForChildClose(child, { timeoutMs = 60_000, label = 'child process' } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
      alreadyExited: true,
      waitedMs: 0,
    });
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      // Kill it, so a bounded failure here cannot leave a process behind for the next test.
      child.kill('SIGKILL');
      reject(
        new Error(
          `${label} did not close within ${timeoutMs}ms (pid ${child.pid}); ` +
            'a wait that outlives its child is the defect this helper exists to prevent',
        ),
      );
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, alreadyExited: false, waitedMs: Date.now() - startedAt });
    };
    child.once('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// exec.mjs
// ---------------------------------------------------------------------------

describe('exec: direct argv, never a shell', () => {
  it('passes arguments verbatim, including shell metacharacters', async () => {
    const result = await runArgv([
      NODE,
      '-e',
      'process.stdout.write(process.argv.slice(1).join("|"))',
      'a b',
      '&& echo pwned',
      '$(whoami)',
    ]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout.toString('utf8'), 'a b|&& echo pwned|$(whoami)');
  });

  it('refuses a string command (no shell string can be passed)', () => {
    assert.throws(() => runArgv('node --test'), /non-empty array of strings/);
    assert.throws(() => runArgv([]), /non-empty array of strings/);
    assert.throws(() => runArgv([NODE, 42]), /must be strings/);
  });

  it('names the execution gate it refused at, and says what would make the call runnable', () => {
    // The gate that runs immediately before `spawn`. Each of these used to be a bare `TypeError` with
    // no code: a caller could see *that* it was refused and not *which* rule refused it, which for the
    // "no shell, ever" invariant is the difference between "my argv is wrong" and "this module will
    // not take a command line".
    const cases = [
      ['node --test', 'EXEC_ARGV_NOT_ARRAY'],
      [[], 'EXEC_ARGV_NOT_ARRAY'],
      [[NODE, 42], 'EXEC_ARGV_ENTRY_NOT_STRING'],
      [['', '--test'], 'EXEC_ARGV_EXECUTABLE_EMPTY'],
    ];
    for (const [argv, code] of cases) {
      assert.throws(
        () => runArgv(argv),
        (error) => {
          assert.equal(error instanceof TypeError, true, 'the refusal is still a TypeError');
          assert.equal(error.code, code, `${JSON.stringify(argv)} must be refused by name`);
          assert.equal(typeof error.detail, 'string', 'and must carry what would change it');
          assert.ok(error.detail.length > 20, `the detail must be a sentence: ${error.detail}`);
          return true;
        },
      );
    }
  });

  it('codes a spawn that never started, beside the operating system code', async () => {
    // `code` stays the OS code (ENOENT here) because that is what a reader needs to fix it; the
    // execution gate's own code says which layer decided, which is the thing a bare ENOENT hides.
    const result = await runArgv(['w2m-definitely-not-a-real-binary']);
    assert.equal(result.spawn_error.code, 'ENOENT');
    assert.equal(result.spawn_error.reason_code, 'EXEC_SPAWN_FAILED');
    assert.equal(classifyExit(result), 'crashed');
  });
  it('records a non-zero exit code', async () => {
    const result = await runArgv([NODE, '-e', 'process.exit(3)']);
    assert.equal(result.exit_code, 3);
    assert.equal(result.signal, null);
    assert.equal(classifyExit(result), 'nonzero_exit');
  });

  it('kills a runaway command on timeout and reports exit_code null', async () => {
    const started = Date.now();
    const result = await runArgv([NODE, '-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 700 });
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.equal(result.exit_code, null, 'a signalled process must not carry an exit code');
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(classifyExit(result), 'timeout');
    assert.ok(elapsed < 15_000, `expected a prompt kill, took ${elapsed}ms`);
  });

  it('truncates the retained sample but hashes the entire stream', async () => {
    const size = 200_000;
    const result = await runArgv(
      [NODE, '-e', `process.stdout.write("x".repeat(${size}))`],
      { maxOutputBytes: 4096 },
    );
    assert.equal(result.stdout_bytes, size, 'stdout_bytes must describe the raw stream');
    assert.equal(result.stdout.length, 4096, 'only the retention cap is kept');
    assert.equal(result.truncated_stdout, true);
    assert.ok(result.warnings.includes(WARN_OUTPUT_TRUNCATED));
    assert.equal(
      result.stdout_sha256,
      createHash('sha256').update('x'.repeat(size)).digest('hex'),
      'stdout_sha256 must be the hash of the whole raw stream',
    );
    assert.equal(classifyExit(result), 'ok');
  });

  it('keeps 4 KiB of head and tail for the optional envelope fields', async () => {
    const result = await runArgv(
      [NODE, '-e', 'process.stdout.write("A".repeat(6000) + "B".repeat(6000))'],
      { maxOutputBytes: 8192 },
    );
    assert.equal(result.stdout_head.length, SAMPLE_BYTES);
    assert.equal(result.stdout_tail.length, SAMPLE_BYTES);
    assert.ok(result.stdout_head.startsWith('AAAA'));
    assert.ok(result.stdout_tail.endsWith('BBBB'));
  });

  it('reports PATH_INVALID when the executable does not exist', async () => {
    const result = await runArgv(['w2m-definitely-not-a-real-binary']);
    assert.equal(result.exit_code, null);
    assert.equal(result.spawn_error?.code, 'ENOENT');
    // `code` stays the operating system's, because that is what a reader needs to fix it; the
    // execution gate's own code says which layer refused, which is what a bare ENOENT hides.
    assert.equal(result.spawn_error?.reason_code, 'EXEC_SPAWN_FAILED');
    assert.ok(result.warnings.includes(WARN_PATH_INVALID));
    assert.equal(classifyExit(result), 'crashed');
  });

  it('honours an AbortSignal (task.cancel / shutdown)', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const result = await runArgv([NODE, '-e', 'setTimeout(() => {}, 30_000)'], {
      signal: controller.signal,
      timeoutMs: 20_000,
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.timed_out, false);
    assert.equal(result.exit_code, null);
    assert.equal(classifyExit(result), 'crashed');
  });

  it('exposes a 2 MiB default retention cap', () => {
    assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024);
  });

  it('normalizes output according to compare_policy', () => {
    const raw = Buffer.from('\u001B[31mRed\u001B[0m\r\nline2\r\n\r\n\r\n');
    const normalized = normalizeOutput(raw, {
      strip_ansi: true,
      normalize_crlf: true,
      strip_trailing_blank_lines: true,
    }).toString('utf8');
    assert.equal(normalized, 'Red\nline2');
    assert.equal(normalizeOutput(raw, { strip_ansi: false }).toString('utf8').includes('\u001B[31m'), true);
    assert.equal(
      normalizeOutput(Buffer.from('a\r\nb\r\n'), { normalize_crlf: false, strip_trailing_blank_lines: false }).toString('utf8'),
      'a\r\nb\r\n',
    );
  });
});

// ---------------------------------------------------------------------------
// allow-list
// ---------------------------------------------------------------------------

describe('allow-list: default-deny prefix matching', () => {
  it('parses the documented JSON array form', () => {
    assert.deepEqual(parseAllowedCommands('["node --test","git status"]'), [
      ['node', '--test'],
      ['git', 'status'],
    ]);
    assert.deepEqual(parseAllowedCommands('[]'), []);
    assert.deepEqual(parseAllowedCommands([['C:\\Program Files\\x\\y.exe', '--flag']]), [
      ['C:\\Program Files\\x\\y.exe', '--flag'],
    ]);
  });

  it('rejects malformed input instead of guessing', () => {
    assert.throws(() => parseAllowedCommands('node --test'), /JSON array/);
    assert.throws(() => parseAllowedCommands('{"a":1}'), /JSON array/);
    assert.throws(() => parseAllowedCommands('[""]'), /must not be empty/);
  });

  it('never treats a comma as a separator', () => {
    const prefixes = parseAllowedCommands('["node --test, git status"]');
    assert.deepEqual(prefixes, [['node', '--test,', 'git', 'status']]);
    assert.equal(matchAllowedCommand(['git', 'status'], prefixes).allowed, false);
  });

  it('is idempotent on an already-normalized prefix list', () => {
    // `createAgent` normalizes its input, and the CLI also parses first, so
    // parsing a `string[][]` twice must be a no-op.
    const once = parseAllowedCommands('["node --test","git status"]');
    const twice = parseAllowedCommands(once);
    assert.deepEqual(twice, once);
    assert.deepEqual(parseAllowedCommands([]), []);
    assert.throws(() => parseAllowedCommands([['node', 5]]), /strings/);
  });

  it('allows a prefix and its extensions, refuses everything else', () => {
    const prefixes = parseAllowedCommands('["node --test","git status"]');
    assert.equal(matchAllowedCommand(['node', '--test'], prefixes).allowed, true);
    assert.equal(matchAllowedCommand(['node', '--test', '--reporter=tap'], prefixes).allowed, true);
    assert.equal(matchAllowedCommand(['node', '-e', 'process.exit(1)'], prefixes).allowed, false);
    assert.equal(matchAllowedCommand(['node'], prefixes).allowed, false, 'shorter than the prefix');
    assert.equal(matchAllowedCommand(['node', '--test', 'x'], prefixes).prefix.join(' '), 'node --test');
    assert.equal(matchAllowedCommand(['git', 'push'], prefixes).allowed, false);
  });

  it('accepts an absolute executable path that names an allowed command', () => {
    const prefixes = parseAllowedCommands('["node --test"]');
    // The absolute path of the file the entry *resolves to* is the executable the entry names, and it
    // is admitted on that identity. Resolving `node` here rather than assuming this process's own
    // executable is what PATH holds keeps the test about the rule: a harness running a bundled
    // runtime with no `node` on PATH is exactly the case where the two are different files.
    const resolved = resolveCommand('node');
    const outcome = matchAllowedCommand([resolved, '--test'], prefixes);
    if (hasPathSeparator(resolved)) {
      assert.equal(outcome.allowed, true, `${resolved} is the file \`node\` resolves to`);
    } else {
      // Nothing named `node` on PATH: no path can be admitted for this entry, and the refusal says so
      // instead of admitting a path because its basename happens to match.
      assert.equal(outcome.reason_code, MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH);
    }
  });

  it('refuses everything when the list is empty', () => {
    assert.equal(matchAllowedCommand([NODE, '--test'], []).allowed, false);
    assert.equal(matchAllowedCommand([NODE, '--test'], undefined).allowed, false);
  });

  it('names every refusal, and says what would change it', () => {
    // A default-deny gate that answers `{allowed: false}` and nothing else tells a caller that the
    // machine will not run their command, and leaves them to guess whether the list is wrong, the
    // command is wrong, or their own call is wrong. The three are separate codes here.
    const prefixes = parseAllowedCommands('["node --test","git status"]');

    const notListed = matchAllowedCommand(['rm', '-rf', '/'], prefixes);
    assert.equal(notListed.allowed, false);
    assert.equal(notListed.reason_code, 'COMMAND_NOT_ALLOWED');
    assert.match(notListed.detail, /node --test/, 'the detail repeats the entries that would cover it');
    assert.match(notListed.detail, /rm -rf \//, 'and names the command that was refused');

    const nothingAllowed = matchAllowedCommand(['node', '--test'], []);
    assert.equal(nothingAllowed.allowed, false);
    assert.equal(nothingAllowed.reason_code, 'COMMAND_NOT_ALLOWED', 'one refusal, one code, one list');
    assert.match(nothingAllowed.detail, /empty/, 'but the remedy is the empty list, and it says so');

    // An argv the matcher cannot even compare against: a caller bug, not a policy decision, so it is
    // deliberately not folded into the code above.
    for (const argv of ['node --test', [], null]) {
      const unusable = matchAllowedCommand(argv, prefixes);
      assert.equal(unusable.allowed, false, `${JSON.stringify(argv)} must still be refused`);
      assert.equal(unusable.reason_code, 'COMMAND_ARGV_EMPTY');
      assert.match(unusable.detail, /argv/);
    }

    const allowed = matchAllowedCommand(['node', '--test'], prefixes);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason_code, null, 'an allowed command has no refusal to name');
    assert.equal(allowed.detail, null);
  });

  it('refuses under the same code the agent writes into an envelope', () => {
    // The whole reason this matcher is shared: a dispatcher's pre-flight refusal and a machine's own
    // refusal must read identically to whoever has to act on them. Two spellings of one refusal would
    // be exactly the drift the shared module exists to prevent, so the literals are asserted equal.
    assert.equal(MATCH_REFUSAL.NOT_ALLOWED, REFUSAL.COMMAND_NOT_ALLOWED);
    assert.equal(
      matchAllowedCommand(['rm', '-rf', '/'], parseAllowedCommands('["node --test"]')).reason_code,
      REFUSAL.COMMAND_NOT_ALLOWED,
    );
    // The three v0.5.10 codes are the matcher's alone, deliberately: the plugin forwards whatever the
    // matcher returned instead of defining a second spelling (`checkAllowedCommand` reads
    // `match.reason_code`), and the agent writes the matcher's code into its envelope. That agreement
    // is asserted from both ends -- here and in tools.test.mjs -- so it is a test, not a hope.
    for (const code of [
      MATCH_REFUSAL.REPARSING_ARGUMENT,
      MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH,
      MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH,
    ]) {
      assert.equal(typeof code, 'string');
      assert.notEqual(code, MATCH_REFUSAL.NOT_ALLOWED, 'a distinct fault keeps a distinct code');
    }
  });
});

// ---------------------------------------------------------------------------
// allow-list: trailing arguments that load code (v0.5.10)
// ---------------------------------------------------------------------------

/** `["node --test"]` -- the entry this repository's README and PROTOCOL use as the example. */
function NODE_TEST_ENTRY() {
  return parseAllowedCommands('["node --test"]');
}

describe('allow-list: a matched prefix does not cover code-loading trailing arguments', () => {
  it('refuses --test-reporter and every other argument that makes node load code', () => {
    // The defect: only the first `prefix.length` tokens were compared, so `node --test
    // --test-reporter=file:///E:/evil-reporter.mjs` returned `allowed: true` and node imported and
    // ran that module. The matcher now refuses the *trailing* arguments that re-enter a parser.
    const prefixes = NODE_TEST_ENTRY();
    for (const argv of [
      ['node', '--test', '--test-reporter=file:///E:/evil-reporter.mjs'],
      ['node', '--test', '--test-reporter', 'file:///E:/evil-reporter.mjs'],
      ['node', '--test', '--import=file:///E:/evil.mjs'],
      ['node', '--test', '--require=E:/evil.cjs'],
      ['node', '--test', '-r', 'E:/evil.cjs'],
      ['node', '--test', '--experimental-loader=file:///E:/evil.mjs'],
      ['node', '--test', '--loader=file:///E:/evil.mjs'],
      ['node', '--test', '-e', 'process.exit(0)'],
      ['node', '--test', '--eval', 'process.exit(0)'],
      ['node', '--test', '-p', '1+1'],
      // A bundle of short options is the same two flags: `-pe` is `--print --eval`.
      ['node', '--test', '-pe', '1+1'],
    ]) {
      const refused = matchAllowedCommand(argv, prefixes);
      assert.equal(refused.allowed, false, `${argv.join(' ')} must be refused`);
      assert.equal(refused.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT, argv.join(' '));
    }

    const refused = matchAllowedCommand(
      ['node', '--test', '--test-reporter=file:///E:/evil-reporter.mjs'],
      prefixes,
    );
    // The refusal has to say *which* argument and what would change it, or the operator's only move
    // is to loosen the allow-list blindly.
    assert.match(refused.detail, /--test-reporter/, 'the detail names the argument');
    assert.match(refused.detail, /trailing argument of the entry `node --test`/, 'and the entry it matched');
    assert.match(refused.detail, /entry of its own/, 'and the remedy');
  });

  it('covers the interpreters in common use, and only per family', () => {
    const cases = [
      [['python'], ['python', '-c', 'import os; os.system("id")']],
      [['python3.12'], ['python3.12', '-m', 'evil']],
      [['perl'], ['perl', '-e', 'print 1']],
      [['ruby'], ['ruby', '-r', '/tmp/evil']],
      [['php'], ['php', '-r', 'system("id");']],
      [['bash'], ['bash', '-lc', 'id']],
      [['pwsh'], ['pwsh', '-Command', 'id']],
      [['cmd'], ['cmd', '/c', 'whoami']],
      [['java'], ['java', '-javaagent:C:\\evil.jar', '-jar', 'app.jar']],
      [['git', 'status'], ['git', 'status', '--exec-path=E:/evil']],
      [['git'], ['git', '-c', 'core.pager=!sh -c id', 'log']],
      [['rsync'], ['rsync', '-e', 'sh -c id', 'a', 'b']],
      [['tar'], ['tar', '-xf', 'a.tar', '--to-command=id']],
      [['find'], ['find', '.', '-name', 'x', '-exec', 'id', ';']],
      [['env'], ['env', '-S', 'id']],
      [['make'], ['make', '--eval=$(shell id)']],
    ];
    for (const [entry, argv] of cases) {
      const refused = matchAllowedCommand(argv, parseAllowedCommands([entry]));
      assert.equal(refused.allowed, false, `${argv.join(' ')} under ${entry.join(' ')}`);
      assert.equal(refused.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT, `${argv.join(' ')} under ${entry.join(' ')}`);
    }
    // The limit, stated rather than discovered: the deny-list is per executable family, so a tool
    // nobody listed keeps prefix-only semantics. `npx`, `xargs` and `sh -c` are grants of *another*
    // program by construction, and no token list enumerates them.
    assert.equal(matchAllowedCommand(['mytool', '--run', 'id'], parseAllowedCommands(['mytool'])).allowed, true);
  });

  it('keeps a legitimate trailing argument, and lets an entry name a refused one', () => {
    // The direction that must keep working. A control that refused the whole entry because one
    // argument is on the deny-list would make `node --test` unusable rather than safer.
    const prefixes = NODE_TEST_ENTRY();
    for (const argv of [
      ['node', '--test', '--test-name-pattern=adds'],
      ['node', '--test', '--reporter=tap'],
      ['node', '--test', 'tests/one.test.mjs'],
      ['node', '--test', '--test-concurrency=1', 'tests/one.test.mjs'],
    ]) {
      const allowed = matchAllowedCommand(argv, prefixes);
      assert.equal(allowed.allowed, true, `${argv.join(' ')} must still be allowed`);
      assert.equal(allowed.reason_code, null);
    }

    // A plain path must not be read as a bundle of short options: `not-a-test-name.mjs` contains an
    // `e`, and a first cut of the deny-list refused it as `-e`.
    assert.equal(matchAllowedCommand(['node', '--test', 'E:/x/not-a-test-name.mjs'], prefixes).allowed, true);

    // The escape hatch the refusal names: an entry that spells the argument out is the explicit
    // grant, and entries are tried in order, so the specific entry must win over the general one.
    const explicit = parseAllowedCommands('["node --test","node --test --test-reporter=tap"]');
    assert.equal(matchAllowedCommand(['node', '--test', '--test-reporter=tap'], explicit).allowed, true);
    assert.equal(
      matchAllowedCommand(['node', '--test', '--test-reporter=file:///E:/evil.mjs'], explicit).reason_code,
      MATCH_REFUSAL.REPARSING_ARGUMENT,
      'naming one value must not admit every value',
    );
  });

  it('says out loud that an allowed prefix still grants what the tool does with its arguments', () => {
    // The honest limit of a *prefix* allow-list, pinned here so nobody reads the deny-list as a
    // sandbox: `node --test <path>` loads and executes that file, so the entry `node --test` is a
    // grant of arbitrary code execution from any file this machine can read. The deny-list narrows
    // the argument shapes that reach it and cannot close it; see the module header.
    const allowed = matchAllowedCommand(['node', '--test', '/anywhere/at/all.mjs'], NODE_TEST_ENTRY());
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason_code, null);
  });
});

// ---------------------------------------------------------------------------
// allow-list: executable identity (v0.5.10)
// ---------------------------------------------------------------------------

describe('allow-list: the executable is a file, not a spelling', () => {
  /**
   * A directory holding one file named like an executable, so identity tests are hermetic.
   *
   * The contents do not matter: nothing here executes it, and the matcher only resolves it.
   *
   * @param {string} name Scratch directory name.
   */
  function plantExecutable(name) {
    const dir = scratch(name);
    const file = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(file, '', 'utf8');
    if (process.platform !== 'win32') chmodSync(file, 0o755);
    return { dir, file };
  }

  it('admits an absolute path only when it is the file the entry resolves to', () => {
    // The defect: `argv[0]` was accepted when its *basename* matched, so `E:\Temp\evil\node.exe` --
    // a copy of another program under an allowed name -- was admitted, and `spawn` ran it.
    const allowedDir = plantExecutable('identity-allowed');
    const evilDir = plantExecutable('identity-evil');
    const prefixes = NODE_TEST_ENTRY();
    const env = { PATH: allowedDir.dir };

    const same = matchAllowedCommand([allowedDir.file, '--test'], prefixes, { env });
    assert.equal(same.allowed, true, "the file the entry resolves to is the entry's executable");

    const other = matchAllowedCommand([evilDir.file, '--test'], prefixes, { env });
    assert.equal(other.allowed, false, 'a different file with the same name is a different program');
    assert.equal(other.reason_code, MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH);
    assert.ok(other.detail.includes(evilDir.file), 'the detail names the refused path');
    assert.ok(other.detail.includes(allowedDir.file), 'and the file the entry resolves to');
  });

  it('admits the same file when the entry names the path itself', () => {
    const allowedDir = plantExecutable('identity-path-entry');
    const evilDir = plantExecutable('identity-path-entry-evil');
    const prefixes = parseAllowedCommands([[allowedDir.file, '--test']]);
    assert.equal(matchAllowedCommand([allowedDir.file, '--test'], prefixes).allowed, true);
    assert.equal(
      matchAllowedCommand([evilDir.file, '--test'], prefixes).reason_code,
      MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH,
    );
    // A bare name against a path entry resolves through PATH, and is admitted only when it is that
    // file -- which is how a dispatcher's `node` reaches an entry that spells the path out.
    assert.equal(
      matchAllowedCommand(['node', '--test'], prefixes, { env: { PATH: allowedDir.dir } }).allowed,
      true,
    );
    assert.equal(
      matchAllowedCommand(['node', '--test'], prefixes, { env: { PATH: evilDir.dir } }).reason_code,
      MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH,
    );
  });

  it('refuses a relative executable outright, even when an entry names it', () => {
    // `./node.exe` is a different file in every working directory, and the working directory is the
    // offer's to choose -- so no entry can pin it, including one that spells the path out.
    const rel = process.platform === 'win32' ? '.\\node.exe' : './node';
    const refused = matchAllowedCommand([rel, '--test'], NODE_TEST_ENTRY());
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason_code, MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH);
    assert.match(refused.detail, /working directory/);
    assert.equal(
      matchAllowedCommand([rel, '--test'], parseAllowedCommands([[rel, '--test']])).reason_code,
      MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH,
    );
  });

  it('still matches a bare name, extension aside, and names an incomparable argv', () => {
    // The direction that must keep working: a bare name is what every existing configuration uses,
    // and `.exe` is not part of the name.
    assert.equal(matchAllowedCommand(['node', '--test'], parseAllowedCommands('["node.exe --test"]')).allowed, true);
    assert.equal(matchAllowedCommand(['node', '--test'], NODE_TEST_ENTRY()).allowed, true);

    // An argv the matcher cannot compare at all is a caller bug, and it is named as one instead of
    // throwing out of `path.basename` (which reached the agent as a `crashed` envelope).
    assert.equal(matchAllowedCommand(['node', 7], NODE_TEST_ENTRY()).reason_code, MATCH_REFUSAL.ARGV_EMPTY);
  });
});

// ---------------------------------------------------------------------------
// capability gate
// ---------------------------------------------------------------------------

describe('capability gate (§6.1)', () => {
  const baseContext = {
    caps: { node: 'v24.16.0', python: '3.12.14', npm: null },
    platform: { os: 'windows' },
    writable: true,
  };

  it('passes when nothing is required', () => {
    assert.equal(evaluateGate({ requirements: {} }, baseContext).ok, true);
  });

  it('accepts a satisfied toolchain requirement', () => {
    assert.equal(
      evaluateGate({ requirements: { toolchain: { node: '>=20' } } }, baseContext).ok,
      true,
    );
  });

  it('refuses an unsatisfied version with MISSING_<TOOL>', () => {
    const verdict = evaluateGate({ requirements: { toolchain: { node: '>=99' } } }, baseContext);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.refusal_reason, 'MISSING_NODE');
  });

  it('refuses a tool that is not installed, never guessing a version', () => {
    assert.equal(
      evaluateGate({ requirements: { toolchain: { npm: '>=9' } } }, baseContext).refusal_reason,
      'MISSING_NPM',
    );
    assert.equal(
      evaluateGate({ requirements: { toolchain: { python: null } } }, baseContext).refusal_reason,
      'MISSING_PYTHON',
    );
  });

  it('refuses on a platform mismatch', () => {
    const verdict = evaluateGate({ requirements: { platform: ['macos'] } }, baseContext);
    assert.equal(verdict.refusal_reason, REFUSAL.PLATFORM_MISMATCH);
    assert.equal(evaluateGate({ requirements: { platform: ['windows', 'macos'] } }, baseContext).ok, true);
  });

  it('refuses a write task on a read-only machine', () => {
    const verdict = evaluateGate({ write: true, requirements: {} }, { ...baseContext, writable: false });
    assert.equal(verdict.refusal_reason, REFUSAL.READ_ONLY_MACHINE);
    assert.equal(evaluateGate({ write: false, requirements: {} }, { ...baseContext, writable: false }).ok, true);
  });

  it('verifies tools outside the caps object (e.g. git) instead of refusing them', () => {
    // `caps` only carries python/npm/node; a `toolchain: {git}` requirement must
    // not be answered with a false MISSING_GIT.
    const withToolchain = { ...baseContext, toolchain: { git: '2.56.0' } };
    assert.equal(evaluateGate({ requirements: { toolchain: { git: '>=2' } } }, withToolchain).ok, true);
    assert.equal(
      evaluateGate({ requirements: { toolchain: { git: '>=99' } } }, withToolchain).refusal_reason,
      'MISSING_GIT',
    );
    assert.equal(
      evaluateGate({ requirements: { toolchain: { git: '>=2' } } }, baseContext).refusal_reason,
      'MISSING_GIT',
      'without a detected version we refuse rather than guess',
    );
  });

  it('understands the version ranges the protocol can send', () => {
    assert.equal(satisfiesVersion('24.16.0', '>=20'), true);
    assert.equal(satisfiesVersion('18.19.0', '>=20'), false);
    assert.equal(satisfiesVersion('24.16.0', '>=18 <25'), true);
    assert.equal(satisfiesVersion('24.16.0', '>=18 <22'), false);
    assert.equal(satisfiesVersion('20.9.1', '^20.1.0'), true);
    assert.equal(satisfiesVersion('21.0.0', '^20.1.0'), false);
    assert.equal(satisfiesVersion('20.1.5', '~20.1.0'), true);
    assert.equal(satisfiesVersion('20.2.0', '~20.1.0'), false);
    assert.equal(satisfiesVersion('20.4.0', '20'), true);
    assert.equal(satisfiesVersion('21.0.0', '20'), false);
    assert.equal(satisfiesVersion('18.0.0', '20 || 18'), true);
    assert.equal(satisfiesVersion('3.12.14', '>=3.8'), true);
    assert.equal(satisfiesVersion('v24.16.0', '>=20'), true);
  });
});

// ---------------------------------------------------------------------------
// reconnect backoff + SSE
// ---------------------------------------------------------------------------

describe('reconnect backoff and SSE parsing', () => {
  it('walks 500ms -> 1s -> 2s -> 4s -> 8s -> 10s and stays at 10s', () => {
    assert.deepEqual(BACKOFF_MS, [500, 1000, 2000, 4000, 8000, 10000]);
    const full = [0, 1, 2, 3, 4, 5, 6, 10].map((attempt) => backoffDelay(attempt, () => 1));
    assert.deepEqual(full, [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('jitters to 50%-100% of the ladder value', () => {
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
      const base = BACKOFF_MS[attempt];
      for (const rand of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
        const delay = backoffDelay(attempt, () => rand);
        assert.ok(delay >= Math.round(base * 0.5), `${delay} < 50% of ${base}`);
        assert.ok(delay <= base, `${delay} > ${base}`);
      }
    }
    assert.equal(backoffDelay(0, () => 0), 250);
    assert.equal(backoffDelay(0, () => 1), 500);
  });

  it('parses frames split across chunks and ignores keepalives', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('event: ready\ndata: {"type":"rea'), []);
    const events = parser.push('dy","seq":1}\n\n: keepalive\n\nevent: task.cancel\nid: 7\ndata: {"type":"task.cancel",\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'ready');
    assert.equal(JSON.parse(events[0].data).seq, 1);

    const rest = parser.push('data: "task_id":"T1"}\n\n');
    assert.equal(rest.length, 1);
    assert.equal(rest[0].id, '7');
    assert.equal(JSON.parse(rest[0].data).task_id, 'T1');
  });

  it('handles CRLF frames and multi-line data', () => {
    const parser = new SseParser();
    const events = parser.push('event: notice\r\ndata: {"a":\r\ndata: 1}\r\n\r\n');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data), { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// git anchors
// ---------------------------------------------------------------------------

describe('git anchors and the worktree fingerprint', { skip: HAS_GIT ? false : 'git not available' }, () => {
  it('reports a clean worktree fingerprint equal to the HEAD tree', async () => {
    const repo = await makeRepo('fp-clean');
    const headTree = await git(repo, ['rev-parse', 'HEAD^{tree}']);
    const fp = await treeFingerprint({ cwd: repo });
    assert.equal(fp.error, null);
    assert.equal(fp.fingerprint, headTree);

    const anchors = await collectPreAnchors({ cwd: repo });
    assert.equal(anchors.pre_tree_fingerprint, headTree);
    assert.equal(anchors.dirty_before, false);
    assert.equal(anchors.fingerprint_error, null);
    assert.equal(anchors.untracked.length, 0);
  });

  it('detects a tracked modification and stays stable across calls', async () => {
    const repo = await makeRepo('fp-dirty');
    const headTree = await git(repo, ['rev-parse', 'HEAD^{tree}']);
    writeFileSync(join(repo, 'tracked.txt'), 'line one changed\n');

    const first = await treeFingerprint({ cwd: repo });
    const second = await treeFingerprint({ cwd: repo });
    assert.notEqual(first.fingerprint, headTree);
    assert.equal(first.fingerprint, second.fingerprint, 'the same worktree must fingerprint the same');
    assert.equal(await isDirty({ cwd: repo }), true);
  });

  it('detects untracked-only changes (what git stash create cannot do)', async () => {
    const repo = await makeRepo('fp-untracked');
    const headTree = await git(repo, ['rev-parse', 'HEAD^{tree}']);

    // `git stash create` returns an empty string both for a clean tree and for
    // a tree whose only difference is untracked files, which is why it is
    // banned. The temp-index fingerprint must distinguish all three states.
    const clean = await treeFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'brand-new.txt'), 'untracked\n');
    const untracked = await treeFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'extra\n');
    const mixed = await treeFingerprint({ cwd: repo });

    assert.equal(clean.fingerprint, headTree);
    assert.notEqual(untracked.fingerprint, clean.fingerprint);
    assert.notEqual(untracked.fingerprint, mixed.fingerprint);
    assert.match(untracked.fingerprint, /^[0-9a-f]{40}$/);
    assert.equal(await isDirty({ cwd: repo }), true);
    assert.deepEqual(await untrackedFiles({ cwd: repo }), ['brand-new.txt']);
  });

  it('ignores ignored files, like git itself', async () => {
    const repo = await makeRepo('fp-ignored');
    const headTree = await git(repo, ['rev-parse', 'HEAD^{tree}']);
    writeFileSync(join(repo, 'ignored.txt'), 'nope\n');
    const fp = await treeFingerprint({ cwd: repo });
    assert.equal(fp.fingerprint, headTree, '.gitignore content must not change the fingerprint');
  });

  it('returns a reason code (never a bare null) for an unborn HEAD', async () => {
    const repo = await makeRepo('fp-nocommit', { commits: 0 });
    const fp = await treeFingerprint({ cwd: repo });
    assert.equal(fp.fingerprint, null);
    assert.equal(fp.error, FINGERPRINT_ERRORS.NO_HEAD);
  });

  it('returns NOT_A_REPO outside a repository', async () => {
    const dir = scratch('fp-notarepo');
    const fp = await treeFingerprint({ cwd: dir });
    assert.equal(fp.fingerprint, null);
    assert.equal(fp.error, FINGERPRINT_ERRORS.NOT_A_REPO);
  });

  it('computes identical fingerprints in temp and project object modes', async () => {
    const repo = await makeRepo('fp-objectmode');
    writeFileSync(join(repo, 'extra.txt'), 'x\n');
    const tempMode = await treeFingerprint({ cwd: repo, objectMode: 'temp' });
    const projectMode = await treeFingerprint({ cwd: repo, objectMode: 'project' });
    assert.equal(tempMode.error, null);
    assert.equal(projectMode.error, null);
    assert.equal(tempMode.fingerprint, projectMode.fingerprint);
  });

  it('writes no loose objects into .git/objects in temp object mode', async () => {
    const repo = await makeRepo('fp-readonly');
    writeFileSync(join(repo, 'fresh.txt'), 'never committed\n');
    const objectsDir = join(repo, '.git', 'objects');

    // Assert the *property* -- no new loose object -- rather than a byte-for-byte
    // `readdir` comparison. git writes its own bookkeeping into this directory
    // (`info/`, `pack/`, and on some versions an ephemeral `maintenance.lock`),
    // and a maintenance run is asynchronous, so comparing whole listings made
    // this test fail on macOS for a reason that had nothing to do with the
    // fingerprint: the lock file happened to be absent there.
    const looseObjects = () =>
      readdirSync(objectsDir)
        .filter((name) => /^[0-9a-f]{2}$/.test(name) || /^[0-9a-f]{38,}$/.test(name))
        .sort()
        .join(',');

    const before = looseObjects();
    const beforeMtime = statSync(join(repo, '.git', 'index')).mtimeMs;

    const fp = await treeFingerprint({ cwd: repo, objectMode: 'temp' });
    assert.equal(fp.error, null);
    assert.equal(looseObjects(), before, 'temp object mode must not add loose objects to the project');
    assert.equal(
      statSync(join(repo, '.git', 'index')).mtimeMs,
      beforeMtime,
      'the real index must not be touched',
    );
  });

  it('runs four concurrent fingerprints without fighting over the index', async () => {
    const repo = await makeRepo('fp-parallel');
    writeFileSync(join(repo, 'untracked-a.txt'), 'a\n');
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => treeFingerprint({ cwd: repo })),
    );
    for (const result of results) assert.equal(result.error, null, JSON.stringify(result));
    const unique = new Set(results.map((result) => result.fingerprint));
    assert.equal(unique.size, 1, `concurrent fingerprints disagreed: ${[...unique].join(', ')}`);

    const expected = await treeFingerprint({ cwd: repo });
    assert.equal(results[0].fingerprint, expected.fingerprint);
  });

  it('stays correct when the worktree changes while four fingerprints run', async () => {
    const repo = await makeRepo('fp-parallel-mutating');
    const writer = (async () => {
      for (let i = 0; i < 12; i += 1) {
        writeFileSync(join(repo, `churn-${i}.txt`), `${i}\n`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const results = await Promise.all([
      treeFingerprint({ cwd: repo }),
      treeFingerprint({ cwd: repo }),
      treeFingerprint({ cwd: repo }),
      treeFingerprint({ cwd: repo }),
    ]);
    await writer;
    for (const result of results) {
      assert.equal(result.error, null, `a concurrent run failed: ${JSON.stringify(result)}`);
      assert.match(result.fingerprint, /^[0-9a-f]{40}$/);
    }
    // No leftover temp index anywhere: a lock collision would surface as
    // INDEX_LOCK/ADD_FAILED above, and the final state must still be readable.
    const settled = await treeFingerprint({ cwd: repo });
    assert.equal(settled.error, null);
  });

  it('hashes anchors and commands deterministically', async () => {
    const a = commandHash(['node', '--test'], SHELL_ID, '.');
    const b = commandHash(['node', '--test'], SHELL_ID, '.');
    const c = commandHash(['node', '--test'], SHELL_ID, 'src');
    const d = commandHash(['node', '--test', '--x'], SHELL_ID, '.');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(SHELL_ID, 'direct-exec');
    assert.equal(FINGERPRINT_ALGO, 'git-temp-index-tree/v1');
  });

  it('normalizes relative paths to forward slashes', () => {
    assert.equal(normalizeRelPath('.\\src\\a'), 'src/a');
    assert.equal(normalizeRelPath('./src/'), 'src');
    assert.equal(normalizeRelPath(''), '.');
    assert.equal(normalizeRelPath(undefined), '.');
  });

  it('refuses a cwd_rel that escapes the project', () => {
    const project = scratch('cwd-guard');
    const ok = resolveProjectCwd(project, 'src');
    assert.equal(ok.ok, true);
    assert.equal(ok.cwd_rel, 'src');
    assert.equal(resolveProjectCwd(project, '.').ok, true);
    assert.equal(resolveProjectCwd(project, '..').ok, false);
    assert.equal(resolveProjectCwd(project, '../outside').reason, 'CWD_OUTSIDE_PROJECT');
    assert.equal(resolveProjectCwd(project, 'a/../../b').ok, false);
  });

  it('canonicalizes JSON per RFC 8785 for hashing', () => {
    assert.equal(jcs({ b: 1, a: [2, null, 'x'] }), '{"a":[2,null,"x"],"b":1}');
    assert.equal(jcs({}), '{}');
    assert.throws(() => jcs({ a: undefined }), /undefined/);
    assert.throws(() => jcs({ a: Number.NaN }), /non-finite/);
    assert.equal(jcsSha256({ a: 1 }), sha256Hex('{"a":1}'));
  });
});

// ---------------------------------------------------------------------------
// spool
// ---------------------------------------------------------------------------

describe('spool: write ahead, delete only after ack', () => {
  it('writes the task to disk before anything else', () => {
    const spool = createSpool(scratch('spool-1'));
    const record = spool.saveTask({
      task_id: '01J-TASK',
      attempt: 1,
      dedupe_key: 'dedupe-1',
      offer: { task_id: '01J-TASK', command_argv: [NODE, '--test'] },
    });
    assert.equal(record.state, 'claimed');
    assert.equal(existsSync(join(spool.root, '01J-TASK__a1', 'task.json')), true);
    assert.equal(existsSync(join(spool.root, '01J-TASK__a1', 'meta.json')), true);
    assert.deepEqual(spool.pendingResults(), [], 'no envelope yet, so nothing to resend');
    assert.equal(spool.interruptedTasks().length, 1);
  });

  it('keeps the envelope until Rabbit confirms, then deletes it', () => {
    const spool = createSpool(scratch('spool-2'));
    spool.saveTask({ task_id: 'T2', attempt: 2, dedupe_key: 'd2', offer: { task_id: 'T2' } });
    const envelope = { task_id: 'T2', attempt: 2, status: 'ok', dedupe_key: 'd2' };
    spool.saveEnvelope({ task_id: 'T2', attempt: 2, envelope });

    const pending = spool.pendingResults();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].envelope, envelope);
    assert.equal(existsSync(join(spool.root, 'T2__a2', 'envelope.json')), true);

    assert.equal(spool.ack({ task_id: 'T2', attempt: 2 }), true);
    assert.equal(spool.list().length, 0);
    assert.equal(existsSync(join(spool.root, 'T2__a2')), false);
    assert.equal(spool.ack({ task_id: 'T2', attempt: 2 }), false, 'acking twice is not an error');
  });

  it('acknowledges by dedupe key for `deduped: true` responses', () => {
    const spool = createSpool(scratch('spool-3'));
    spool.saveEnvelope({ task_id: 'T3', attempt: 1, envelope: { task_id: 'T3', dedupe_key: 'k3' } });
    spool.saveEnvelope({ task_id: 'T4', attempt: 1, envelope: { task_id: 'T4', dedupe_key: 'k4' } });
    assert.equal(spool.ackByDedupeKey('k3'), 1);
    assert.equal(spool.list().length, 1);
    assert.equal(spool.list()[0].task_id, 'T4');
  });

  it('keeps separate directories per attempt', () => {
    const spool = createSpool(scratch('spool-4'));
    spool.saveEnvelope({ task_id: 'T5', attempt: 1, envelope: { task_id: 'T5' } });
    spool.saveEnvelope({ task_id: 'T5', attempt: 2, envelope: { task_id: 'T5' } });
    assert.equal(spool.list().length, 2);
    assert.equal(spool.ack({ task_id: 'T5', attempt: 1 }), true);
    assert.equal(spool.list()[0].attempt, 2);
  });

  it('never writes into the project directory', () => {
    const project = scratch('spool-project');
    const state = scratch('spool-state');
    const spool = createSpool(state);
    spool.saveEnvelope({ task_id: 'T6', attempt: 1, envelope: { task_id: 'T6' } });
    assert.deepEqual(readdirSync(project), [], 'the project must stay untouched');
    assert.equal(spool.root.startsWith(state), true);
  });
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('identity: device.json', () => {
  it('mints a UUID v4 machine_id that is not derived from the hostname', () => {
    const dir = scratch('identity-1');
    const { identity, created } = loadOrCreateIdentity({ dir, name: 'win-desktop' });
    assert.equal(created, true);
    assert.match(identity.machine_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(identity.machine_name, 'win-desktop');
    assert.equal(identity.device_token, null);
    assert.notEqual(identity.machine_id, newMachineId(), 'ids must be unique');
  });

  it('keeps the same machine_id across restarts and name changes', () => {
    const dir = scratch('identity-2');
    const first = loadOrCreateIdentity({ dir, name: 'win-a' });
    const second = loadOrCreateIdentity({ dir, name: 'win-b' });
    assert.equal(second.created, false);
    assert.equal(second.identity.machine_id, first.identity.machine_id);
    assert.equal(second.identity.machine_name, 'win-b');
    const third = loadOrCreateIdentity({ dir });
    assert.equal(third.identity.machine_name, 'win-b', 'the rename must have been persisted');
  });

  it('writes 0600 where the platform honours POSIX bits', { skip: IS_WINDOWS ? 'NTFS has no POSIX bits' : false }, () => {
    const dir = scratch('identity-3');
    const file = deviceFilePath({ dir });
    loadOrCreateIdentity({ dir });
    assert.equal(statSync(file).mode & 0o777, DEVICE_FILE_MODE);
  });

  it('stores the device token after pairing', () => {
    const dir = scratch('identity-4');
    loadOrCreateIdentity({ dir });
    saveDeviceToken('tok-123', { dir });
    assert.equal(loadIdentity({ dir }).identity.device_token, 'tok-123');
    assert.throws(() => saveDeviceToken('', { dir }), /empty device_token/);
  });

  it('refuses to silently replace a corrupt identity file', () => {
    const dir = scratch('identity-5');
    const file = deviceFilePath({ dir });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '{ not json');
    assert.equal(loadIdentity({ dir }).reason, 'INVALID_JSON');
    assert.throws(() => loadOrCreateIdentity({ dir }), (error) => error.code === 'IDENTITY_CORRUPT');

    writeFileSync(file, JSON.stringify({ machine_id: 'not-a-uuid' }));
    assert.throws(() => loadOrCreateIdentity({ dir }), (error) => error.code === 'IDENTITY_CORRUPT');
  });

  it('validates identity objects before writing them', () => {
    assert.equal(validateIdentity({ machine_id: newMachineId() }).ok, true);
    assert.equal(validateIdentity(null).reason, 'NOT_AN_OBJECT');
    assert.equal(validateIdentity({ machine_id: 'x' }).reason, 'MACHINE_ID_NOT_UUID_V4');
    assert.equal(validateIdentity({ machine_id: newMachineId(), device_token: 5 }).reason, 'DEVICE_TOKEN_NOT_STRING');
    const fresh = loadOrCreateIdentity({ dir: scratch('identity-6') });
    assert.equal(validateIdentity(fresh.identity).ok, true);
  });

  it('derives a readable default machine name per platform', () => {
    assert.equal(defaultMachineName({ platform: 'win32', host: 'DESKTOP-ABC' }), 'win-desktop-abc');
    assert.equal(defaultMachineName({ platform: 'darwin', host: "Fang's MacBook Pro" }), 'mac-fang-s-macbook-pro');
    assert.equal(defaultMachineName({ platform: 'linux', host: '' }), 'linux-device');
  });
});

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

describe('envelope assembly', () => {
  /** @returns {object} A minimal-but-complete envelope. */
  function fixture(overrides = {}) {
    return {
      envelope_version: ENVELOPE_VERSION,
      task_id: '01J-TEST',
      attempt: 1,
      dedupe_key: 'k',
      machine_id: '3f2a0000-0000-4000-8000-000000000000',
      machine_name: 'win-desktop',
      platform: { os: 'windows', os_version: '10.0', arch: 'x64', shell: 'cmd', shell_version: null },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: 'v24.16.0' },
      index: 0,
      index_total: 1,
      mode: 'replicate',
      cwd_rel: '.',
      base_commit: 'a'.repeat(40),
      base_tree: 'b'.repeat(40),
      pre_tree_fingerprint: 'b'.repeat(40),
      post_tree_fingerprint: 'b'.repeat(40),
      fingerprint_algo: FINGERPRINT_ALGO,
      fingerprint_error: null,
      head_commit: 'a'.repeat(40),
      dirty_before: false,
      command_argv: ['node', '--test'],
      command_hash: commandHash(['node', '--test'], SHELL_ID, '.'),
      shell_id: SHELL_ID,
      started_at: '2026-10-07T12:00:00.000Z',
      ended_at: '2026-10-07T12:00:01.000Z',
      duration_ms: 1000,
      exit_code: 0,
      status: 'ok',
      refusal_reason: null,
      stdout_sha256: sha256Hex('ok\n'),
      stdout_bytes: 3,
      stderr_sha256: sha256Hex(''),
      stderr_bytes: 0,
      warnings: [],
      ...overrides,
    };
  }

  it('carries every §5.1 required field and a verifiable hash', () => {
    const envelope = buildEnvelope(fixture());
    for (const field of REQUIRED_ENVELOPE_FIELDS) {
      assert.ok(field in envelope, `missing required field ${field}`);
    }
    assert.equal(verifyEnvelope(envelope), true);
    assert.equal(envelope.envelope_sha256, envelopeSha256(envelope));
  });

  it('detects tampering', () => {
    const envelope = buildEnvelope(fixture());
    const tampered = { ...envelope, exit_code: 1 };
    assert.equal(verifyEnvelope(tampered), false);
    assert.equal(verifyEnvelope({}), false);
  });

  it('refuses to build an envelope with a missing required field', () => {
    const incomplete = fixture();
    delete incomplete.dedupe_key;
    assert.throws(() => buildEnvelope(incomplete), /missing required field: dedupe_key/);
  });

  it('declares protocol/envelope versions and the direct-exec shell id', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(ENVELOPE_VERSION, '1.0');
    assert.equal(SHELL_ID, 'direct-exec');
    assert.equal(HEARTBEAT_INTERVAL_MS, 10_000);
  });
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

describe('capability probing', () => {
  it('reports exactly the contract keys', async () => {
    const caps = await probeCaps();
    assert.deepEqual(Object.keys(caps).sort(), [...CAPS_KEYS].sort());
    assert.equal(typeof caps.case_sensitive_fs, 'boolean');
    assert.equal(typeof caps.symlinks, 'boolean');
    assert.equal(typeof caps.exec_bit, 'boolean');
    assert.equal(caps.python === null || typeof caps.python === 'string', true);
    assert.equal(caps.npm === null || typeof caps.npm === 'string', true);
    assert.equal(caps.node === null || typeof caps.node === 'string', true);
  });

  it('finds a node with a real version string', async () => {
    const caps = await probeCaps();
    assert.match(caps.node, /^v?\d+\.\d+\.\d+/);
  });

  it('finds python in the bundled DSH runtime when PATH has none', async () => {
    const { caps, detail } = await probeCapsDetailed();
    if (findExecutable('python') === null && findExecutable('python3') === null) {
      assert.equal(detail.python.source, 'bundled', 'expected the DSH bundled python');
      assert.match(caps.python, /^\d+\.\d+\.\d+$/);
    } else {
      assert.match(caps.python, /^\d+\.\d+\.\d+$/);
    }
  });

  it('reports npm as null rather than inventing a version', async () => {
    const { caps, detail } = await probeCapsDetailed();
    if (caps.npm === null) {
      assert.ok(
        ['NOT_FOUND', 'NEEDS_SHELL', 'VERSION_UNPARSED'].includes(detail.npm.error),
        `unexpected npm probe error ${detail.npm.error}`,
      );
    } else {
      assert.match(caps.npm, /^\d+\.\d+\.\d+/);
    }
  });

  it('reports the windows filesystem honestly', { skip: IS_WINDOWS ? false : 'windows-only expectation' }, async () => {
    const caps = await probeCaps();
    assert.equal(caps.case_sensitive_fs, false);
    assert.equal(caps.exec_bit, false);
  });

  it('probes case sensitivity and the exec bit for real', () => {
    const probed = probeFilesystemCaps(scratch('caps-probe'));
    assert.equal(typeof probed.case_sensitive_fs, 'boolean');
    assert.equal(probed.case_sensitive_source, 'probe');
    assert.equal(typeof probed.exec_bit, 'boolean');
    assert.match(probed.exec_bit_source, /^probe:/);
    assert.match(probed.symlinks_source, /^probe/);
  });

  it('is stable across repeated probes', async () => {
    const first = await probeCaps();
    const second = await probeCaps();
    assert.deepEqual(first, second);
  });

  it('reports a usable platform object', async () => {
    const platform = await detectPlatform();
    assert.ok(['windows', 'macos', 'linux'].includes(platform.os));
    assert.equal(typeof platform.os_version, 'string');
    assert.ok(platform.os_version.length > 0);
    assert.ok(['x64', 'arm64', 'ia32'].includes(platform.arch));
    assert.equal(typeof platform.shell, 'string');
    assert.equal(platform.shell_version === null || typeof platform.shell_version === 'string', true);
  });

  it('does not leak probe detail into the contract caps object', async () => {
    const { caps, detail } = await probeCapsDetailed();
    assert.equal('detail' in caps, false);
    assert.equal('dsh_dependencies_dir' in caps, false);
    assert.ok(detail.dsh_dependencies_dir === null || typeof detail.dsh_dependencies_dir === 'string');
  });
});

// ---------------------------------------------------------------------------
// Executable resolution: the probe and the executor must agree
// ---------------------------------------------------------------------------

/**
 * Measured on macOS 27.0 / arm64, 2026-10-09.
 *
 * `caps.node` reported `v24.21.0` with source `bundled` -- real and correct, because DSH ships node
 * under `$DSH_HOME/dsh-runtimes/...`. The same machine could not run `node --test`: the executor
 * handed the bare name to `spawn(..., {shell:false})`, which only searches PATH, so every such task
 * came back `crashed` with `exit_code: null`. These cases reproduce that in miniature: a tool that
 * exists only in the bundled tree, and a PATH that cannot see it.
 */
describe('executable resolution (probe and executor share one search order)', () => {
  let root;
  let pathDir;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'w2m-resolve-'));
    pathDir = join(root, 'on-path');
    const binDir = join(root, 'node', 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    // The SAME name in both places, so "which one won" is the only question. The
    // first version of this block asserted against a real `/bin/sh`, which is a
    // POSIX-only assumption: Windows splits PATH on `;` rather than `:`, and has no
    // `/bin/sh` at all. CI caught it on windows-latest, which is the whole reason
    // the matrix exists.
    for (const dir of [binDir, pathDir]) {
      const tool = join(dir, 'w2m-fake-tool');
      writeFileSync(tool, '#!/bin/sh\necho resolved-ok\n');
      chmodSync(tool, 0o755);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const env = (extra = {}) => ({ PATH: '', DSH_RUNTIME_DEPS: root, ...extra });

  it('finds a bundled tool that PATH does not have', () => {
    assert.equal(findExecutable('w2m-fake-tool', { env: env() }), null);
    assert.equal(
      resolveCommand('w2m-fake-tool', { env: env() }),
      join(root, 'node', 'bin', 'w2m-fake-tool'),
    );
  });

  it('keeps PATH ahead of the bundled runtime', () => {
    // Same name in both trees; PATH must win. Expressed with a directory that
    // exists on every platform rather than with a hard-coded `/bin:/usr/bin`.
    const resolved = resolveCommand('w2m-fake-tool', { env: env({ PATH: pathDir }) });
    assert.equal(resolved, join(pathDir, 'w2m-fake-tool'));
  });

  it('leaves an unfindable name alone so the honest ENOENT survives', () => {
    assert.equal(resolveCommand('w2m-truly-missing', { env: env() }), 'w2m-truly-missing');
  });

  it('never rewrites an explicit path', () => {
    assert.equal(resolveCommand('/bin/sh'), '/bin/sh');
    assert.equal(resolveCommand('./relative-tool'), './relative-tool');
  });

  // POSIX only, and named as such. A shell script is not a Windows executable:
  // `CreateProcess` needs a real PE image, and fabricating one as a test fixture is
  // out of proportion. The resolution case above is the cross-platform half of the
  // same defect, and this half proves `runArgv` actually consults the resolver.
  it(
    'starts a bundled-only tool from runArgv even when PATH cannot see it',
    {
      skip:
        process.platform === 'win32'
          ? 'a POSIX shell script is not a Windows executable; see the resolution case above'
          : false,
    },
    async () => {
      const result = await runArgv(['w2m-fake-tool'], { env: env() });
      assert.equal(result.spawn_error, null);
      assert.equal(result.exit_code, 0);
      assert.match(result.stdout.toString('utf8'), /resolved-ok/);
    },
  );

  it('still reports a spawn failure, unchanged, for a command that exists nowhere', async () => {
    const result = await runArgv(['w2m-truly-missing'], { env: env() });
    assert.equal(result.spawn_error.code, 'ENOENT');
    assert.equal(classifyExit(result), 'crashed');
    assert.ok(result.warnings.includes(WARN_PATH_INVALID));
  });

  it('can be told to spawn argv[0] verbatim', async () => {
    const result = await runArgv(['w2m-fake-tool'], { env: env(), resolveExecutable: false });
    assert.equal(result.spawn_error.code, 'ENOENT');
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('lease heartbeat', () => {
  it('sends phase/task/machine and honours cancel:true', async () => {
    const sent = [];
    let cancelled = 0;
    const heartbeat = new Heartbeat({
      send: async (body) => {
        sent.push(body);
        return { lease_until: '2026-10-07T12:00:00Z', cancel: true };
      },
      taskId: 'T', machineId: 'M', attempt: 3,
      onCancel: () => { cancelled += 1; },
    });
    heartbeat.setPhase('running', 50);
    await heartbeat.tick();
    assert.deepEqual(sent[0], {
      task_id: 'T',
      machine_id: 'M',
      attempt: 3,
      phase: 'running',
      progress: 50,
    });
    assert.equal(cancelled, 1);
  });

  it('survives a failing heartbeat without throwing', async () => {
    const errors = [];
    const heartbeat = new Heartbeat({
      send: async () => { throw new Error('network down'); },
      taskId: 'T', machineId: 'M', attempt: 1,
      onError: (error) => errors.push(error.message),
    });
    assert.equal(await heartbeat.tick(), null);
    assert.deepEqual(errors, ['network down']);
  });

  it('is not started until start() is called, and stops cleanly', () => {
    const heartbeat = new Heartbeat({ send: async () => ({}), taskId: 'T', machineId: 'M', attempt: 1 });
    assert.equal(heartbeat.timer, null);
    heartbeat.start();
    assert.notEqual(heartbeat.timer, null);
    heartbeat.stop();
    assert.equal(heartbeat.timer, null);
  });
});

// ---------------------------------------------------------------------------
// pairing and end-to-end execution against a fake Rabbit
// ---------------------------------------------------------------------------

/**
 * Minimal Rabbit: pairing, SSE stream and result intake.
 *
 * `basePath` mounts the whole thing under a sub-path (`https://host/w2m`), which
 * is the deployment shape v0.1.2 exists for; every request path is recorded so a
 * test can prove the prefix was not eaten.
 */
async function startFakeRabbit({
  basePath = '',
  heartbeatExtra = null,
  heartbeatIdleStatus = 200,
  resultError = null,
  blobError = null,
} = {}) {
  const state = {
    pairs: [],
    results: [],
    heartbeats: [],
    streams: [],
    receivedTokens: [],
    paths: [],
    /** Status codes returned for lease-less (diagnostic) heartbeats. */
    idleHeartbeatStatuses: [],
    /**
     * One entry per SSE attach, recording exactly what the agent sent, so a test
     * can assert on the cursor it did (or did not) resume from (task-18).
     *
     * @type {Array<{seq: string|null, lastEventId: string|null, url: string}>}
     */
    attaches: [],
    /**
     * Every request, verbatim: method, path *with query* (what `req.url` holds
     * on the relay side), headers, and the exact body text -- everything
     * `verifyRequest` needs in order to check a signature for real (task-26).
     *
     * @type {Array<{method: string, path: string, headers: Record<string,string>, rawBody: string, body: object|null}>}
     */
    requests: [],
    blobs: [],
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = null;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      state.paths.push(url.pathname);
      state.receivedTokens.push(request.headers.authorization ?? null);
      state.requests.push({
        method: request.method ?? 'GET',
        // `req.url` on the relay side is path + query, sub-path included.
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers },
        rawBody: raw,
        body,
      });
      // Everything is served under `basePath`; anything outside it is a 404,
      // exactly like a relay behind `--base-path`.
      if (basePath !== '' && !url.pathname.startsWith(`${basePath}/`)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
        return;
      }
      const pathname = basePath === '' ? url.pathname : url.pathname.slice(basePath.length);

      if (pathname === '/v1/stream') {
        state.attaches.push({
          seq: url.searchParams.get('seq'),
          lastEventId: request.headers['last-event-id'] ?? null,
          url: request.url,
        });
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const stream = {
          response,
          seq: 0,
          closed: false,
          /**
           * @param {string} type
           * @param {object} payload
           */
          send(type, payload) {
            if (stream.closed) return;
            stream.seq += 1;
            response.write(`id: ${stream.seq}\nevent: ${type}\ndata: ${JSON.stringify({ type, seq: stream.seq, ...payload })}\n\n`);
          },
          close() {
            stream.closed = true;
            response.end();
          },
        };
        state.streams.push(stream);
        response.on('close', () => {
          stream.closed = true;
        });
        return;
      }

      if (pathname === '/v1/pair') {
        state.pairs.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ device_token: 'tok-e2e', protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z' }));
        return;
      }
      if (pathname === '/v1/heartbeat') {
        state.heartbeats.push(body);
        // An idle diagnostic heartbeat (v0.3.0) carries no `task_id`; a
        // pre-v0.3.0 relay answers it with 404 because it insists on a lease.
        const isIdle = !body || !Object.prototype.hasOwnProperty.call(body, 'task_id');
        if (isIdle && heartbeatIdleStatus !== 200) {
          state.idleHeartbeatStatuses.push(heartbeatIdleStatus);
          response.writeHead(heartbeatIdleStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        // `heartbeatExtra` lets a test play a *newer* relay that answers with
        // fields this agent has never heard of (v0.3.0 compatibility).
        response.end(
          JSON.stringify({ lease_until: '2026-10-07T12:10:00Z', cancel: false, ...(heartbeatExtra ?? {}) }),
        );
        return;
      }
      // v1.2.4: the content-addressed blob route a large pipeline stage uploads to. Records the sha and the exact body so a
      // test can verify the name IS the hash of what was sent.
      if (pathname.startsWith('/v1/fleet/blobs/')) {
        // v1.2.10: a reduce task's agent FETCHES the artifacts it reduces, so the fake relay serves what it stored.
        if (request.method === 'GET') {
          const wanted = decodeURIComponent(pathname.slice('/v1/fleet/blobs/'.length));
          const stored = state.blobs.find((blob) => blob.sha === wanted) ?? null;
          if (stored === null) {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
            return;
          }
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.end(stored.raw);
          return;
        }
        if (blobError) {
          response.writeHead(blobError.status ?? 500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: blobError.code ?? 'BLOB_REFUSED' } }));
          return;
        }
        state.blobs.push({ sha: decodeURIComponent(pathname.slice('/v1/fleet/blobs/'.length)), raw });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, sha256: decodeURIComponent(pathname.slice('/v1/fleet/blobs/'.length)) }));
        return;
      }
      if (pathname === '/v1/result') {
        if (resultError) {
          // Play a relay that refuses the result for a protocol reason (a bad
          // signature, a missing operator token, — so the agent's reporting of
          // *why* can be asserted.
          response.writeHead(resultError.status, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { code: resultError.code, message: resultError.message ?? 'refused' } }),
          );
          return;
        }
        state.results.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, deduped: false }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Wait for the agent to open a stream, then return it. */
    async stream(timeoutMs = 10_000) {
      return waitFor(() => state.streams.find((entry) => !entry.closed), {
        timeoutMs,
        label: 'SSE stream',
      });
    },
    async close() {
      for (const stream of state.streams) stream.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Build an agent wired to the shared fixtures.
 *
 * Module scope so every describe block -- including the v0.1.2 reconnection
 * suite -- constructs the agent identically.
 *
 * @param {object} options
 * @param {string} options.rabbit
 * @param {string} options.project
 * @param {string[]} options.allowed
 * @param {Array<{level: string, message: string, extra: object}>} [options.logs]
 */
function makeAgent({
  rabbit,
  project,
  allowed,
  once = true,
  name = 'e2e',
  stringForm = false,
  logs,
  idleHeartbeatIntervalMs,
  signingSecret,
  redactOutput,
}) {
  const stateDir = join(root, `e2e-state-${name}`);
  const serialized = allowed.map((prefix) => prefix.join(' '));
  const log = logs
    ? (level, message, extra) => logs.push({ level, message, extra: extra ?? {} })
    : () => {};
  return createAgent({
    rabbitUrl: rabbit,
    project,
    stateDir,
    identity: {
      machine_id: '3f2a1111-2222-4333-8444-555566667777',
      machine_name: 'win-e2e',
      device_token: 'tok-e2e',
      rabbit_url: rabbit,
    },
    caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
    platform: { os: 'windows', os_version: '10.0', arch: 'x64', shell: 'cmd', shell_version: null },
    // The documented API accepts both forms; `stringForm` exercises the raw
    // `['node -e']` shape that a caller would read straight off the CLI.
    allowedCommands: stringForm ? serialized : parseAllowedCommands(JSON.stringify(serialized)),
    once,
    // The contract's cadence is 10s (asserted via HEARTBEAT_INTERVAL_MS); the
    // end-to-end tests use a fast cadence so cancel does not cost 10s.
    heartbeatIntervalMs: 150,
    ...(idleHeartbeatIntervalMs === undefined ? {} : { idleHeartbeatIntervalMs }),
    ...(signingSecret === undefined ? {} : { signingSecret }),
    ...(redactOutput === undefined ? {} : { redactOutput }),
    log,
    tmpDir: root,
    // Isolation: these tests must see the standing policy (no capability), not whatever a developer
    // activated in the plugin UI on this machine. A missing file reads as `denied`.
    execCapabilityFile: join(root, 'e2e-exec-capability.json'),
  });
}

describe('Localside agent end to end', () => {
  it('accepts the documented string form of allowedCommands and runs a task', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-stringform');
    try {
      // Regression: passing `['node -e']` (the shape task-8 documents) used to
      // crash `start()` with `prefix.join is not a function`.
      const agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        name: 'stringform',
        stringForm: true,
      });
      assert.deepEqual(agent.allowedCommands, [['node', '-e']]);

      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-STRINGFORM',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("string-form\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-stringform',
      });
      await running;

      assert.equal(rabbit.state.results.length, 1);
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'ok');
      assert.equal(envelope.stdout_sha256, sha256Hex('string-form\n'));
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('uploads a large pipeline stage as a blob and names it in the envelope (v1.2.4)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-dataflow-blob');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'dataflow-blob' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      const big = 'x'.repeat(70_000); // > MAX_INLINE_BYTES (64 KiB)
      // Generated at run time: a 70 KiB argv is rejected by Windows' CreateProcess limit long before the stage
      // could run, which is a property of the test rather than of the feature.
      const argv = [NODE, '-e', 'process.stdout.write("x".repeat(70000))'];
      stream.send('task.offer', {
        task_id: '01J-E2E-DATAFLOW-BLOB',
        attempt: 1,
        mode: 'pipeline',
        index: 0,
        index_total: 1,
        command_argv: argv,
        stages: [{ command_argv: argv }],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-dataflow-blob',
      });
      await running;

      assert.equal(rabbit.state.blobs.length, 1, 'exactly one blob was uploaded');
      const uploaded = rabbit.state.blobs[0];
      const sha = sha256Hex(big);
      assert.equal(uploaded.sha, sha, 'the blob name is the hash of the stage output');
      assert.equal(uploaded.raw, big, 'the relay received the exact bytes');

      const envelope = rabbit.state.results[0];
      assert.equal(envelope.blob_sha256, sha, 'the envelope names the blob');
      assert.equal(envelope.output_mode, 'blob');
      assert.equal(envelope.stdout_head, '', 'a blob envelope does not also inline the head');
      assert.equal(envelope.pipeline.stages[0].blob_sha256, sha, 'the stage record names it too');
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('uploads a large plain-command stdout as a blob, so a reduce can see a map result (v1.2.7)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-plain-blob');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'plain-blob' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      const big = 'x'.repeat(70_000);
      const argv = [NODE, '-e', 'process.stdout.write("x".repeat(70000))'];
      stream.send('task.offer', {
        task_id: '01J-E2E-PLAIN-BLOB',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: argv,
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-plain-blob',
      });
      await running;

      assert.equal(rabbit.state.blobs.length, 1, 'a plain command above the inline cap uploads exactly one blob');
      const uploaded = rabbit.state.blobs[0];
      const sha = sha256Hex(big);
      assert.equal(uploaded.sha, sha, 'the blob name is the hash of the command output');
      assert.equal(uploaded.raw, big, 'the exact bytes were uploaded');
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.blob_sha256, sha, 'the envelope names the blob');
      assert.equal(envelope.output_mode, 'blob');
      assert.equal(envelope.stdout_head, '', 'a blob envelope does not also inline the head');
      assert.equal(envelope.pipeline ?? null, null, 'a plain command is not a pipeline');
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });
  it('fetches reduce artifacts before running the reduce command (v1.2.10)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-reduce-fetch');
    try {
      const artifact = 'artifact-bytes-from-map';
      const sha = sha256Hex(artifact);
      rabbit.state.blobs.push({ sha, raw: Buffer.from(artifact, 'utf8') });
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'reduce-fetch' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      const script = 'const m=JSON.parse(require("fs").readFileSync(process.env.W2M_REDUCE_MANIFEST,"utf8"));const f=require("fs").readFileSync(m.inputs[0].file,"utf8");process.stdout.write(JSON.stringify({of:process.env.W2M_REDUCE_OF,n:m.inputs.length,machine:m.inputs[0].machine_id,bytes:m.inputs[0].bytes,data:f}));';
      stream.send('task.offer', {
        task_id: '01J-E2E-REDUCE-FETCH',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', script],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-reduce-fetch',
        reduce_of: '01J-MAP-TASK',
        reduce_inputs: [{ machine_id: 'm1', sha256: sha }],
      });
      await running;

      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'ok');
      const parsed = JSON.parse(envelope.stdout_head);
      assert.equal(parsed.of, '01J-MAP-TASK', 'the reduce knows which map task it belongs to');
      assert.equal(parsed.n, 1);
      assert.equal(parsed.machine, 'm1');
      assert.equal(parsed.bytes, Buffer.byteLength(artifact));
      assert.equal(parsed.data, artifact, 'the exact artifact bytes were written to the input file');
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });
  it('fails the stage by name when the blob upload is refused (v1.2.4)', async () => {
    const rabbit = await startFakeRabbit({ blobError: { status: 500, code: 'BLOB_REFUSED' } });
    const project = await makeRepo('e2e-dataflow-blob-fail');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'dataflow-blob-fail' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      const argv = [NODE, '-e', 'process.stdout.write("y".repeat(70000))'];
      stream.send('task.offer', {
        task_id: '01J-E2E-DATAFLOW-BLOB-FAIL',
        attempt: 1,
        mode: 'pipeline',
        index: 0,
        index_total: 1,
        command_argv: argv,
        stages: [{ command_argv: argv }],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-dataflow-blob-fail',
      });
      await running;

      const envelope = rabbit.state.results[0];
      assert.equal(envelope.pipeline.stages[0].status, 'failed');
      assert.equal(envelope.pipeline.stages[0].refusal_reason, 'BLOB_UPLOAD_FAILED');
      assert.equal(rabbit.state.blobs.length, 0, 'nothing was stored');
      assert.equal(envelope.blob_sha256, undefined, 'no reference to a blob that does not exist');
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('signs the command it ran, and a tampered argv hash fails verification (v1.2.6)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-sign');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'sign' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-SIGN', attempt: 1, mode: 'replicate', index: 0, index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("signed\\n")'],
        cwd_rel: '.', write: false, timeout_ms: 30_000, dedupe_key: 'dk-e2e-sign',
      });
      await running;
      const envelope = rabbit.state.results[0];
      assert.ok(envelope.signature, 'the envelope carries a signature');
      assert.equal(envelope.signature.alg, 'ed25519');
      const verdict = verifyEnvelopeSignature({
        signature: envelope.signature,
        task_id: envelope.task_id,
        argv_hash: envelope.command_hash,
        machine_id: envelope.machine_id,
      });
      assert.equal(verdict, 'signed', 'the signature verifies against the command hash');
      const tampered = verifyEnvelopeSignature({
        signature: envelope.signature,
        task_id: envelope.task_id,
        argv_hash: 'b'.repeat(64),
        machine_id: envelope.machine_id,
      });
      assert.equal(tampered, 'bad_signature', 'a different argv hash must not verify');
      assert.equal(verifyEnvelope(envelope), true);
    } finally { await rabbit.close(); }
  });

  it('replaces a secret a command printed, before the envelope leaves the machine (v1.2.6)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-redact-on');
    try {
      const RAW = 'token sk-abcdefghijklmnop1234';
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'redact-on' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-REDACT-ON', attempt: 1, mode: 'replicate', index: 0, index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write(' + JSON.stringify(RAW) + ')'],
        cwd_rel: '.', write: false, timeout_ms: 30_000, dedupe_key: 'dk-e2e-redact-on',
      });
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.stdout_head.includes('sk-abcdefghijklmnop1234'), false, 'the secret must not reach the relay');
      assert.match(envelope.stdout_head, /\[redacted:api-key\]/);
      assert.equal(envelope.redacted[0].field, 'stdout_head');
      assert.equal(envelope.stdout_sha256, sha256Hex(RAW), 'raw bytes stay the evidence');
      assert.equal(verifyEnvelope(envelope), true);
    } finally { await rabbit.close(); }
  });

  it('says unredacted: true when the operator turns redaction off (v1.2.6)', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-redact-off');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'redact-off', redactOutput: false });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-REDACT-OFF', attempt: 1, mode: 'replicate', index: 0, index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("token sk-abcdefghijklmnop1234\\n")'],
        cwd_rel: '.', write: false, timeout_ms: 30_000, dedupe_key: 'dk-e2e-redact-off',
      });
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.stdout_head.includes('sk-abcdefghijklmnop1234'), true, 'off means off');
      assert.equal(envelope.unredacted, true, 'and it says so');
      assert.equal(verifyEnvelope(envelope), true);
    } finally { await rabbit.close(); }
  });

  it('pairs, runs an allowed offer and delivers a verifiable envelope', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-run');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']] });

      // Pairing first: the contract's §2.2 exchange.
      const paired = await agent.pair('PAIR-7K2M9QX4');
      assert.equal(paired.device_token, 'tok-e2e');
      assert.equal(rabbit.state.pairs[0].machine_id, '3f2a1111-2222-4333-8444-555566667777');
      assert.equal(rabbit.state.pairs[0].pairing_code, 'PAIR-7K2M9QX4');
      assert.deepEqual(Object.keys(rabbit.state.pairs[0].caps).sort(), [...CAPS_KEYS].sort());
      // v1.2.6: pairing is where the relay learns which key this machine signs envelopes with.
      assert.equal(typeof rabbit.state.pairs[0].public_key, 'string');
      assert.ok(rabbit.state.pairs[0].public_key.length > 0, 'the signing public key travels with the pairing request');

      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-1',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("hello\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        base_commit: await git(project, ['rev-parse', 'HEAD']),
        base_tree: await git(project, ['rev-parse', 'HEAD^{tree}']),
        requirements: { toolchain: { node: '>=20' }, platform: ['windows'] },
        compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true },
        dedupe_key: 'dk-e2e-1',
        deadline: '2026-10-07T13:00:00Z',
      });

      await running;

      assert.equal(rabbit.state.results.length, 1);
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'ok');
      assert.equal(envelope.exit_code, 0);
      assert.equal(envelope.stdout_sha256, sha256Hex('hello\n'));
      assert.equal(envelope.stdout_bytes, 6);
      assert.equal(envelope.shell_id, 'direct-exec');
      assert.equal(envelope.fingerprint_algo, 'git-temp-index-tree/v1');
      assert.equal(envelope.pre_tree_fingerprint, envelope.base_tree, 'clean repo must match base_tree');
      assert.equal(envelope.dirty_before, false);
      assert.equal(envelope.refusal_reason, null);
      assert.equal(envelope.dedupe_key, 'dk-e2e-1');
      assert.equal(verifyEnvelope(envelope), true);
      assert.equal(envelope.command_hash, commandHash(envelope.command_argv, SHELL_ID, '.'));
      for (const field of REQUIRED_ENVELOPE_FIELDS) assert.ok(field in envelope, `missing ${field}`);

      // Spool is emptied only because Rabbit answered 200.
      assert.equal(agent.spool.list().length, 0);
      // Assert the heartbeat *mechanism* fired, not that a particular phase was
      // caught in the act. `running` heartbeats arrive on a 10s interval, and
      // this offer completes in well under a second, so requiring one here made
      // the test depend on machine speed: it passed on a slower Windows runner
      // and failed on macOS. That the phase is emitted at all is covered by the
      // heartbeat unit tests, which drive the clock directly.
      assert.ok(
        rabbit.state.heartbeats.length > 0,
        'the agent must heartbeat while handling an offer',
      );
      assert.ok(rabbit.state.heartbeats.some((beat) => beat.phase === 'preparing'));
      assert.ok(rabbit.state.heartbeats.every((beat) => beat.machine_id === '3f2a1111-2222-4333-8444-555566667777'));
      assert.ok(rabbit.state.receivedTokens.includes('Bearer tok-e2e'));
    } finally {
      await rabbit.close();
    }
  });

  it('refuses a command outside the allow-list without running it', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-refuse');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'refuse' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-REFUSE',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '--test'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-refuse',
      });
      await running;

      assert.equal(rabbit.state.results.length, 1);
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, REFUSAL.COMMAND_NOT_ALLOWED);
      assert.equal(envelope.exit_code, null);
      assert.equal(envelope.stdout_bytes, 0);
      assert.equal(verifyEnvelope(envelope), true);
      assert.equal(agent.spool.list().length, 0);
    } finally {
      await rabbit.close();
    }
  });

  it('refuses a whole pipeline when a later stage is outside the allow-list, and runs no stage', async () => {
    // HIGH-1: `mode:'pipeline'` was gated on the offer's `command_argv`, which the relay sets to
    // `stages[0].command_argv`, so every stage after the first was unchecked on the machine that ran
    // it -- and a dispatcher that posts straight to `/v1/task` never touches the plugin's pre-flight.
    // The whole chain is refused before anything runs, and the refusal names the stage.
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-pipeline-list');
    try {
      const witness = join(project, 'stage0-ran.txt');
      const proof = join(project, 'stage1-proof.txt');
      // Stage 0 is an ordinary allowed invocation with a side effect, so "nothing ran" is a fact about
      // the filesystem rather than about a status field. The entry names `-e` because that is what
      // stage 0 uses -- a trailing `-e` is refused by the matcher as code the entry never named, so an
      // entry of just `node` would refuse stage 0 too and prove nothing about stage 1.
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'pipeline-list' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-PIPELINE-ALLOWLIST',
        attempt: 1,
        mode: 'pipeline',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(witness)}, 'ran')`],
        stages: [
          { command_argv: [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(witness)}, 'ran')`] },
          // The stage the entry does not cover. It is the *second* stage, which is the whole defect.
          { command_argv: [NODE, '--test', 'two.test.mjs'] },
        ],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-pipeline-allowlist',
      });
      await running;

      assert.equal(rabbit.state.results.length, 1);
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, MATCH_REFUSAL.NOT_ALLOWED, "the matcher's code, not a second spelling");
      assert.equal(envelope.exit_code, null);
      assert.equal(verifyEnvelope(envelope), true);
      assert.equal(envelope.protocol_violations.length, 1, 'the stage that failed travels with the envelope');
      assert.match(envelope.protocol_violations[0], /^stage 1: COMMAND_NOT_ALLOWED/);
      // `--test` is not on the entry, so the second stage is refused -- which is the point. The
      // first stage's own side effect must not have happened either: the chain is refused as a whole.
      assert.equal(existsSync(proof), false, 'the disallowed stage must not have run');
      assert.equal(existsSync(witness), false, 'nor may an allowed earlier stage run before the refusal');
    } finally {
      await rabbit.close();
    }
  });

  it('refuses a stage carrying a code-loading argument under the code the plugin pre-flight reports', async () => {
    // The two ends of one rule, on one chain. The plugin's dispatch pre-flight refuses
    // `stages: ['node --test', 'node --test --test-reporter=file:///E:/evil.mjs']` with
    // `reason_code: COMMAND_REPARSING_ARGUMENT` and `stage_index: 1` (test/tools.test.mjs); this is
    // the same chain reaching a real agent, which must refuse it with the same code and must name the
    // same stage. A shared matcher is only worth sharing if the two answers cannot differ.
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-pipeline-reparsing');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '--test']], name: 'pipeline-reparse' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-PIPELINE-REPARSING',
        attempt: 1,
        mode: 'pipeline',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '--test'],
        stages: [
          // Allowed on its own: `node --test` with no arguments runs zero tests and exits 0.
          { command_argv: [NODE, '--test'] },
          { command_argv: [NODE, '--test', '--test-reporter=file:///E:/evil-reporter.mjs'] },
        ],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-pipeline-reparsing',
      });
      await running;

      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(
        envelope.refusal_reason,
        MATCH_REFUSAL.REPARSING_ARGUMENT,
        'the code the plugin pre-flight reports for this same chain',
      );
      assert.equal(envelope.protocol_violations.length, 1);
      assert.match(envelope.protocol_violations[0], /^stage 1: COMMAND_REPARSING_ARGUMENT/);
      assert.match(envelope.protocol_violations[0], /--test-reporter/, 'and the argument that caused it');
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('runs every stage of a pipeline whose stages are all allowed', async () => {
    // The direction that must keep working. A chain the allow-list covers runs, in order, and the
    // per-stage record still says so.
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-pipeline-ok');
    try {
      const witness = join(project, 'order.txt');
      const stageArgv = (name) => [
        NODE,
        '-e',
        `require('fs').appendFileSync(${JSON.stringify(witness)}, ${JSON.stringify(`${name}\n`)})`,
      ];
      // `-e` is named by the entry: it is the argument these stages use, and a *trailing* `-e` is
      // refused precisely because it would let an entry that names only the tool run arbitrary source.
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'pipeline-ok' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-PIPELINE-OK',
        attempt: 1,
        mode: 'pipeline',
        index: 0,
        index_total: 1,
        command_argv: stageArgv('one'),
        stages: [
          { command_argv: stageArgv('one') },
          { command_argv: stageArgv('two') },
        ],
        cwd_rel: '.',
        write: false,
        timeout_ms: 60_000,
        dedupe_key: 'dk-e2e-pipeline-ok',
      });
      await running;

      const envelope = rabbit.state.results[0];
      assert.equal(
        envelope.status,
        'ok',
        `every stage is covered by the entry, so the chain must run: ${JSON.stringify({
          status: envelope.status,
          refusal_reason: envelope.refusal_reason,
          protocol_violations: envelope.protocol_violations,
          warnings: envelope.warnings,
          exit_code: envelope.exit_code,
          stages: envelope.pipeline?.stages,
          stdout_head: envelope.stdout_head,
          stderr_head: envelope.stderr_head,
        })}`,
      );
      assert.equal(envelope.refusal_reason, null);
      assert.equal(
        existsSync(witness),
        true,
        `the stages must write the witness: ${JSON.stringify({
          argv: envelope.command_argv,
          stages: envelope.pipeline?.stages,
          stdout_head: envelope.stdout_head,
          stderr_head: envelope.stderr_head,
          cwd_rel: envelope.cwd_rel,
          project,
        })}`,
      );
      assert.equal(readFileSync(witness, 'utf8'), 'one\ntwo\n', 'the stages ran in order');
      assert.deepEqual(envelope.pipeline.stages.map((s) => s.status), ['ok', 'ok']);
      assert.equal(envelope.pipeline.stopped_at, null);
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('refuses on a capability mismatch before executing', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-gate');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'gate' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-GATE',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("x")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        requirements: { toolchain: { node: '>=99' }, platform: ['macos'] },
        dedupe_key: 'dk-e2e-gate',
      });
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, 'MISSING_NODE');
      assert.equal(envelope.exit_code, null);
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('stops a running command when task.cancel arrives', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-cancel');
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], name: 'cancel' });
      const started = Date.now();
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-CANCEL',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'setTimeout(() => {}, 60_000)'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 60_000,
        dedupe_key: 'dk-e2e-cancel',
      });

      await waitFor(() => rabbit.state.heartbeats.some((beat) => beat.phase === 'running'), {
        label: 'running heartbeat',
      });
      stream.send('task.cancel', { task_id: '01J-E2E-CANCEL', reason: 'superseded' });
      await running;
      const elapsed = Date.now() - started;

      assert.equal(rabbit.state.results.length, 1);
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'crashed');
      assert.equal(envelope.exit_code, null);
      assert.equal(envelope.signal, 'SIGTERM');
      assert.ok(elapsed < 30_000, `cancel should be prompt, took ${elapsed}ms`);
      assert.equal(verifyEnvelope(envelope), true);
    } finally {
      await rabbit.close();
    }
  });

  it('answers a transport re-delivery from cache but re-runs a new attempt', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('e2e-dedupe');
    const marker = join(project, 'runs.txt');
    const runCount = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0);
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], once: false, name: 'dedupe' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      const offer = {
        task_id: '01J-E2E-DEDUPE',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [
          NODE,
          '-e',
          `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n')`,
        ],
        cwd_rel: '.',
        write: false,
        timeout_ms: 30_000,
        dedupe_key: 'dk-e2e-dedupe',
      };
      stream.send('task.offer', offer);
      await waitFor(() => rabbit.state.results.length === 1, { label: 'first result' });

      // Same (machine_id, dedupe_key, attempt) again: a transport re-delivery,
      // so it must be answered without executing a second time.
      stream.send('task.offer', { ...offer });
      await waitFor(() => rabbit.state.results.length === 2, { label: 'cached resend' });
      assert.equal(runCount(), 1, 'command ran again for an identical attempt');
      assert.equal(rabbit.state.results[1].attempt, 1);
      assert.equal(rabbit.state.results[1].stdout_sha256, rabbit.state.results[0].stdout_sha256);

      // attempt=2 is a genuine retry (§4.4 keeps attempt out of dedupe_key):
      // it must execute and report its own attempt.
      stream.send('task.offer', { ...offer, attempt: 2 });
      await waitFor(() => rabbit.state.results.length === 3, { label: 'retry result' });
      assert.equal(runCount(), 2, 'a new attempt must actually run');
      assert.equal(rabbit.state.results[2].attempt, 2);

      agent.stop();
      await running;
    } finally {
      await rabbit.close();
    }
  });

  it('rejects a stream whose protocol version is not 1', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ device_token: 'x', protocol_version: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const agent = createAgent({
      rabbitUrl: 'http://127.0.0.1:1',
      project: root,
      stateDir: join(root, 'e2e-state-mismatch'),
      identity: { machine_id: newMachineId(), machine_name: 'x', device_token: null, rabbit_url: null },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
      platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
      allowedCommands: [],
      fetchImpl,
      log: () => {},
    });
    await assert.rejects(() => agent.pair('PAIR-00000000'), (error) => error.code === 'PROTOCOL_MISMATCH');
    assert.equal(calls.length, 1);
  });

  it('keeps an envelope in the spool when Rabbit is unreachable', async () => {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/v1/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(`id: 1\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', seq: 1 })}\n\n`);
          response.write(
            `id: 2\nevent: task.offer\ndata: ${JSON.stringify({
              type: 'task.offer',
              seq: 2,
              task_id: '01J-E2E-UNDELIVERED',
              attempt: 1,
              mode: 'replicate',
              index: 0,
              index_total: 1,
              command_argv: [NODE, '-e', 'process.stdout.write("x")'],
              cwd_rel: '.',
              write: false,
              timeout_ms: 10_000,
              dedupe_key: 'dk-e2e-undelivered',
            })}\n\n`,
          );
          return;
        }
        if (url.pathname === '/v1/heartbeat') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ cancel: false }));
          return;
        }
        // /v1/result: hard failure, so the envelope must stay spooled.
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'INTERNAL' } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const project = await makeRepo('e2e-undelivered');
    const stateDir = join(root, 'e2e-state-undelivered');
    try {
      const agent = createAgent({
        rabbitUrl: `http://127.0.0.1:${port}`,
        project,
        stateDir,
        identity: { machine_id: newMachineId(), machine_name: 'x', device_token: 'tok', rabbit_url: null },
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
        platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
        allowedCommands: parseAllowedCommands('["node -e"]'),
        once: true,
        log: () => {},
        resultRetries: 1,
      });
      await agent.start();
      const pending = agent.spool.pendingResults();
      assert.equal(pending.length, 1, 'an undelivered envelope must remain spooled');
      assert.equal(pending[0].task_id, '01J-E2E-UNDELIVERED');
      assert.equal(verifyEnvelope(pending[0].envelope), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// v0.1.2 §2: base address and endpoint joining
// ---------------------------------------------------------------------------

describe('base URL and endpoint joining (v0.1.2 §2)', () => {
  const BASES = [
    'http://127.0.0.1:8787',
    'http://100.64.0.5:8787',
    'https://w2m.example.com',
    'https://w2m.example.com/',
    'https://w2m.example.com/w2m',
    'https://w2m.example.com/w2m/',
    'https://w2m.example.com/team-a/w2m',
    'http://[::1]:8787',
  ];
  const NORMALIZED = [
    'http://127.0.0.1:8787',
    'http://100.64.0.5:8787',
    'https://w2m.example.com',
    'https://w2m.example.com',
    'https://w2m.example.com/w2m',
    'https://w2m.example.com/w2m',
    'https://w2m.example.com/team-a/w2m',
    'http://[::1]:8787',
  ];
  const PATHS = ['/v1/stream', 'v1/stream', '/v1/stream?machine_id=x&seq=2', '/healthz', 'v1/pair'];

  it('normalises eight base shapes', () => {
    assert.equal(BASES.length, 8);
    BASES.forEach((base, index) => {
      assert.equal(resolveBaseUrl(base), NORMALIZED[index], base);
    });
  });

  it('joins eight bases x five paths without eating a sub-path or collapsing the scheme', () => {
    assert.equal(PATHS.length, 5);
    for (const [index, base] of BASES.entries()) {
      const normalized = NORMALIZED[index];
      for (const path of PATHS) {
        const joined = joinUrl(resolveBaseUrl(base), path);
        assert.equal(joined, `${normalized}/${path.replace(/^\/+/, '')}`, `joinUrl(${base}, ${path})`);
        assert.match(joined, /^https?:\/\//, 'the scheme double slash must survive');
        assert.ok(joined.startsWith(`${normalized}/`), 'the base must survive verbatim');
      }
    }
    assert.equal(BASES.length * PATHS.length, 40, 'the matrix is 40 combinations');
  });

  it('keeps exactly the sub-path that the v1 client used to eat', () => {
    const base = resolveBaseUrl('https://h/w2m');
    assert.equal(joinUrl(base, '/v1/stream'), 'https://h/w2m/v1/stream');
    assert.equal(
      joinUrl(base, '/v1/stream?machine_id=m1&seq=2'),
      'https://h/w2m/v1/stream?machine_id=m1&seq=2',
    );
    assert.equal(joinUrl('https://h/w2m/', 'v1/result'), 'https://h/w2m/v1/result');
    assert.equal(joinUrl('https://h/w2m/', '/v1/result'), 'https://h/w2m/v1/result');
    // Stated as the wrong answer so nobody "simplifies" it back to a URL resolve.
    assert.notEqual(joinUrl(base, '/v1/stream'), 'https://h/v1/stream');
  });

  it('rejects unusable rabbitUrl values, naming rabbitUrl and the reason', () => {
    const bad = [
      'https://w2m.example.com?x=1',
      'https://w2m.example.com/w2m?a=1',
      'https://w2m.example.com#frag',
      'https://w2m.example.com/w2m#frag',
      'https://w2m.example.com/w2m?',
      'ftp://w2m.example.com',
      'file:///tmp/w2m',
      'not a url',
      '',
      '   ',
      null,
      undefined,
      42,
    ];
    for (const value of bad) {
      assert.throws(
        () => resolveBaseUrl(value),
        (error) => {
          assert.equal(error.code, 'RABBIT_URL_INVALID');
          assert.match(error.message, /rabbitUrl/);
          return true;
        },
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
    assert.throws(() => resolveBaseUrl('https://h/w2m?x=1'), /query string/);
    assert.throws(() => resolveBaseUrl('https://h/w2m#f'), /fragment/);
    assert.throws(() => resolveBaseUrl('ftp://h'), /http or https/);
  });

  it('fails at agent construction, not at first request', () => {
    const project = scratch('url-guard');
    const build = (rabbitUrl, name) =>
      createAgent({
        rabbitUrl,
        project,
        stateDir: join(root, `url-guard-state-${name}`),
        identity: { machine_id: newMachineId(), machine_name: 'x', device_token: 't', rabbit_url: null },
        caps: {},
        platform: { os: 'windows' },
        allowedCommands: [],
        log: () => {},
      });
    assert.throws(() => build('https://h?x=1', 'a'), /rabbitUrl/);
    assert.throws(() => build('', 'b'), /rabbitUrl/);
    // A sub-path is not a problem: it is normalised and exposed for logging.
    assert.equal(build('https://h/w2m/', 'c').baseUrl, 'https://h/w2m');
  });

  it('composes endpoints through endpointUrl too', () => {
    assert.equal(endpointUrl('https://h/w2m/', '/v1/task'), 'https://h/w2m/v1/task');
    assert.equal(endpointUrl('http://[::1]:8787', 'healthz'), 'http://[::1]:8787/healthz');
    assert.equal(endpointUrl('http://[::1]:8787/', '/healthz'), 'http://[::1]:8787/healthz');
  });

  it('contains no base-resolving URL constructor or posix join in client code', () => {
    // Regression guard for the exact defect: `new URL(path, base)` and
    // `path.posix.join` both destroy a deployment sub-path or the scheme.
    const stripComments = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const agentDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent');
    for (const file of ['url.mjs', 'agent.mjs']) {
      const source = stripComments(readFileSync(join(agentDir, file), 'utf8'));
      assert.doesNotMatch(source, /new URL\([^)]*,/, `${file} must not resolve a path against a base`);
      assert.doesNotMatch(source, /posix\.join/, `${file} must not use path.posix.join`);
    }
  });
});

// ---------------------------------------------------------------------------
// v0.1.2 §8: relay restarts, RTT visibility, replay window, reconnect logging
// ---------------------------------------------------------------------------

describe('cross-network reconnection (v0.1.2 §8)', () => {
  it('resets the seq cursor when relay_id changes, keeps it when it does not', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('relay-id');
    const logs = [];
    try {
      const agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'relayid',
        logs,
      });
      const running = agent.start();
      const readyCount = () => logs.filter((entry) => entry.message === 'stream ready').length;

      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-A', machine_id: 'rabbit' });
      await waitFor(() => readyCount() === 1, { label: 'first ready' });
      first.send('peer.hello', { machine_id: 'peer-1' });
      first.send('peer.hello', { machine_id: 'peer-2' });
      await waitFor(() => agent.state.seq >= 3, { label: 'cursor advanced' });
      const cursorBefore = agent.state.seq;
      assert.equal(agent.state.relayId, 'relay-A');

      // Same relay reconnects (proxy idle timeout): the cursor must survive.
      first.close();
      const second = await rabbit.stream();
      assert.notEqual(second, first);
      second.send('ready', { protocol_version: 1, relay_id: 'relay-A', seq: 1, machine_id: 'rabbit' });
      await waitFor(() => readyCount() === 2, { label: 'second ready' });
      assert.equal(agent.state.seq, cursorBefore, 'an unchanged relay_id must not reset the cursor');
      assert.equal(agent.state.relayIdChanges, 0);

      // A restarted relay numbers events from 1 again: the cursor is **discarded**
      // (not adopted), and the stream it was sent on is dropped in favour of a
      // cursor-less attach -- see the task-18 cases below.
      second.close();
      const third = await rabbit.stream();
      third.send('ready', { protocol_version: 1, relay_id: 'relay-B', seq: 1, machine_id: 'rabbit' });
      await waitFor(() => agent.state.relayIdChanges === 1, { label: 'relay restart detected' });
      assert.equal(
        agent.state.seq,
        0,
        'a new relay_id must discard the seq cursor rather than adopt the ready frame position',
      );
      assert.equal(agent.state.cursorRelayId, null, 'a discarded cursor has no owning relay');
      assert.equal(agent.state.relayId, 'relay-B');
      assert.ok(
        logs.some((entry) => entry.level === 'warn' && /relay restarted/.test(entry.message)),
        'a relay restart must be logged as a warning',
      );

      agent.stop();
      await running;
    } finally {
      await rabbit.close();
    }
  });

  it('summarises heartbeat round trips into a five-sample window', () => {
    assert.equal(RTT_WINDOW, 5);
    assert.deepEqual(summarizeRtt([]), { last: null, avg: null, samples: [] });
    assert.deepEqual(summarizeRtt([10.4, 20.6]), { last: 21, avg: 16, samples: [10, 21] });
    const summary = summarizeRtt([10, 20, 30, 40, 50, 60, 70]);
    assert.deepEqual(summary.samples, [30, 40, 50, 60, 70], 'only the newest five are kept');
    assert.equal(summary.last, 70);
    assert.equal(summary.avg, 50);
    assert.deepEqual(summarizeRtt([Number.NaN, 5, Number.POSITIVE_INFINITY]), {
      last: 5,
      avg: 5,
      samples: [5],
    });
  });

  it('records RTT on agent state without adding an envelope field', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('rtt');
    try {
      const agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'rtt',
      });
      assert.deepEqual(agent.state.rttMs, { last: null, avg: null, samples: [] });

      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-RTT',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("rtt")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-rtt',
      });
      await running;

      assert.ok(rabbit.state.heartbeats.length >= 1, 'the run must have heartbeated');
      assert.ok(agent.state.rttMs.samples.length >= 1, 'a heartbeat must record an RTT sample');
      assert.ok(agent.state.rttMs.samples.length <= RTT_WINDOW);
      assert.equal(typeof agent.state.rttMs.last, 'number');
      assert.equal(typeof agent.state.rttMs.avg, 'number');
      assert.ok(agent.state.rttMs.last >= 0);

      const envelope = rabbit.state.results[0];
      assert.equal(
        Object.keys(envelope).some((key) => /rtt/i.test(key)),
        false,
        'RTT must not leak into the comparable envelope',
      );
    } finally {
      await rabbit.close();
    }
  });

  it('aligns the seq cursor from a REPLAY_TRUNCATED notice', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('replay');
    const logs = [];
    try {
      const agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'replay',
        logs,
      });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-R', machine_id: 'rabbit' });
      await waitFor(() => logs.some((entry) => entry.message === 'stream ready'), { label: 'ready' });

      stream.send('notice', {
        level: 'warn',
        code: 'REPLAY_TRUNCATED',
        message: 'replay window truncated',
        oldest_available_seq: 10,
      });
      await waitFor(() => agent.state.replayTruncated !== null, { label: 'replay notice handled' });
      assert.equal(agent.state.seq, 9, 'the cursor must realign to oldest_available_seq - 1');
      assert.equal(agent.state.replayTruncated.oldest_available_seq, 10);
      assert.ok(
        logs.some((entry) => entry.level === 'warn' && /seq cursor aligned to 9/.test(entry.message)),
        'the realignment must be visible in the log',
      );

      // Without the field there is nothing to align to: leave the cursor alone.
      const cursorBefore = agent.state.seq;
      const noticesBefore = logs.filter((entry) => /oldest_available_seq/.test(entry.message)).length;
      stream.send('notice', {
        level: 'warn',
        code: 'REPLAY_TRUNCATED',
        message: 'replay window truncated, no detail',
      });
      await waitFor(
        () => logs.filter((entry) => /oldest_available_seq/.test(entry.message)).length > noticesBefore,
        { label: 'second notice handled' },
      );
      assert.equal(agent.state.seq, cursorBefore, 'a notice without the field must not move the cursor');

      agent.stop();
      await running;
    } finally {
      await rabbit.close();
    }
  });

  it('logs the reconnect number and the next delay, climbing the ladder', async () => {
    let streamRequests = 0;
    const server = createServer((request, response) => {
      if (request.url.startsWith('/v1/stream')) {
        streamRequests += 1;
        // Always unavailable: every attempt is an "unstable" connection, so the
        // backoff ladder has to climb.
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'INTERNAL' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const logs = [];
    const agent = createAgent({
      rabbitUrl: `http://127.0.0.1:${port}`,
      project: await makeRepo('reconnect-log'),
      stateDir: join(root, 'e2e-state-reconnect-log'),
      identity: { machine_id: newMachineId(), machine_name: 'x', device_token: 'tok', rabbit_url: null },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
      platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
      allowedCommands: [],
      once: false,
      log: (level, message, extra) => logs.push({ level, message, extra: extra ?? {} }),
    });
    const running = agent.start();
    try {
      const reconnectLine = (n) =>
        logs.find((entry) => new RegExp(`reconnect #${n} in \\d+ms`).test(entry.message));
      await waitFor(() => reconnectLine(3), { label: 'third reconnect attempt' });
      agent.stop();
      await running;

      const ranges = [
        [250, 500],
        [500, 1000],
        [1000, 2000],
      ];
      for (let n = 1; n <= 3; n += 1) {
        const entry = reconnectLine(n);
        assert.ok(entry, `missing reconnect #${n} log line`);
        assert.equal(entry.level, 'warn');
        assert.match(entry.message, /stream error/, 'the reason must be visible');
        assert.equal(entry.extra.attempt, n, 'the attempt number must be 1-based and explicit');
        const [low, high] = ranges[n - 1];
        assert.ok(
          entry.extra.delay_ms >= low && entry.extra.delay_ms <= high,
          `reconnect #${n} delay ${entry.extra.delay_ms}ms outside ${low}-${high}ms`,
        );
      }
      assert.ok(streamRequests >= 3);
    } finally {
      agent.stop();
      await running;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps retrying gently instead of hot-looping on a cleanly closed stream', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      if (request.url.startsWith('/v1/stream')) {
        requests += 1;
        // Accept, send nothing, close immediately: a flapping tunnel.
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const logs = [];
    const agent = createAgent({
      rabbitUrl: `http://127.0.0.1:${port}`,
      project: await makeRepo('hot-loop'),
      stateDir: join(root, 'e2e-state-hot-loop'),
      identity: { machine_id: newMachineId(), machine_name: 'x', device_token: 'tok', rabbit_url: null },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
      platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
      allowedCommands: [],
      once: false,
      log: (level, message, extra) => logs.push({ level, message, extra: extra ?? {} }),
    });
    const started = Date.now();
    const running = agent.start();
    try {
      await waitFor(() => logs.some((entry) => /reconnect #3 /.test(entry.message)), {
        label: 'three backoff reconnects',
      });
      const elapsed = Date.now() - started;
      // Log line #3 is written after the first two sleeps (>=250+500ms); a hot
      // loop would reach it in a few milliseconds.
      assert.ok(
        elapsed >= 700,
        `three unstable reconnects must back off, took only ${elapsed}ms (hot loop?)`,
      );
      assert.ok(
        logs.some((entry) => /event stream closed by server/.test(entry.message)),
        'a clean close is still reported as a disconnect',
      );
      assert.ok(STABLE_STREAM_MS >= 500 && RECONNECT_DELAY_AFTER_STABLE_MS >= 0);

      // The assertion the counter existed for. `requests` was incremented on every stream attempt
      // and never read, so the test's own subject -- that reconnects stay *few* -- went unchecked:
      // an implementation that backed off for the log line while also opening a connection per
      // millisecond would have passed. Three reconnects are expected within the window the wait
      // above allows, so anything close to the elapsed time means a hot loop regardless of the
      // backoff messages.
      assert.ok(
        requests <= 12,
        `a flapping stream must not be reconnected in a tight loop; ${requests} attempts in ` +
          `${Date.now() - started}ms`,
      );
    } finally {
      agent.stop();
      await running;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// task-18: the event cursor belongs to one relay process
// ---------------------------------------------------------------------------

describe('event cursor lifecycle across relay restarts (task-18)', () => {
  it('sends the cursor only when it is usable', () => {
    // Nothing to resume.
    assert.equal(cursorUsableFor({ seq: 0, cursorRelayId: null, relayId: null }), false);
    assert.equal(cursorUsableFor({ seq: 0, cursorRelayId: 'A', relayId: 'A' }), false);
    assert.equal(cursorUsableFor({}), false);
    // A pre-v0.1.2 relay sends no relay_id: there is nothing to compare against,
    // so the v1 resume behaviour is kept.
    assert.equal(cursorUsableFor({ seq: 7, cursorRelayId: null, relayId: null }), true);
    // Same relay: resume, or every reconnect becomes a full replay.
    assert.equal(cursorUsableFor({ seq: 7, cursorRelayId: 'A', relayId: 'A' }), true);
    // Different relay process: the cursor means nothing to it.
    assert.equal(cursorUsableFor({ seq: 7, cursorRelayId: 'A', relayId: 'B' }), false);
    // The relay identifies itself but the cursor predates that identity.
    assert.equal(cursorUsableFor({ seq: 7, cursorRelayId: null, relayId: 'B' }), false);
  });

  it('still resumes from the cursor when relay_id is unchanged', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('cursor-same-relay');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'cursor-same',
      });
      running = agent.start();
      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-S', machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-S', { label: 'cursor attributed' });
      first.send('peer.hello', { machine_id: 'peer-1' });
      first.send('peer.hello', { machine_id: 'peer-2' });
      await waitFor(() => agent.state.seq >= 3, { label: 'cursor advanced' });

      assert.equal(rabbit.state.attaches.length, 1);
      assert.equal(rabbit.state.attaches[0].lastEventId, null, 'nothing to resume on a first attach');
      assert.equal(rabbit.state.attaches[0].seq, null);

      // Same relay, new socket (proxy idle timeout): the cursor MUST be sent.
      first.close();
      const second = await waitFor(() => rabbit.state.attaches[1] ?? null, { label: 'second attach' });
      assert.equal(second.lastEventId, '3', 'an unchanged relay_id must still resume');
      assert.equal(second.seq, '4', 'and must still ask for the next seq');
      assert.equal(agent.state.relayIdChanges, 0);
    } finally {
      // A leaked running agent keeps reconnecting on a timer and would keep the
      // whole test process alive forever.
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('discards the cursor and re-attaches without one when relay_id changes', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('cursor-new-relay');
    const logs = [];
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'cursor-new',
        logs,
      });
      running = agent.start();
      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-1', machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-1', { label: 'cursor attributed' });
      first.send('peer.hello', { machine_id: 'peer-1' });
      first.send('peer.hello', { machine_id: 'peer-2' });
      first.send('peer.hello', { machine_id: 'peer-3' });
      await waitFor(() => agent.state.seq >= 4, { label: 'cursor advanced' });

      // The process behind the URL is replaced. Until `ready` arrives we cannot
      // know, so this attach still carries the old cursor -- that is precisely
      // the window the fix closes.
      first.close();
      const doomed = await waitFor(() => rabbit.state.attaches[1] ?? null, { label: 'attach to relay-2' });
      assert.equal(doomed.lastEventId, '4', 'context: the doomed attach still carried the old cursor');

      const second = await rabbit.stream();
      second.send('ready', { protocol_version: 1, relay_id: 'relay-2', seq: 1, machine_id: 'rabbit' });

      // The agent must throw that stream away and attach again with no cursor at
      // all, so relay-2 replays from its own beginning (its seq 1 offer).
      const fresh = await waitFor(() => rabbit.state.attaches[2] ?? null, {
        label: 'cursor-less re-attach',
      });
      assert.equal(fresh.lastEventId, null, 'a restarted relay must not receive the old cursor');
      assert.equal(fresh.seq, null, 'and must not be asked for a seq from the old process');
      assert.equal(agent.state.relayIdChanges, 1);
      assert.equal(agent.state.relayId, 'relay-2');
      assert.equal(agent.state.seq, 0, 'the cursor is discarded, not adopted');
      assert.equal(agent.state.cursorRelayId, null);
      assert.ok(
        logs.some(
          (entry) =>
            entry.level === 'warn' &&
            /discarding seq cursor and re-attaching without one/.test(entry.message),
        ),
        `the discard must be visible in the log: ${logs.map((entry) => entry.message).join(' | ')}`,
      );
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('re-attaches with no cursor on the very next attempt, and then resumes the new relay', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('cursor-new-relay-resume');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'cursor-new-resume',
      });
      running = agent.start();
      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-X', machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-X', { label: 'cursor attributed' });
      first.send('peer.hello', { machine_id: 'peer-1' });
      first.send('peer.hello', { machine_id: 'peer-2' });
      await waitFor(() => agent.state.seq >= 3, { label: 'cursor advanced' });

      first.close();
      const second = await rabbit.stream();
      second.send('ready', { protocol_version: 1, relay_id: 'relay-Y', seq: 1, machine_id: 'rabbit' });

      // Wait for the cursor-less re-attach rather than for "a stream": the
      // server-side close of the dropped stream is asynchronous, so polling for
      // a new attach is the only race-free signal.
      const fresh = await waitFor(() => rabbit.state.attaches[2] ?? null, {
        label: 'cursor-less re-attach',
      });
      assert.equal(fresh.lastEventId, null, 'the replaced relay must not receive the old cursor');

      // On the new relay the cursor is live again: relay-Y's events advance it,
      // and a later reconnect resumes from it (no permanent full replay).
      const third = await rabbit.stream();
      third.send('ready', { protocol_version: 1, relay_id: 'relay-Y', seq: 1, machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-Y', { label: 'new cursor attributed' });
      third.send('peer.hello', { machine_id: 'peer-1' });
      third.send('peer.hello', { machine_id: 'peer-2' });
      await waitFor(() => agent.state.seq >= 3, { label: 'new cursor advanced' });

      third.close();
      const resumed = await waitFor(() => rabbit.state.attaches[3] ?? null, { label: 'fourth attach' });
      assert.equal(resumed.lastEventId, '3', 'once the cursor belongs to relay-Y it is resumed again');
      assert.equal(resumed.seq, '4');
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('aligns the cursor downward when the new relay window is smaller', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('cursor-replay-down');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'cursor-replay-down',
      });
      running = agent.start();
      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-T', machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-T', { label: 'cursor attributed' });
      first.send('peer.hello', { seq: 42, machine_id: 'jump' });
      await waitFor(() => agent.state.seq === 42, { label: 'cursor at 42' });

      // A window that starts far below the cursor we arrived with: the alignment
      // must move *down*, so it cannot be a `max`.
      first.send('notice', {
        level: 'warn',
        code: 'REPLAY_TRUNCATED',
        message: 'short window',
        oldest_available_seq: 3,
      });
      await waitFor(() => agent.state.seq === 2, { label: 'cursor aligned downward' });
      assert.equal(agent.state.replayTruncated.previous_seq, 42);
      assert.equal(agent.state.replayTruncated.oldest_available_seq, 3);

      // And the aligned cursor is what the next attach uses.
      first.close();
      const resumed = await waitFor(() => rabbit.state.attaches[1] ?? null, { label: 're-attach' });
      assert.equal(resumed.lastEventId, '2');
      assert.equal(resumed.seq, '3', 'the next attach asks for oldest_available_seq');
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI (v0.1.2: sub-path rabbitUrl, --operator-token)
// ---------------------------------------------------------------------------

describe('w2m-localside CLI', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'w2m-localside.mjs');

  /**
   * @param {string[]} args
   * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
   */
  function runCli(args, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: {
          ...process.env,
          DSH_HOME: join(root, 'cli-dsh-home'),
          // The command under test is built from `process.execPath` — an absolute path — while the
          // allow-list entry is the bare name `node -e`. `matchAllowedCommand` admits an absolute
          // path only when it resolves to the same file the entry's bare name resolves to, and that
          // name is looked up through PATH and then the bundled runtime **under this child's
          // DSH_HOME**. Two things therefore have to be true, and on a clean CI runner both are:
          //
          //   * the scratch DSH_HOME above carries no `dsh-runtimes/`, so `bundledBinDirs()` returns
          //     nothing there;
          //   * `actions/setup-node` puts `node` on PATH.
          //
          // So this passed in CI and failed on a machine where node exists *only* as DSH's bundled
          // runtime — measured here as `COMMAND_EXECUTABLE_PATH_MISMATCH`, which is the allow-list
          // behaving exactly as documented. Putting the executing node's own directory on the
          // child's PATH restores the identity the check is meant to confirm, rather than weakening
          // the check: the absolute path still has to match a real, resolvable `node`, and a
          // mismatched one is still refused.
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  it('documents --operator-token and rejects an unusable rabbitUrl as a usage error', async () => {
    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--operator-token/);
    assert.match(help.stdout, /sub-path/);

    const bad = await runCli(['--rabbit', 'https://h/w2m?x=1', '--project', root]);
    assert.equal(bad.code, 2, 'a bad base address is a usage error, not a crash');
    assert.match(bad.stderr, /rabbitUrl/);
    assert.match(bad.stderr, /query string/);
  });

  it('runs a task against a relay mounted under a sub-path', async () => {
    const rabbit = await startFakeRabbit({ basePath: '/w2m' });
    const project = await makeRepo('cli-subpath');
    try {
      const childPromise = runCli([
        '--rabbit',
        `${rabbit.url}/w2m/`,
        '--project',
        project,
        '--name',
        'cli-subpath',
        '--allowed-commands',
        '["node -e"]',
        '--operator-token',
        'op-token-for-test',
        '--state',
        join(root, 'cli-subpath-state'),
        '--once',
      ]);

      // If the prefix were eaten this would never arrive: the relay 404s
      // everything outside /w2m.
      const stream = await rabbit.stream(15_000);
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-cli', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-CLI-SUBPATH',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("subpath\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-cli-subpath',
      });

      const result = await childPromise;
      assert.equal(result.code, 0, `CLI exited ${result.code}: ${result.stderr}`);
      assert.equal(rabbit.state.results.length, 1);
      assert.equal(rabbit.state.results[0].status, 'ok');
      assert.equal(rabbit.state.results[0].stdout_sha256, sha256Hex('subpath\n'));

      // Every request went under the prefix, including the SSE stream.
      assert.ok(rabbit.state.paths.includes('/w2m/v1/stream'), `paths: ${rabbit.state.paths.join(', ')}`);
      assert.ok(rabbit.state.paths.includes('/w2m/v1/heartbeat'));
      assert.ok(rabbit.state.paths.includes('/w2m/v1/result'));
      assert.ok(
        rabbit.state.paths.every((path) => path.startsWith('/w2m/')),
        `a request escaped the prefix: ${rabbit.state.paths.join(', ')}`,
      );
      assert.match(result.stdout, new RegExp(`${rabbit.url}/w2m`), 'the effective base URL is logged');
    } finally {
      await rabbit.close();
    }
  });
});

// ---------------------------------------------------------------------------
// task-16: the cross-process diagnostics channel (agent writes, plugin reads)
// ---------------------------------------------------------------------------

/**
 * Register the *real* plugin against a fake `ctx.tools`, exactly as
 * `tools.test.mjs` does, so `w2m_status` here is the shipping tool and not a
 * re-implementation of it.
 *
 * @param {object} config
 * @returns {Promise<Map<string, object>>}
 */
async function registerPluginTools(config) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: () => {}, info: () => {} },
  };
  await applyPinned(ctx, config);
  return tools;
}

describe('agent state file for cross-process diagnostics (task-16)', () => {
  it('publishes agent-state.json that the plugin reads from another process', async () => {
    // Real relay implementation, real HTTP, real operator token.
    const relayDir = scratch('state16-relay');
    const relay = createRelayServer({ stateDir: relayDir, pairingCodeReusable: true });
    const listen = await relay.listen({ host: '127.0.0.1', port: 0 });
    const operatorToken = await waitFor(
      () => {
        try {
          return readFileSync(join(relayDir, 'operator-token.txt'), 'utf8').trim() || null;
        } catch {
          return null;
        }
      },
      { label: 'operator token' },
    );

    const project = await makeRepo('state16-project');
    // The documented default layout: DSH_HOME/xclient/device.json (identity) and
    // DSH_HOME/xclient/localside/... (agent state). No --state override, so this
    // test covers what a user gets out of the box.
    const dshHome = scratch('state16-dsh');
    const agentStateDir = join(dshHome, 'xclient', 'localside');
    const stateFile = join(agentStateDir, AGENT_STATE_FILE);
    const identityPath = join(dshHome, 'xclient', 'device.json');

    /** @type {import('node:child_process').ChildProcess|null} */
    let child = null;
    let childOut = '';
    let childErr = '';
    try {
      child = spawn(
        NODE,
        [
          CLI_PATH,
          '--rabbit', listen.url,
          '--pair', listen.pairingCode,
          '--project', project,
          '--name', 'state16',
          '--allowed-commands', '["node -e"]',
          '--once',
          '--once-idle-ms', '60000',
        ],
        { env: { ...process.env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (chunk) => {
        childOut += chunk;
      });
      child.stderr.on('data', (chunk) => {
        childErr += chunk;
      });

      const device = await waitFor(
        () => {
          try {
            const parsed = JSON.parse(readFileSync(identityPath, 'utf8'));
            return parsed.device_token ? parsed : null;
          } catch {
            return null;
          }
        },
        { label: 'paired device identity', timeoutMs: 30_000 },
      );

      // The agent must be attached to the relay before work is worth submitting.
      await waitFor(
        async () => {
          const response = await fetch(`${listen.url}/v1/devices`, {
            headers: { authorization: `Bearer ${device.device_token}` },
          });
          if (!response.ok) return null;
          const body = await response.json();
          return body.devices?.some((entry) => entry.machine_id === device.machine_id) ?? false;
        },
        { label: 'agent online', timeoutMs: 30_000 },
      );

      const anchor = await treeFingerprint({ cwd: project });
      assert.equal(anchor.error, null);
      const submitted = await fetch(`${listen.url}/v1/task`, {
        method: 'POST',
        headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'replicate',
          // Long enough that the snapshot is read while the agent is still connected.
          command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("state16\\n"), 1200)'],
          cwd_rel: '.',
          index_total: 1,
          timeout_ms: 30_000,
          write: false,
          base_commit: await git(project, ['rev-parse', 'HEAD']),
          base_tree: anchor.fingerprint,
          compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true },
          halt: 'never',
          created_by: 'state16-test',
        }),
      });
      const submittedText = await submitted.text();
      assert.ok(submitted.ok, `POST /v1/task -> ${submitted.status} ${submittedText}`);
      const task = JSON.parse(submittedText);

      // Read the file from *outside* the agent, as the plugin does. No access to
      // the agent object at all: this process never created it.
      const published = await waitFor(
        () => {
          try {
            const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
            return typeof parsed?.rttMs?.last === 'number' ? parsed : null;
          } catch {
            return null;
          }
        },
        { label: `published RTT in ${stateFile}`, timeoutMs: 30_000 },
      );

      assert.equal(published.schema_version, AGENT_STATE_SCHEMA_VERSION);
      assert.equal(published.machine_id, device.machine_id);
      assert.equal(typeof published.rttMs.last, 'number');
      assert.ok(published.rttMs.samples.length >= 1, 'a heartbeat must have been recorded');
      assert.equal(published.connected, true, 'read while the stream was up');
      assert.equal(published.replay_truncated, false);
      assert.equal(typeof published.unstable_reconnects, 'number');
      assert.equal(
        Object.prototype.hasOwnProperty.call(published, 'reconnect_attempts'),
        false,
        'the relay owns `reconnect_attempts`; the file channel must not reuse it',
      );
      assert.match(published.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'RFC3339 UTC');

      // relay_id must agree with the relay's own /healthz, not with a guess.
      const health = await (await fetch(`${listen.url}/healthz`)).json();
      assert.ok(health.relay_id, 'v0.1.2 relay must publish a relay_id');
      assert.equal(published.relay_id, health.relay_id);

      // machine_id must agree with the relay's device table.
      const devicesResponse = await fetch(`${listen.url}/v1/devices`, {
        headers: { authorization: `Bearer ${device.device_token}` },
      });
      const devicesBody = await devicesResponse.json();
      const deviceIds = (devicesBody.devices ?? []).map((entry) => entry.machine_id);
      assert.ok(
        deviceIds.includes(published.machine_id),
        `relay device table ${JSON.stringify(deviceIds)} must contain ${published.machine_id}`,
      );

      // No credential of any kind may reach a world-readable-ish diagnostics file.
      const raw = readFileSync(stateFile, 'utf8');
      assert.equal(raw.includes(device.device_token), false, 'device_token must never be published');
      assert.equal(raw.includes(operatorToken), false, 'operator_token must never be published');
      assert.doesNotMatch(raw, /token/i, 'no token-shaped field belongs in this file');

      // And the real plugin, pointed at the directory its docs describe
      // (the one holding device.json), must find it.
      const tools = await registerPluginTools({
        rabbitUrl: listen.url,
        stateDir: join(dshHome, 'xclient'),
        projectDir: project,
      });
      const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(status.rtt.available, true, JSON.stringify(status.rtt));
      assert.equal(status.rtt.source, 'state-file');
      assert.equal(status.rtt.last, published.rttMs.last);
      assert.deepEqual(status.rtt.samples, published.rttMs.samples);

      // The run really happened: the agent exits by itself in --once mode, and a
      // non-empty spool would mean the result was never acknowledged.
      //
      // v0.5.10: the exit state is read before any listener is attached. The child usually exits
      // while this process is still assembling the assertions above, and `on('close')` attached to a
      // child that has already closed never fires -- the suite then hangs in this line with the work
      // it was waiting for already done.
      const { code: exitCode } = await waitForChildClose(child, { label: 'the --once agent' });
      assert.equal(exitCode, 0, `agent must stop cleanly; stderr: ${childErr}`);
      assert.ok(
        childOut.includes(`result delivered for ${task.task_id}`),
        `the relay must have accepted the result; stdout: ${childOut}`,
      );
      const spoolDir = join(agentStateDir, 'spool');
      assert.equal(
        readdirSync(spoolDir).length,
        0,
        `spool must be empty after an acknowledged result: ${readdirSync(spoolDir).join(', ')}`,
      );
      child = null;
    } finally {
      if (child) child.kill();
      await relay.close();
    }
  });

  it('never publishes a half-written document', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('state16-atomic');
    const stateDir = scratch('state16-atomic-state');
    const stateFile = join(stateDir, AGENT_STATE_FILE);
    try {
      const agent = createAgent({
        rabbitUrl: rabbit.url,
        project,
        stateDir,
        identity: { machine_id: newMachineId(), machine_name: 'atomic', device_token: 'tok', rabbit_url: null },
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
        platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
        allowedCommands: parseAllowedCommands('["node -e"]'),
        once: true,
        // A very fast heartbeat makes the writer race the reader hard.
        heartbeatIntervalMs: 20,
        log: () => {},
      });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-atomic', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-ATOMIC',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'setTimeout(() => {}, 900)'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-atomic',
      });

      // Wait for the writer to publish at least once, so the loop below cannot pass vacuously by
      // reading a file that never existed.
      const appeared = Date.now() + 3000;
      while (Date.now() < appeared && !existsSync(stateFile)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const deadline = Date.now() + 1200;
      let reads = 0;
      let parsed = 0;
      while (Date.now() < deadline) {
        try {
          const text = readFileSync(stateFile, 'utf8');
          reads += 1;
          JSON.parse(text);
          parsed += 1;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await running;

      // The property is "every read saw complete JSON", not "the machine managed N reads in 1200ms".
      // The old `reads > 20` threshold measured throughput and failed in CI under load while the code
      // was correct; `reads > 0` is what this test actually needs, and `parsed === reads` is the
      // invariant that a torn write would break.
      assert.ok(reads > 0, 'the reader must have observed the published file at least once');
      assert.equal(parsed, reads, 'every read that saw the file must have seen complete JSON');
      assert.deepEqual(
        readdirSync(stateDir).filter((name) => name.includes('.tmp-')),
        [],
        'an atomic publish must not leave temp files behind',
      );
    } finally {
      await rabbit.close();
    }
  });

  it('keeps running when the state directory cannot be written', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('state16-blocked');
    const stateDir = scratch('state16-blocked-state');
    const logs = [];
    try {
      const agent = createAgent({
        rabbitUrl: rabbit.url,
        project,
        stateDir,
        identity: { machine_id: newMachineId(), machine_name: 'blocked', device_token: 'tok', rabbit_url: null },
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
        platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
        allowedCommands: parseAllowedCommands('["node -e"]'),
        once: true,
        heartbeatIntervalMs: 20,
        log: (level, message, extra) => logs.push({ level, message, extra: extra ?? {} }),
      });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-blocked', machine_id: 'rabbit' });
      await waitFor(() => agent.state.statePublishedAt !== null, { label: 'first publish' });

      // Break only the *publish* path: a directory where the file must go makes
      // the final rename fail while the spool (which the task needs) stays
      // healthy. That isolates "diagnostics write failed" from "task cannot run".
      rmSync(join(stateDir, AGENT_STATE_FILE), { force: true });
      mkdirSync(join(stateDir, AGENT_STATE_FILE));

      stream.send('task.offer', {
        task_id: '01J-E2E-BLOCKED',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("blocked-but-alive\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-blocked',
      });
      await running;

      // The task still ran, was delivered, and the agent stopped cleanly.
      assert.equal(rabbit.state.results.length, 1);
      assert.equal(rabbit.state.results[0].status, 'ok');
      assert.equal(rabbit.state.results[0].stdout_sha256, sha256Hex('blocked-but-alive\n'));
      assert.ok(agent.state.rttMs.samples.length >= 1, 'RTT is still tracked in memory');
      assert.ok(
        logs.some((entry) => entry.level === 'warn' && /could not publish agent-state\.json/.test(entry.message)),
        'a failed publish must be reported once, not swallowed',
      );
    } finally {
      await rabbit.close();
    }
  });

  it('keeps updated_at fresh while idle, so a reader can tell the agent is alive', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('state16-idle');
    const stateDir = scratch('state16-idle-state');
    const stateFile = join(stateDir, AGENT_STATE_FILE);
    try {
      const agent = createAgent({
        rabbitUrl: rabbit.url,
        project,
        stateDir,
        identity: { machine_id: newMachineId(), machine_name: 'idle', device_token: 'tok', rabbit_url: null },
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
        platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
        allowedCommands: [],
        once: false,
        // No task is ever offered here: only idleness can move the timestamp.
        statePublishIntervalMs: 40,
        log: () => {},
      });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-idle', machine_id: 'rabbit' });

      const read = () => {
        try {
          return JSON.parse(readFileSync(stateFile, 'utf8'));
        } catch {
          return null;
        }
      };
      const first = await waitFor(() => {
        const snapshot = read();
        return snapshot?.connected === true ? snapshot : null;
      }, { label: 'connected publish' });

      const refreshed = await waitFor(() => {
        const snapshot = read();
        return snapshot && snapshot.updated_at !== first.updated_at ? snapshot : null;
      }, { label: 'idle refresh', timeoutMs: 5000 });

      assert.equal(refreshed.connected, true, 'idle refresh must not fake a disconnect');
      assert.equal(refreshed.relay_id, 'relay-idle');
      assert.ok(refreshed.updated_at > first.updated_at, 'the timestamp must advance');

      agent.stop();
      await running;
      // The interval must not outlive the agent.
      const afterStop = read();
      assert.equal(afterStop.connected, false);
    } finally {
      await rabbit.close();
    }
  });

  it('refuses to run an offer it cannot spool, and says so', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('state16-nospool');
    const stateDir = scratch('state16-nospool-state');
    const logs = [];
    try {
      const agent = createAgent({
        rabbitUrl: rabbit.url,
        project,
        stateDir,
        identity: { machine_id: newMachineId(), machine_name: 'nospool', device_token: 'tok', rabbit_url: null },
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
        platform: { os: 'windows', os_version: '1', arch: 'x64', shell: 'cmd', shell_version: null },
        allowedCommands: parseAllowedCommands('["node -e"]'),
        once: true,
        log: (level, message, extra) => logs.push({ level, message, extra: extra ?? {} }),
      });
      // The spool directory is created at construction; break it afterwards so
      // only `saveTask` fails.
      rmSync(join(stateDir, 'spool'), { recursive: true, force: true });
      writeFileSync(join(stateDir, 'spool'), 'not a directory', 'utf8');

      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-nospool', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-NOSPOOL',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("must not run\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-nospool',
      });
      await running;

      assert.equal(rabbit.state.results.length, 0, 'an unspooled offer must not produce a result');
      assert.ok(
        logs.some((entry) => /could not spool 01J-E2E-NOSPOOL; not running it/.test(entry.message)),
        `expected an explicit refusal to run; logs: ${logs.map((entry) => entry.message).join(' | ')}`,
      );
      // The agent survived and released the task slot rather than wedging.
      assert.equal(agent.state.current, null);
      assert.equal(agent.state.handled, 1);
    } finally {
      await rabbit.close();
    }
  });

  it('stops cleanly when the relay is unreachable, without a state-file write crash', async () => {
    // A port nothing listens on: bind, read the port, release it.
    const probe = createServer(() => {});
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const dshHome = scratch('state16-dead-dsh');
    const stateDir = join(dshHome, 'xclient', 'localside');
    const child = spawn(
      NODE,
      [
        CLI_PATH,
        '--rabbit', `http://127.0.0.1:${deadPort}`,
        '--project', await makeRepo('state16-dead-project'),
        '--state', stateDir,
        '--once',
        '--once-idle-ms', '1200',
      ],
      { env: { ...process.env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // Same reason as the task-16 wait: read the exit state instead of racing the `close` event.
    const { code: exitCode } = await waitForChildClose(child, { label: 'the disconnected agent' });

    assert.equal(exitCode, 0, `an unreachable relay must not be fatal; stderr: ${stderr}`);
    assert.equal(stderr.trim(), '', 'no stack trace may reach stderr');
    // The file is published even while disconnected, which is how an operator
    // can tell "agent running, relay down" from "no agent here".
    const published = JSON.parse(readFileSync(join(stateDir, AGENT_STATE_FILE), 'utf8'));
    assert.equal(published.connected, false);
    assert.equal(published.rttMs.last, null);
    assert.ok(published.unstable_reconnects >= 1, 'it must have tried to reconnect');
  });
});

// ---------------------------------------------------------------------------
// v0.3.0: RTT and link diagnostics travel to the relay with the heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat diagnostics over the wire (v0.3.0)', () => {
  it('reports rtt_ms only when a round trip was actually measured', () => {
    // No measurement: the key must be ABSENT, not null and not 0. `null` would
    // add a shape for the relay to handle and `0` would be read as "extremely
    // fast", turning "unknown" into a good score.
    const unmeasured = heartbeatDiagnostics({ rttMs: { last: null }, reconnectAttempts: 0 });
    assert.equal(Object.prototype.hasOwnProperty.call(unmeasured, 'rtt_ms'), false);
    assert.equal('rtt_ms' in unmeasured, false);
    assert.deepEqual(unmeasured, { unstable_reconnects: 0 });
    // The relay publishes its own `reconnect_attempts`; the agent must not
    // reuse that name for a different quantity.
    assert.equal('reconnect_attempts' in unmeasured, false);

    // A measured sub-millisecond round trip is genuinely 0, and that is a
    // measurement, not a placeholder -- so it is sent.
    assert.deepEqual(heartbeatDiagnostics({ rttMs: { last: 0 }, reconnectAttempts: 2 }), {
      rtt_ms: 0,
      unstable_reconnects: 2,
    });
    // Integers only, rounded.
    assert.equal(heartbeatDiagnostics({ rttMs: { last: 12.6 } }).rtt_ms, 13);
    assert.equal(Number.isInteger(heartbeatDiagnostics({ rttMs: { last: 12.4 } }).rtt_ms), true);
  });

  it('drops an out-of-range sample instead of clamping it', () => {
    const huge = heartbeatDiagnostics({ rttMs: { last: MAX_HEARTBEAT_RTT_MS + 1 }, reconnectAttempts: 0 });
    assert.equal('rtt_ms' in huge, false, 'a bogus sample must not reach the relay aggregate');
    assert.equal(heartbeatDiagnostics({ rttMs: { last: 1e9 } }).rtt_ms, undefined);
    assert.equal('rtt_ms' in heartbeatDiagnostics({ rttMs: { last: 1e9 } }), false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5]) {
      const result = heartbeatDiagnostics({ rttMs: { last: bad } });
      assert.equal('rtt_ms' in result, false, `${bad} must not be reported`);
    }
    // The boundary itself is a real measurement and is kept.
    assert.equal(heartbeatDiagnostics({ rttMs: { last: MAX_HEARTBEAT_RTT_MS } }).rtt_ms, MAX_HEARTBEAT_RTT_MS);
    // And the tolerance is an option, so a caller can tighten it.
    assert.equal('rtt_ms' in heartbeatDiagnostics({ rttMs: { last: 500 } }, { maxRttMs: 100 }), false);
  });

  it('merges diagnostics into the heartbeat body and survives a broken provider', async () => {
    const sent = [];
    const heartbeat = new Heartbeat({
      send: async (body) => {
        sent.push(body);
        return { cancel: false };
      },
      taskId: 'T',
      machineId: 'M',
      attempt: 3,
      diagnostics: () => ({ rtt_ms: 7, unstable_reconnects: 1 }),
    });
    heartbeat.setPhase('running', 50);
    await heartbeat.tick();
    assert.deepEqual(sent[0], {
      task_id: 'T',
      machine_id: 'M',
      attempt: 3,
      phase: 'running',
      progress: 50,
      rtt_ms: 7,
      unstable_reconnects: 1,
    });

    // A diagnostics provider that throws must not cost us the lease renewal.
    const second = [];
    const broken = new Heartbeat({
      send: async (body) => {
        second.push(body);
        return { cancel: false };
      },
      taskId: 'T',
      machineId: 'M',
      attempt: 1,
      diagnostics: () => {
        throw new Error('provider exploded');
      },
    });
    await broken.tick();
    assert.deepEqual(second[0], {
      task_id: 'T',
      machine_id: 'M',
      attempt: 1,
      phase: 'preparing',
      progress: 0,
    });

    // No provider at all: exactly the v0.2.3 body.
    const third = [];
    const plain = new Heartbeat({
      send: async (body) => {
        third.push(body);
        return {};
      },
      taskId: 'T',
      machineId: 'M',
      attempt: 1,
    });
    await plain.tick();
    assert.equal('rtt_ms' in third[0], false);
  });

  it('puts rtt_ms in the real heartbeat request, and only after a measurement', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('rtt-wire');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    const hasRtt = (body) => Object.prototype.hasOwnProperty.call(body, 'rtt_ms');
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'rtt-wire',
      });
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-rtt', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-RTTWIRE',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        // Long enough for several heartbeat intervals (150ms in this harness).
        command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("x"), 1200)'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-rtt-wire',
      });

      // The first heartbeat fires the moment the lease is claimed -- before any
      // round trip has completed -- so its body must not carry the field at all.
      const first = await waitFor(() => rabbit.state.heartbeats[0] ?? null, { label: 'first heartbeat' });
      assert.equal(hasRtt(first), false, `no measurement yet, so no key: ${JSON.stringify(first)}`);
      assert.equal('rtt_ms' in first, false);
      assert.equal(first.rtt_ms, undefined);
      assert.equal(first.unstable_reconnects, 0, 'the counter is sent from the start');
      assert.equal('reconnect_attempts' in first, false, 'the relay owns that name');

      // Once a round trip has been measured, every later heartbeat carries it.
      const withRtt = await waitFor(
        () => rabbit.state.heartbeats.find((body) => hasRtt(body)) ?? null,
        { label: 'heartbeat carrying rtt_ms' },
      );
      assert.equal(Number.isInteger(withRtt.rtt_ms), true, JSON.stringify(withRtt));
      assert.ok(withRtt.rtt_ms >= 0 && withRtt.rtt_ms <= MAX_HEARTBEAT_RTT_MS);
      assert.equal(Number.isInteger(withRtt.unstable_reconnects), true);
      assert.equal(withRtt.phase === 'running' || withRtt.phase === 'preparing', true);

      await running;

      // Every body that carries the key carries a sane integer; no body ever
      // carries null or a non-number.
      for (const body of rabbit.state.heartbeats) {
        if (hasRtt(body)) {
          assert.equal(
            Number.isInteger(body.rtt_ms) && body.rtt_ms >= 0 && body.rtt_ms <= MAX_HEARTBEAT_RTT_MS,
            true,
            `bad rtt_ms on the wire: ${JSON.stringify(body)}`,
          );
        }
      }
      assert.equal(rabbit.state.results.length, 1);
      assert.equal(rabbit.state.results[0].status, 'ok');

      // The local file channel is still written, and the two agree -- this is
      // the "relay primary, file fallback" pair, not a replacement.
      const published = JSON.parse(readFileSync(agent.state.stateFile, 'utf8'));
      assert.equal(typeof published.rttMs.last, 'number');
      assert.equal(published.unstable_reconnects, agent.state.unstableReconnects);
      assert.equal(
        Object.prototype.hasOwnProperty.call(published, 'reconnect_attempts'),
        false,
        'the file must use the new name too, not keep the relay\'s',
      );
      const lastOnWire = [...rabbit.state.heartbeats].reverse().find((body) => hasRtt(body));
      // The relay receives a *sample stream* while the file holds the *current*
      // value, so the two need not be equal at the instant we read: one more
      // round trip can complete after the final heartbeat. What must hold is
      // that the number we sent came from the same rolling window the file
      // publishes -- i.e. it was a real measurement, not a different number.
      assert.ok(
        published.rttMs.samples.includes(lastOnWire.rtt_ms),
        `the value sent (${lastOnWire.rtt_ms}) must come from the file's window ${JSON.stringify(published.rttMs.samples)}`,
      );
      assert.ok(
        Number.isInteger(published.rttMs.last) && published.rttMs.last >= 0,
        'the file still holds a real measurement (0 is a legal sub-millisecond one)',
      );
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('ignores fields a newer relay adds to the heartbeat response', async () => {
    const rabbit = await startFakeRabbit({
      heartbeatExtra: {
        rtt_ms: 999,
        rtt_avg_ms: 42,
        // The relay's own counter, which is a different quantity from the
        // agent's `unstable_reconnects` -- both names may legitimately appear.
        reconnect_attempts: 0,
        link: { quality: 'good', samples: [1, 2, 3] },
        future_field: null,
      },
    });
    const project = await makeRepo('rtt-unknown-response');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'rtt-unknown-response',
      });
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-future', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-FUTURE',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("y"), 600)'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-future',
      });
      await running;

      // The run is unaffected: unknown response fields are ignored, and the
      // relay's echoed value never leaks into our own measurement.
      assert.equal(rabbit.state.results.length, 1);
      assert.equal(rabbit.state.results[0].status, 'ok');
      assert.ok(rabbit.state.heartbeats.length >= 2, 'the lease must keep being renewed');
      assert.notEqual(agent.state.rttMs.last, 999, 'a value echoed by the relay is not our measurement');
      assert.ok(agent.state.rttMs.last <= MAX_HEARTBEAT_RTT_MS);
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v0.3.0: idle diagnostic heartbeats (a machine with nothing to do is exactly
// the one an operator looks at, and it used to go silent)
// ---------------------------------------------------------------------------

describe('idle diagnostic heartbeats (v0.3.0)', () => {
  /** Bodies that carry no lease: the diagnostic shape. */
  const idleBodies = (rabbit) =>
    rabbit.state.heartbeats.filter((body) => !Object.prototype.hasOwnProperty.call(body, 'task_id'));

  it('sends the documented idle body shape while no task is running', async () => {
    assert.equal(IDLE_HEARTBEAT_INTERVAL_MS, 60_000, 'the production cadence is one minute');
    assert.equal(HEARTBEAT_INTERVAL_MS, 10_000, 'the lease cadence is unchanged');

    const rabbit = await startFakeRabbit();
    const project = await makeRepo('idle-body');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'idle-body',
        idleHeartbeatIntervalMs: 80,
      });
      running = agent.start();

      const first = await waitFor(() => idleBodies(rabbit)[0] ?? null, { label: 'first idle heartbeat' });
      assert.equal(first.diagnostic, true, 'the explicit flag is what keeps it off the lease path');
      assert.equal('task_id' in first, false, 'an idle heartbeat must not impersonate a lease');
      assert.equal(first.machine_id, agent.identity.machine_id);
      assert.equal(Number.isInteger(first.unstable_reconnects), true, JSON.stringify(first));
      assert.equal(
        Object.prototype.hasOwnProperty.call(first, 'rtt_ms'),
        false,
        'the very first beat has no measurement yet',
      );
      // No lease heartbeat may be produced by an idle agent.
      assert.equal(
        rabbit.state.heartbeats.every((body) => !Object.prototype.hasOwnProperty.call(body, 'task_id')),
        true,
        'an idle agent must not emit lease heartbeats',
      );

      // Once an idle round trip completes it is a real measurement, and it is
      // reported exactly like the lease heartbeat reports one.
      const withRtt = await waitFor(
        () => idleBodies(rabbit).find((body) => Object.prototype.hasOwnProperty.call(body, 'rtt_ms')) ?? null,
        { label: 'idle heartbeat carrying rtt_ms' },
      );
      assert.equal(Number.isInteger(withRtt.rtt_ms), true, JSON.stringify(withRtt));
      assert.ok(withRtt.rtt_ms >= 0 && withRtt.rtt_ms <= MAX_HEARTBEAT_RTT_MS);

      // And the local file keeps being written with the same numbers.
      const published = JSON.parse(readFileSync(agent.state.stateFile, 'utf8'));
      assert.equal(typeof published.rttMs.last, 'number');
      assert.equal(published.unstable_reconnects, agent.state.unstableReconnects);
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('never touches lease or task state, even when the relay answers cancel:true', async () => {
    // A lease heartbeat treats `cancel: true` as "stop the task". An idle
    // heartbeat holds no lease, so the same response must be inert -- otherwise
    // a relay that cancels *some other* task could stop an idle agent.
    const rabbit = await startFakeRabbit({ heartbeatExtra: { cancel: true, lease_until: null } });
    const project = await makeRepo('idle-cancel');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'idle-cancel',
        idleHeartbeatIntervalMs: 60,
      });
      running = agent.start();

      await waitFor(() => idleBodies(rabbit).length >= 3, { label: 'three idle heartbeats' });
      assert.equal(agent.state.stopped, false, 'an idle agent must not be stopped by a heartbeat response');
      assert.equal(agent.state.current, null, 'no local task slot may be occupied');
      assert.equal(agent.state.handled, 0, 'and no task may be considered handled');
      assert.equal(rabbit.state.results.length, 0);
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('tolerates a pre-v0.3.0 relay answering 404, without a retry storm', async () => {
    const rabbit = await startFakeRabbit({ heartbeatIdleStatus: 404 });
    const project = await makeRepo('idle-404');
    const logs = [];
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'idle-404',
        logs,
        idleHeartbeatIntervalMs: 60,
      });
      const startedAt = Date.now();
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-old', machine_id: 'rabbit' });

      // Let the idle cadence hit the 404ing endpoint *before* any task exists:
      // an agent with nothing to do is the case this whole feature is for.
      await waitFor(() => rabbit.state.idleHeartbeatStatuses.length >= 2, { label: 'idle 404s' });

      // A real task must then run normally: the diagnostic traffic is best
      // effort, not part of the task path.
      stream.send('task.offer', {
        task_id: '01J-E2E-IDLE404',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("ok\\n"), 500)'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-idle-404',
      });
      await running;
      const elapsedMs = Date.now() - startedAt;

      assert.equal(rabbit.state.results.length, 1, 'the task must complete despite 404s');
      assert.equal(rabbit.state.results[0].status, 'ok');
      assert.equal(rabbit.state.results[0].stdout_sha256, sha256Hex('ok\n'));
      assert.ok(rabbit.state.idleHeartbeatStatuses.length >= 1, 'the 404s really happened');
      assert.ok(
        rabbit.state.idleHeartbeatStatuses.every((status) => status === 404),
        'every rejected idle beat answered 404',
      );

      // One request per interval, not a retry storm.
      const intervalMs = 60;
      const allowed = Math.ceil(elapsedMs / intervalMs) + 3;
      assert.ok(
        rabbit.state.idleHeartbeatStatuses.length <= allowed,
        `${rabbit.state.idleHeartbeatStatuses.length} idle attempts in ${elapsedMs}ms exceeds ${allowed} ` +
          '(an unretried cadence sends one per interval)',
      );
      // And it is reported at debug level only: a diagnostic the relay simply
      // does not implement must not become warn/error noise.
      const noisy = logs.filter((entry) => entry.level !== 'debug' && /idle heartbeat/.test(entry.message));
      assert.deepEqual(noisy, [], `idle failures must not be warn/error: ${JSON.stringify(noisy)}`);
      assert.ok(
        logs.some((entry) => entry.level === 'debug' && /HTTP 404/.test(entry.message)),
        'the 404 must still be visible at debug level',
      );
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v0.3.0: request signing (HMAC over method + path-with-query + body)
// ---------------------------------------------------------------------------

describe('request signing (v0.3.0)', () => {
  const SIGNING_SECRET = 'test-signing-secret-do-not-use';
  const SIGNING_HEADERS = [SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER];

  /** Does this recorded request carry any signing header? */
  const signedHeadersPresent = (request) =>
    SIGNING_HEADERS.filter((name) => Object.prototype.hasOwnProperty.call(request.headers, name));

  /**
   * Verify one recorded request with the real verifier.
   *
   * @param {object} request
   * @param {object} [options]
   */
  function verifyRecorded(request, options = {}) {
    return verifyRequest({
      headers: request.headers,
      method: request.method,
      path: options.path ?? request.path,
      body: request.rawBody,
      secrets: options.secrets ?? SIGNING_SECRET,
      nonces: options.nonces ?? new NonceCache(),
    });
  }

  it('adds no signing header at all when no secret is configured', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('sign-off');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({ rabbit: rabbit.url, project, allowed: [['node', '-e']], once: true, name: 'sign-off' });
      assert.equal(agent.signingEnabled, false);
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-plain', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-SIGNOFF',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("unsigned\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-sign-off',
      });
      await running;

      // The backward-compatibility gate: not one signing header, on any request,
      // so the wire stays byte-identical to v0.2.3.
      assert.ok(rabbit.state.requests.length >= 3, 'stream + heartbeat + result were all seen');
      for (const request of rabbit.state.requests) {
        assert.deepEqual(
          signedHeadersPresent(request),
          [],
          `unsigned agent sent ${signedHeadersPresent(request).join(', ')} on ${request.method} ${request.path}`,
        );
      }
      assert.equal(rabbit.state.results.length, 1);
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('signs every /v1 request so the real verifier accepts it', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('sign-on');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'sign-on',
        signingSecret: SIGNING_SECRET,
      });
      assert.equal(agent.signingEnabled, true);
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-signed', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-SIGNON',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("signed\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-sign-on',
      });
      await running;

      assert.ok(rabbit.state.requests.length >= 3);
      assert.ok(
        rabbit.state.requests.some((request) => request.method === 'GET' && request.path.startsWith('/v1/stream')),
        'the SSE attach must be among the signed requests',
      );
      for (const request of rabbit.state.requests) {
        assert.ok(request.path.startsWith('/v1/'), `unexpected path ${request.path}`);
        assert.deepEqual(
          signedHeadersPresent(request).sort(),
          [...SIGNING_HEADERS].sort(),
          `${request.method} ${request.path} is missing a signing header`,
        );
        const verdict = verifyRecorded(request);
        assert.equal(verdict.ok, true, `${request.method} ${request.path} failed verification: ${JSON.stringify(verdict)}`);
        assert.equal(verdict.signed, true);
      }
      // A wrong secret must not verify, or the assertion above would be vacuous.
      const wrong = verifyRecorded(rabbit.state.requests[0], { secrets: 'not-the-secret' });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.code, 'SIGNATURE_MISMATCH');
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('binds the SSE query, so a pathname-only signature does not verify', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('sign-query');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: false,
        name: 'sign-query',
        signingSecret: SIGNING_SECRET,
      });
      running = agent.start();
      const first = await rabbit.stream();
      first.send('ready', { protocol_version: 1, relay_id: 'relay-q', machine_id: 'rabbit' });
      await waitFor(() => agent.state.cursorRelayId === 'relay-q', { label: 'cursor attributed' });
      first.send('peer.hello', { machine_id: 'peer-1' });
      first.send('peer.hello', { machine_id: 'peer-2' });
      await waitFor(() => agent.state.seq >= 3, { label: 'cursor advanced' });

      // Reconnect: the attach URL now carries the resume seq, which is exactly
      // the case that a pathname-only signature gets wrong.
      first.close();
      const reattach = await waitFor(
        () =>
          rabbit.state.requests.find(
            (request) => request.method === 'GET' && request.path.includes('/v1/stream?') && request.path.includes('seq='),
          ) ?? null,
        { label: 'signed SSE re-attach with a query' },
      );
      assert.match(reattach.path, /^\/v1\/stream\?machine_id=/, reattach.path);
      assert.match(reattach.path, /seq=4/, `expected the resume seq in ${reattach.path}`);

      const withQuery = verifyRecorded(reattach);
      assert.equal(withQuery.ok, true, JSON.stringify(withQuery));

      // The regression guard: signing the pathname alone produces a signature
      // the relay can never accept, and it fails silently as a 401 in production.
      const pathnameOnly = verifyRecorded(reattach, { path: '/v1/stream' });
      assert.equal(pathnameOnly.ok, false, 'a pathname-only signature must not verify');
      assert.equal(pathnameOnly.code, 'SIGNATURE_MISMATCH');

      // Replay is caught too, which is what makes the nonce more than decoration.
      const nonces = new NonceCache();
      assert.equal(verifyRecorded(reattach, { nonces }).ok, true);
      const replay = verifyRecorded(reattach, { nonces });
      assert.equal(replay.ok, false);
      assert.equal(replay.code, 'SIGNATURE_REPLAY');
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it("keeps the relay's own error code when a signed request is refused", async () => {
    const rabbit = await startFakeRabbit({
      resultError: { status: 401, code: 'SIGNATURE_REQUIRED', message: 'this relay requires a signed request' },
    });
    const project = await makeRepo('sign-401');
    const logs = [];
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: rabbit.url,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'sign-401',
        logs,
        signingSecret: SIGNING_SECRET,
      });
      running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-401', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-SIGN401',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("x\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-sign-401',
      });
      await running;

      // The relay's code, not a paraphrase: SIGNATURE_EXPIRED and
      // SIGNATURE_REQUIRED need completely different fixes.
      assert.equal(agent.state.lastRelayError?.code, 'SIGNATURE_REQUIRED', JSON.stringify(agent.state.lastRelayError));
      assert.equal(agent.state.lastRelayError.http_status, 401);
      assert.equal(agent.state.lastRelayError.path, '/v1/result');

      const kept = logs.find((entry) => /result kept in spool/.test(entry.message));
      assert.ok(kept, `expected the delivery failure to be logged: ${logs.map((e) => e.message).join(' | ')}`);
      assert.equal(kept.extra.code, 'SIGNATURE_REQUIRED');
      assert.equal(kept.extra.status, 401);

      // A refused result stays spooled (never silently dropped), and a 4xx is
      // not retried into a storm.
      assert.equal(agent.spool.pendingResults().length, 1);
      assert.equal(rabbit.state.results.length, 0);
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('signs the API path, not the base-prefixed wire path', async () => {
    // With a deployment prefix there are two proxy shapes and the client cannot
    // tell them apart: one forwards `/w2m/v1/heartbeat` and the relay strips its
    // base path, the other strips it before the relay ever sees it. Only the
    // routed path (`/v1/heartbeat`) is knowable to both sides, so that is what
    // gets signed -- signing what is on the wire would 401 every request behind
    // a stripping proxy.
    const rabbit = await startFakeRabbit({ basePath: '/w2m' });
    const project = await makeRepo('sign-subpath');
    /** @type {object|null} */
    let agent = null;
    /** @type {Promise<void>|null} */
    let running = null;
    try {
      agent = makeAgent({
        rabbit: `${rabbit.url}/w2m`,
        project,
        allowed: [['node', '-e']],
        once: true,
        name: 'sign-subpath',
        signingSecret: SIGNING_SECRET,
      });
      running = agent.start();
      const stream = await rabbit.stream(15_000);
      stream.send('ready', { protocol_version: 1, relay_id: 'relay-sub', machine_id: 'rabbit' });
      stream.send('task.offer', {
        task_id: '01J-E2E-SIGNSUB',
        attempt: 1,
        mode: 'replicate',
        index: 0,
        index_total: 1,
        command_argv: [NODE, '-e', 'process.stdout.write("sub\\n")'],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        dedupe_key: 'dk-e2e-sign-sub',
      });
      await running;

      assert.ok(rabbit.state.requests.length >= 3);
      for (const request of rabbit.state.requests) {
        // The request still goes to the prefixed URL...
        assert.ok(request.path.startsWith('/w2m/v1/'), `expected the base path on the wire: ${request.path}`);
        // ...but the signature covers the routed path.
        const routed = request.path.slice('/w2m'.length);
        const verdict = verifyRecorded(request, { path: routed });
        assert.equal(verdict.ok, true, `${routed}: ${JSON.stringify(verdict)}`);

        // And the wire-path signature is exactly what a stripping proxy could
        // never verify -- pinned here so nobody "fixes" it back.
        const wireSigned = verifyRecorded(request, { path: request.path });
        assert.equal(wireSigned.ok, false, 'a base-prefixed signature must not verify');
        assert.equal(wireSigned.code, 'SIGNATURE_MISMATCH');
      }
    } finally {
      agent?.stop();
      if (running) await running.catch(() => {});
      await rabbit.close();
    }
  });

  it('treats an empty secret as explicitly off, and any other unusable value as an error', () => {
    const project = scratch('sign-config');
    const build = (signingSecret, name) =>
      createAgent({
        rabbitUrl: 'http://127.0.0.1:1',
        project,
        stateDir: join(root, `sign-config-state-${name}`),
        identity: { machine_id: newMachineId(), machine_name: 'x', device_token: 't', rabbit_url: null },
        caps: {},
        platform: { os: 'windows' },
        allowedCommands: [],
        log: () => {},
        ...(signingSecret === undefined ? {} : { signingSecret }),
      });

    // Absent, null and '' all mean "no signing at all" -- the wire stays exactly
    // as v0.2.3 sent it.
    assert.equal(build(undefined, 'a').signingEnabled, false);
    assert.equal(build(null, 'b').signingEnabled, false);
    assert.equal(build('', 'c').signingEnabled, false, "'' is the explicit off switch, not an error");
    assert.equal(build('a-real-secret', 'd').signingEnabled, true);

    // Anything else is a configuration mistake, and a configuration mistake must
    // never be downgraded into "unsigned link that looks fine" (§0).
    for (const bad of [42, true, {}, [], Symbol('s')]) {
      assert.throws(
        () => build(bad, `bad-${typeof bad}`),
        (error) => error instanceof TypeError && /signingSecret must be a string/.test(error.message),
        `expected ${String(bad)} to be rejected`,
      );
    }
  });

  it('matches the verifier byte-for-byte on the frozen test vectors', () => {
    // Published by the relay side (task-25) and reproduced here against the
    // frozen signing module: if either side ever changes the canonical string,
    // one of these two assertions goes red immediately instead of showing up as
    // a 401 in production.
    const secret = 'test-secret-abc';
    const vector1 = {
      method: 'POST',
      path: '/v1/heartbeat',
      timestamp: 1_780_000_000,
      nonce: 'abcdef0123456789',
      body: '{"task_id":"T1","machine_id":"m1"}',
    };
    const vector2 = {
      method: 'GET',
      path: '/v1/stream?machine_id=m1&seq=4',
      timestamp: 1_780_000_001,
      nonce: '0123456789abcdef',
      body: '',
    };
    assert.equal(
      canonicalString(vector1),
      'v1\nPOST\n/v1/heartbeat\n1780000000\nabcdef0123456789\nc132705f2342284320b7e59ef2f32f9d580f6ecf1b83116ae22b71ad6fa09d28',
    );
    assert.equal(
      signRequest({ secret, ...vector1 }),
      'v1=a8de86289154861c7289b87e3bb4f39121c5ca0f59d50f819285efe3265778db',
    );
    assert.equal(
      canonicalString(vector2),
      'v1\nGET\n/v1/stream?machine_id=m1&seq=4\n1780000001\n0123456789abcdef\nb613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
    );
    assert.equal(
      signRequest({ secret, ...vector2 }),
      'v1=a9c899e05b70be0c4fce37ef7cbedacd8bdf36984faeafc8499f13a135776ce6',
    );
    // The control the relay side published: a prefix changes the signature, so
    // the choice in the test above is not cosmetic.
    assert.notEqual(
      signRequest({ secret, ...vector1, path: '/w2m/v1/heartbeat' }),
      signRequest({ secret, ...vector1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// v0.5.10: process lifetime, bounded waits, and a publish path that cleans up
// after itself. All three were found by an independent verifier against v0.5.9:
// a documented `unref()` that did not exist (so a host without `ctx.effect`
// could never exit), an unbounded wait on a one-shot event, and a failed rename
// that leaked its temp file -- 266 of them in one live state directory.
// ---------------------------------------------------------------------------

describe('process lifetime: a started node must not hold its host open (v0.5.10)', () => {
  /** The plugin under test, by URL, for the child process below. */
  const PLUGIN_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'plugin', 'tools.mjs')).href;

  /**
   * The bare-context host, as a script: register the *shipping* plugin against a ctx that has no
   * `effect`, start the P2P node through `w2m_status`, say what it observed, and then simply stop.
   *
   * Nothing here calls `process.exit()`. The process ends if -- and only if -- every handle the node
   * owns is unreferenced, which is exactly the sentence the plugin's ownership comment promises.
   * Written to a scratch file (not embedded with `-e`) so a failure can be reproduced by hand.
   */
  const BARE_CTX_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [pluginUrl, stateDir, projectDir] = process.argv.slice(2);
mkdirSync(stateDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(stateDir, 'device.json'),
  JSON.stringify(
    {
      machine_id: '11111111-2222-4333-8444-555566667777',
      machine_name: 'bare-ctx',
      device_token: 'tok',
      rabbit_url: null,
    },
    null,
    2,
  ),
);

const plugin = await import(pluginUrl);
const tools = new Map();
const ctx = {
  // Deliberately no \`effect\`: this is the host the ownership comment describes.
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return definition;
    },
  },
  logger: { warn: () => {}, info: () => {} },
};
// Port 1 is not listening: the announcement fails, which is a reported fact and never fatal. What
// matters here is that the socket binds and the accept loop starts.
await plugin.apply(ctx, { autoStartAgent: true, rabbitUrl: 'http://127.0.0.1:1', stateDir, projectDir });
const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
console.log(
  'BARE_CTX_OK p2p_running=' + status.p2p?.running + ' socket_bound=' + status.p2p?.transport?.socket_bound,
);
`;

  it('exits by itself after a bare context started the node', async () => {
    const dir = scratch('bare-ctx-exit');
    const scriptPath = join(dir, 'bare-ctx-exit.mjs');
    writeFileSync(scriptPath, BARE_CTX_SCRIPT);

    const child = spawn(NODE, [scriptPath, PLUGIN_URL, join(dir, 'state'), join(dir, 'project')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    try {
      const { code } = await waitForChildClose(child, {
        timeoutMs: 30_000,
        label: 'the bare-context host',
      });
      assert.equal(code, 0, `the bare-context host must exit cleanly; stderr: ${stderr}`);
    } catch (error) {
      assert.fail(`${error.message}; stdout: ${stdout} stderr: ${stderr}`);
    }
    // Without this the test passes for a host that never started a node and therefore had nothing
    // to hold it open -- a green result that proves the opposite of what it claims.
    assert.match(
      stdout,
      /BARE_CTX_OK p2p_running=true socket_bound=true/,
      `the node must really have started, or exiting proves nothing; stdout: ${stdout}`,
    );
  });
});

describe('child-process waits are bounded (v0.5.10)', () => {
  it('resolves for a child that has already closed, instead of waiting for an event that cannot fire', async () => {
    const child = spawn(NODE, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    // Attached at spawn time, so this is the child's own exit and not a race with it.
    await new Promise((resolve) => child.once('exit', resolve));

    // The mechanism the defect is made of: `close` is one-shot, so a listener attached afterwards
    // never fires. Measured here rather than asserted from memory -- 150ms is many event-loop turns.
    let lateListenerFired = false;
    child.on('close', () => {
      lateListenerFired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      lateListenerFired,
      false,
      'a close listener attached after the child exited must not fire; that is the hang the helper prevents',
    );

    const startedAt = Date.now();
    const result = await waitForChildClose(child, { timeoutMs: 5000 });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.code, 3, 'the helper must report the code the child exited with');
    assert.equal(result.alreadyExited, true, 'an exited child is recognised without waiting');
    assert.ok(elapsed < 1000, `the helper must short-circuit, not wait out its timeout; took ${elapsed}ms`);
  });

  it('turns a child that never closes into a named failure instead of an unbounded wait', async () => {
    const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await assert.rejects(
        () => waitForChildClose(child, { timeoutMs: 300, label: 'the stuck child' }),
        /the stuck child did not close within 300ms/,
      );
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('state publishing: a failed rename is retried and cleaned up (v0.5.10)', () => {
  /**
   * Count -- and optionally fail -- the renames that target the state file.
   *
   * The agent binds `renameSync` as a named import of `node:fs`, so patching the module's own
   * property only takes effect after `syncBuiltinESMExports()`. Scoped to the state file on purpose:
   * `spool.mjs` uses the same temp+rename pattern, and a failure injected there would measure a
   * different file's behaviour. Always undone in the caller's `finally`.
   *
   * @param {string} stateFilePath
   * @param {{failures?: number}} [options]
   */
  function injectRenameFailures(stateFilePath, { failures = 0 } = {}) {
    const real = fs.renameSync;
    /** @type {Map<string, number>} temp path -> rename attempts */
    const attempts = new Map();
    let calls = 0;
    let left = failures;
    fs.renameSync = (from, to) => {
      if (to !== stateFilePath) return real(from, to);
      calls += 1;
      attempts.set(from, (attempts.get(from) ?? 0) + 1);
      if (left > 0) {
        left -= 1;
        const error = new Error(`EPERM: injected transient rename failure (${left} left)`);
        error.code = 'EPERM';
        throw error;
      }
      return real(from, to);
    };
    syncBuiltinESMExports();
    return {
      renameCalls: () => calls,
      attemptsBySource: () => attempts,
      restore: () => {
        fs.renameSync = real;
        syncBuiltinESMExports();
      },
    };
  }

  /** A port nothing listens on, so publishes happen (one per failed attach) with no relay needed. */
  async function deadPort() {
    const probe = createServer(() => {});
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  /**
   * @param {{stateDir: string, project: string, rabbitUrl: string, logs?: object[]}} options
   */
  function makeStateAgent({ stateDir, project, rabbitUrl, logs }) {
    return createAgent({
      rabbitUrl,
      project,
      stateDir,
      identity: {
        machine_id: '3f2a1111-2222-4333-8444-555566667777',
        machine_name: 'publish-retry',
        device_token: 'tok',
        rabbit_url: null,
      },
      caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false, python: null, npm: null, node: process.version },
      platform: { os: 'windows', os_version: '10.0', arch: 'x64', shell: 'cmd', shell_version: null },
      allowedCommands: [],
      once: false,
      heartbeatIntervalMs: 60_000,
      statePublishIntervalMs: 0,
      log: logs ? (level, message, extra) => logs.push({ level, message, extra: extra ?? {} }) : () => {},
    });
  }

  /** Temp files this test's publish path left in the state directory. */
  const leftoverTempFiles = (stateDir) =>
    readdirSync(stateDir).filter((name) => name.includes(`${AGENT_STATE_FILE}.tmp-`) || name.includes('.tmp-'));

  it('leaves no temp file behind when every rename fails, and keeps running', async () => {
    const project = scratch('publish-forced-project');
    const stateDir = scratch('publish-forced-state');
    const stateFilePath = join(stateDir, AGENT_STATE_FILE);
    // A directory where the file must go: the rename can never succeed on any platform.
    mkdirSync(stateFilePath);
    const logs = [];
    const patch = injectRenameFailures(stateFilePath);
    let agent = null;
    let running = null;
    try {
      agent = makeStateAgent({ stateDir, project, rabbitUrl: `http://127.0.0.1:${await deadPort()}`, logs });
      running = agent.start();
      await waitFor(() => patch.renameCalls() >= 3, { label: 'three failed publish attempts' });

      // The failure is reported by name, once, and never fatal.
      const warned = logs.filter((entry) => /could not publish agent-state\.json/.test(entry.message));
      assert.equal(warned.length, 1, 'a repeated failure is warned about once, not once per attempt');
      assert.match(
        String(warned[0].extra.error),
        /EPERM|EACCES|EISDIR|ENOTEMPTY|ENOTDIR/,
        `the warning must carry the filesystem reason; got ${JSON.stringify(warned[0].extra.error)}`,
      );

      // The property: a publish that failed leaves nothing of its own behind. Before v0.5.10 this
      // equalled the attempt count, which is how one live state directory reached 266 files / 187 KB.
      assert.deepEqual(
        leftoverTempFiles(stateDir),
        [],
        'a failed publish must unlink the temp file it created',
      );
      assert.equal(agent.state.statePublishedAt, null, 'nothing was published, so nothing claims to be');
      assert.equal(agent.state.stopped, false, 'a diagnostics write must never take the agent down');
      agent.stop();
      await running;
      running = null;
    } finally {
      patch.restore();
      agent?.stop();
      if (running) await running.catch(() => {});
    }
  });

  it('publishes through a transient EPERM instead of losing the publish', async () => {
    const project = scratch('publish-transient-project');
    const stateDir = scratch('publish-transient-state');
    const stateFilePath = join(stateDir, AGENT_STATE_FILE);
    // Two injected failures: enough that the first publish cannot succeed without a retry, and few
    // enough that the retry budget (STATE_RENAME_ATTEMPTS) is not exhausted.
    const patch = injectRenameFailures(stateFilePath, { failures: 2 });
    const logs = [];
    let agent = null;
    let running = null;
    try {
      agent = makeStateAgent({ stateDir, project, rabbitUrl: `http://127.0.0.1:${await deadPort()}`, logs });
      running = agent.start();
      await waitFor(() => agent.state.statePublishedAt !== null, { label: 'a published snapshot' });

      // The publish went through *within one call*, not on a later attempt: the temp file it created
      // was renamed three times -- two injected EPERMs and then the success.
      const firstTmp = [...patch.attemptsBySource().keys()][0];
      assert.ok(firstTmp, 'the publish path must have tried to rename a temp file');
      assert.equal(
        patch.attemptsBySource().get(firstTmp),
        3,
        `the same temp file must be retried after a transient EPERM; attempts: ${JSON.stringify([...patch.attemptsBySource()])}`,
      );
      // The retry is visible in the log, not only in the file: before v0.5.10 the only trace of this
      // contention was the pile of temp files it left behind.
      assert.ok(
        logs.some((entry) => /published agent-state\.json after 3 rename attempts/.test(entry.message)),
        `a retried publish must say so; log: ${JSON.stringify(logs.map((entry) => entry.message))}`,
      );
      assert.equal(
        logs.filter((entry) => /could not publish agent-state\.json/.test(entry.message)).length,
        0,
        'a publish that succeeded on a retry is not a failure and must not be warned about',
      );

      const published = JSON.parse(readFileSync(stateFilePath, 'utf8'));
      assert.equal(published.schema_version, AGENT_STATE_SCHEMA_VERSION);
      assert.equal(published.machine_id, '3f2a1111-2222-4333-8444-555566667777');
      assert.deepEqual(leftoverTempFiles(stateDir), [], 'the retry must not leak the temp file it retried');

      // The negative direction: with the failures consumed, a healthy publish needs exactly one
      // rename. The retry is a failure path, not a second rename on every publish.
      await waitFor(() => patch.attemptsBySource().size >= 2, { label: 'a second publish' });
      const secondTmp = [...patch.attemptsBySource().keys()][1];
      assert.equal(patch.attemptsBySource().get(secondTmp), 1, 'a rename that succeeds is not retried');
      assert.deepEqual(leftoverTempFiles(stateDir), [], 'and it leaves no temp file either');
      agent.stop();
      await running;
      running = null;
    } finally {
      patch.restore();
      agent?.stop();
      if (running) await running.catch(() => {});
    }
  });
});

describe('grant e2e (v1.3.10-beta.6 slice)', () => {
  const offerFor = (taskId, argv, overrides = {}) => ({
    task_id: taskId,
    attempt: 1,
    mode: 'replicate',
    index: 0,
    index_total: 1,
    command_argv: argv,
    cwd_rel: '.',
    write: false,
    timeout_ms: 30_000,
    dedupe_key: 'dk-' + taskId,
    ...overrides,
  });

  const readyFrame = { protocol_version: 1, rabbit_time: '2026-10-21T12:00:00Z', machine_id: 'rabbit' };

  it('executes a command under an empty allow-list when a valid grant authorises it', async () => {
    const grant = await import('../src/maintenance/grant.mjs');
    const operator = await import('../src/maintenance/operator-key.mjs');
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('grant-e2e-ok');
    const keys = operator.generateOperatorKeyPair();
    const argv = [NODE, '-e', 'process.stdout.write("grant-ok")'];
    const taskId = '01J-GRANT-E2E-OK';
    process.env.W2M_MAINTENANCE_PINS = join(project, '.grant-pins.json');
    try {
      const signed = grant.signGrant(grant.buildGrant({ taskId, machineIds: ['m-grant-e2e'], argv, nowMs: Date.now(), ttlMs: 60_000 }), keys.privateKeyPem);
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [], name: 'grant-e2e-ok' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', readyFrame);
      stream.send('task.offer', offerFor(taskId, argv, { machine_id: 'm-grant-e2e', operator_key: operator.registrationPayload(keys), grant: signed }));
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'ok');
      assert.equal(envelope.stdout_sha256, sha256Hex('grant-ok'));
    } finally { await rabbit.close(); delete process.env.W2M_MAINTENANCE_PINS; }
  });

  it('refuses argv that the grant does not cover, even with an empty allow-list', async () => {
    const grant = await import('../src/maintenance/grant.mjs');
    const operator = await import('../src/maintenance/operator-key.mjs');
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('grant-e2e-argv');
    const keys = operator.generateOperatorKeyPair();
    const signedArgv = [NODE, '-e', 'process.stdout.write("allowed")'];
    const otherArgv = [NODE, '-e', 'process.stdout.write("not-allowed")'];
    const taskId = '01J-GRANT-E2E-ARGV';
    process.env.W2M_MAINTENANCE_PINS = join(project, '.grant-pins.json');
    try {
      const signed = grant.signGrant(grant.buildGrant({ taskId, machineIds: ['m-grant-e2e'], argv: signedArgv, nowMs: Date.now(), ttlMs: 60_000 }), keys.privateKeyPem);
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [], name: 'grant-e2e-argv' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', readyFrame);
      stream.send('task.offer', offerFor(taskId, otherArgv, { machine_id: 'm-grant-e2e', operator_key: operator.registrationPayload(keys), grant: signed }));
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, 'GRANT_ARGV_MISMATCH');
    } finally { await rabbit.close(); delete process.env.W2M_MAINTENANCE_PINS; }
  });

  it('refuses with COMMAND_NOT_ALLOWED when no grant is present', async () => {
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('grant-e2e-none');
    const argv = [NODE, '-e', 'process.stdout.write("no-grant")'];
    try {
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [], name: 'grant-e2e-none' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', readyFrame);
      stream.send('task.offer', offerFor('01J-GRANT-E2E-NONE', argv));
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, 'COMMAND_NOT_ALLOWED');
    } finally { await rabbit.close(); }
  });

  it('refuses a grant that names a different machine', async () => {
    const grant = await import('../src/maintenance/grant.mjs');
    const operator = await import('../src/maintenance/operator-key.mjs');
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('grant-e2e-machine');
    const keys = operator.generateOperatorKeyPair();
    const argv = [NODE, '-e', 'process.stdout.write("wrong-machine")'];
    const taskId = '01J-GRANT-E2E-MACHINE';
    process.env.W2M_MAINTENANCE_PINS = join(project, '.grant-pins.json');
    try {
      const signed = grant.signGrant(grant.buildGrant({ taskId, machineIds: ['someone-else'], argv, nowMs: Date.now(), ttlMs: 60_000 }), keys.privateKeyPem);
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [], name: 'grant-e2e-machine' });
      const running = agent.start();
      const stream = await rabbit.stream();
      stream.send('ready', readyFrame);
      stream.send('task.offer', offerFor(taskId, argv, { machine_id: 'm-grant-e2e', operator_key: operator.registrationPayload(keys), grant: signed }));
      await running;
      const envelope = rabbit.state.results[0];
      assert.equal(envelope.status, 'refused');
      assert.equal(envelope.refusal_reason, 'GRANT_WRONG_MACHINE');
    } finally { await rabbit.close(); delete process.env.W2M_MAINTENANCE_PINS; }
  });
});

describe('grant replay e2e (v1.3.10-beta.6 slice)', () => {
  it('refuses a replayed grant end to end, after the first use succeeded', async () => {
    const grant = await import('../src/maintenance/grant.mjs');
    const operator = await import('../src/maintenance/operator-key.mjs');
    const rabbit = await startFakeRabbit();
    const project = await makeRepo('grant-e2e-replay');
    const keys = operator.generateOperatorKeyPair();
    const argv = [NODE, '-e', 'process.stdout.write("once")'];
    const taskId = '01J-GRANT-E2E-REPLAY';
    process.env.W2M_MAINTENANCE_PINS = join(project, '.grant-pins.json');
    try {
      const signed = grant.signGrant(grant.buildGrant({ taskId, machineIds: ['m-grant-e2e'], argv, nowMs: Date.now(), ttlMs: 60_000 }), keys.privateKeyPem);
      const agent = makeAgent({ rabbit: rabbit.url, project, allowed: [], name: 'grant-e2e-replay' });
      const running = agent.start();
      const stream = await rabbit.stream();
      const offer = {
        task_id: taskId, attempt: 1, mode: 'replicate', index: 0, index_total: 1,
        command_argv: argv, cwd_rel: '.', write: false, timeout_ms: 30_000,
        dedupe_key: 'dk-replay', machine_id: 'm-grant-e2e',
        operator_key: operator.registrationPayload(keys), grant: signed,
      };
      stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-21T12:00:00Z', machine_id: 'rabbit' });
      stream.send('task.offer', offer);
      await running;
      const first = rabbit.state.results[0];
      assert.equal(first.status, 'ok');
      assert.equal(first.stdout_sha256, sha256Hex('once'));
      assert.equal(first.authorization?.provenance, 'grant', 'the result records that a grant authorised this run');
      assert.match(String(first.authorization?.grant_id ?? ''), /^gr-/);
      // Second delivery of the same signed grant: the use ledger must make it a replay, not a second execution.
      const secondRabbit = await startFakeRabbit();
      const agent2 = makeAgent({ rabbit: secondRabbit.url, project, allowed: [], name: 'grant-e2e-replay2' });
      const running2 = agent2.start();
      const stream2 = await secondRabbit.stream();
      stream2.send('ready', { protocol_version: 1, rabbit_time: '2026-10-21T12:00:00Z', machine_id: 'rabbit' });
      stream2.send('task.offer', { ...offer, attempt: 2, dedupe_key: 'dk-replay-2' });
      await running2;
      const second = secondRabbit.state.results[0];
      assert.equal(second.status, 'refused');
      assert.equal(second.refusal_reason, 'GRANT_REPLAY');
      await secondRabbit.close();
    } finally { await rabbit.close(); delete process.env.W2M_MAINTENANCE_PINS; }
  });
});



describe('workspace execution', () => {
  it('runs in an isolated worktree, reports the patch, and cleans up', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-ws-exec-'));
      WS_FIXTURES.push(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base', 'utf8');
    git('add', '--all');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');

    const rabbit = await startFakeRabbit();
    const agent = makeAgent({ rabbit: rabbit.url, project: repo, allowed: [[NODE, '-e']], name: 'workspace-exec' });
    const running = agent.start();
    const stream = await rabbit.stream();
    stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-22T12:00:00Z', machine_id: 'rabbit' });
    stream.send('task.offer', {
      task_id: '01J-WORKSPACE-EXEC', attempt: 1, mode: 'replicate', index: 0, index_total: 1,
      command_argv: [NODE, '-e', 'require("fs").writeFileSync("out.txt", "hi")'],
      cwd_rel: '.', write: false, timeout_ms: 30_000, dedupe_key: 'dk-workspace-exec', machine_id: 'm-workspace-exec',
      workspace: { kind: 'worktree', base_commit: base, produce: 'patch' },
    });
    await running;
    const result = rabbit.state.results[0];
    assert.equal(result.status, 'ok', JSON.stringify(result).slice(0, 300));
    assert.equal(result.workspace.base_commit, base);
    assert.notEqual(result.workspace.head_commit, base);
    assert.ok((result.workspace.changed_files ?? []).includes('out.txt'), 'changed_files names the new file: ' + JSON.stringify(result.workspace));
    assert.match(String(result.workspace.patch_sha256), /^[0-9a-f]{64}$/);
    assert.equal(result.workspace.patch_bytes > 0, true);
    assert.equal(result.workspace.cleaned, true);
    assert.equal(fs.existsSync(path.join(repo, 'out.txt')), false, 'the main copy was never written');
    assert.equal(fs.existsSync(path.join(repo, '.w2m-worktrees', '01J-WORKSPACE-EXEC')), false, 'the worktree was removed');
    await rabbit.close();
  });

  it('refuses WORKSPACE_CREATE_FAILED when the base commit does not exist', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-ws-bad-'));
      WS_FIXTURES.push(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo, encoding: 'utf8' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a', 'utf8');
    execFileSync('git', ['add', '--all'], { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, encoding: 'utf8' });
    const rabbit = await startFakeRabbit();
    const agent = makeAgent({ rabbit: rabbit.url, project: repo, allowed: [[NODE, '--version']], name: 'workspace-bad' });
    const running = agent.start();
    const stream = await rabbit.stream();
    stream.send('ready', { protocol_version: 1, rabbit_time: '2026-10-22T12:00:00Z', machine_id: 'rabbit' });
    stream.send('task.offer', { task_id: '01J-WORKSPACE-BAD', attempt: 1, mode: 'replicate', index: 0, index_total: 1, command_argv: [NODE, '--version'], cwd_rel: '.', write: false, timeout_ms: 30_000, dedupe_key: 'dk-workspace-bad', machine_id: 'm-workspace-bad', workspace: { kind: 'worktree', base_commit: 'f'.repeat(40), produce: 'patch' } });
    await running;
    const result = rabbit.state.results[0];
    assert.equal(result.status, 'refused');
    assert.equal(result.refusal_reason, 'WORKSPACE_CREATE_FAILED');
    await rabbit.close();
  });
});
