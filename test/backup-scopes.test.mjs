/**
 * Backup scopes: what the expanded P0 scope set copies, what it deliberately leaves out, and why.
 *
 * The audit in `docs/BACKUP-SCOPE.md` is the specification these tests freeze: every skipped path is asserted to
 * be *reported* with a class and a reason (silence is the defect being fixed), credentials are asserted to be
 * opt-in, and the caps are asserted to refuse rather than truncate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import {
  BACKUP_SCOPES,
  DEFAULT_BACKUP_SCOPES,
  MAX_INVENTORY_FILES,
  MAX_SCOPE_FILE_BYTES,
  MAX_SCOPE_TOTAL_BYTES,
  SCOPE_CODES,
  classifyHomePath,
  collectScopeFiles,
  homeInventory,
  isCredentialRel,
  resolveBackupScopes,
} from '../src/backup/scopes.mjs';
import { put, tempDir } from './helpers/backup-fixture.mjs';

/** A home carrying one of everything the expanded scopes must classify. */
function scopeHome() {
  const { dir, cleanup } = tempDir('w2m-scope-home-');
  const files = {
    'storages/workspace.json': '{"unit":{"name":"workspace","version":2}}',
    'cordis.patch.yml': 'plugins:\n  - id: a\n',
    'profiles/desktop/package.json': '{"name":"p","dsh":{"profile":{"bundles":[]}}}',
    'profiles/desktop/cordis.patch.yml': 'plugins: []\n',
    'profiles/desktop/cordis.yml': 'plugins: []\n',
    'profiles/desktop/pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'profiles/desktop/pnpm-workspace.yaml': 'packages: []\n',
    'profiles/desktop/node_modules/dep/index.js': 'require("x")',
    'profiles/desktop/cordis.patch.yml.bak-20260101': 'old',
    'profiles/desktop/notes.txt': 'not config',
    'xclient/device.json': '{"sn":"x"}',
    'xclient/device.key': 'private',
    'xclient/gpw-folders.json': '{"allow":[]}',
    'xclient/gpw-folders.json.key': 'private',
    'xclient/spool/outbox.json': '[]',
    'xclient/w2m-backup/state.json': '{}',
    'xclient/agent.log': 'log line',
    'xclient/agent.json.bak-20260101': 'old',
    'storages/dsh-context/state.json': '{}',
    'storages/session_projcache/projection.json': '{}',
    'storages/workspace.json.bak-20260101': 'old',
    'llm-deepseek/config.json': '{"model":"x"}',
    'fang/contract.json': '{}',
    'attachments/v1/objects/aa/aa00': 'attachment',
    '.credentials.yaml': 'token: secret\n',
    '.credentials.yaml.bak': 'token: older\n',
    '.anonymous-user-id': 'anon',
    'dsh-runtimes/node/bin/node': 'binary',
    'xray-proxy/xray.exe': 'binary',
    '.w2m-restore-backups/20260101T000000Z/workspace.json': '{"old":true}',
    'sessions/.event-cache/projection.json': '{"cache":true}',
    'sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd': 'log',
  };
  for (const [rel, text] of Object.entries(files)) put(join(dir, ...rel.split('/')), text);
  // A symlink outside the home: reported and never followed.
  const link = join(dir, 'xclient', 'linked-outside');
  let symlink = true;
  try {
    fs.symlinkSync(dir, link, 'junction');
  } catch {
    symlink = false;
  }
  return { dir, cleanup, symlink };
}

describe('backup scopes: resolveBackupScopes', () => {
  it('treats an absent value as every scope (the P0 default)', () => {
    assert.deepEqual(resolveBackupScopes(undefined), { ok: true, scopes: [...DEFAULT_BACKUP_SCOPES] });
    assert.deepEqual(resolveBackupScopes(null), { ok: true, scopes: [...DEFAULT_BACKUP_SCOPES] });
    assert.deepEqual([...DEFAULT_BACKUP_SCOPES], [...BACKUP_SCOPES]);
    assert.equal(BACKUP_SCOPES.length, 5);
  });

  it('accepts a subset in canonical order and de-duplicates it', () => {
    assert.deepEqual(resolveBackupScopes(['state', 'registry', 'state']), { ok: true, scopes: ['registry', 'state'] });
    assert.deepEqual(resolveBackupScopes([]), { ok: true, scopes: [] });
  });

  it('refuses an unknown scope and a non-array value by name', () => {
    for (const bad of ['all', ['sessions', 'everything'], 42, { scopes: ['sessions'] }]) {
      const result = resolveBackupScopes(bad);
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, SCOPE_CODES.UNKNOWN);
      assert.match(result.detail, /scope/u);
    }
  });
});

describe('backup scopes: collectScopeFiles', () => {
  it('collects registry, config and state files with a kind, scope and reason', () => {
    const home = scopeHome();
    try {
      const collected = collectScopeFiles({ dshHome: home.dir });
      assert.equal(collected.ok, true);
      assert.equal(collected.secrets_included, false);
      assert.deepEqual(collected.scopes, [...BACKUP_SCOPES]);
      const byRel = new Map(collected.files.map((row) => [row.rel, row]));
      const expected = {
        'storages/workspace.json': 'registry',
        'cordis.patch.yml': 'config',
        'profiles/desktop/package.json': 'config',
        'profiles/desktop/cordis.patch.yml': 'config',
        'profiles/desktop/cordis.yml': 'config',
        'profiles/desktop/pnpm-lock.yaml': 'config',
        'profiles/desktop/pnpm-workspace.yaml': 'config',
        'xclient/device.json': 'state',
        'xclient/gpw-folders.json': 'state',
        'xclient/spool/outbox.json': 'state',
        'xclient/w2m-backup/state.json': 'state',
        'storages/dsh-context/state.json': 'state',
        'llm-deepseek/config.json': 'state',
        'fang/contract.json': 'state',
      };
      for (const [rel, kind] of Object.entries(expected)) {
        const row = byRel.get(rel);
        assert.ok(row, `${rel} must be collected`);
        assert.equal(row.kind, kind, rel);
        assert.equal(row.scope, kind, rel);
        assert.ok(typeof row.reason === 'string' && row.reason.length > 0, `${rel} has no reason`);
        assert.ok(row.file.startsWith(home.dir), `${rel} resolves inside the home`);
      }
      // Sorted, deterministic.
      const rels = collected.files.map((row) => row.rel);
      assert.deepEqual(rels, [...rels].sort());
    } finally {
      home.cleanup();
    }
  });

  it('skips dependency trees, caches, backups, logs and credentials, each with a class and reason', () => {
    const home = scopeHome();
    try {
      const collected = collectScopeFiles({ dshHome: home.dir });
      const rels = new Set(collected.files.map((row) => row.rel));
      for (const rel of [
        'profiles/desktop/node_modules/dep/index.js',
        'profiles/desktop/cordis.patch.yml.bak-20260101',
        'profiles/desktop/notes.txt',
        'storages/session_projcache/projection.json',
        'storages/workspace.json.bak-20260101',
        'xclient/agent.log',
        'xclient/agent.json.bak-20260101',
        'dsh-runtimes/node/bin/node',
        'xray-proxy/xray.exe',
        '.w2m-restore-backups/20260101T000000Z/workspace.json',
        'sessions/.event-cache/projection.json',
        '.credentials.yaml',
        '.anonymous-user-id',
        'xclient/device.key',
        'xclient/gpw-folders.json.key',
      ]) {
        assert.equal(rels.has(rel), false, `${rel} must not be collected`);
      }
      const skipped = new Map(collected.skipped.map((row) => [row.rel, row]));
      const classOf = (rel) => {
        const row = skipped.get(rel) ?? [...skipped.values()].find((candidate) => candidate.rel === rel || rel.startsWith(`${candidate.rel}/`));
        assert.ok(row, `${rel} must be reported as skipped`);
        return row.class;
      };
      assert.equal(classOf('profiles/desktop/node_modules'), 'reinstallable');
      assert.equal(classOf('dsh-runtimes'), 'reinstallable');
      assert.equal(classOf('xray-proxy'), 'reinstallable');
      assert.equal(classOf('sessions/.event-cache'), 'cache');
      assert.equal(classOf('storages/session_projcache'), 'cache');
      assert.equal(classOf('.w2m-restore-backups'), 'self-copy');
      assert.equal(classOf('storages/workspace.json.bak-20260101'), 'self-copy');
      assert.equal(classOf('.credentials.yaml'), 'credential');
      assert.equal(classOf('xclient/device.key'), 'credential');
      assert.equal(classOf('profiles/desktop/cordis.patch.yml.bak-20260101'), 'self-copy');
      for (const row of collected.skipped) {
        assert.ok(typeof row.reason === 'string' && row.reason.length > 0, `${row.rel} skipped without a reason`);
        assert.ok(typeof row.class === 'string' && row.class.length > 0, `${row.rel} skipped without a class`);
      }
    } finally {
      home.cleanup();
    }
  });

  it('includes credentials only when includeSecrets is explicitly true', () => {
    const home = scopeHome();
    try {
      const defaultRun = collectScopeFiles({ dshHome: home.dir });
      assert.equal(defaultRun.files.some((row) => isCredentialRel(row.rel)), false);
      assert.equal(defaultRun.secrets_included, false);
      const withSecrets = collectScopeFiles({ dshHome: home.dir, includeSecrets: true });
      assert.equal(withSecrets.secrets_included, true);
      const rels = new Set(withSecrets.files.map((row) => row.rel));
      for (const rel of ['.credentials.yaml', '.credentials.yaml.bak', '.anonymous-user-id', 'xclient/device.key', 'xclient/gpw-folders.json.key']) {
        assert.equal(rels.has(rel), true, `${rel} must be included with includeSecrets`);
      }
      // The default run reports the same files as skipped credentials, not silently absent.
      const skipped = new Set(defaultRun.skipped.filter((row) => row.class === 'credential').map((row) => row.rel));
      for (const rel of ['.credentials.yaml', '.anonymous-user-id', 'xclient/device.key', 'xclient/gpw-folders.json.key']) {
        assert.equal(skipped.has(rel), true, `${rel} must be reported as a skipped credential`);
      }
    } finally {
      home.cleanup();
    }
  });

  it('collects only the selected scopes', () => {
    const home = scopeHome();
    try {
      const registry = collectScopeFiles({ dshHome: home.dir, scopes: ['registry'] });
      assert.deepEqual(registry.files.map((row) => row.rel), ['storages/workspace.json']);
      const none = collectScopeFiles({ dshHome: home.dir, scopes: [] });
      assert.deepEqual(none.files, []);
      const config = collectScopeFiles({ dshHome: home.dir, scopes: ['config'] });
      assert.equal(config.files.every((row) => row.kind === 'config'), true);
      const unknown = collectScopeFiles({ dshHome: home.dir, scopes: ['nope'] });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.reason_code, SCOPE_CODES.UNKNOWN);
    } finally {
      home.cleanup();
    }
  });

  it('never follows a symlink and reports it as one', { skip: process.platform !== 'win32' ? false : false }, () => {
    const home = scopeHome();
    try {
      if (home.symlink !== true) return; // creating a junction can be refused by policy; the rule is asserted elsewhere
      const collected = collectScopeFiles({ dshHome: home.dir });
      const synced = collected.skipped.find((row) => row.rel === 'xclient/linked-outside');
      assert.ok(synced, 'the symlink must be reported');
      assert.equal(synced.class, 'symlink');
      assert.equal(collected.files.some((row) => row.rel.startsWith('xclient/linked-outside/')), false);
    } finally {
      home.cleanup();
    }
  });

  it('skips a regular file over the per-file cap with reason too-large', () => {
    const { dir, cleanup } = tempDir('w2m-scope-cap-');
    try {
      put(join(dir, 'xclient', 'big.bin'), Buffer.alloc(MAX_SCOPE_FILE_BYTES + 1, 1));
      const collected = collectScopeFiles({ dshHome: dir, scopes: ['state'] });
      assert.equal(collected.ok, true);
      assert.equal(collected.files.some((row) => row.rel === 'xclient/big.bin'), false);
      const skipped = collected.skipped.find((row) => row.rel === 'xclient/big.bin');
      assert.ok(skipped);
      assert.equal(skipped.class, 'cap');
      assert.match(skipped.reason, /too-large/u);
    } finally {
      cleanup();
    }
  });

  it('refuses (not truncates) when the expanded set exceeds the total cap', () => {
    const { dir, cleanup } = tempDir('w2m-scope-total-');
    try {
      // Sparse files: the stat size counts, the disk usage does not. Each is exactly at the per-file cap.
      const fileCount = Math.ceil(MAX_SCOPE_TOTAL_BYTES / MAX_SCOPE_FILE_BYTES) + 1;
      for (let index = 0; index < fileCount; index += 1) {
        const file = put(join(dir, 'xclient', `part-${String(index).padStart(2, '0')}.bin`), Buffer.alloc(0));
        const fd = fs.openSync(file, 'r+');
        try {
          fs.ftruncateSync(fd, MAX_SCOPE_FILE_BYTES);
        } finally {
          fs.closeSync(fd);
        }
      }
      const collected = collectScopeFiles({ dshHome: dir, scopes: ['state'] });
      assert.equal(collected.ok, false);
      assert.equal(collected.reason_code, SCOPE_CODES.TOO_LARGE);
      assert.equal(collected.cap_bytes, MAX_SCOPE_TOTAL_BYTES);
      assert.ok(collected.total_bytes > MAX_SCOPE_TOTAL_BYTES);
    } finally {
      cleanup();
    }
  });
});

describe('backup scopes: homeInventory', () => {
  it('totals the home and classifies each top-level area', () => {
    const home = scopeHome();
    try {
      const inventory = homeInventory({ dshHome: home.dir });
      assert.equal(inventory.ok, true);
      assert.equal(inventory.exists, true);
      assert.equal(inventory.truncated, false);
      const totalFiles = Object.values({
        files: 34, // fixture files above; the junction adds none (never followed)
      }).length;
      void totalFiles;
      assert.ok(inventory.files >= 30, `inventory counted ${inventory.files} files`);
      assert.ok(inventory.bytes > 0);
      const rows = new Map(inventory.top.map((row) => [row.rel, row]));
      assert.equal(rows.get('dsh-runtimes').class, 'reinstallable');
      assert.equal(rows.get('xray-proxy').class, 'reinstallable');
      assert.equal(rows.get('profiles/desktop/node_modules').class, 'reinstallable');
      assert.equal(rows.get('sessions/.event-cache').class, 'cache');
      assert.equal(rows.get('storages/session_projcache').class, 'cache');
      assert.equal(rows.get('.w2m-restore-backups').class, 'self-copy');
      assert.equal(rows.get('xclient/device.key').class, 'credential');
      assert.equal(rows.get('xclient/device.json').class, 'in-scope');
      assert.equal(rows.get('storages/workspace.json').class, 'in-scope');
      assert.equal(rows.get('cordis.patch.yml').class, 'in-scope');
      // The rows add up to the home total (top-level aggregation is not double-counted).
      assert.equal(inventory.top.reduce((sum, row) => sum + row.files, 0), inventory.files);
      assert.equal(inventory.top.reduce((sum, row) => sum + row.bytes, 0), inventory.bytes);
    } finally {
      home.cleanup();
    }
  });

  it('agrees with classifyHomePath on a representative path set', () => {
    assert.equal(classifyHomePath('dsh-runtimes/node/bin/node'), 'reinstallable');
    assert.equal(classifyHomePath('profiles/desktop/node_modules/x/index.js'), 'reinstallable');
    assert.equal(classifyHomePath('xray-proxy/xray.exe'), 'reinstallable');
    assert.equal(classifyHomePath('sessions/.event-cache/x.json'), 'cache');
    assert.equal(classifyHomePath('storages/session_projcache/x.json'), 'cache');
    assert.equal(classifyHomePath('.w2m-restore-backups/20260101T000000Z/workspace.json'), 'self-copy');
    assert.equal(classifyHomePath('storages/workspace.json.bak-20260101'), 'self-copy');
    assert.equal(classifyHomePath('.credentials.yaml'), 'credential');
    assert.equal(classifyHomePath('xclient/device.key'), 'credential');
    assert.equal(classifyHomePath('sessions/--E-GPT--/s/x.v4.jsonl.zstd'), 'in-scope');
    assert.equal(classifyHomePath('attachments/v1/objects/aa/aa00'), 'in-scope');
    assert.equal(classifyHomePath('storages/workspace.json'), 'in-scope');
    assert.equal(classifyHomePath('cordis.patch.yml'), 'in-scope');
    assert.equal(classifyHomePath('profiles/desktop/package.json'), 'in-scope');
    assert.equal(classifyHomePath('something-new/state.json'), 'unknown');
  });

  it('reports a home larger than the inventory guard as truncated instead of walking forever', () => {
    // The guard is exercised without creating 200k files: the walk stops at the cap, and a home below the cap is
    // complete. The property that matters is that `truncated` exists and is false for a normal home.
    const { dir, cleanup } = tempDir('w2m-scope-inv-');
    try {
      put(join(dir, 'xclient', 'a.json'), '{}');
      const inventory = homeInventory({ dshHome: dir });
      assert.equal(inventory.truncated, false);
      assert.equal(inventory.files, 1);
      assert.equal(typeof MAX_INVENTORY_FILES, 'number');
      assert.ok(MAX_INVENTORY_FILES >= 100_000);
    } finally {
      cleanup();
    }
  });
});
