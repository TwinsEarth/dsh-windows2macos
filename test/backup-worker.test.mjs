/**
 * S8: the backup engine runs on a `worker_threads` worker without changing what it produces.
 *
 * The suite has four groups, matching the slice's acceptance criteria (docs/REFACTOR-P1-PLAN.md §2, S8):
 *
 *   1. a **real** Worker on a throwaway fixture home/repository: the run succeeds with `mode:'worker'`, the
 *      snapshot content is identical to an inline run, and the progress stages arrive in order;
 *   2. the **supervisor**: injected fake workers drive the progress/done path, the pinned `resourceLimits`, the
 *      named OOM/timeout/crash failures, and the progress state file (including the "no secret in it" rule);
 *   3. the **fallbacks**: a synchronous spawn throw and `W2M_BACKUP_INLINE=1` both produce the unchanged inline run;
 *   4. the **plugin seam**: `apply()` with `deps.backupRunner` sends the run route, the scheduled slot and the verify
 *      route through the runner, exposes `engine_mode`/`progress`, and turns a worker failure into a named refusal
 *      instead of throwing out of the route.
 *
 * No network, no real DSH home: every fixture is a temp directory and every repository is written under `tmpdir()`.
 * The config/test seam keeps the real `Worker` only in group 1 (the requirement is a real-thread test), and the fake
 * factory everywhere else so OOM/timeout/crash paths are deterministic instead of machine-dependent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { manifestDigest } from '../src/backup/manifest.mjs';
import { readSnapshot } from '../src/backup/repo.mjs';
import { BACKUP_WORKER_STATE_REL, classifyHomePath, collectScopeFiles } from '../src/backup/scopes.mjs';
import {
  DEFAULT_WORKER_TIMEOUT_MS,
  WORKER_CODES,
  WORKER_RESOURCE_LIMITS,
  backupWorkerStateFile,
  createBackupWorkerRunner,
  readWorkerState,
} from '../src/plugin/backup-worker.mjs';
import {
  apply,
  BACKUP_RUN_ROUTE_PATH,
  BACKUP_VERIFY_ROUTE_PATH,
  normalizeConfig,
  RUN_CONFIRM_TOKEN,
} from '../src/plugin/backup.mjs';
import { makeHome, put, registryDocument, tempDir } from './helpers/backup-fixture.mjs';

/** A fixed clock for both runs, so `created_at` (and everything derived from it) is comparable. */
const NOW = new Date('2026-11-17T12:00:00.000Z');

/** The deterministic half of a run input: no OS keystore probing, no wall clock. */
const FIXED_INPUT = Object.freeze({ platform: 'linux', machineKey: false, now: NOW });

/** The sentinel used to prove no credential reaches the progress file or a worker message after `start`. */
const SENTINEL_PASSWORD = 'sentinel-PIN-9xQ7-never-on-disk';

function homeFixture() {
  return makeHome({
    sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }],
    registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }),
  });
}

function backupInput(home, root) {
  return { root, dshHome: home, ...FIXED_INPUT };
}

/** A recording logger: the fallback path must say "inline" in a warning, the supervisor must warn on state failures. */
function recordingLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
    },
  };
}

/**
 * A fake Worker with exactly the surface the runner uses: `on`/`postMessage`/`terminate`.
 *
 * `onStart` runs synchronously inside `postMessage`, which makes the event ordering deterministic: the runner's
 * listeners are attached before the start message is posted, so progress emitted from `onStart` is delivered in the
 * same call stack and the progress state file is already written when `run()` returns its promise.
 */
function fakeWorker() {
  const worker = new EventEmitter();
  worker.posted = [];
  worker.terminated = false;
  worker.onStart = null;
  worker.postMessage = (message) => {
    worker.posted.push(message);
    if (typeof worker.onStart === 'function') worker.onStart(message, worker);
  };
  worker.terminate = () => {
    worker.terminated = true;
    return Promise.resolve(0);
  };
  return worker;
}

/** A fake Cordis context recording route registrations and log lines (the backup-run suite's shape, trimmed). */
function fakeCtx() {
  const registrations = [];
  const effects = [];
  const logs = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection']);
      callback({ connection: { fetch: { register: (definition) => registrations.push(definition) } } });
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') effects.push(disposer);
      return disposer;
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    get: () => null,
  };
  return { ctx, registrations, effects, logs };
}

/** A scheduler harness: `run` can be invoked directly, without waiting for the 22:00 slot. */
function schedulerHarness() {
  const captured = { options: null };
  return {
    captured,
    createScheduler: (options) => {
      captured.options = options;
      return {
        start() {},
        stop() {},
        describe() {
          return { time_zone: options.timeZone, times: options.times, stopped: false, next_at: null };
        },
      };
    },
  };
}

/** A run result shaped like `runBackup`'s, with a value no inline run could produce (the fake marker). */
function fakeRunResult(overrides = {}) {
  return {
    ok: true,
    snapshot_id: '20261117T120000Z-fakecafe',
    digest: 'a'.repeat(64),
    sessions: 1,
    files: 1,
    blocks_new: 1,
    blocks_reused: 0,
    dedupe_ratio: 0,
    duration_ms: 5,
    rotated: 0,
    old_format: 'records',
    old_usage: null,
    warnings: [],
    memory_guard: { refusals: 0 },
    ...overrides,
  };
}

/** A verify result shaped like `verifyRepo`'s. */
function fakeVerifyResult(overrides = {}) {
  return {
    ok: true,
    counts: { snapshots: 1, files: 1, blocks: 1, bytes: 1, old: 0, current: 0 },
    problems: [],
    ...overrides,
  };
}

/** The manifest digest a run of the same content would have produced for `snapshotId`. */
function digestWithSnapshotId(manifest, snapshotId) {
  return manifestDigest({ ...manifest, snapshot_id: snapshotId });
}

describe('backup worker: real worker_threads execution', () => {
  it('never captures its own in-flight progress file (the settled state.json stays in scope)', () => {
    const { home, cleanup } = homeFixture();
    try {
      put(join(home, 'xclient', 'w2m-backup', 'state.json'), '{"last_runtime_verify":null}\n');
      put(join(home, 'xclient', 'w2m-backup', 'worker.json'), '{"stage":"store"}\n');
      put(join(home, 'xclient', 'w2m-backup', '.worker.json.tmp-1-2-3'), '{"stage":"scan"}\n');
      const collected = collectScopeFiles({ dshHome: home, scopes: ['state'] });
      assert.equal(collected.ok, true, collected.detail);
      const rels = collected.files.map((file) => file.rel);
      assert.ok(rels.includes('xclient/w2m-backup/state.json'), 'the settled state.json is still backed up');
      assert.equal(rels.includes(BACKUP_WORKER_STATE_REL), false, 'the in-flight progress file is not a backup candidate');
      assert.equal(rels.some((rel) => rel.includes('.worker.json.tmp-')), false, 'nor are its atomic-write temporaries');
      const skipped = collected.skipped.find((row) => row.rel === BACKUP_WORKER_STATE_REL);
      assert.equal(skipped?.class, 'self-copy', 'the skip is reported with a class, not silently dropped');
      assert.equal(classifyHomePath(BACKUP_WORKER_STATE_REL), 'self-copy', 'the coverage report agrees');
      assert.equal(backupWorkerStateFile(home), join(home, ...BACKUP_WORKER_STATE_REL.split('/')), 'one path, one constant');
    } finally {
      cleanup();
    }
  });

  it('runs the engine on a real Worker and produces the inline-identical snapshot (digest up to the random id)', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir: repoDir, cleanup: cleanRepo } = tempDir('w2m-worker-real-repo-');
    try {
      // The progress home is the fixture home itself: the runner really writes `xclient/w2m-backup/worker.json`
      // into the directory being scanned, which is what makes the "scan does not capture its own progress file"
      // exclusion an end-to-end fact rather than a unit-test one.
      const runner = createBackupWorkerRunner({ dshHome: home, env: {}, timeoutMs: 120_000 });
      const root = join(repoDir, 'repo');
      const outcome = await runner.run(backupInput(home, root));

      assert.equal(outcome.ok, true, outcome.error?.detail);
      assert.equal(outcome.mode, 'worker', 'the real run must execute on the worker');
      assert.equal(outcome.result.ok, true, outcome.result.detail);
      assert.match(outcome.result.snapshot_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      assert.equal(runner.mode(), 'worker');

      // The coarse progress stages are posted while the synchronous engine call is still running: scan/select/store
      // from the wrapped scan seam and a completion checkpoint after the commit. Their order is the assertion.
      const stages = outcome.progress.map((event) => event.stage);
      for (const stage of ['scan', 'select', 'store', 'commit']) {
        assert.ok(stages.includes(stage), `progress must include ${stage} (saw ${stages.join(', ')})`);
      }
      assert.ok(stages.indexOf('scan') < stages.indexOf('select'), 'scan is reported before select');
      assert.ok(stages.indexOf('select') < stages.indexOf('store'), 'select is reported before store');
      assert.ok(stages.indexOf('store') < stages.indexOf('commit'), 'store is reported before the commit checkpoint');

      // The terminal path removed the progress file; the run itself reported (and therefore skipped) it.
      assert.equal(existsSync(backupWorkerStateFile(home)), false);
      assert.ok(
        outcome.result.scope_skipped.some((row) => row.rel === BACKUP_WORKER_STATE_REL && row.class === 'self-copy'),
        'the in-flight progress file is reported as a deliberate skip in the run result',
      );

      // The inline comparison: a fresh repository, the same fixture bytes, a fixed clock. `snapshot_id` is random by
      // design (repo.mjs `makeSnapshotId` uses 4 random bytes), so the raw digests cannot be equal across two runs;
      // the meaningful invariant is that the manifest digest matches once the volatile id is aligned. `created_at`
      // is already identical because both runs were given the same `now`.
      const inline = runBackup(backupInput(home, join(repoDir, 'repo-inline')));
      assert.equal(inline.ok, true, inline.detail);
      const workerSnapshot = readSnapshot({ root, snapshotId: outcome.result.snapshot_id });
      const inlineSnapshot = readSnapshot({ root: join(repoDir, 'repo-inline'), snapshotId: inline.snapshot_id });

      assert.deepEqual(inlineSnapshot.manifest.files, workerSnapshot.manifest.files, 'the file entries are identical');
      assert.equal(
        workerSnapshot.manifest.files.some((file) => file.rel === BACKUP_WORKER_STATE_REL),
        false,
        'the worker snapshot does not contain the progress file',
      );
      assert.deepEqual(inlineSnapshot.manifest.counts, workerSnapshot.manifest.counts);
      assert.deepEqual(inlineSnapshot.manifest.scopes, workerSnapshot.manifest.scopes);
      assert.deepEqual(inlineSnapshot.manifest.registry, workerSnapshot.manifest.registry);
      assert.equal(
        digestWithSnapshotId(inlineSnapshot.manifest, outcome.result.snapshot_id),
        outcome.result.digest,
        'the inline manifest is byte-identical to the worker snapshot once the random snapshot id is aligned',
      );
      assert.equal(
        digestWithSnapshotId(workerSnapshot.manifest, inline.snapshot_id),
        inline.digest,
        'and the same in the other direction',
      );
    } finally {
      cleanHome();
      cleanRepo();
    }
  });

  it('runs a verify job on the real Worker as well', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir: repoDir, cleanup: cleanRepo } = tempDir('w2m-worker-real-verify-');
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-real-verify-state-');
    try {
      const root = join(repoDir, 'repo');
      const seeded = runBackup(backupInput(home, root));
      assert.equal(seeded.ok, true, seeded.detail);

      const runner = createBackupWorkerRunner({ dshHome: stateHome, env: {}, timeoutMs: 120_000 });
      const verifyInput = { root, dshHome: home, platform: 'linux', machineKey: false, futureAppend: false, runtime: false };
      const outcome = await runner.run(verifyInput, { jobs: ['verify'], verifyOptions: verifyInput });

      assert.equal(outcome.ok, true, outcome.error?.detail);
      assert.equal(outcome.mode, 'worker');
      assert.equal(outcome.result.ok, true, outcome.result.detail);
      assert.equal(outcome.result.counts.snapshots, 1, 'the run this test seeded is the one verified');
      assert.ok(Array.isArray(outcome.result.problems));
      assert.ok(outcome.progress.some((event) => event.stage === 'verify'), 'the verify checkpoint is reported');
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false);
    } finally {
      cleanHome();
      cleanRepo();
      cleanState();
    }
  });
});

describe('backup worker: supervisor, progress file and named failures', () => {
  it('drives progress -> done on an injected worker, pins resourceLimits, and keeps the secret out of the file', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-fake-state-');
    try {
      const worker = fakeWorker();
      const spawnCalls = [];
      const { lines, logger } = recordingLogger();
      const runner = createBackupWorkerRunner({
        dshHome: stateHome,
        env: {},
        logger,
        spawn: (url, options) => {
          spawnCalls.push({ url, options });
          return worker;
        },
      });

      worker.onStart = (message, self) => {
        assert.equal(message.type, 'start');
        assert.deepEqual(message.jobs, ['run']);
        self.emit('message', { type: 'progress', stage: 'scan', done: 0, total: 0 });
        self.emit('message', { type: 'progress', stage: 'store', done: 2, total: 2 });
        // The done message is posted on a later turn so the test can inspect the in-flight state file first.
        setImmediate(() => self.emit('message', { type: 'done', result: { ok: true, snapshot_id: 'snap-fake', sessions: 1 } }));
      };

      const input = { ...backupInput(home, join(stateHome, 'repo')), password: SENTINEL_PASSWORD };
      const running = runner.run(input);

      // The start message is the single credential hand-off: it carries the password once...
      assert.equal(worker.posted.length, 1);
      assert.equal(worker.posted[0].type, 'start');
      assert.equal(worker.posted[0].input.password, SENTINEL_PASSWORD);
      // ...and nothing the runner writes to disk or posts after it does.
      assert.equal(JSON.stringify(worker.posted.slice(1)).includes(SENTINEL_PASSWORD), false);

      // In-flight progress: the record has the documented shape and no input/credential material.
      const during = readWorkerState(stateHome);
      assert.notEqual(during.state, null, 'the progress file is written while the run is in flight');
      assert.equal(during.file, backupWorkerStateFile(stateHome));
      assert.equal(during.state.stage, 'store');
      assert.equal(during.state.done, 2);
      assert.equal(during.state.total, 2);
      assert.equal(during.state.mode, 'worker');
      assert.equal(typeof during.state.started_at, 'string');
      assert.equal(typeof during.state.updated_at, 'string');
      assert.equal(during.state.pid, process.pid);
      assert.deepEqual(Object.keys(during.state).sort(), ['done', 'mode', 'pid', 'stage', 'started_at', 'total', 'updated_at']);
      const rawFile = readFileSync(during.file, 'utf8');
      assert.equal(rawFile.includes(SENTINEL_PASSWORD), false, 'the progress file must never carry a credential');
      assert.equal(rawFile.includes('password'), false, 'not even the field name');

      const outcome = await running;
      assert.equal(outcome.ok, true);
      assert.equal(outcome.mode, 'worker');
      assert.deepEqual(outcome.progress.map((event) => event.stage), ['scan', 'store']);
      assert.equal(outcome.result.snapshot_id, 'snap-fake');
      assert.equal(outcome.result.ok, true);
      assert.equal(worker.terminated, true, 'the worker is terminated once it reported a result');
      assert.equal(runner.mode(), 'worker');
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false, 'the progress file is removed on finish');
      assert.deepEqual(lines, [], 'a healthy worker run needs no warning');

      assert.equal(spawnCalls.length, 1);
      assert.ok(String(spawnCalls[0].url).endsWith('/src/backup/engine-worker.mjs'), 'the real worker entry is spawned');
      assert.deepEqual(spawnCalls[0].options.resourceLimits, { ...WORKER_RESOURCE_LIMITS });
      assert.equal(spawnCalls[0].options.resourceLimits.maxOldGenerationSizeMb, 1024);
    } finally {
      cleanHome();
      cleanState();
    }
  });

  it('maps a worker OOM error event to BACKUP_WORKER_OOM and terminates the thread', async () => {
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-oom-state-');
    try {
      const worker = fakeWorker();
      const runner = createBackupWorkerRunner({
        dshHome: stateHome,
        env: {},
        timeoutMs: 5_000,
        spawn: () => worker,
      });
      worker.onStart = () => {
        const error = new Error('Worker terminated due to reaching memory limit: JS heap out of memory');
        error.code = 'ERR_WORKER_OUT_OF_MEMORY';
        worker.emit('error', error);
      };

      const outcome = await runner.run(backupInput('C:\\unused', join(stateHome, 'repo')));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.mode, 'worker');
      assert.equal(outcome.code, WORKER_CODES.OOM);
      assert.equal(outcome.error.code, WORKER_CODES.OOM);
      assert.match(outcome.error.detail, /out of memory/u);
      assert.equal(worker.terminated, true);
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false);
    } finally {
      cleanState();
    }
  });

  it('treats exit code 134 as OOM and any other exit as BACKUP_WORKER_FAILED', async () => {
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-exit-state-');
    try {
      const oomWorker = fakeWorker();
      oomWorker.onStart = () => oomWorker.emit('exit', 134);
      const oomRunner = createBackupWorkerRunner({ dshHome: stateHome, env: {}, timeoutMs: 5_000, spawn: () => oomWorker });
      const oomOutcome = await oomRunner.run(backupInput('C:\\unused', join(stateHome, 'repo')));
      assert.equal(oomOutcome.code, WORKER_CODES.OOM);
      assert.equal(oomWorker.terminated, true);

      const crashWorker = fakeWorker();
      crashWorker.onStart = () => crashWorker.emit('exit', 1);
      const crashRunner = createBackupWorkerRunner({ dshHome: stateHome, env: {}, timeoutMs: 5_000, spawn: () => crashWorker });
      const crashOutcome = await crashRunner.run(backupInput('C:\\unused', join(stateHome, 'repo')));
      assert.equal(crashOutcome.code, WORKER_CODES.FAILED);
      assert.equal(crashOutcome.ok, false);
      assert.equal(crashWorker.terminated, true);
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false);
    } finally {
      cleanState();
    }
  });

  it('turns a silent worker into BACKUP_WORKER_TIMEOUT and terminates it', async () => {
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-timeout-state-');
    try {
      const worker = fakeWorker();
      const { lines, logger } = recordingLogger();
      const runner = createBackupWorkerRunner({ dshHome: stateHome, env: {}, logger, timeoutMs: 40, spawn: () => worker });
      const startedAt = Date.now();
      const outcome = await runner.run(backupInput('C:\\unused', join(stateHome, 'repo')));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, WORKER_CODES.TIMEOUT);
      assert.match(outcome.error.detail, /40 ms/u);
      assert.equal(worker.terminated, true, 'a timed-out worker must be terminated, not left running');
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false);
      assert.ok(Date.now() - startedAt >= 30, 'the timeout is the configured budget');
      assert.deepEqual(lines, [], 'a timeout is a return value, not a thrown warning');
    } finally {
      cleanState();
    }
  });

  it('falls back to the unchanged inline run when the spawn factory throws synchronously', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir: repoDir, cleanup: cleanRepo } = tempDir('w2m-worker-fallback-repo-');
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-fallback-state-');
    try {
      let spawnCalls = 0;
      const { lines, logger } = recordingLogger();
      const runner = createBackupWorkerRunner({
        dshHome: stateHome,
        env: {},
        logger,
        spawn: () => {
          spawnCalls += 1;
          throw new Error('worker_threads is unavailable on this host');
        },
      });

      const outcome = await runner.run(backupInput(home, join(repoDir, 'repo')));
      assert.equal(spawnCalls, 1);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.mode, 'inline');
      assert.equal(outcome.result.ok, true, outcome.result.detail);
      assert.match(outcome.result.snapshot_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      assert.ok(lines.some((line) => line.includes('inline')), 'the fallback is declared in a logger warning');
      assert.equal(runner.mode(), 'inline');
      assert.equal(existsSync(backupWorkerStateFile(stateHome)), false, 'the inline path writes no progress file');
    } finally {
      cleanHome();
      cleanRepo();
      cleanState();
    }
  });

  it('honours W2M_BACKUP_INLINE=1 without spawning anything', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir: repoDir, cleanup: cleanRepo } = tempDir('w2m-worker-inline-env-');
    const { dir: stateHome, cleanup: cleanState } = tempDir('w2m-worker-inline-state-');
    try {
      let spawnCalls = 0;
      const runner = createBackupWorkerRunner({
        dshHome: stateHome,
        env: { W2M_BACKUP_INLINE: '1' },
        spawn: () => {
          spawnCalls += 1;
          return fakeWorker();
        },
      });
      const outcome = await runner.run(backupInput(home, join(repoDir, 'repo')));
      assert.equal(spawnCalls, 0, 'the explicit inline switch must not even create a worker');
      assert.equal(outcome.mode, 'inline');
      assert.equal(outcome.ok, true);
      assert.equal(outcome.result.ok, true, outcome.result.detail);
    } finally {
      cleanHome();
      cleanRepo();
      cleanState();
    }
  });
});

describe('backup worker: plugin seam', () => {
  it('sends the run route, the scheduled slot and the verify route through deps.backupRunner', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup: cleanRepo } = tempDir('w2m-worker-plugin-');
    try {
      const fake = fakeCtx();
      const harness = schedulerHarness();
      const calls = [];
      const runner = {
        run: async (input, options = {}) => {
          calls.push({ input, options });
          const jobs = Array.isArray(options.jobs) ? options.jobs : ['run'];
          return jobs.includes('verify') ? { ok: true, mode: 'worker', result: fakeVerifyResult() } : { ok: true, mode: 'worker', result: fakeRunResult() };
        },
      };
      apply(
        fake.ctx,
        {
          backupDir: join(dir, 'repo'),
          dshHome: home,
          backupMachineKey: false,
          backupRuntimeVerify: 'off',
          backupTimes: ['23:59:59'],
          backupTimeZone: 'UTC',
          backupCatchUpMs: 1,
        },
        { backupRunner: runner, createScheduler: harness.createScheduler },
      );

      // Mount is inert: no worker/inline call happens just because the row mounted.
      assert.equal(calls.length, 0, 'the mount path must not run a backup');

      const find = (path) => fake.registrations.find((row) => row.path === path);
      const runRoute = find(BACKUP_RUN_ROUTE_PATH);
      assert.ok(runRoute, 'the run route is mounted');

      const posted = await runRoute.fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }),
      }));
      const body = await posted.json();
      assert.equal(body.ok, true, `${body.reason_code}: ${body.detail}`);
      assert.equal(body.snapshot_id, '20261117T120000Z-fakecafe', 'the route returns the runner result, not a fresh inline run');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].options.jobs, ['run']);
      assert.equal(calls[0].input.root, join(dir, 'repo'));
      assert.equal(calls[0].input.dshHome, home);
      assert.equal(typeof calls[0].input.maxHeapBytes, 'number', 'the engine input is built exactly as before S8');

      const described = await (await runRoute.fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }))).json();
      assert.equal(described.engine_mode, 'worker', 'describe exposes the last execution location');
      assert.equal(described.progress, null, 'no progress record once the fake run has finished');
      assert.equal(described.worker_timeout_ms, DEFAULT_WORKER_TIMEOUT_MS);
      assert.equal(described.state.engine_mode, 'worker');

      // The scheduled slot is the same `runNow`: it must also call the runner.
      const scheduled = await harness.captured.options.run();
      assert.equal(scheduled.ok, true);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].options.jobs, ['run']);

      // The verify route (non-cached, non-runtime) is the other synchronous engine call: it goes through the runner.
      const verifyRoute = find(BACKUP_VERIFY_ROUTE_PATH);
      const verified = await (await verifyRoute.fetch(new Request(`http://local.invalid${BACKUP_VERIFY_ROUTE_PATH}`, { method: 'GET' }))).json();
      assert.equal(verified.ok, true);
      assert.equal(verified.counts.snapshots, 1);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[2].options.jobs, ['verify']);
      assert.equal(calls[2].options.verifyOptions.runtime, false);
      assert.equal(calls[2].options.verifyOptions.futureAppend, true);
    } finally {
      cleanHome();
      cleanRepo();
    }
  });

  it('maps a worker failure to a named refusal without throwing out of the route', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup: cleanRepo } = tempDir('w2m-worker-plugin-failure-');
    try {
      const fake = fakeCtx();
      const harness = schedulerHarness();
      const runner = {
        run: async () => ({
          ok: false,
          mode: 'worker',
          code: WORKER_CODES.OOM,
          error: { code: WORKER_CODES.OOM, detail: 'the backup worker ran out of memory' },
        }),
      };
      apply(
        fake.ctx,
        {
          backupDir: join(dir, 'repo'),
          dshHome: home,
          backupMachineKey: false,
          backupRuntimeVerify: 'off',
          backupTimes: ['23:59:59'],
          backupTimeZone: 'UTC',
          backupCatchUpMs: 1,
        },
        { backupRunner: runner, createScheduler: harness.createScheduler },
      );

      // The scheduled path (a timer with no person to ask) must log the named failure and return it, never throw.
      const scheduled = await harness.captured.options.run();
      assert.equal(scheduled.ok, false);
      assert.equal(scheduled.reason_code, WORKER_CODES.OOM);
      assert.match(scheduled.detail, /out of memory/u);
      assert.ok(
        fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes(WORKER_CODES.OOM)),
        'the refusal is a logged warning naming the code',
      );

      const runRoute = fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH);
      const posted = await runRoute.fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }),
      }));
      assert.equal(posted.status, 200, 'a named failure is a 200 refusal, like every engine refusal');
      const body = await posted.json();
      assert.equal(body.ok, false);
      assert.equal(body.reason_code, WORKER_CODES.OOM);
      assert.equal(body.detail, 'the backup worker ran out of memory');
      assert.equal(existsSync(join(dir, 'repo')), false, 'a failed worker wrote no repository');

      const described = await (await runRoute.fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }))).json();
      assert.equal(described.state.last_error.reason_code, WORKER_CODES.OOM);
      assert.equal(described.engine_mode, 'worker', 'the attempted execution location is still visible');
    } finally {
      cleanHome();
      cleanRepo();
    }
  });

  it('normalizes backupWorkerTimeoutMs (30 min default, positive integers only)', () => {
    const defaults = normalizeConfig({}, { env: {}, platform: 'win32' });
    assert.equal(defaults.ok, true);
    assert.equal(defaults.worker_timeout_ms, DEFAULT_WORKER_TIMEOUT_MS);
    assert.equal(DEFAULT_WORKER_TIMEOUT_MS, 30 * 60 * 1000, 'the documented default is 30 minutes');

    // An explicit null is "not configured" (the same convention as the row's other optional values), not a value.
    assert.equal(normalizeConfig({ backupWorkerTimeoutMs: null }, { env: {}, platform: 'win32' }).worker_timeout_ms, DEFAULT_WORKER_TIMEOUT_MS);

    const custom = normalizeConfig({ backupWorkerTimeoutMs: 60_000 }, { env: {}, platform: 'win32' });
    assert.equal(custom.ok, true);
    assert.equal(custom.worker_timeout_ms, 60_000);

    for (const bad of [0, -1, 1.5, '30000', true, {}]) {
      const refused = normalizeConfig({ backupWorkerTimeoutMs: bad }, { env: {}, platform: 'win32' });
      assert.equal(refused.ok, false, `backupWorkerTimeoutMs=${String(bad)} must be refused`);
      assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(refused.detail, /backupWorkerTimeoutMs must be a positive integer/u);
    }
  });
});
