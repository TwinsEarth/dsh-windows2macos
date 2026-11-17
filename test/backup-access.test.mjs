/**
 * Unlock (two real paths) and the workspace-registry protocol (gate G2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { describeUnlock, machineSecretAvailable, unlockRepo } from '../src/backup/unlock.mjs';
import {
  applyRegistryRestore,
  findWorkspaceForSlug,
  planRegistryRestore,
  verifyRegistryWrite,
  workspaceSlug,
} from '../src/backup/registry.mjs';
import { ensureLayout } from '../src/backup/layout.mjs';
import { readWorkspaceRegistry } from '../src/util/dsh-workspace.mjs';
import { makeHome, registryDocument, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const SESSION = 'session-aaaaaaaa-0001';
const WIN32 = process.platform === 'win32';

/** Identity-faking DPAPI transport (protect echoes base64, unprotect decodes it). */
function fakeRunner(command, args, input = '') {
  const text = args.join(' ');
  if (text.includes('ProtectedData]::Protect') || text.includes('ProtectedData]::Unprotect')) {
    return { ok: true, status: 0, stdout: input, stderr: '', error: '' };
  }
  return { ok: true, status: 0, stdout: 'ok', stderr: '', error: '' };
}

/** A repository seeded with a password only, plus the home it was made from. */
function passwordRepo() {
  const home = makeHome({
    sessions: [{ workspace: '--E-GPT--', id: SESSION }],
    registry: registryDocument({ sessionIds: [SESSION] }),
  });
  const repo = tempDir('w2m-access-repo-');
  const run = runBackup({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
  assert.equal(run.ok, true, run.detail);
  return { repo, home };
}

describe('unlock: describing the repository without touching a secret', () => {
  it('reports a password-only repository as exactly that', () => {
    const { repo, home } = passwordRepo();
    try {
      const described = describeUnlock({ root: repo.dir, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(described.ok, true);
      assert.deepEqual(described.envelopes, ['password']);
      assert.equal(described.password_required, true);
      assert.equal(described.machine_available, false);
      assert.equal(described.account_supported, false, 'no account envelope is written; the spy measured no secret');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('reports an uninitialised repository instead of pretending it is locked', () => {
    const { dir, cleanup } = tempDir('w2m-access-empty-');
    try {
      ensureLayout(dir);
      const described = describeUnlock({ root: dir, dshHome: dir, platform: 'linux', machineKey: false });
      assert.equal(described.ok, false);
      assert.equal(described.reason_code, 'BACKUP_REPO_NOT_INITIALIZED');
    } finally {
      cleanup();
    }
  });
});

describe('unlock: the attempt', () => {
  it('opens with the right password, refuses the wrong one, and never returns the key', () => {
    const { repo, home } = passwordRepo();
    try {
      const good = unlockRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(good.ok, true, good.detail);
      assert.equal(good.via, 'password');
      assert.equal('dek' in good, false, 'the unlock result must not carry the data key');

      const bad = unlockRepo({ root: repo.dir, dshHome: home.home, password: 'nope', platform: 'linux', machineKey: false });
      assert.equal(bad.ok, false);
      assert.equal(bad.reason_code, 'BACKUP_NO_PERMISSION');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('adds a machine envelope on the first OS-keystore machine, then opens with no password', () => {
    const { repo, home } = passwordRepo();
    try {
      const upgrade = unlockRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'win32', runner: fakeRunner });
      assert.equal(upgrade.ok, true, upgrade.detail);
      assert.equal(upgrade.via, 'password');
      assert.equal(upgrade.machine_envelope_added, true);

      const described = describeUnlock({ root: repo.dir, dshHome: home.home, platform: 'win32', runner: fakeRunner });
      assert.ok(described.envelopes.includes('machine'));
      assert.equal(described.machine_available, true);

      const passwordless = unlockRepo({ root: repo.dir, dshHome: home.home, platform: 'win32', runner: fakeRunner });
      assert.equal(passwordless.ok, true, passwordless.detail);
      assert.equal(passwordless.via, 'machine');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('is honest about platforms without an OS keystore', () => {
    const { dir, cleanup } = tempDir('w2m-access-machine-');
    try {
      const result = machineSecretAvailable({ dshHome: dir, platform: 'darwin', runner: fakeRunner });
      assert.equal(result.available, false);
      assert.ok(['keychain-not-implemented', 'platform-unsupported'].includes(result.reason));
    } finally {
      cleanup();
    }
  });

  it('uses the real DPAPI when the platform is Windows', { skip: WIN32 ? false : 'DPAPI is Windows-only' }, () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry: registryDocument({ sessionIds: [SESSION] }) });
    try {
      const result = machineSecretAvailable({ dshHome: home.home });
      assert.equal(result.available, true, result.reason ?? '');
      assert.equal(result.created, true);
    } finally {
      home.cleanup();
    }
  });
});

describe('registry: the slug mapping and the plan', () => {
  it('derives the same directory name DSH uses', () => {
    assert.equal(workspaceSlug('E:\\GPT'), '--E-GPT--');
    assert.equal(workspaceSlug('E:\\ToFuture'), '--E-ToFuture--');
    assert.equal(workspaceSlug('C:\\Users\\fangw\\Documents\\deepseek-harness\\default-workspace'), '--C-Users-fangw-Documents-deepseek-harness-default-workspace--');
    assert.equal(workspaceSlug('E:/GPT'), '--E-GPT--', 'forward slashes are normalised too');
  });

  it('finds the registered workspace by slug', () => {
    const registry = { workspaces: [{ id: 'w1', path: 'E:\\GPT', title: 'GPT', sessionIds: [] }], registered: new Set(), archived: new Set(), pinned: new Set() };
    assert.equal(findWorkspaceForSlug(registry, '--E-GPT--')?.id, 'w1');
    assert.equal(findWorkspaceForSlug(registry, '--E-Nowhere--'), null);
  });

  it('plans registration and archive flags, then verifies them by reading back', () => {
    const home = makeHome({
      sessions: [{ workspace: '--E-GPT--', id: SESSION }],
      registry: registryDocument({ sessionIds: [] }),
    });
    try {
      const plan = planRegistryRestore({ dshHome: home.home, sessionId: SESSION, workspaceName: '--E-GPT--', archived: true, pinned: true });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.changed, true);
      assert.deepEqual(plan.actions.sort(), [`archive ${SESSION}`, `pin ${SESSION}`, `register ${SESSION} in workspace w1`].sort());

      const applied = applyRegistryRestore({ dshHome: home.home, plan });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(applied.verified, true);
      assert.match(applied.warning, /client keeps this registry in memory/u);

      const registry = readWorkspaceRegistry(home.home);
      assert.ok(registry.registered.has(SESSION));
      assert.ok(registry.archived.has(SESSION));
      assert.ok(registry.pinned.has(SESSION));

      const again = planRegistryRestore({ dshHome: home.home, sessionId: SESSION, workspaceName: '--E-GPT--', archived: true, pinned: true });
      assert.equal(again.ok, true);
      assert.equal(again.changed, false, 'a second plan must be a no-op');
    } finally {
      home.cleanup();
    }
  });

  it('refuses to invent a workspace for an unknown slug', () => {
    const home = makeHome({
      sessions: [{ workspace: '--E-GPT--', id: SESSION }],
      registry: registryDocument({ sessionIds: [] }),
    });
    try {
      const plan = planRegistryRestore({ dshHome: home.home, sessionId: SESSION, workspaceName: '--E-Elsewhere--' });
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, 'BACKUP_RESTORE_WORKSPACE_UNKNOWN');
      assert.match(plan.detail, /pass --workspace-path/u);
    } finally {
      home.cleanup();
    }
  });

  it('never leaves a half-verified plan: a corrupt registry is a named refusal', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }] });
    try {
      fs.writeFileSync(join(home.home, 'storages', 'workspace.json'), 'not json');
      const plan = planRegistryRestore({ dshHome: home.home, sessionId: SESSION, workspaceName: '--E-GPT--' });
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, 'BACKUP_REGISTRY_UNREADABLE');
      const verification = verifyRegistryWrite({ dshHome: home.home, plan });
      assert.equal(verification.ok, true, 'verifying a refused plan is a no-op, not a crash');
    } finally {
      home.cleanup();
    }
  });
});
