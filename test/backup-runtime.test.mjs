/**
 * Runtime validation (gate G5): the verdict must come from the installed Harness, and a failed measurement must
 * never read as a pass.
 *
 * The real-runtime cases skip on a machine without a Harness installation (named skip, so it is visible). The
 * deterministic cases pin the parts that do not need one: artifact decoding, the "no installation" refusal, and a
 * validator that *fails to produce a verdict* being reported as a refusal rather than silently accepted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLegalEvent,
  buildArtifactFromBuffer,
  clearVerdictCache,
  findHarnessInstallation,
  runtimeValidate,
  runtimeValidateBatch,
  validateCandidate,
  validateCandidates,
} from '../src/backup/runtime-validate.mjs';
import { framesFor, runtimeValidSessionLog, sessionLog, header } from './helpers/backup-fixture.mjs';

const harness = findHarnessInstallation();

describe('runtime validation: finding the installation', () => {
  it('returns null when nothing is installed, instead of guessing', () => {
    const found = findHarnessInstallation({ env: { W2M_DSH_ROOT: '', LOCALAPPDATA: 'Z:\\no-such-dir', ProgramFiles: 'Z:\\no-such-dir' } });
    assert.equal(found, null);
  });

  it('accepts an explicit root only when resources/app.asar exists under it', () => {
    if (harness === null) return; // the positive case needs an installation
    const found = findHarnessInstallation({ env: { W2M_DSH_ROOT: harness.root } });
    assert.equal(found?.root, harness.root);
    assert.equal(found?.source, 'W2M_DSH_ROOT');
  });
});

describe('runtime validation: artifact decoding', () => {
  it('decodes the fixture log into a header plus dense event rows', () => {
    const artifact = buildArtifactFromBuffer(runtimeValidSessionLog('session-aaaaaaaa-0001'));
    assert.equal(artifact.header.id, 'session-aaaaaaaa-0001');
    assert.equal(artifact.events.length, 2);
    assert.equal(artifact.inheritedEventCount, 0);
  });

  it('refuses an empty log and a log whose first row is not a session header', () => {
    assert.throws(() => buildArtifactFromBuffer(Buffer.alloc(0)), /empty/u);
    assert.throws(() => buildArtifactFromBuffer(framesFor([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])), /not a session header/u);
  });

  it('counts inherited events from the seed-end marker (seeded sessions)', () => {
    const seeded = framesFor([
      header('session-bbbbbbbb-0002', { isSeeded: true, delegationDepth: 1 }),
      { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    ]);
    assert.equal(buildArtifactFromBuffer(seeded).inheritedEventCount, 1);
  });
});

describe('runtime validation: refusing the wrong things', () => {
  it('reports "unavailable" (not ok) when no installation exists', () => {
    const verdict = runtimeValidate({ buffer: runtimeValidSessionLog('session-aaaaaaaa-0001'), harness: null });
    assert.equal(verdict.available, false);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no DeepSeek Harness installation/u);
  });

  it('treats a validator that produces no verdict as a refusal, never a pass', () => {
    // Point the "harness" at this node binary: the driver starts, cannot find app.asar, and reports a failure.
    const verdict = runtimeValidate({
      buffer: runtimeValidSessionLog('session-aaaaaaaa-0001'),
      harness: { root: process.cwd(), runtime: process.execPath, asar: 'none', source: 'test' },
      timeoutMs: 30_000,
    });
    assert.equal(verdict.available, true);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no verdict|refused|app\.asar/u);
  });
});

describe('runtime validation: the restore gate', () => {
  const buffer = runtimeValidSessionLog('session-aaaaaaaa-0001');

  it('accepts static-only evidence when the runtime is not required', () => {
    const gate = validateCandidate({ buffer, expectedSessionId: 'session-aaaaaaaa-0001', harness: null, requireRuntime: false });
    assert.equal(gate.ok, true);
    assert.equal(gate.runtime_verified, false);
    assert.match(gate.detail, /static-only/u);
  });

  it('refuses when the runtime is required but unavailable', () => {
    const gate = validateCandidate({ buffer, expectedSessionId: 'session-aaaaaaaa-0001', harness: null, requireRuntime: true });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'BACKUP_RUNTIME_UNAVAILABLE');
  });

  it('refuses a statically invalid log before the runtime is even consulted', () => {
    // A seq gap is the doctor's cheapest rule; the point is that the gate stops at the pre-filter, not that this
    // particular rule is the only one.
    const gap = framesFor([
      header('session-aaaaaaaa-0001'),
      { type: 'turn/start', seq: 7, time: 1, data: { turn: 1 } },
    ]);
    const gate = validateCandidate({ buffer: gap, expectedSessionId: 'session-aaaaaaaa-0001', harness: null, requireRuntime: true });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'BACKUP_CANDIDATE_INVALID');
    assert.equal(gate.runtime, null, 'the runtime must not be spawned for a log the pre-filter already refused');
  });

  it(
    'confirms a runtime-valid log with the installed Harness (and refuses a header the Harness rejects)',
    { skip: harness === null ? 'no DeepSeek Harness installation on this machine' : false },
    () => {
      const good = validateCandidate({ buffer, expectedSessionId: 'session-aaaaaaaa-0001' });
      assert.equal(good.ok, true, good.detail);
      assert.equal(good.runtime_verified, true);

      // The same log with the v4-only fields removed: the installed codec reads it as an older physical format.
      const invalidHeader = framesFor([
        { type: 'session', version: 4, id: 'session-aaaaaaaa-0001', cwd: 'E:\\GPT', createdAt: 1, agentPreset: 'standard' },
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      ]);
      const bad = validateCandidate({ buffer: invalidHeader, expectedSessionId: 'session-aaaaaaaa-0001' });
      assert.equal(bad.ok, false);
      assert.ok(['BACKUP_RUNTIME_REJECTED', 'BACKUP_CANDIDATE_INVALID'].includes(bad.reason_code), bad.reason_code);
    },
  );

  it('validates a batch in one runtime process and caches verdicts by content', { skip: harness === null ? 'no DeepSeek Harness installation on this machine' : false }, () => {
    clearVerdictCache();
    const a = runtimeValidSessionLog('session-aaaaaaaa-0001');
    const b = runtimeValidSessionLog('session-bbbbbbbb-0002');
    const started = Date.now();
    const batch = runtimeValidateBatch({
      artifacts: [buildArtifactFromBuffer(a), buildArtifactFromBuffer(b)],
      harness,
    });
    const elapsed = Date.now() - started;
    assert.equal(batch.available, true);
    assert.equal(batch.verdicts.length, 2);
    assert.deepEqual(batch.verdicts.map((verdict) => verdict.ok), [true, true]);
    // One process instead of two: on this machine a single spawn is ~0.5-1 s.
    assert.ok(elapsed < 30_000, `batch validation took ${elapsed} ms`);

    const again = runtimeValidateBatch({ artifacts: [buildArtifactFromBuffer(a)], harness });
    assert.equal(again.verdicts[0].ok, true);
    assert.ok(again.duration_ms <= elapsed, 'the cached second call must not be slower than the spawn that filled it');
  });

  it('validateCandidates appends one legal event and asks the runtime about both (G3+G5)', { skip: harness === null ? 'no DeepSeek Harness installation on this machine' : false }, () => {
    clearVerdictCache();
    const { results } = validateCandidates({
      items: [{ buffer: runtimeValidSessionLog('session-aaaaaaaa-0001'), expectedSessionId: 'session-aaaaaaaa-0001', appendCheck: true }],
    });
    assert.equal(results[0].ok, true, results[0].detail);
    assert.equal(results[0].runtime_verified, true);
    assert.equal(results[0].future_append, true);
  });

  it('appendLegalEvent keeps the prefix bytes unchanged and adds one frame', () => {
    const original = runtimeValidSessionLog('session-aaaaaaaa-0001');
    const appended = appendLegalEvent(original);
    assert.ok(appended.length > original.length);
    assert.ok(appended.subarray(0, original.length).equals(original));
    const artifact = buildArtifactFromBuffer(appended);
    assert.equal(artifact.events.length, 3);
    assert.equal(artifact.events[2].type, 'permission/preset');
    assert.equal(artifact.events[2].seq, 2);
  });

  it('refuses a log whose header id does not match the session being restored', () => {
    const gate = validateCandidate({ buffer: sessionLog('session-cccccccc-0003'), expectedSessionId: 'session-aaaaaaaa-0001', harness: null, requireRuntime: false });
    assert.equal(gate.ok, false);
    assert.ok(gate.static.codes.includes('SESSION_ID_MISMATCH'), JSON.stringify(gate.static.codes));
  });
});
