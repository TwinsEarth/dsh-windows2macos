/**
 * Policy guard: nobody writes `storages/workspace.json` by hand.
 *
 * On 2026-11-21 a drill cleanup deleted table rows with ad-hoc JSON surgery and left the matching ids in
 * `global.workspaceIds`. One dangling id made the DSH `workspaceController` fail to mount, so **every**
 * workspace operation stopped. The repair path now lives in `src/backup/workspace-registry-guard.mjs`, and
 * registry writes belong to the modules that maintain the invariants:
 *
 *   * `src/backup/registry.mjs` — plan/atomic write/read-back (the one writer),
 *   * `src/backup/register.mjs` — pre-restore *copies* of the document,
 *   * `src/backup/restore.mjs` — pre-restore *copies* of the document,
 *   * `src/backup/workspace-registry-guard.mjs` + `scripts/workspace-registry-guard.mjs` — the repairer.
 *
 * Anything else must go through those modules. This file reads the tree and fails if a write-like call and
 * `workspace.json` appear together anywhere else. It is deliberately textual: the point is to catch the
 * "quick script" that bypasses the protocol, which is exactly the shape that broke a live installation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = ['src', 'scripts', 'bin', 'tools'];
const EXT = new Set(['.mjs', '.js', '.cjs', '.ps1']);
const ALLOWED = new Set([
  'src/backup/registry.mjs',
  'src/backup/register.mjs',
  'src/backup/restore.mjs',
  'src/backup/workspace-registry-guard.mjs',
  'scripts/workspace-registry-guard.mjs',
]);
const WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|renameSync|rmSync|unlinkSync|openSync)\b/gu;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (EXT.has(extname(entry.name))) out.push(full);
  }
  return out;
}

describe('workspace registry write policy', () => {
  it('only the registry modules write storages/workspace.json', () => {
    const offenders = [];
    for (const root of SCAN) {
      const base = join(REPO, root);
      if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const file of walk(base, [])) {
        const rel = relative(REPO, file).replace(/\\/g, '/');
        if (ALLOWED.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.includes('workspace.json')) return;
          if (!WRITE.test(line)) { WRITE.lastIndex = 0; return; }
          WRITE.lastIndex = 0;
          offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a write-like call touches workspace.json outside the registry modules — route it through src/backup/registry.mjs (or the guard) instead:\n' + offenders.join('\n'),
    );
  });

  it('the guard is reachable from the PowerShell wrapper and w2m-fix', () => {
    const cli = readFileSync(join(REPO, 'src/fix/cli.mjs'), 'utf8');
    assert.match(cli, /workspace-registry/u, 'w2m-fix must carry the workspace-registry command');
    assert.match(cli, /runWorkspaceRegistry/u);
    assert.match(cli, /inspectWorkspaceRegistry/u);
    assert.match(cli, /repairWorkspaceRegistry/u);
    const wrapper = readFileSync(join(REPO, 'tools/dsh-workspace-guard.ps1'), 'utf8');
    assert.match(wrapper, /w2m-fix\.mjs/u, 'the PowerShell wrapper must delegate to the w2m-fix CLI');
    assert.match(wrapper, /workspace-registry/u);
    assert.match(wrapper, /-repair/u, '-Fix must map to --repair');
    assert.match(wrapper, /Stop-Process/u, '-Fix must stop the client before repairing its in-memory document');
    const helper = readFileSync(join(REPO, 'scripts/workspace-registry-guard.mjs'), 'utf8');
    assert.match(helper, /inspectWorkspaceRegistry/u, 'the cross-platform helper must use the same guard module');
    assert.match(helper, /repairWorkspaceRegistry/u);
  });

  it('the repairer keeps rows and only drops dangling ids', () => {
    const source = readFileSync(join(REPO, 'src/backup/workspace-registry-guard.mjs'), 'utf8');
    assert.match(source, /keptIds\.push\(row\)/u, 'an unlisted row must be appended, never dropped');
    assert.match(source, /bak-guard-/u, 'a repair must back the document up first');
    assert.match(source, /inspectWorkspaceRegistry\(dshHome\)/u, 'a repair must re-inspect and converge');
  });
});
