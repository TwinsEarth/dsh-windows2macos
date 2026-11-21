/**
 * Wiring for the **two** backup sub-plugins, and the proof that both ship disabled.
 *
 * ## What this suite is for
 *
 * v3.5.5 splits the backup capability into two independently mountable rows:
 *
 *   * `dsh-backup` — the scheduled, content-addressed repository engine (`lib/backup.js`);
 *   * `dsh-backup-plugin` — the stateless archive tool surface (`lib/backup-plugin.js`), the six
 *     `backup_*` tools the BackUP-dsh-plugin contract defines.
 *
 * A package that declares a subpath nothing mounts is the defect this repository has shipped three
 * times, so the wiring is measured rather than described: the export map resolves to real files, the
 * bundle patch carries both rows with `disabled: true`, **the tool surface is absent when neither row is
 * enabled**, and each row can be enabled on its own. The last two are asserted by actually mounting the
 * patch rows against a fake Cordis context -- the same modules a profile would mount, not a copy.
 *
 * The end-to-end behaviour (create -> verify -> restore -> import an official ZIP) is
 * `backup-subplugin-e2e.test.mjs`; this file stays about shape, wiring and packaging.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { documentContract, packageFilesExpansion, requiredShippedEntries } from '../scripts/preflight.mjs';
import { apply as applyArchivePlugin, TOOL_NAMES } from '../src/plugin/backup-plugin.mjs';
import { makeHome, tempDir } from './helpers/backup-fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The row ids, spelled out so a rename has to touch this file too. */
const ROW_IDS = Object.freeze(['dsh-backup', 'dsh-backup-plugin']);

/** The archive row's subpath and entry, which package.json must declare. */
const ARCHIVE_SUBPATH = './dsh-backup-plugin';

/**
 * Parse the bundle patch's `- insert:` row list.
 *
 * A deliberately small reader: `scripts/preflight.mjs` and `test/claims.test.mjs` already own the
 * "is this file a patch at all" question. This one only needs the facts the suite mounts -- each row's
 * `id`, `name` and `disabled` -- so it reads indentation rather than growing a YAML dependency.
 *
 * @param {string} text
 * @returns {Array<{id: string, name: string|null, disabled: string|null, config: Record<string,string>}>}
 */
function patchRows(text) {
  const rows = [];
  let current = null;
  let inInsert = false;
  let inConfig = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^- insert:\s*$/.test(raw)) {
      inInsert = true;
      continue;
    }
    if (!inInsert) continue;
    if (raw.trim() !== '' && !/^\s/.test(raw)) break;
    const rowMatch = /^ {4}- id:\s*(.+?)\s*$/.exec(raw);
    if (rowMatch !== null) {
      current = { id: rowMatch[1].replace(/^['"]|['"]$/g, ''), name: null, disabled: null, config: {} };
      rows.push(current);
      inConfig = false;
      continue;
    }
    if (current === null) continue;
    const field = /^ {6}(name|disabled|config):(.*)$/.exec(raw);
    if (field !== null) {
      const [, key, rest] = field;
      if (key === 'name') current.name = rest.trim().replace(/^['"]|['"]$/g, '');
      else if (key === 'disabled') current.disabled = rest.trim();
      else inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    const entry = /^ {8}([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (entry !== null) current.config[entry[1]] = entry[2].trim();
  }
  return rows;
}

/**
 * Resolve a row's `name` through `package.json#exports`, exactly as the Loader does for a subpath row.
 *
 * @param {{id: string, name: string|null}} row
 * @returns {string} absolute path of the entry module
 */
function rowModuleFile(row) {
  assert.ok(typeof row.name === 'string' && row.name !== '', `row ${row.id} carries no name`);
  const subpath = row.name === pkg.name ? '.' : row.name.slice(pkg.name.length);
  assert.ok(subpath.startsWith('/') || subpath === '.', `row ${row.id} names ${row.name}, which is not this package`);
  const target = pkg.exports[subpath === '/' ? '.' : `.${subpath}`];
  assert.ok(typeof target === 'string', `row ${row.id} names ${row.name}, which package.json does not export`);
  const file = join(ROOT, target);
  assert.ok(existsSync(file), `row ${row.id} -> ${target} does not exist`);
  return file;
}

/**
 * A fake Cordis context that records what a mount registers.
 *
 * `inject` is synchronous because both plugins inject only already-present services in this host shape:
 * `connection` for the repository row's panel routes, `tools` for the archive row's six tools.
 */
function fakeContext() {
  const registered = [];
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition) {
        registered.push(definition);
        return definition;
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    inject(_names, callback) {
      callback({ ...ctx, connection: { fetch: { register: (definition) => routes.push(definition) } } });
    },
  };
  return { ctx, registered, routes, disposers };
}

/** Per-row configuration for the mount test: throwaway paths, no schedule and no runtime verdict. */
function rowConfig(id, home) {
  const project = join(home, 'project');
  if (id === 'dsh-backup') {
    return { dshHome: home, backupDir: join(home, 'repository'), backupRuntimeVerify: 'off', backupCatchUpOnStart: false };
  }
  return { dshHome: home, backupRoot: join(home, 'archives'), projectRoot: project, workspace: project };
}

/**
 * Mount the selected patch rows through their package entries.
 *
 * @param {Array<object>} rows
 * @param {string[]} enabledIds
 * @returns {Promise<{registered: object[], routes: object[]}>}
 */
async function mountRows(rows, enabledIds) {
  const { dir: home, cleanup } = tempDir('w2m-backup-row-mount-');
  const probe = fakeContext();
  try {
    for (const row of rows) {
      if (!enabledIds.includes(row.id)) continue;
      const module = await import(pathToFileURL(rowModuleFile(row)).href);
      await module.apply(probe.ctx, rowConfig(row.id, home));
    }
  } finally {
    for (const dispose of probe.disposers) dispose();
    cleanup();
  }
  return { registered: probe.registered, routes: probe.routes };
}

describe('the two backup rows: exports and package shape', () => {
  it('every string export resolves to a real file (the whole export map, not only the new subpath)', () => {
    const entries = Object.entries(pkg.exports);
    assert.ok(entries.length >= 10, `the export map holds only ${entries.length} entries; the scan has drifted`);
    for (const [subpath, target] of entries) {
      assert.equal(typeof target, 'string', `export ${subpath} is not a string`);
      assert.ok(target.startsWith('./'), `export ${subpath} must be a relative path, got ${target}`);
      assert.ok(existsSync(join(ROOT, target)), `export ${subpath} -> ${target} does not exist in the tree`);
    }
    assert.equal(pkg.exports[ARCHIVE_SUBPATH], './lib/backup-plugin.js');
    assert.equal(pkg.exports['./dsh-backup'], './lib/backup.js');
  });

  it('both subpaths import, both name a plugin, and the archive entry exports the six-tool surface', async () => {
    for (const subpath of ['./dsh-backup', './dsh-backup-plugin']) {
      const target = pkg.exports[subpath];
      const module = await import(pathToFileURL(join(ROOT, target)).href);
      assert.equal(typeof module.apply, 'function', `${subpath} exports no apply()`);
      assert.equal(typeof module.name, 'string', `${subpath} exports no plugin name`);
      assert.ok(module.name.startsWith('w2m-'), `${subpath} names the plugin ${module.name}`);
    }
    // Node self-reference: the specifier a profile row uses must resolve to this package's exports.
    const archive = await import('@twinsearth/w2m-dsh-plugin/dsh-backup-plugin');
    assert.equal(typeof archive.apply, 'function');
    assert.deepEqual([...archive.TOOL_NAMES].sort(), [...TOOL_NAMES].sort());
    assert.equal(archive.TOOL_NAMES.length, 6);
    const legacy = await import('@twinsearth/w2m-dsh-plugin/dsh-backup');
    assert.equal(typeof legacy.apply, 'function');
  });

  it('every module named by the archive row ships in the packed file set', () => {
    const shipped = new Set(packageFilesExpansion(ROOT, pkg.files));
    for (const rel of [
      'lib/backup-plugin.js',
      'src/plugin/backup-plugin.mjs',
      'src/backup/zip-archive.mjs',
      'src/backup/session-zip.mjs',
      'src/backup/zip.mjs',
      'docs/BACKUP-SUBPLUGIN.md',
    ]) {
      assert.ok(shipped.has(rel), `${rel} is not covered by package.json#files, so it would not be published`);
    }
    const required = requiredShippedEntries(pkg);
    const exportEntry = required.find((entry) => entry.field === 'exports["./dsh-backup-plugin"]');
    assert.ok(exportEntry, 'requiredShippedEntries() does not see the new export');
    assert.equal(exportEntry.path, 'lib/backup-plugin.js');
  });

  it('packs the new modules into the release tarball, at the tree version', () => {
    const out = mkdtempSync(join(tmpdir(), 'w2m-backup-pack-'));
    try {
      const stdout = execFileSync(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--out', out], { encoding: 'utf8' });
      assert.match(stdout, /packed \d+ files/u);
      const tarball = join(out, `twinsearth-w2m-dsh-plugin-${pkg.version}.tgz`);
      assert.ok(existsSync(tarball), `the packer wrote no ${pkg.version} tarball: ${stdout}`);
      const tar = gunzipSync(readFileSync(tarball));
      for (const rel of [
        'package/lib/backup-plugin.js',
        'package/src/plugin/backup-plugin.mjs',
        'package/src/backup/zip-archive.mjs',
        'package/src/backup/session-zip.mjs',
        'package/src/backup/zip.mjs',
      ]) {
        assert.ok(tar.includes(Buffer.from(rel, 'utf8')), `the packed tarball does not carry ${rel}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('documents the subpath, the row and all six tools in a shipped document', () => {
    const file = join(ROOT, 'docs', 'BACKUP-SUBPLUGIN.md');
    assert.ok(existsSync(file), 'docs/BACKUP-SUBPLUGIN.md is missing');
    const text = readFileSync(file, 'utf8');
    for (const needle of ['@twinsearth/w2m-dsh-plugin/dsh-backup-plugin', 'dsh-backup-plugin', 'dsh-backup']) {
      assert.ok(text.includes(needle), `the document never names ${needle}`);
    }
    for (const tool of TOOL_NAMES) assert.ok(text.includes(tool), `the document never names ${tool}`);
    const contract = documentContract({ root: ROOT, files: pkg.files });
    assert.ok(contract.shipped.includes('docs/BACKUP-SUBPLUGIN.md'), 'the document is not covered by package.json#files');
  });
});

describe('the two backup rows: the bundle patch', () => {
  const rows = patchRows(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'));

  it('carries both rows, each naming its own subpath', () => {
    for (const id of ROW_IDS) {
      const row = rows.find((entry) => entry.id === id);
      assert.ok(row, `cordis.patch.yml carries no row ${id}`);
      assert.equal(row.name, id === 'dsh-backup' ? '@twinsearth/w2m-dsh-plugin/dsh-backup' : '@twinsearth/w2m-dsh-plugin/dsh-backup-plugin');
    }
  });

  it('ships BOTH rows disabled by default', () => {
    for (const id of ROW_IDS) {
      const row = rows.find((entry) => entry.id === id);
      assert.equal(row.disabled, 'true', `row ${id} must ship disabled: true (got ${row.disabled}); enabling it is the operator's decision`);
    }
    // The old default (enabled) is the specific regression this release reverses.
    const enabled = rows.filter((row) => ROW_IDS.includes(row.id) && row.disabled !== 'true');
    assert.deepEqual(enabled, [], `backup row(s) still enabled by default: ${enabled.map((row) => row.id).join(', ')}`);
  });

  it('keeps the archive row configured for the tool surface it mounts', () => {
    const row = rows.find((entry) => entry.id === 'dsh-backup-plugin');
    assert.equal(row.config.backupRoot, "''", 'the row documents the empty backupRoot default');
    assert.equal(row.config.includeProject, 'true');
    assert.equal(row.config.includeSessions, 'true');
    assert.equal(row.config.includeProfile, 'false');
    assert.equal(row.config.keepBackups, '0');
    assert.ok('maxFileBytes' in row.config, 'the row documents the per-entry size cap');
  });
});

describe('default-disabled and individual enablement, measured by mounting the patch rows', () => {
  const rows = patchRows(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'));

  it('neither row enabled: the tool surface is absent and no route is registered', async () => {
    const mounted = await mountRows(rows, []);
    assert.deepEqual(mounted.registered, [], 'a backup tool was registered although neither row is enabled');
    assert.deepEqual(mounted.routes, [], 'a backup route was registered although neither row is enabled');
  });

  it('only dsh-backup enabled: the repository row mounts routes, and registers NO backup_* tools', async () => {
    const mounted = await mountRows(rows, ['dsh-backup']);
    assert.ok(mounted.routes.length > 0, 'the repository row registered no route when enabled on its own');
    const backupTools = mounted.registered.filter((definition) => definition.name.startsWith('backup_'));
    assert.deepEqual(backupTools, [], 'the repository row must not claim the archive tool surface');
  });

  it('only dsh-backup-plugin enabled: exactly the six tools mount, and no repository route', async () => {
    const mounted = await mountRows(rows, ['dsh-backup-plugin']);
    assert.deepEqual(
      mounted.registered.map((definition) => definition.name).sort(),
      [...TOOL_NAMES].sort(),
      'the archive row did not register exactly the six contract tools',
    );
    assert.deepEqual(mounted.routes, [], 'the archive row must not mount the repository panel routes');
  });

  it('both rows enabled: the two surfaces coexist (one timer/repository, one on-demand archive)', async () => {
    const mounted = await mountRows(rows, ['dsh-backup', 'dsh-backup-plugin']);
    assert.ok(mounted.routes.length > 0);
    assert.deepEqual(mounted.registered.map((definition) => definition.name).sort(), [...TOOL_NAMES].sort());
  });
});

describe('the archive tool surface: definitions', () => {
  it('every tool declares a name, description, parameters and an output renderer', async () => {
    const { home, cleanup } = makeHome();
    const { dir: workDir, cleanup: cleanTemp } = tempDir('w2m-backup-tool-defs-');
    try {
      const definitions = [];
      const ctx = {
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        tools: { register: (definition) => definitions.push(definition) },
        inject: (_names, callback) => callback(ctx),
      };
      await applyArchivePlugin(ctx, { dshHome: home, backupRoot: join(workDir, 'archives'), projectRoot: home, workspace: home });
      assert.equal(definitions.length, 6);
      for (const definition of definitions) {
        assert.ok(typeof definition.description === 'string' && definition.description.trim() !== '', `${definition.name}: description`);
        assert.ok(definition.parameters !== null && typeof definition.parameters === 'object', `${definition.name}: parameters`);
        assert.equal(typeof definition.execute, 'function', `${definition.name}: execute`);
        assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output.render`);
      }
      const byName = new Map(definitions.map((definition) => [definition.name, definition]));
      for (const key of ['projectRoot', 'workspace', 'includeProject', 'includeSessions', 'includeProfile']) {
        assert.ok(key in byName.get('backup_create').parameters, `backup_create is missing ${key}`);
      }
      assert.ok('archive' in byName.get('backup_verify').parameters);
      assert.ok('mode' in byName.get('backup_restore').parameters);
      assert.ok('zip' in byName.get('backup_import_session_zip').parameters);
      assert.equal(Object.keys(byName.get('backup_status').parameters).length, 0, 'backup_status must stay read-only with no parameters');

      // `forceRunning` must describe the replacement it performs, not a flag that is merely accepted and echoed:
      // the old "accepted for contract compatibility" text was the lie this assertion keeps from coming back.
      for (const tool of ['backup_restore', 'backup_import_session_zip']) {
        const forceRunning = byName.get(tool).parameters.forceRunning;
        assert.equal(forceRunning?.type, 'boolean', `${tool} must expose forceRunning`);
        assert.match(forceRunning.description, /sessions-<UTC>/u, `${tool}: forceRunning must name the recovery copy it makes`);
        assert.match(forceRunning.description, /replac/iu, `${tool}: forceRunning must say what it replaces`);
        assert.equal(
          /accepted for contract compatibility/iu.test(forceRunning.description),
          false,
          `${tool}: forceRunning is real semantics now, not an accepted-and-reported flag`,
        );
      }
    } finally {
      cleanup();
      cleanTemp();
    }
  });
});
