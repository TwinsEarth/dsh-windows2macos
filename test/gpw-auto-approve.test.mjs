/**
 * v1.8.2 timeout policy — a yellow (class-C) call is approved after 100 s with no operator answer, while the lists keep
 * their own rules: red is denied outright and a whitelist hit never becomes pending. The auto-approval is recorded as a
 * session grant, so the next identical call is blue.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply } from '../src/plugin/gpw.mjs';

const fixtures = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-auto-'));
  fixtures.push(dir);
  return dir;
};
after(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked on Windows */
    }
  }
});

function mount(config = {}) {
  const listeners = new Map();
  const ctx = {
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: (_services, callback) => callback({ connection: { fetch: { register: () => {} } } }),
    permissionPresets: { current: () => 'danger-full-access' },
    workingDirectory: null,
  };
  apply(ctx, config);
  return { preExecute: listeners.get('tools/pre-execute') };
}

const execFor = (path, name = 'write') => ({ agent: { session: { header: { id: 'session-timeout' } } }, name, parameters: { path } });

describe('GPW timeout auto-approve (v1.8.2)', () => {
  it('approves a yellow call after the timeout and makes its next occurrence blue', async () => {
    const file = join(fixture(), 'gpw-folders.json');
    const { preExecute } = mount({ foldersFile: file, foldersKey: 'test-key', pendingTimeoutMs: 60, requireFullAccess: true });
    const target = join(fixture(), 'outside', 'a.txt');
    const outcome = await preExecute(execFor(target), () => undefined);
    assert.equal(outcome.kind, 'allow', 'no operator answer -> auto-approve');
    assert.match(outcome.reason, /auto-approved/);
    // the auto-approval is a session grant: the same call now runs immediately (blue)
    const again = await preExecute(execFor(target), () => undefined);
    assert.equal(again.kind, 'allow');
    assert.doesNotMatch(String(again.reason), /no operator answer/);
  });

  it('keeps red denied outright, with no timeout involved', async () => {
    const file = join(fixture(), 'gpw-folders.json');
    const { preExecute } = mount({ foldersFile: file, foldersKey: 'test-key', pendingTimeoutMs: 60, requireFullAccess: true });
    const denied = await preExecute(execFor(join(fixture(), '.ssh', 'id_rsa')), () => undefined);
    assert.equal(denied.kind, 'deny');
  });

  it('keeps a whitelist hit immediate (never queued, so the timeout rule cannot apply)', async () => {
    const allowed = fixture();
    const file = join(fixture(), 'gpw-folders.json');
    const { preExecute } = mount({ foldersFile: file, foldersKey: 'test-key', pendingTimeoutMs: 60, requireFullAccess: true, whitelist: [allowed] });
    const child = join(allowed, 'sub', 'file.txt');
    const outcome = await preExecute(execFor(child), () => undefined);
    assert.equal(outcome.kind, 'allow');
    assert.doesNotMatch(String(outcome.reason ?? ''), /no operator answer/);
  });

  it('exposes the 100 s default in the source', async () => {
    const source = (await import('node:fs')).readFileSync(join(process.cwd(), 'src', 'plugin', 'gpw.mjs'), 'utf8');
    assert.match(source, /DEFAULT_PENDING_TIMEOUT_MS = 100_000/);
  });
});
