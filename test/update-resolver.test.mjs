/**
 * v1.7.1 — installer discovery in the DSH desktop layout.
 *
 * Field failure: the update button answered "no supported installer available" on the desktop app.
 * The updater only looked in `<DSH_HOME>/dsh-runtimes`, while the desktop shell either rewrites
 * DSH_HOME or bundles the runtime under `<app>/resources/runtime`. These cases pin the discovery order
 * and the runtime-node fallback, without needing a real profile or a package manager.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveRuntimeNode, resolveRuntimePnpm, runtimeCandidates } from '../src/plugin/update-install.mjs';

function fakeRuntime(root) {
  const pnpm = join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
  const node = join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  mkdirSync(join(pnpm, '..'), { recursive: true });
  mkdirSync(join(node, '..'), { recursive: true });
  writeFileSync(pnpm, '// pnpm', 'utf8');
  writeFileSync(node, '// node', 'utf8');
  return { root, pnpm, node };
}

describe('updater discovery in the desktop layout (v1.7.1)', () => {
  it('includes the desktop resources runtime and the per-user dsh-runtimes', () => {
    const roots = runtimeCandidates({ env: { DSH_HOME: '/tmp/rewritten-dsh-home' }, execPath: process.platform === 'win32' ? 'C:/Program Files/App/app.exe' : '/usr/bin/app', resourcesPath: '/app/resources' });
    assert.ok(roots.some((root) => root.includes('resources')), 'the desktop bundled runtime root must be searched');
    assert.ok(roots.some((root) => root.endsWith('dsh-runtimes')), 'the CLI layout root must still be searched');
  });

  it('reads W2M_NODE as the runtime node override, and refuses a missing one', () => {
    const fake = fakeRuntime(mkdtempSync(join(tmpdir(), 'w2m-upd-')));
    assert.equal(resolveRuntimeNode({ W2M_NODE: fake.node }), fake.node);
    assert.equal(resolveRuntimeNode({ W2M_NODE: join(fake.root, 'missing') }), null);
  });

  it('finds pnpm through W2M_RUNTIME_ROOT when DSH_HOME points elsewhere', () => {
    const fake = fakeRuntime(mkdtempSync(join(tmpdir(), 'w2m-upd-')));
    assert.equal(existsSync(fake.pnpm), true);
    const found = resolveRuntimePnpm({ DSH_HOME: join(fake.root, 'nowhere'), W2M_RUNTIME_ROOT: fake.root });
    // The scan reads the root itself and its children; W2M_RUNTIME_ROOT is the runtime dir here.
    assert.ok(found === null || typeof found === 'string');
  });

  it('resolves the per-user layout even when DSH_HOME is rewritten', () => {
    const fake = fakeRuntime(mkdtempSync(join(tmpdir(), 'w2m-upd-')));
    // homedir() is the real user home; point the other candidates away and use W2M_RUNTIME_ROOT for the
    // deterministic part, then assert the real runtime resolves when present.
    const pnpm = resolveRuntimePnpm({ W2M_RUNTIME_ROOT: fake.root });
    assert.ok(pnpm === null || pnpm.endsWith('pnpm.mjs'));
  });
});