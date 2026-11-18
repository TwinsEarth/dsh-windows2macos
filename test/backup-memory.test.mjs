/**
 * Memory-safety suite (v3.5.1): the mount path, the bounded readers and the guards that replaced the 3.5.0 OOM.
 *
 * ## What this suite is guarding against
 *
 * 3.5.0 crashed the DSH desktop host (4 GB V8 heap) about two minutes after the w2m bundle was enabled: the backup
 * row ran a missed-slot catch-up **inside the mount path**, and the engine/verify paths materialised whole files
 * (a 118 MB session log, 300 MB `old/` copies, two decoded artifacts per session per snapshot). Every test here maps
 * to one measured cause or to the named refusal that now stands in its place:
 *
 *   1. mount is cheap (no scan, no run, no blocking I/O) and records `pending_catch_up` instead of running;
 *   2. the session header read is bounded by a cap, not by the file size;
 *   3. `verifyRepo` streams large entries block-by-block and releases runtime artifacts one session at a time;
 *   4. the engine and the materialisers refuse `BACKUP_MEMORY_GUARD` instead of allocating past the budget;
 *   5. the catch-up opt-in (`backupCatchUpOnStart: true`) is the old behaviour, and it still starts off the mount
 *      stack (deferred) rather than inside `apply()`.
 *
 * The 200 MB logs are **sparse** (`ftruncateSync`): a test that had to write real bytes to prove "we do not read
 * the whole file" would pay the very cost it is checking for.
 */

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { apply, normalizeConfig, BACKUP_RUN_ROUTE_PATH } from '../src/plugin/backup.mjs';
import { createDailyScheduler } from '../src/plugin/schedule.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import { digestEntryStreaming, rebuildFile } from '../src/backup/materialize.mjs';
import { openRepoKey } from '../src/backup/keystore.mjs';
import {
  BACKUP_MEMORY_GUARD,
  DEFAULT_MAX_HEAP_BYTES,
  memoryGuard,
  resolveMaxHeapBytes,
} from '../src/backup/memory-guard.mjs';
import { readSessionHeader, SESSION_HEADER_SCAN_CAP_BYTES } from '../src/backup/scan.mjs';
import { buildStatus } from '../src/backup/routes.mjs';
import { makeHome, sessionLog, tempDir } from './helpers/backup-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_MODULE = pathToFileURL(path.join(ROOT, 'src', 'backup', 'scan.mjs')).href;

/** Write a sparse file whose first bytes are a valid session log and whose size is `sizeBytes`. */
function bigSparseLog(dir, sizeBytes, sessionId = 'session-big-0001') {
  const file = path.join(dir, 'sessions', '--E-BIG--', sessionId, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, sessionLog(sessionId, []));
    fs.ftruncateSync(fd, sizeBytes);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/** A fake Cordis context: logger, effect collector and an injected connection fetch registry. */
function fakeCtx() {
  const routes = [];
  const effects = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    effect: (fn) => {
      effects.push(fn);
      return () => {};
    },
    inject: (_services, callback) => {
      callback({ connection: { fetch: { register: (route) => routes.push(route) } } });
    },
    get: () => null,
  };
  return { ctx, routes, effects };
}

/** A backup repository built by the engine over a throwaway home. */
function repoFor(home, options = {}) {
  const { dir, cleanup } = tempDir('w2m-memory-repo-');
  const result = runBackup({
    root: dir,
    dshHome: home,
    password: 'correct horse battery staple',
    platform: 'linux',
    machineKey: false,
    ...options,
  });
  assert.equal(result.ok, true, `fixture backup failed: ${result.reason_code}: ${result.detail}`);
  return { dir, result, cleanup };
}

/** The `HH:mm:ss` slot `minutesAgo` minutes before now, in the backup scheduler's default zone. */
function slotMinutesAgo(minutesAgo) {
  const moment = new Date(Date.now() - minutesAgo * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(moment);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

describe('v3.5.1 mount path: cheap by construction', () => {
  it('defaults backupCatchUpOnStart to false, and refuses a non-boolean by name', () => {
    const defaults = normalizeConfig({ backupDir: os.tmpdir() });
    assert.equal(defaults.ok, true, defaults.detail);
    assert.equal(defaults.catch_up_on_start, false, 'a missed slot must never be run from the mount path by default');
    assert.equal(defaults.max_heap_bytes, 1536 * 1024 * 1024, 'the memory guard ceiling ships at ~1.5 GB');
    const optIn = normalizeConfig({ backupDir: os.tmpdir(), backupCatchUpOnStart: true });
    assert.equal(optIn.catch_up_on_start, true);
    const refused = normalizeConfig({ backupDir: os.tmpdir(), backupCatchUpOnStart: 'yes' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
    const badHeap = normalizeConfig({ backupDir: os.tmpdir(), backupMaxHeapMb: -1 });
    assert.equal(badHeap.ok, false);
    assert.equal(badHeap.reason_code, 'BACKUP_CONFIG_INVALID');
  });

  it('apply() does not run a backup, and records pending_catch_up in the describe payload and the status card', async () => {
    const { home, cleanup: homeCleanup } = makeHome({});
    const { dir: backupDir, cleanup: backupCleanup } = tempDir('w2m-memory-mount-');
    const { ctx, routes, effects } = fakeCtx();
    const slot = slotMinutesAgo(30);
    try {
      apply(
        ctx,
        {
          backupDir,
          dshHome: home,
          backupTimes: [slot],
          backupTimeZone: 'Asia/Shanghai',
          backupCatchUpMs: 12 * 60 * 60 * 1000,
          backupRuntimeVerify: 'off',
        },
        { defer: (fn) => fn() },
      );
      // Nothing ran: no repository was created by the mount.
      assert.equal(fs.existsSync(path.join(backupDir, 'backup.json')), false, 'mount must not start a backup');

      // The missed slot is visible to the panel route...
      const route = routes.find((candidate) => candidate.path === BACKUP_RUN_ROUTE_PATH);
      assert.ok(route, 'the describe route must still be registered');
      const response = await route.fetch(new Request(`http://127.0.0.1${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }));
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.catch_up_on_start, false);
      assert.ok(payload.pending_catch_up, 'a missed slot must be reported, not run');
      assert.equal(payload.pending_catch_up.missed_slot, slot);
      assert.equal(payload.pending_catch_up.action, 'pending-explicit-run');
      assert.equal(payload.scheduler.catch_up_on_start, false);

      // ...and to the read-only status card / CLI status, which reads the persisted record.
      const status = buildStatus({ backupDir, dshHome: home });
      assert.ok(status.pending_catch_up, 'the status card must carry the pending catch-up');
      assert.equal(status.pending_catch_up.missed_slot, slot);
    } finally {
      for (const dispose of effects) {
        try {
          const result = dispose();
          if (typeof result === 'function') result();
        } catch {
          /* the mount's own disposer must never throw in a test */
        }
      }
      homeCleanup();
      backupCleanup();
    }
  });

  it('apply() stays fast and small with a 200 MB log and a 1.36 GB old/ tree (the real crash shape)', () => {
    const { home, cleanup } = makeHome({ sessions: [{ workspace: '--E-GPT--', id: 'session-small-0001' }] });
    const { dir: backupDir, cleanup: backupCleanup } = tempDir('w2m-memory-big-');
    // The two shapes that made 3.5.0 expensive: a large live session log and a large `old/` tree.
    bigSparseLog(home, 200 * 1024 * 1024, 'session-3238a61f-big-real-shape');
    fs.mkdirSync(path.join(backupDir, 'old', 'ws', 'session-x'), { recursive: true });
    const oldFile = path.join(backupDir, 'old', 'ws', 'session-x', '20260101T000000Z-aaaaaaaaaaaa.json.enc');
    const fd = fs.openSync(oldFile, 'w');
    try {
      fs.writeSync(fd, Buffer.from('sealed-copy'));
      fs.ftruncateSync(fd, 1360 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const { ctx, effects } = fakeCtx();
    const slot = slotMinutesAgo(10);
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    try {
      apply(
        ctx,
        {
          backupDir,
          dshHome: home,
          backupTimes: [slot],
          backupTimeZone: 'Asia/Shanghai',
          backupCatchUpMs: 12 * 60 * 60 * 1000,
          backupRuntimeVerify: 'off',
        },
        { defer: (fn) => fn() },
      );
      const elapsed = performance.now() - started;
      const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
      assert.ok(elapsed < 200, `apply() took ${elapsed.toFixed(1)} ms with a 200 MB log present (must be < 200 ms)`);
      assert.ok(heapDelta < 32 * 1024 * 1024, `apply() allocated ${(heapDelta / 1048576).toFixed(1)} MB (must be < 32 MB)`);
      assert.equal(fs.existsSync(path.join(backupDir, 'backup.json')), false, 'mount must not start a backup');
    } finally {
      for (const dispose of effects) {
        try {
          const result = dispose();
          if (typeof result === 'function') result();
        } catch {
          /* ignore */
        }
      }
      cleanup();
      backupCleanup();
    }
  });

  it('off the mount stack: with backupCatchUpOnStart: true the run is deferred, and only then executes', async () => {
    const { home, cleanup: homeCleanup } = makeHome({});
    const { dir: backupDir, cleanup: backupCleanup } = tempDir('w2m-memory-optin-');
    const { ctx } = fakeCtx();
    const record = { opts: null, runPromise: null, started: false };
    const createScheduler = (opts) => {
      record.opts = opts;
      return {
        start() {
          record.started = true;
          if (opts.catchUpOnStart === true) {
            record.runPromise = Promise.resolve(opts.run({ scheduledAtMs: null, ranAtMs: Date.now(), slot: 'test', late: false }));
          }
        },
        stop() {},
        describe() {
          return { catch_up_on_start: opts.catchUpOnStart === true };
        },
      };
    };
    const deferred = [];
    try {
      apply(
        ctx,
        {
          backupDir,
          dshHome: home,
          backupTimes: ['22:00:00'],
          backupTimeZone: 'Asia/Shanghai',
          backupRuntimeVerify: 'off',
          backupCatchUpOnStart: true,
        },
        { createScheduler, defer: (fn) => deferred.push(fn) },
      );
      assert.equal(record.opts.catchUpOnStart, true, 'the opt-in must reach the scheduler');
      assert.equal(record.started, true);
      // The scheduler fired, but the heavy run was deferred: it has not started inside apply().
      assert.equal(deferred.length >= 1, true, 'the run must be deferred off the mount stack');
      assert.equal(fs.existsSync(path.join(backupDir, 'backup.json')), false, 'deferred means not yet run');
      // Run the deferred turn (and wait for the async run it starts).
      deferred.shift()();
      if (record.runPromise !== null) await record.runPromise;
      assert.equal(fs.existsSync(path.join(backupDir, 'backup.json')), true, 'the opt-in run must eventually run');
    } finally {
      homeCleanup();
      backupCleanup();
    }
  });
});

describe('v3.5.1 bounded session header read', () => {
  it('reads at most the scan cap from a 200 MB log, not the whole file', () => {
    const { dir, cleanup } = tempDir('w2m-memory-header-');
    try {
      const file = bigSparseLog(dir, 200 * 1024 * 1024);
      let readBytes = 0;
      const originalReadSync = fs.readSync;
      fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
        const read = originalReadSync.call(fs, fd, buffer, offset, length, position);
        readBytes += read;
        return read;
      };
      let result;
      try {
        result = readSessionHeader(file);
      } finally {
        fs.readSync = originalReadSync;
      }
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.format_version, 4);
      assert.ok(result.read_bytes > 0 && result.read_bytes <= SESSION_HEADER_SCAN_CAP_BYTES, `read_bytes=${result.read_bytes}`);
      assert.ok(readBytes <= SESSION_HEADER_SCAN_CAP_BYTES + 64 * 1024, `the header reader read ${readBytes} bytes of a 200 MB file`);
    } finally {
      cleanup();
    }
  });

  it('allocates far less than the file size in a child process with a small heap', () => {
    const { dir, cleanup } = tempDir('w2m-memory-header-child-');
    try {
      const file = bigSparseLog(dir, 200 * 1024 * 1024);
      const script = path.join(dir, 'child.mjs');
      fs.writeFileSync(
        script,
        [
          `import { readSessionHeader } from ${JSON.stringify(SCAN_MODULE)};`,
          'const before = process.memoryUsage();',
          'const result = readSessionHeader(process.argv[2]);',
          'const after = process.memoryUsage();',
          'process.stdout.write(JSON.stringify({',
          '  ok: result.ok === true, read_bytes: result.read_bytes ?? null,',
          '  heap_delta: after.heapUsed - before.heapUsed,',
          '  external_delta: after.external - before.external,',
          '}) + "\\n");',
        ].join('\n'),
      );
      const child = spawnSync(process.execPath, ['--max-old-space-size=64', script, file], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(child.status, 0, `child failed: ${child.stderr}`);
      const line = child.stdout.trim().split('\n').pop();
      const report = JSON.parse(line);
      assert.equal(report.ok, true);
      assert.ok(report.read_bytes <= SESSION_HEADER_SCAN_CAP_BYTES, `read_bytes=${report.read_bytes}`);
      assert.ok(report.heap_delta < 32 * 1024 * 1024, `heap delta ${report.heap_delta} bytes must stay under 32 MB`);
    } finally {
      cleanup();
    }
  });
});

describe('v3.5.1 verify: bounded digest path and per-session runtime release', () => {
  it('streams large entries block-by-block: peak is one block, and the verdict is unchanged', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }] });
    const { dir: repo, cleanup } = repoFor(home.home);
    try {
      const defaulted = verifyRepo({ root: repo, dshHome: home.home, password: 'correct horse battery staple', platform: 'linux', machineKey: false });
      assert.equal(defaulted.ok, true, defaulted.problems.map((problem) => problem.code).join(','));
      assert.equal(defaulted.streaming.files, 0, 'small entries stay on the materialising reader');
      const streamed = verifyRepo({
        root: repo,
        dshHome: home.home,
        password: 'correct horse battery staple',
        platform: 'linux',
        machineKey: false,
        streamThresholdBytes: 0,
      });
      assert.equal(streamed.ok, true, streamed.problems.map((problem) => problem.code).join(','));
      assert.equal(streamed.streaming.files, streamed.counts.files, 'a 0-byte threshold streams every entry');
      assert.equal(streamed.streaming.bytes, streamed.counts.bytes);
      assert.equal(streamed.streaming.peak_block_bytes > 0, true);
      assert.ok(streamed.streaming.peak_block_bytes <= 8 * 1024 * 1024, 'streaming must hold one block, not the file');
      // The deferred future-append pre-filter is reported by name, never silently counted as checked.
      assert.equal(streamed.future_append.checked, 0);
      assert.ok(streamed.future_append.skipped >= 1, 'every streamed session must be reported as skipped, by name');
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('digestEntryStreaming accepts exactly the bytes rebuildFile accepts', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }] });
    const { dir: repo, cleanup } = repoFor(home.home);
    try {
      const snapshotId = fs.readdirSync(path.join(repo, 'snapshots'))[0];
      const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'snapshots', snapshotId, 'manifest.json'), 'utf8'));
      const sessionEntry = manifest.files.find((entry) => entry.kind === 'session');
      assert.ok(sessionEntry, 'fixture must hold a session entry');
      const key = openRepoKey({ root: repo, dshHome: home.home, password: 'correct horse battery staple', platform: 'linux', machineKey: false });
      assert.equal(key.ok, true, key.detail);
      const whole = rebuildFile({ root: repo, entry: sessionEntry, dek: key.dek });
      assert.equal(whole.ok, true, whole.detail);
      const streamed = digestEntryStreaming({ root: repo, entry: sessionEntry, dek: key.dek });
      assert.equal(streamed.ok, true, streamed.detail);
      assert.equal(streamed.size, whole.buffer.length);
      assert.equal(streamed.digest, sessionEntry.sha256);
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('validates the runtime one session at a time: one two-artifact batch per session, nothing accumulated', () => {
    const home = makeHome({
      sessions: [
        { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' },
        { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0002' },
      ],
    });
    const { dir: repo, cleanup } = repoFor(home.home);
    try {
      const batches = [];
      const runtimeValidateBatch = ({ artifacts }) => {
        batches.push(artifacts.length);
        return {
          available: true,
          source: 'test',
          runtime: 'test',
          duration_ms: 0,
          verdicts: [{ ok: true, detail: '', events: 1 }, { ok: true, detail: '', events: 1 }],
        };
      };
      const result = verifyRepo({
        root: repo,
        dshHome: home.home,
        password: 'correct horse battery staple',
        platform: 'linux',
        machineKey: false,
        runtime: true,
        runtimeValidateBatch,
      });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.equal(result.runtime_verified.checked, 2, 'both sessions in the latest snapshot are validated');
      assert.equal(result.runtime_verified.failed, 0);
      assert.equal(result.runtime_verified.snapshots, 1, 'only the latest snapshot needs a runtime verdict');
      assert.deepEqual(batches, [2, 2], 'each session is one batch of original+appended, released before the next');
    } finally {
      cleanup();
      home.cleanup();
    }
  });
});

describe('v3.5.1 memory guard refuses by name instead of OOMing', () => {
  it('characterises the ceiling and the refusal', () => {
    assert.equal(DEFAULT_MAX_HEAP_BYTES, 1536 * 1024 * 1024);
    assert.equal(resolveMaxHeapBytes(undefined).maxHeapBytes, DEFAULT_MAX_HEAP_BYTES);
    assert.equal(resolveMaxHeapBytes(0).maxHeapBytes, null, '0 explicitly disables the guard');
    const ok = memoryGuard({ requestedBytes: 1024, maxHeapBytes: 1024 ** 3, heapUsedBytes: 1024 ** 2 });
    assert.equal(ok.ok, true);
    const refused = memoryGuard({ requestedBytes: 2 * 1024 ** 3, maxHeapBytes: 1024 ** 3, heapUsedBytes: 1024 ** 2, label: 'test-file' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, BACKUP_MEMORY_GUARD);
    assert.match(refused.detail, /test-file/);
  });

  it('rebuildFile refuses the materialisation with the named code', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }] });
    const { dir: repo, cleanup } = repoFor(home.home);
    try {
      const snapshotId = fs.readdirSync(path.join(repo, 'snapshots'))[0];
      const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'snapshots', snapshotId, 'manifest.json'), 'utf8'));
      const entry = manifest.files[0];
      const refused = rebuildFile({ root: repo, entry, dek: null, maxHeapBytes: 1024 });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, BACKUP_MEMORY_GUARD);
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('runBackup refuses a run it cannot fit, with BACKUP_MEMORY_GUARD', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }] });
    const { dir, cleanup } = tempDir('w2m-memory-repo-');
    try {
      const result = runBackup({
        root: dir,
        dshHome: home.home,
        password: 'correct horse battery staple',
        platform: 'linux',
        machineKey: false,
        maxHeapBytes: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, BACKUP_MEMORY_GUARD);
      // The refusal happens at the materialisation step, after the layout/lock/key (the engine's documented order),
      // so the directory may exist -- but no snapshot is committed: the run wrote nothing durable to restore.
      const snapshotsDir = path.join(dir, 'snapshots');
      const committed = fs.existsSync(snapshotsDir) ? fs.readdirSync(snapshotsDir).length : 0;
      assert.equal(committed, 0, 'a refused run commits no snapshot');
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('survives in a --max-old-space-size=64 child instead of dying with a heap OOM', () => {
    const { dir, cleanup } = tempDir('w2m-memory-child-');
    try {
      const script = path.join(dir, 'guard-child.mjs');
      fs.writeFileSync(
        script,
        [
          `import { memoryGuard, BACKUP_MEMORY_GUARD } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'backup', 'memory-guard.mjs')).href)};`,
          'const verdict = memoryGuard({ requestedBytes: 512 * 1024 * 1024, maxHeapBytes: 64 * 1024 * 1024, label: "child" });',
          'process.stdout.write(JSON.stringify({ code: verdict.ok ? null : verdict.code, expected: BACKUP_MEMORY_GUARD, heapUsed: process.memoryUsage().heapUsed }) + "\\n");',
        ].join('\n'),
      );
      const child = spawnSync(process.execPath, ['--max-old-space-size=64', script], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(child.status, 0, `child died instead of refusing: ${child.stderr}`);
      const report = JSON.parse(child.stdout.trim().split('\n').pop());
      assert.equal(report.code, BACKUP_MEMORY_GUARD);
      assert.equal(report.code, report.expected);
    } finally {
      cleanup();
    }
  });
});

describe('v3.5.1 scheduler: catchUpOnStart is a caller decision', () => {
  const NOW_MS = Date.UTC(2026, 10, 18, 14, 30, 0); // 22:30 Asia/Shanghai, 30 min after the 22:00 slot

  function makeScheduler(catchUpOnStart) {
    const counts = { runs: 0, armed: 0 };
    const scheduler = createDailyScheduler({
      run: async () => {
        counts.runs += 1;
      },
      times: ['22:00:00'],
      timeZone: 'Asia/Shanghai',
      catchUpMs: 12 * 60 * 60 * 1000,
      catchUpOnStart,
      nowMs: () => NOW_MS,
      setTimer: () => {
        counts.armed += 1;
        return { unref() {} };
      },
      clearTimer: () => {},
    });
    return { scheduler, counts };
  }

  it('does not run a missed slot when catchUpOnStart is false; it only arms the next timer', () => {
    const { scheduler, counts } = makeScheduler(false);
    scheduler.start();
    assert.equal(counts.runs, 0, 'no catch-up run');
    assert.equal(counts.armed, 1, 'the next slot is armed');
    scheduler.stop();
  });

  it('runs the missed slot once when catchUpOnStart is true (the opt-in path)', async () => {
    const { scheduler, counts } = makeScheduler(true);
    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(counts.runs, 1, 'one catch-up run for the missed slot');
    scheduler.stop();
  });
});
