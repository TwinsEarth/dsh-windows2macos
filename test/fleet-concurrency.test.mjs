/**
 * 1.9.2: the relay no longer stores data-plane objects, so fleet-memory sync
 * (publish/latest/pull/diff/merge) is retired by name and the local document
 * is never touched. This replaces the previous live-relay suites.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';

const ACTIONS = ['publish', 'latest', 'pull', 'diff', 'merge'];

async function rig() {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-mem-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-mem-state-'));
  const doc = '# Fleet memory\n- 〔id:timeout〕default timeout is 300 s\n';
  await fs.writeFile(path.join(profileDir, 'fleet-memory.md'), doc, 'utf8');
  const tools = new Map();
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return definition; } },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    inject(_names, callback) { callback(ctx); },
  };
  await plugin.apply(ctx, {
    autoStartAgent: false, rabbitUrl: 'http://127.0.0.1:1', stateDir, profileDir, operatorToken: 'op',
  });
  return { memory: tools.get('w2m_memory'), profileDir, stateDir, doc };
}

describe('concurrent publishing is retired in 1.9.2', () => {
  it('refuses fleet-memory sync by name and leaves the local document untouched', async () => {
    const { memory, profileDir, stateDir, doc } = await rig();
    assert.ok(memory, 'w2m_memory must be registered');
    for (const action of ACTIONS) {
      await assert.rejects(
        memory.execute({ action }, {}),
        (err) => err.code === 'MEMORY_SYNC_UNAVAILABLE',
        action + ' must be refused by name',
      );
    }
    assert.equal(await fs.readFile(path.join(profileDir, 'fleet-memory.md'), 'utf8'), doc);
    await fs.rm(profileDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });
});
