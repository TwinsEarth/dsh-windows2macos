/**
 * `w2m-fix workspace-registry` CLI contract: exit codes, human/JSON output, and the repair actually
 * converging on disk (the PowerShell wrapper at `tools/dsh-workspace-guard.ps1` delegates here).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspaceRegistry } from '../src/backup/workspace-registry-guard.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, 'bin', 'w2m-fix.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A home whose registry lists one row plus one dangling id, with no session directory. */
function brokenHome() {
  const home = tempDir('w2m-guard-cli-');
  mkdirSync(join(home.dir, 'storages'), { recursive: true });
  writeFileSync(join(home.dir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'aaaaaaaa-0001', workspaceIds: ['aaaaaaaa-0001', 'cccccccc-0003'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'aaaaaaaa-0001': { path: 'E:\\Work\\A', title: 'A', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
  }, null, 2));
  return home;
}

describe('w2m-fix workspace-registry: CLI', () => {
  it('check exits 1 on a dangling id and writes nothing', async () => {
    const home = brokenHome();
    try {
      const before = readFileSync(join(home.dir, 'storages', 'workspace.json'), 'utf8');
      const result = run(['workspace-registry', '--check', '--dsh-home', home.dir]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /WORKSPACE_ID_DANGLING/u);
      assert.match(result.stdout, /inconsistent/u);
      assert.equal(readFileSync(join(home.dir, 'storages', 'workspace.json'), 'utf8'), before, 'check must not write');
    } finally { home.cleanup(); }
  });

  it('repair exits 0, backs the file up, and converges', async () => {
    const home = brokenHome();
    try {
      const result = run(['workspace-registry', '--repair', '--dsh-home', home.dir]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /repaired/u);
      assert.match(result.stdout, /restart DeepSeek Harness/u);
      const after = inspectWorkspaceRegistry(home.dir);
      assert.equal(after.ok, true);
      assert.deepEqual(after.ids, ['aaaaaaaa-0001']);
      const second = run(['workspace-registry', '--repair', '--dsh-home', home.dir]);
      assert.equal(second.code, 0);
      assert.match(second.stdout, /nothing to repair/u);
    } finally { home.cleanup(); }
  });

  it('--json returns the plan/summary as one object', () => {
    const home = brokenHome();
    try {
      const result = run(['workspace-registry', '--check', '--json', '--dsh-home', home.dir]);
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.command, 'workspace-registry');
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.danglingIds, ['cccccccc-0003']);
    } finally { home.cleanup(); }
  });

  it('a missing registry is a usage error (2), not a crash', () => {
    const home = tempDir('w2m-guard-cli-empty-');
    try {
      const result = run(['workspace-registry', '--check', '--dsh-home', home.dir]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stdout, /registry file is missing/u);
    } finally { home.cleanup(); }
  });
});
