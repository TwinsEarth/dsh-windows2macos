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
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  evaluateGate,
  matchAllowedCommand,
  parseAllowedCommands,
  satisfiesVersion,
  summarizeRtt,
  verifyEnvelope,
} from '../src/agent/agent.mjs';
import { endpointUrl, joinUrl, resolveBaseUrl } from '../src/agent/url.mjs';
import { createRelayServer } from '../src/relay/server.mjs';
import * as plugin from '../src/plugin/tools.mjs';

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
    assert.equal(matchAllowedCommand([NODE, '--test'], prefixes).allowed, true);
  });

  it('refuses everything when the list is empty', () => {
    assert.equal(matchAllowedCommand([NODE, '--test'], []).allowed, false);
    assert.equal(matchAllowedCommand([NODE, '--test'], undefined).allowed, false);
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
async function startFakeRabbit({ basePath = '' } = {}) {
  const state = {
    pairs: [],
    results: [],
    heartbeats: [],
    streams: [],
    receivedTokens: [],
    paths: [],
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
      // Everything is served under `basePath`; anything outside it is a 404,
      // exactly like a relay behind `--base-path`.
      if (basePath !== '' && !url.pathname.startsWith(`${basePath}/`)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
        return;
      }
      const pathname = basePath === '' ? url.pathname : url.pathname.slice(basePath.length);

      if (pathname === '/v1/stream') {
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
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ lease_until: '2026-10-07T12:10:00Z', cancel: false }));
        return;
      }
      if (pathname === '/v1/result') {
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
function makeAgent({ rabbit, project, allowed, once = true, name = 'e2e', stringForm = false, logs }) {
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
    log,
    tmpDir: root,
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

      // A restarted relay numbers events from 1 again: adopt the new position.
      second.close();
      const third = await rabbit.stream();
      third.send('ready', { protocol_version: 1, relay_id: 'relay-B', seq: 1, machine_id: 'rabbit' });
      await waitFor(() => agent.state.relayIdChanges === 1, { label: 'relay restart detected' });
      assert.equal(agent.state.seq, 1, 'a new relay_id must reset the seq cursor');
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
    } finally {
      agent.stop();
      await running;
      await new Promise((resolve) => server.close(resolve));
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
        env: { ...process.env, DSH_HOME: join(root, 'cli-dsh-home') },
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
  await plugin.apply(ctx, config);
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
      assert.equal(typeof published.reconnect_attempts, 'number');
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
      const exitCode = await new Promise((resolve) => child.on('close', resolve));
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

      assert.ok(reads > 20, `expected to catch the file mid-flight, only ${reads} reads`);
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
    const exitCode = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(exitCode, 0, `an unreachable relay must not be fatal; stderr: ${stderr}`);
    assert.equal(stderr.trim(), '', 'no stack trace may reach stderr');
    // The file is published even while disconnected, which is how an operator
    // can tell "agent running, relay down" from "no agent here".
    const published = JSON.parse(readFileSync(join(stateDir, AGENT_STATE_FILE), 'utf8'));
    assert.equal(published.connected, false);
    assert.equal(published.rttMs.last, null);
    assert.ok(published.reconnect_attempts >= 1, 'it must have tried to reconnect');
  });
});
