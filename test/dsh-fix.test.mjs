/**
 * Self-repair subplugin (`@twinsearth/w2m-dsh-plugin/dsh-fix`): the in-process
 * repair, its offline CLI, and the wiring that makes it a mountable subplugin.
 *
 * The failure this exists for was measured on this host: several sessions whose
 * history referenced image attachments that had been deleted, so every turn
 * failed with `TRANSPORT` ("DeepSeek Messages transport failed") in tens of
 * milliseconds, and retrying five times could not help. The repair appends one
 * `image/offload` event - the durable mechanism the official image-budget
 * plugin already uses - and asks the agent loop to retry the step.
 *
 * The assertions are grouped by what a reader would have to trust otherwise:
 *   * the published entry (`lib/dsh-fix.js`) mounts the same plugin the patch
 *     row names, and the manifest ships every path it points at;
 *   * the listener repairs only when the *view* references an unreadable image,
 *     delegates real failures, and stays inside its per-turn bound;
 *   * the offline CLI reads the real v4 container, hides compaction-shadowed
 *     messages, writes a checksummed frame, verifies it, and can roll back.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  apply,
  findUnreadableImages,
  inject,
  name,
  resolveObjectsRoot,
  resolveStatePath,
} from '../lib/dsh-fix.js';
import { applyFix, listBackups, pendingFixes, restoreBackup } from '../src/fix/repair.mjs';
import { buildFixture, frameCount, imageBlock, load, MISSING_ID, MISSING_SHADOWED_ID } from './helpers/dsh-fix-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PATCH = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
const CLI = path.join(ROOT, 'bin', 'w2m-fix.mjs');

const MISSING = crypto.createHash('sha256').update('missing').digest('hex');
const PRESENT = crypto.createHash('sha256').update('present').digest('hex');

const TEMP_ROOTS = [];
after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must not turn a green suite red.
    }
  }
});

/** A throwaway directory, remembered for cleanup. */
function tmpRoot(prefix = 'w2m-dsh-fix-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

/** An attachment object root where PRESENT exists and everything else does not. */
function objectsRoot() {
  const root = tmpRoot('w2m-dsh-fix-objects-');
  const file = path.join(root, PRESENT.slice(0, 2), PRESENT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'bytes');
  return root;
}

/**
 * A fake session with a three-node surface: node 1 has a missing image, node 2 a
 * present one, node 3 an image already marked offloaded.
 */
function fakeSession({ withMissing = true } = {}) {
  const events = new Map([
    [1, { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'shot' }, imageBlock(withMissing ? MISSING : PRESENT)] } } }],
    [2, { type: 'tool/result', data: { message: { role: 'tool', content: [imageBlock(PRESENT)] } } }],
    [3, { type: 'tool/result', data: { message: { role: 'tool', content: [imageBlock(MISSING, { offloaded: true })] } } }],
  ]);
  const appended = [];
  return {
    appended,
    session: {
      // Seq 99 is NOT on the surface and is missing too: it must never be a target.
      surface: { nodes: [1, 2, 3] },
      eventAt: (seq) => events.get(seq) ?? (seq === 99 ? { type: 'tool/result', data: { message: { role: 'tool', content: [imageBlock(MISSING)] } } } : undefined),
      deriveEventMessage: (event) => event.data.message,
      append: (type, data) => {
        appended.push({ type, data });
      },
    },
  };
}

/**
 * A fake Cordis context.
 *
 * The plugin deliberately registers no message projection: the official
 * `compaction-image-offload` row owns the `image/offload` type, and a second
 * registration from this plugin failed that row's fiber when it was measured.
 */
function fakeCtx({ flush = true } = {}) {
  const listeners = new Map();
  const logs = [];
  const flushes = [];
  const projections = [];
  return {
    listeners,
    logs,
    flushes,
    projections,
    ctx: {
      sessions: {
        registerMessageProjection(projection) {
          projections.push(projection);
        },
        ...(flush
          ? {
              flush: async (session) => {
                flushes.push(session);
              },
            }
          : {}),
      },
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
      on: (type, handler) => listeners.set(type, handler),
    },
  };
}

const payload = (session, overrides = {}) => ({
  agent: { session },
  turn: 1,
  step: 1,
  provider: 'deepseek-account',
  failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' },
  signal: { aborted: false },
  ...overrides,
});

describe('dsh-fix: published wiring', () => {
  it('the package subpath exports the plugin surface the patch row mounts', () => {
    assert.equal(name, 'w2m-dsh-fix');
    assert.deepEqual(inject, ['agents', 'sessions']);
    assert.equal(typeof apply, 'function');
    assert.equal(typeof findUnreadableImages, 'function');
  });

  it('package.json exports ./dsh-fix, ships its entry, and declares the CLI bin', () => {
    assert.equal(PACKAGE.exports['./dsh-fix'], './lib/dsh-fix.js');
    for (const entry of ['lib', 'src', 'bin', 'cli']) {
      assert.ok(PACKAGE.files.includes(entry), `package.json#files must ship ${entry}/`);
    }
    assert.equal(PACKAGE.bin['w2m-fix'], 'bin/w2m-fix.mjs');
    assert.ok(fs.existsSync(path.join(ROOT, PACKAGE.exports['./dsh-fix'])));
    assert.ok(fs.existsSync(path.join(ROOT, 'cli', 'bin', 'dsh-fix-attachments.mjs')), 'the standalone-compatible CLI path stays present');
  });

  it('cordis.patch.yml mounts the subpath under the id dsh-fix', () => {
    const block = PATCH.split('\n');
    const at = block.findIndex((line) => line.trim() === '- id: dsh-fix');
    assert.notEqual(at, -1, 'cordis.patch.yml must carry the dsh-fix row');
    assert.match(block[at + 1] ?? '', /^\s+name:\s+'@twinsearth\/w2m-dsh-plugin\/dsh-fix'$/);
  });
});

describe('dsh-fix: the in-process repair', () => {
  it('registers no message projection: the core image-offload row owns the type', () => {
    // Measured through the real Loader: this plugin can be activated BEFORE the
    // official compaction-image-offload row. Registering the same projection
    // here made the core row's own registration throw and failed its fiber,
    // which failed the whole mount. The repair only appends an event the core
    // projection already understands.
    const { ctx, projections, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: objectsRoot(), statePath: path.join(tmpRoot(), 'state.json') });
    assert.equal(projections.length, 0, 'no second registration of image/offload may be attempted');
    assert.equal(typeof listeners.get('agent/request-error'), 'function');
  });

  it('delegates when the session refuses the event (core projection disabled)', async () => {
    const root = objectsRoot();
    const { ctx, listeners, logs } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });
    const { session } = fakeSession();
    session.append = () => {
      throw new Error('session message projection "image/offload" is not registered');
    };
    let nextCalls = 0;
    const action = await listeners.get('agent/request-error')(payload(session), async () => {
      nextCalls += 1;
      return { kind: 'stop' };
    });
    assert.deepEqual(action, { kind: 'stop' });
    assert.equal(nextCalls, 1);
    assert.match(logs[0] ?? '', /could not record the offload decision/);
  });

  it('resolveObjectsRoot honours config, then DSH_HOME', () => {
    assert.equal(resolveObjectsRoot({ objectsRoot: '/tmp/x' }), '/tmp/x');
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = path.join(tmpRoot('w2m-dsh-fix-home-'), 'home');
    try {
      assert.equal(resolveObjectsRoot({}), path.join(process.env.DSH_HOME, 'attachments', 'v1', 'objects'));
      assert.equal(resolveStatePath({}), path.join(process.env.DSH_HOME, 'xclient', 'dsh-fix-state.json'));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it('finds only unreadable images on the surface, skipping offloaded ones', () => {
    const root = objectsRoot();
    const { session } = fakeSession();
    const { targets, unreadable } = findUnreadableImages(session, root);
    assert.equal(unreadable, 1);
    assert.deepEqual(targets, [{ seq: 1, imageIndexes: [0] }]);
  });

  it('repairs the request from the error waterfall and asks for one retry', async () => {
    const root = objectsRoot();
    const { ctx, listeners, logs, flushes } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });

    const handler = listeners.get('agent/request-error');
    assert.equal(typeof handler, 'function');

    const { session, appended } = fakeSession();
    let nextCalls = 0;
    const action = await handler(payload(session), async () => {
      nextCalls += 1;
      return { kind: 'stop' };
    });

    assert.deepEqual(action, { kind: 'retry' }, 'a durable repair must ask for a retry');
    assert.equal(nextCalls, 0, 'the waterfall must not be delegated when we repaired');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, 'image/offload');
    assert.deepEqual(appended[0].data.targets, [{ seq: 1, imageIndexes: [0] }]);
    assert.equal(flushes.length, 1, 'the repair must be flushed before the retry');
    assert.equal(flushes[0], session);
    assert.match(logs[0] ?? '', /1 unreadable image/);
  });

  it('delegates when nothing is unreadable, so real network errors surface', async () => {
    const root = objectsRoot();
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });

    const { session, appended } = fakeSession({ withMissing: false });
    let nextCalls = 0;
    const action = await listeners.get('agent/request-error')(payload(session), async () => {
      nextCalls += 1;
      return { kind: 'stop' };
    });

    assert.deepEqual(action, { kind: 'stop' });
    assert.equal(nextCalls, 1);
    assert.equal(appended.length, 0);
  });

  it('ignores failures whose code is not attachment-related', async () => {
    const root = objectsRoot();
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });

    const { session, appended } = fakeSession();
    let nextCalls = 0;
    await listeners.get('agent/request-error')(
      payload(session, { failure: { code: 'RATE_LIMIT', message: 'slow down' } }),
      async () => {
        nextCalls += 1;
        return { kind: 'stop' };
      },
    );

    assert.equal(nextCalls, 1);
    assert.equal(appended.length, 0);
  });

  it('respects an aborted signal', async () => {
    const root = objectsRoot();
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });

    const { session, appended } = fakeSession();
    let nextCalls = 0;
    await listeners.get('agent/request-error')(payload(session, { signal: { aborted: true } }), async () => {
      nextCalls += 1;
      return { kind: 'stop' };
    });

    assert.equal(nextCalls, 1);
    assert.equal(appended.length, 0);
  });

  it('caps repairs per turn so a broken artifact cannot loop forever', async () => {
    const root = objectsRoot();
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json'), maxRepairsPerTurn: 2 });

    const handler = listeners.get('agent/request-error');
    const { session, appended } = fakeSession();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
      return { kind: 'stop' };
    };

    const first = await handler(payload(session), next);
    const second = await handler(payload(session), next);
    const third = await handler(payload(session), next);

    assert.deepEqual(first, { kind: 'retry' });
    assert.deepEqual(second, { kind: 'retry' });
    assert.deepEqual(third, { kind: 'stop' }, 'the cap must delegate instead of retrying forever');
    assert.equal(appended.length, 2);
    assert.equal(nextCalls, 1);
  });

  it('still retries when the persistence flush is unavailable or fails', async () => {
    const root = objectsRoot();
    const { ctx, listeners, logs } = fakeCtx({ flush: false });
    apply(ctx, { objectsRoot: root, statePath: path.join(root, 'state.json') });

    const { session } = fakeSession();
    const action = await listeners.get('agent/request-error')(payload(session), async () => ({ kind: 'stop' }));
    assert.deepEqual(action, { kind: 'retry' }, 'an unavailable flush must not cost the in-memory repair');
    assert.equal(logs.filter((message) => /not flushed/.test(message)).length, 0, 'a missing optional service is not a warning');
  });

  it('records a mount marker and updates it on every repair', async () => {
    const root = objectsRoot();
    const statePath = path.join(root, 'state.json');
    const { ctx, listeners } = fakeCtx();
    apply(ctx, { objectsRoot: root, statePath });

    const mounted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(mounted.version, 1);
    assert.equal(mounted.repairs, 0);
    assert.equal(mounted.lastRepair, null);
    assert.equal(mounted.objectsRoot, root);
    assert.ok(typeof mounted.mountedAt === 'string' && mounted.mountedAt.length > 0);

    const { session } = fakeSession();
    await listeners.get('agent/request-error')(payload(session), async () => ({ kind: 'stop' }));

    const afterRepair = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterRepair.repairs, 1);
    assert.equal(afterRepair.lastRepair.turn, 1);
    assert.deepEqual(afterRepair.lastRepair.targets, [{ seq: 1, imageIndexes: [0] }]);
    assert.ok(typeof afterRepair.lastRepair.at === 'string' && afterRepair.lastRepair.at.length > 0);
  });
});

describe('dsh-fix: the offline CLI', () => {
  it('reads a v4 artifact and hides shadowed nodes', () => {
    const fixture = buildFixture(tmpRoot());
    const session = load(fixture.artifact);

    assert.equal(session.formatVersion, 4);
    assert.equal(session.formatSupported, true);
    assert.equal(session.lastSeq, 7);
    assert.equal(session.frames.length, 8);
    assert.equal(session.refs.length, 3);
    assert.ok(session.shadowed.has(6), 'seq 6 must be shadowed');
    assert.equal(session.tornStart, undefined);
  });

  it('finds only the surface image whose object is gone', () => {
    const fixture = buildFixture(tmpRoot());
    const session = load(fixture.artifact);
    const pending = pendingFixes(session, fixture.objects);

    assert.equal(pending.length, 1, 'only seq 3 qualifies');
    assert.equal(pending[0].seq, 3);
    assert.equal(pending[0].imageIndex, 0);
    assert.equal(pending[0].attachmentId, MISSING_ID);
    assert.notEqual(pending[0].attachmentId, MISSING_SHADOWED_ID);
  });

  it('applies the repair, verifies it, and is idempotent', () => {
    const fixture = buildFixture(tmpRoot());
    const before = fs.statSync(fixture.artifact).size;
    const session = load(fixture.artifact);
    const pending = pendingFixes(session, fixture.objects);

    const result = applyFix(session, pending, { storeRoot: fixture.objects });
    assert.equal(result.changed, true);
    assert.equal(result.newSeq, 8);
    assert.ok(fs.existsSync(result.backup), 'backup must exist');
    assert.equal(fs.statSync(result.backup).size, before);
    assert.equal(frameCount(fixture.artifact), session.frames.length + 1);

    const after = load(fixture.artifact);
    assert.equal(after.lastSeq, 8);
    assert.equal(pendingFixes(after, fixture.objects).length, 0, 'nothing left to repair');
    const offloaded = after.offloaded.get(3);
    assert.ok(offloaded && offloaded.has(0), 'seq 3 image 0 must be offloaded');

    const second = applyFix(after, pendingFixes(after, fixture.objects), { storeRoot: fixture.objects });
    assert.equal(second.changed, false);
    assert.equal(frameCount(fixture.artifact), session.frames.length + 1);
  });

  it('restores from backup and reports the session as unresolved again', () => {
    const fixture = buildFixture(tmpRoot());
    const original = fs.statSync(fixture.artifact).size;
    const session = load(fixture.artifact);
    applyFix(session, pendingFixes(session, fixture.objects), { storeRoot: fixture.objects });

    const backups = listBackups(fixture.artifact);
    assert.equal(backups.length, 1);
    const current = load(fixture.artifact);
    restoreBackup(current, backups[0].path);

    const restored = load(fixture.artifact);
    assert.equal(fs.statSync(fixture.artifact).size, original);
    assert.equal(restored.lastSeq, 7);
    assert.equal(pendingFixes(restored, fixture.objects).length, 1);
  });

  it('refuses an artifact with a torn final frame', () => {
    const fixture = buildFixture(tmpRoot());
    fs.appendFileSync(fixture.artifact, Buffer.from([0x28, 0xb5, 0x2f]));

    const session = load(fixture.artifact);
    assert.notEqual(session.tornStart, undefined);
    assert.throws(
      () => applyFix(session, [{ seq: 3, imageIndex: 0, attachmentId: MISSING_ID }], { storeRoot: fixture.objects }),
      /torn frame/,
    );
  });

  it('refuses an unknown session format version', () => {
    const fixture = buildFixture(tmpRoot(), { formatVersion: 9 });
    const session = load(fixture.artifact);
    assert.equal(session.formatSupported, false);
    assert.throws(
      () => applyFix(session, [{ seq: 3, imageIndex: 0, attachmentId: MISSING_ID }], { storeRoot: fixture.objects }),
      /unsupported session format/,
    );
  });

  it('cli scan reports the broken session without writing', () => {
    const fixture = buildFixture(tmpRoot());
    const before = fs.statSync(fixture.artifact).size;
    const out = execFileSync(process.execPath, [CLI, 'scan', '--dsh-home', fixture.root], { encoding: 'utf8' });

    assert.match(out, /need a repair|needs a repair/);
    assert.match(out, /seq 3/);
    assert.equal(fs.statSync(fixture.artifact).size, before, 'scan must not write');
    assert.equal(listBackups(fixture.artifact).length, 0);
  });

  it('cli fix without --apply stays a dry run', () => {
    const fixture = buildFixture(tmpRoot());
    const before = fs.statSync(fixture.artifact).size;
    const out = execFileSync(process.execPath, [CLI, 'fix', '--dsh-home', fixture.root], { encoding: 'utf8' });

    assert.match(out, /dry run/i);
    assert.equal(fs.statSync(fixture.artifact).size, before);
  });

  it('cli --help exits 0 with usage, and the standalone-compatible path runs the same CLI', () => {
    const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help, /Usage/);
    const alias = execFileSync(process.execPath, [path.join(ROOT, 'cli', 'bin', 'dsh-fix-attachments.mjs'), '--help'], { encoding: 'utf8' });
    assert.match(alias, /Usage/);
  });
});
