/**
 * UI card contract for the eight W2M tools (v0.3.3).
 *
 * This file exists because "UI cards" was an open item for several rounds and the answer turned out to
 * be: **there is nothing to add.** The runtime treats `presentCall`'s return value as an opaque hint
 * and never validates it -- `defineTool` merely wraps it so a schema-invalid argument list yields
 * `undefined` (`dsh-tools/lib/index.js:874-877` in the shipped runtime). There is no registry of card
 * types to choose from, and no consumer in the shipped bundle that reads `card` at all.
 *
 * What the shipped runtime *does* contain is two reference implementations, and they are the only
 * evidence available for what the fields mean:
 *
 *   `dsh-tools/lib/index.js:1445`          run_code        { card: "generic", title: args.description,
 *                                                             kind: "execute", rawInput: args.code }
 *   `dsh-plugin-manager/lib/types/tools.js:85`  the plugin manager
 *                                          { card: 'generic', title: '…',
 *                                            kind: args.action.startsWith('list_') ? 'read' : 'other',
 *                                            rawInput: args }
 *
 * Both use `card: 'generic'`. The plugin manager varies `kind` by whether the action mutates. That is
 * the whole vocabulary with a reference behind it, so the tests below assert exactly that much and no
 * more -- inventing a richer card would be guessing at an interface nobody has documented.
 *
 * The one real defect this file was written to catch: `w2m_update` reported `kind: 'read'` while being
 * able to install a new version into the very profile it runs in. A false "read" is worse than no hint,
 * because the hint is what a user reads to decide whether a call is safe.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as plugin from '../src/plugin/tools.mjs';

const cleanup = [];

after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway profile directory. */
function makeProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w2m-card-'));
  cleanup.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test' }), 'utf8');
  return dir;
}

/** Register the plugin and hand back the tool map. */
async function register(config = {}) {
  const tools = new Map();
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect: () => {},
    on: () => {},
  };
  await plugin.apply(ctx, { rabbitUrl: 'http://127.0.0.1:1', ...config });
  return tools;
}

describe('tool cards: the contract the shipped runtime actually implements', () => {
  it('gives every tool a presentCall that yields a generic card with a title', async () => {
    const tools = await register({ stateDir: makeProfile() });
    assert.equal(tools.size, 8, 'the eight tools are the surface this contract covers');
    for (const [name, tool] of tools) {
      assert.equal(typeof tool.presentCall, 'function', `${name} needs a presentCall`);
      const card = tool.presentCall({});
      assert.ok(card && typeof card === 'object', `${name}.presentCall must return an object`);
      // `generic` is the only card value with a reference implementation in the shipped runtime.
      assert.equal(card.card, 'generic', `${name} must use the only documented card value`);
      assert.equal(typeof card.title, 'string', `${name} needs a title`);
      assert.ok(card.title.length > 0, `${name}'s title must not be empty`);
      assert.ok('rawInput' in card, `${name} must supply rawInput`);
      assert.equal(typeof card.kind, 'string', `${name} needs a kind`);
    }
  });

  it('marks a check-and-install cycle as mutating, not as a read', async () => {
    // The defect this file exists for. `check` installs a newer release when one exists, so reporting
    // it as a read is a false claim about safety in the one place a user reads to judge that.
    const tools = await register({ stateDir: makeProfile() });
    const update = tools.get('w2m_update');

    assert.equal(update.presentCall({ action: 'check' }).kind, 'other',
      'a cycle that can install must not be labelled read');
    // `status` only reports; `'read'` is accurate for it and is the value the reference implementation
    // uses for its non-mutating actions.
    assert.equal(update.presentCall({ action: 'status' }).kind, 'read');
    // With no action the tool defaults to `status`, so the no-argument call must agree with `status`.
    assert.equal(update.presentCall({}).kind, 'read', 'the default action is status');
    assert.equal(update.presentCall(undefined).kind, 'read', 'a missing args object is the default action');
  });

  it('keeps a write-capable run distinguishable from a read-only one', async () => {
    const tools = await register({ stateDir: makeProfile() });
    const run = tools.get('w2m_run');
    const reading = run.presentCall({ command_argv: ['node', '--test'] });
    const writing = run.presentCall({ command_argv: ['node', '--test'], write: true });
    assert.notEqual(reading.kind, writing.kind, 'a writing run must not look like a read-only one');
    assert.equal(writing.kind, 'write');
    assert.equal(reading.kind, 'read');
  });

  it('never puts a credential in rawInput', async () => {
    // rawInput is handed to the UI, so anything in it is rendered. Tokens belong to the host config and
    // must not travel into a card, however the argument list is shaped.
    const tools = await register({
      stateDir: makeProfile(),
      operatorToken: 'LEAK-CANARY-OPERATOR',
      signingSecret: 'LEAK-CANARY-SIGNING',
    });
    for (const [name, tool] of tools) {
      const rendered = JSON.stringify(tool.presentCall({ action: 'check', command_argv: ['node'] }) ?? {});
      assert.equal(rendered.includes('LEAK-CANARY-OPERATOR'), false, `${name} leaked the operator token`);
      assert.equal(rendered.includes('LEAK-CANARY-SIGNING'), false, `${name} leaked the signing secret`);
    }
  });

  it('survives being called with no arguments, like the runtime does on an invalid call', async () => {
    // `defineTool` returns `undefined` from `presentCall` when the arguments fail schema validation
    // (`dsh-tools/lib/index.js:875`), so the UI must already cope with a missing card -- but our own
    // function is still called with whatever the caller passed, including nothing.
    const tools = await register({ stateDir: makeProfile() });
    for (const [name, tool] of tools) {
      assert.doesNotThrow(() => tool.presentCall(undefined), `${name}.presentCall(undefined)`);
      assert.doesNotThrow(() => tool.presentCall({}), `${name}.presentCall({})`);
    }
  });
});
