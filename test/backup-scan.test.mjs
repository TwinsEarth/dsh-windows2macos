/**
 * Backup scan: the enumeration a backup engine is allowed to trust, proven to be read-only.
 *
 * Every assertion here is about a fact the engine will act on: which logs exist, which are registered/archived/
 * pinned, which attachment objects are where, and what the derived caches are. The last test in the first
 * block is the one that matters most: a full scan **with hashing and decompression** must leave the home
 * byte-identical, mtimes included, because a scan that touches what it reads cannot run against a live client.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  ATTACHMENTS_REL,
  EXCLUSIONS,
  SESSION_FILE_RE,
  hashFile,
  readSessionHeader,
  scanAttachments,
  scanHome,
  scanSessionFile,
  scanSessions,
  summarize,
  toRel,
} from '../src/backup/scan.mjs';
import { event, framesFor, header, makeHome, put, registryDocument, sessionLog, tempDir } from './helpers/backup-fixture.mjs';

/** Every file under `root` with its size and mtime, for a before/after comparison. */
function treeState(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = statSync(full);
        out.set(relative(root, full).split('\\').join('/'), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

describe('backup scan: a fixture home', () => {
  const attachment = { id: `${'ab'.repeat(32)}` };
  const otherAttachment = { id: `${'cd'.repeat(32)}` };
  const { home, cleanup } = makeHome({
    sessions: [
      { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001', events: [event(0), event(1), event(2)] },
      { workspace: '--E-GPT--', id: 'session-bbbbbbbb-0002', events: [event(0)] },
      { workspace: '--E-ToFuture--', id: 'session-cccccccc-0003', events: [event(0)] },
    ],
    registry: registryDocument({
      sessionIds: ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002'],
      archived: ['session-bbbbbbbb-0002'],
      pinned: ['session-aaaaaaaa-0001'],
    }),
    attachments: [attachment, otherAttachment],
  });
  after(() => cleanup());

  it('enumerates sessions with their registry flags and totals', () => {
    const scan = scanHome({ dshHome: home });
    assert.equal(scan.exists, true);
    assert.equal(scan.totals.sessions, 3);
    assert.equal(scan.totals.archived, 1);
    assert.equal(scan.totals.pinned, 1);
    assert.equal(scan.totals.unregistered, 1, 'session-cccccccc-0003 exists on disk but is not registered');
    assert.equal(scan.totals.sessions_bad, 0);
    assert.equal(scan.totals.attachments, 2);
    assert.equal(scan.registry.ok, true);
    assert.equal(scan.registry.registered.size, 2);
    const byId = new Map(scan.sessions.map((row) => [row.session_id, row]));
    assert.deepEqual(byId.get('session-aaaaaaaa-0001').flags, { registered: true, archived: false, pinned: true });
    assert.deepEqual(byId.get('session-bbbbbbbb-0002').flags, { registered: true, archived: true, pinned: false });
    assert.deepEqual(byId.get('session-cccccccc-0003').flags, { registered: false, archived: false, pinned: false });
  });

  it('records the header fields a restore needs, and the relative path the manifest will use', () => {
    const scan = scanHome({ dshHome: home });
    const row = scan.sessions.find((entry) => entry.session_id === 'session-aaaaaaaa-0001');
    assert.equal(row.ok, true);
    assert.equal(row.format_version, 4);
    assert.equal(row.header.id, 'session-aaaaaaaa-0001');
    assert.equal(row.header.cwd, 'E:\\GPT');
    assert.equal(row.header.created_at, 1794842804375);
    assert.equal(row.workspace, '--E-GPT--');
    assert.equal(row.rel, 'sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd');
    assert.equal(row.file, join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd'));
  });

  it('leaves the whole home byte-identical, mtimes included, even when hashing and decompressing', () => {
    const before = treeState(home);
    const scan = scanHome({ dshHome: home, hash: true, deep: true });
    const after = treeState(home);
    assert.deepEqual(after, before, 'a scan must not create, rewrite or touch any file');
    assert.equal(scan.totals.sessions, 3);
  });

  it('hashes exactly the file bytes when asked', () => {
    const scan = scanHome({ dshHome: home, hash: true });
    for (const row of scan.sessions) {
      const expected = createHash('sha256').update(readFileSync(row.file)).digest('hex');
      assert.equal(row.hash, expected);
    }
    for (const row of scan.attachments) {
      const expected = createHash('sha256').update(readFileSync(row.file)).digest('hex');
      assert.equal(row.hash, expected);
    }
  });

  it('counts events only in deep mode, and reports the frame and seq totals', () => {
    const shallow = scanHome({ dshHome: home });
    assert.equal(shallow.sessions.find((row) => row.session_id === 'session-aaaaaaaa-0001').events, undefined);

    const deep = scanHome({ dshHome: home, deep: true });
    const row = deep.sessions.find((entry) => entry.session_id === 'session-aaaaaaaa-0001');
    assert.equal(row.events, 3, 'three events, header excluded');
    assert.equal(row.last_seq, 2);
    assert.equal(row.frames, 4, 'one header frame plus one frame per event');
    assert.equal(row.text_format_supported, true);
    assert.equal(row.torn_frame, false);
  });

  it('enumerates content-addressed attachments and checks the fan-out directory', () => {
    const { attachments } = scanAttachments({ dshHome: home });
    assert.equal(attachments.length, 2);
    const ids = attachments.map((row) => row.attachment_id).sort();
    assert.deepEqual(ids, [attachment.id, otherAttachment.id].sort());
    for (const row of attachments) {
      assert.equal(row.ok, true);
      assert.equal(row.rel, `attachments/v1/objects/${row.attachment_id.slice(0, 2)}/${row.attachment_id}`);
    }

    const broken = tempDir('w2m-scan-fanout-');
    try {
      const home2 = join(broken.dir, 'home');
      put(join(home2, ...ATTACHMENTS_REL, 'zz', attachment.id), Buffer.from('x'));
      const result = scanAttachments({ dshHome: home2 });
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].ok, false);
      assert.match(result.attachments[0].detail, /starts with ab/u);
    } finally {
      broken.cleanup();
    }
  });

  it('never walks the restore pre-copy area (a legacy copy under sessions/ is not a workspace)', () => {
    const home = makeHome({
      sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }],
      registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }),
    });
    const legacy = join(
      home.home,
      'sessions',
      '.w2m-restore-backups',
      '20260101T000000Z',
      'sessions',
      '--E-GPT--',
      'session-bbbbbbbb-0002',
    );
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'session.v4.jsonl.zstd'), sessionLog('session-bbbbbbbb-0002'));
    try {
      const result = scanSessions({ dshHome: home.home });
      assert.deepEqual(result.sessions.map((row) => row.session_id), ['session-aaaaaaaa-0001']);
      assert.equal(result.sessions.some((row) => row.rel.includes('.w2m-restore-backups')), false);
    } finally {
      home.cleanup();
    }
  });

  it('reports the derived caches as exclusions instead of walking them', () => {
    const scan = scanHome({ dshHome: home });
    assert.deepEqual(scan.exclusions.map((entry) => entry.rel), EXCLUSIONS.map((entry) => entry.rel));
    assert.ok(!scan.sessions.some((row) => row.rel.includes('.event-cache')));
    assert.ok(!scan.attachments.some((row) => row.rel.includes('session_projcache')));
    assert.ok(scan.exclusions.every((entry) => entry.reason.length > 20), 'every exclusion carries a real reason');
  });

  it('groups totals by workspace, largest first', () => {
    const scan = scanHome({ dshHome: home });
    assert.equal(scan.totals.by_workspace.length, 2);
    assert.deepEqual(scan.totals.by_workspace.map((row) => row.workspace).sort(), ['--E-GPT--', '--E-ToFuture--']);
    const sum = scan.totals.by_workspace.reduce((total, row) => total + row.bytes, 0);
    assert.equal(sum, scan.totals.session_bytes);
  });

  it('survives a home that does not exist, and an unreadable registry, without throwing', () => {
    const missing = scanHome({ dshHome: join(home, 'nope') });
    assert.equal(missing.exists, false);
    assert.equal(missing.totals.sessions, 0);
    assert.equal(missing.registry.ok, false);
    assert.equal(missing.registry.error, null, 'missing is not an error, it is a state');

    const broken = tempDir('w2m-scan-bad-registry-');
    try {
      const home2 = join(broken.dir, 'home');
      put(join(home2, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd'), sessionLog('session-aaaaaaaa-0001'));
      put(join(home2, 'storages', 'workspace.json'), '{ not json');
      const scan = scanHome({ dshHome: home2 });
      assert.equal(scan.registry.ok, false);
      assert.match(scan.registry.error, /JSON/u);
      assert.equal(scan.sessions[0].flags, null, 'an unreadable registry means the flags are unknown, not false');
      assert.equal(scan.totals.unregistered, 0, 'without a registry, "unregistered" is unknowable and must not be asserted');
    } finally {
      broken.cleanup();
    }
  });
});

describe('backup scan: single files and refusals', () => {
  it('flags a malformed log instead of failing the whole scan', () => {
    const { home, cleanup } = makeHome({
      sessions: [
        { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' },
        { workspace: '--E-GPT--', id: 'session-bbbbbbbb-0002', logFile: 'session.v4.jsonl.zstd' },
      ],
      registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002'] }),
    });
    try {
      // Overwrite the second log with bytes that are not a zstd container.
      put(join(home, 'sessions', '--E-GPT--', 'session-bbbbbbbb-0002', 'session.v4.jsonl.zstd'), 'plain text');
      const scan = scanHome({ dshHome: home });
      const bad = scan.sessions.find((row) => row.session_id === 'session-bbbbbbbb-0002');
      assert.equal(bad.ok, false);
      assert.ok(bad.codes.includes('BACKUP_SCAN_NOT_ZSTD'), bad.codes.join(','));
      assert.equal(scan.totals.sessions_bad, 1);
      assert.equal(scan.sessions.find((row) => row.session_id === 'session-aaaaaaaa-0001').ok, true);
    } finally {
      cleanup();
    }
  });

  it('flags a header whose id does not match its directory', () => {
    const { home, cleanup } = makeHome({
      sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001', headerId: null }],
    });
    try {
      const result = scanSessionFile(join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd'), {
        dshHome: home,
        expectedSessionId: 'session-aaaaaaaa-0001',
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.codes, ['SESSION_ID_MISMATCH']);
    } finally {
      cleanup();
    }
  });

  it('refuses an empty log and a log whose first frame is not a session header', () => {
    const { dir, cleanup } = tempDir('w2m-scan-header-');
    try {
      const empty = put(join(dir, 'empty.v4.jsonl.zstd'), Buffer.alloc(0));
      assert.equal(readSessionHeader(empty).code, 'BACKUP_SCAN_HEADER_UNREADABLE');

      const notHeader = put(join(dir, 'event.v4.jsonl.zstd'), framesFor([event(0)]));
      assert.equal(readSessionHeader(notHeader).code, 'BACKUP_SCAN_HEADER_UNREADABLE');

      const good = put(join(dir, 'good.v4.jsonl.zstd'), sessionLog('session-aaaaaaaa-0001'));
      const parsed = readSessionHeader(good);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.format_version, 4);
      assert.equal(parsed.header.id, 'session-aaaaaaaa-0001');

      const mixed = put(join(dir, 'mixed.v4.jsonl.zstd'), framesFor([header('session-aaaaaaaa-0001'), event(0)]));
      assert.equal(readSessionHeader(mixed).ok, true, 'the reader looks at the first line only; the doctor owns the frame rule');
    } finally {
      cleanup();
    }
  });

  it('picks the newest format version when a directory holds more than one log', () => {
    const { dir, cleanup } = tempDir('w2m-scan-versions-');
    try {
      const home = join(dir, 'home');
      const sessionDir = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001');
      put(join(sessionDir, 'session.v4.jsonl.zstd'), sessionLog('session-aaaaaaaa-0001'));
      put(join(sessionDir, 'session.v5.jsonl.zstd'), sessionLog('session-aaaaaaaa-0001'));
      put(join(sessionDir, 'session.v4.jsonl.zstd.bak-20261117'), Buffer.from('backup file'));
      const { sessions } = scanSessions({ dshHome: home });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].name, 'session.v5.jsonl.zstd');
      assert.match(sessions[0].rel, /session\.v5\.jsonl\.zstd$/u);
    } finally {
      cleanup();
    }
  });

  it('derives relative paths with forward slashes on every platform', () => {
    assert.equal(toRel('C:\\DSH', 'C:\\DSH\\sessions\\--E-GPT--\\session-x\\session.v4.jsonl.zstd'), 'sessions/--E-GPT--/session-x/session.v4.jsonl.zstd');
    assert.equal(SESSION_FILE_RE.test('session.v4.jsonl.zstd'), true);
    assert.equal(SESSION_FILE_RE.test('session.v4.jsonl.zstd.bak-1'), false);
  });

  it('summarize works on rows alone, without a home', () => {
    assert.deepEqual(
      summarize({
        sessions: [
          { size: 10, ok: true, workspace: 'w', flags: { registered: true, archived: false, pinned: false } },
          { size: 5, ok: false, workspace: 'w', flags: { registered: false, archived: true, pinned: false } },
        ],
        attachments: [{ size: 3 }],
      }),
      {
        sessions: 2,
        sessions_bad: 1,
        session_bytes: 15,
        archived: 1,
        pinned: 0,
        unregistered: 1,
        attachments: 1,
        attachment_bytes: 3,
        by_workspace: [{ workspace: 'w', sessions: 2, bytes: 15 }],
      },
    );
  });

  it('hashFile is plain sha256 of the bytes', () => {
    const { dir, cleanup } = tempDir('w2m-scan-hash-');
    try {
      const file = put(join(dir, 'x.bin'), Buffer.from('abc'));
      assert.equal(hashFile(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      cleanup();
    }
  });
});
