/**
 * Workspace registry guard: inspect/repair `storages/workspace.json` invariants.
 *
 * The defect this covers: a drill cleanup deleted two `tables.workspaces` rows but left their ids in
 * `global.workspaceIds`, so the DSH `workspaceController` failed to mount and every workspace operation
 * returned "active Service workspaceController is unavailable". The repair must keep visible rows, drop
 * only dangling ids, and fix the default — then converge (a second repair reports no change).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectWorkspaceRegistry, repairWorkspaceRegistry, workspaceRegistryFile } from '../src/backup/workspace-registry-guard.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

/** A home whose registry is exactly the given rows/ids/default (null ids = derive from rows). */
function homeWith({ rows, ids = null, defaultId = null, raw = null }) {
  const home = tempDir('w2m-guard-home-');
  mkdirSync(join(home.dir, 'storages'), { recursive: true });
  const file = workspaceRegistryFile(home.dir);
  if (raw !== null) {
    writeFileSync(file, raw);
    return { ...home, file };
  }
  const document = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: defaultId ?? rows[0] ?? null,
      workspaceIds: ids ?? rows.map((row) => row.id),
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: Object.fromEntries(rows.map((row) => [row.id, { path: row.path, title: row.title ?? row.id, sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }])) },
  };
  writeFileSync(file, JSON.stringify(document, null, 2));
  return { ...home, file };
}

const A = { id: 'aaaaaaaa-0001', path: 'E:\\Work\\A', title: 'A' };
const B = { id: 'bbbbbbbb-0002', path: 'E:\\Work\\B', title: 'B' };

describe('workspace registry guard: inspect', () => {
  it('reports a consistent registry as ok', () => {
    const home = homeWith({ rows: [A, B], defaultId: B.id });
    try {
      const report = inspectWorkspaceRegistry(home.dir);
      assert.equal(report.ok, true);
      assert.deepEqual(report.problems, []);
      assert.equal(report.defaultOk, true);
    } finally { home.cleanup(); }
  });

  it('finds a dangling id that no row carries (the fatal case)', () => {
    const home = homeWith({ rows: [A, B], ids: [A.id, B.id, 'cccccccc-0003'] });
    try {
      const report = inspectWorkspaceRegistry(home.dir);
      assert.equal(report.ok, false);
      assert.deepEqual(report.danglingIds, ['cccccccc-0003']);
      assert.equal(report.problems[0].code, 'WORKSPACE_ID_DANGLING');
    } finally { home.cleanup(); }
  });

  it('finds an unlisted row and an invalid default', () => {
    const home = homeWith({ rows: [A, B], ids: [A.id], defaultId: 'dddddddd-0004' });
    try {
      const report = inspectWorkspaceRegistry(home.dir);
      assert.deepEqual(report.unlistedRows, [B.id]);
      assert.equal(report.defaultOk, false);
      assert.deepEqual(report.problems.map((problem) => problem.code).sort(), ['WORKSPACE_DEFAULT_INVALID', 'WORKSPACE_ROW_UNLISTED']);
    } finally { home.cleanup(); }
  });

  it('reports missing and unreadable files without throwing', () => {
    const home = tempDir('w2m-guard-empty-');
    try {
      const missing = inspectWorkspaceRegistry(home.dir);
      assert.equal(missing.ok, false);
      assert.equal(missing.error, 'registry file is missing');
      mkdirSync(join(home.dir, 'storages'), { recursive: true });
      writeFileSync(workspaceRegistryFile(home.dir), '{not json');
      const broken = inspectWorkspaceRegistry(home.dir);
      assert.equal(broken.ok, false);
      assert.match(broken.error, /not valid JSON/u);
    } finally { home.cleanup(); }
  });
});

describe('workspace registry guard: repair', () => {
  it('drops a dangling id, keeps every visible row, and converges', () => {
    const home = homeWith({ rows: [A, B], ids: [A.id, 'cccccccc-0003', B.id], defaultId: A.id });
    try {
      const before = readFileSync(home.file, 'utf8');
      const repaired = repairWorkspaceRegistry(home.dir);
      assert.equal(repaired.ok, true);
      assert.equal(repaired.changed, true);
      assert.ok(existsSync(repaired.backup), 'a backup must exist before the write');
      assert.equal(readFileSync(repaired.backup, 'utf8'), before, 'the backup is the pre-repair bytes');
      assert.deepEqual(repaired.after.ids, [A.id, B.id]);
      assert.deepEqual(repaired.after.rows, [A.id, B.id]);
      const again = repairWorkspaceRegistry(home.dir);
      assert.equal(again.changed, false, 'repair must be idempotent');
      assert.equal(again.ok, true);
    } finally { home.cleanup(); }
  });

  it('keeps an unlisted row by appending it to the ids instead of deleting it', () => {
    const home = homeWith({ rows: [A, B], ids: [A.id], defaultId: A.id });
    try {
      const repaired = repairWorkspaceRegistry(home.dir);
      assert.equal(repaired.ok, true);
      assert.deepEqual(repaired.after.ids, [A.id, B.id]);
      assert.ok(repaired.after.rows.includes(B.id), 'visible row must survive');
    } finally { home.cleanup(); }
  });

  it('reassigns an invalid default and keeps a valid one', () => {
    const home = homeWith({ rows: [A, B], ids: [A.id, B.id], defaultId: 'dddddddd-0004' });
    try {
      const repaired = repairWorkspaceRegistry(home.dir);
      assert.equal(repaired.ok, true);
      assert.equal(repaired.after.defaultId, A.id);
      assert.equal(repaired.after.defaultOk, true);
    } finally { home.cleanup(); }
  });

  it('refuses to touch an unreadable document', () => {
    const home = homeWith({ rows: [], raw: '{broken' });
    try {
      const repaired = repairWorkspaceRegistry(home.dir);
      assert.equal(repaired.ok, false);
      assert.equal(repaired.changed, false);
      assert.match(repaired.error, /not valid JSON/u);
      assert.equal(readFileSync(home.file, 'utf8'), '{broken');
    } finally { home.cleanup(); }
  });

  it('leaves the directory with exactly one new backup per repair', () => {
    const home = homeWith({ rows: [A], ids: [A.id, 'eeeeeeee-0005'], defaultId: A.id });
    try {
      repairWorkspaceRegistry(home.dir);
      const backups = readdirSync(join(home.dir, 'storages')).filter((name) => name.startsWith('workspace.json.bak-guard-'));
      assert.equal(backups.length, 1);
    } finally { home.cleanup(); }
  });
});

describe('workspace registry guard: session references', () => {
  /** Write a stored session log for `id` under `sessions/<slug>/<id>/`. */
  function putSession(dir, slug, id) {
    mkdirSync(join(dir, 'sessions', slug, id), { recursive: true });
    writeFileSync(join(dir, 'sessions', slug, id, 'session.v4.jsonl.zstd'), 'log');
  }

  it('reports a row sessionId with no log as WORKSPACE_SESSION_MISSING', () => {
    const home = homeWith({ rows: [A], ids: [A.id], defaultId: A.id });
    try {
      const file = workspaceRegistryFile(home.dir);
      const document = JSON.parse(readFileSync(file, 'utf8'));
      document.tables.workspaces[A.id].sessionIds = ['session-present-0001', 'session-missing-0002'];
      writeFileSync(file, JSON.stringify(document, null, 2));
      putSession(home.dir, '--work-a--', 'session-present-0001');
      const report = inspectWorkspaceRegistry(home.dir);
      assert.equal(report.ok, false);
      assert.deepEqual(report.missingSessions, [{ workspaceId: A.id, sessionId: 'session-missing-0002' }]);
      assert.equal(report.problems.at(-1).code, 'WORKSPACE_SESSION_MISSING');
    } finally { home.cleanup(); }
  });

  it('repair prunes only the references that do not resolve, and keeps the sessions that exist', () => {
    const home = homeWith({ rows: [A], ids: [A.id], defaultId: A.id });
    try {
      const file = workspaceRegistryFile(home.dir);
      const document = JSON.parse(readFileSync(file, 'utf8'));
      document.tables.workspaces[A.id].sessionIds = ['session-present-0001', 'session-missing-0002'];
      writeFileSync(file, JSON.stringify(document, null, 2));
      putSession(home.dir, '--work-a--', 'session-present-0001');
      const repaired = repairWorkspaceRegistry(home.dir);
      assert.equal(repaired.ok, true);
      assert.deepEqual(repaired.after.missingSessions, []);
      const after = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(after.tables.workspaces[A.id].sessionIds, ['session-present-0001']);
      assert.ok(existsSync(join(home.dir, 'sessions', '--work-a--', 'session-present-0001')), 'the log itself is untouched');
    } finally { home.cleanup(); }
  });

  it('does not judge session references when the home has no sessions directory', () => {
    const home = homeWith({ rows: [A], ids: [A.id], defaultId: A.id });
    try {
      const file = workspaceRegistryFile(home.dir);
      const document = JSON.parse(readFileSync(file, 'utf8'));
      document.tables.workspaces[A.id].sessionIds = ['session-anywhere-0001'];
      writeFileSync(file, JSON.stringify(document, null, 2));
      const report = inspectWorkspaceRegistry(home.dir);
      assert.equal(report.ok, true, 'a home without sessions/ cannot claim a session is missing');
      assert.deepEqual(report.missingSessions, []);
    } finally { home.cleanup(); }
  });
});
