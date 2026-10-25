/**
 * v1.7.7/v1.7.8 regression guard: GPW activation must read only services it declares, and the blacklist guard must be
 * registered on an agent's own context instead of the root one.
 *
 * Field failures:
 *   v1.7.7: cannot get property "tools" without inject   (ctx.tools read at activation while inject named only permissionPresets)
 *   v1.7.8: TypeError: Cannot read properties of undefined (reading 'layers')
 *           (ctx.tools.guard at activation, where the tools service has no agent layer table yet)
 *
 * The supported shape for per-agent behavior is `agent.ctx` obtained from an `agent/created` listener; this test mounts
 * apply() behind a strict Cordis-like context that throws on undeclared reads AND on the root `tools` read, then emits
 * agent/created with a fake agent and asserts the guard was installed there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { apply, inject, name } from '../src/plugin/gpw.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function strictContext() {
  const declared = new Set(inject);
  const listeners = new Map();
  const target = {
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: (services, callback) => {
      for (const service of services) declared.add(service);
      callback({ connection: { fetch: { register: () => {} } } });
    },
    permissionPresets: { current: () => 'danger-full-access' },
    workingDirectory: null,
  };
  const ctx = new Proxy(target, {
    get(object, property) {
      if (property === 'then') return undefined;
      if (typeof property === 'string' && !(property in object) && !declared.has(property)) {
        throw new Error('cannot get property "' + property + '" without inject');
      }
      return object[property];
    },
  });
  return { ctx, listeners };
}

describe('GPW activation (v1.7.8)', () => {
  it('declares permissionPresets and does not require the root tools service', () => {
    assert.equal(name, 'dsh-gpw');
    assert.ok(inject.includes('permissionPresets'));
    assert.equal(inject.includes('tools'), false, 'the root tools service is not read any more');
  });

  it('mounts behind a strict context and installs the pre-execute gate without touching root tools', () => {
    const { ctx, listeners } = strictContext();
    assert.doesNotThrow(() => apply(ctx, {}), 'activation must not read undeclared/root services');
    assert.equal(typeof listeners.get('tools/pre-execute'), 'function', 'the folder gate is installed');
    assert.equal(typeof listeners.get('agent/created'), 'function', 'guards are registered per agent');
  });

  it('registers the blacklist guard on the agent context from agent/created', () => {
    const { ctx, listeners } = strictContext();
    apply(ctx, {});
    const guarded = [];
    const agent = {
      session: {},
      ctx: {
        tools: {
          guard: (guard) => {
            guarded.push(guard);
            return () => {};
          },
        },
      },
    };
    listeners.get('agent/created')({ agent });
    assert.equal(guarded.length, 1, 'one guard per agent');
    assert.equal(guarded[0]({ name: 'read', parameters: { path: '/repo/a.txt' } }), undefined, 'paths outside the blacklist pass the guard');
  });

  it('keeps the per-agent registration in the source and drops the root one', () => {
    const source = readFileSync(join(here, '..', 'src', 'plugin', 'gpw.mjs'), 'utf8');
    assert.match(source, /ctx\.on\('agent\/created'/);
    assert.equal(/ctx\.tools\?\.guard\s*\(/.test(source), false, 'no root-scope guard registration');
    assert.match(source, /tools\/pre-execute/, 'the gate is a pre-execute listener');
  });
});
