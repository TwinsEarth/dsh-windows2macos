/**
 * v1.7.7 regression guard: GPW activation must read only services it declares.
 *
 * Field failure (v1.7.5-beta.1):
 *   组件启用失败: dsh: warning: 1 entry did not activate dsh-gpw (@twinsearth/w2m-dsh-plugin/gpw):
 *   Error: cannot get property "tools" without inject
 *
 * Cordis resolves ctx.<name> against the fiber's inject list and throws for an undeclared read, so this test mounts
 * apply() behind a context whose property getter throws exactly like Cordis does.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { apply, inject, name } from '../src/plugin/gpw.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('GPW activation (v1.7.7)', () => {
  it('declares every service it reads', () => {
    assert.equal(name, 'dsh-gpw');
    for (const service of ['permissionPresets', 'tools']) {
      assert.ok(inject.includes(service), 'inject must name ' + service);
    }
  });

  it('mounts behind a strict Cordis-like context without throwing', () => {
    const declared = new Set(inject);
    const registry = [];
    const ctx = new Proxy(
      {
        effect: () => {},
        logger: { info: () => {}, warn: () => {} },
        on: (event, listener) => {
          registry.push({ event, listener });
          return () => {};
        },
        inject: (services, callback) => {
          for (const service of services) declared.add(service);
          callback({ connection: { fetch: { register: () => {} } } });
        },
        permissionPresets: { current: () => 'danger-full-access' },
        tools: { guard: () => () => {} },
        workingDirectory: { ensure: async () => null },
      },
      {
        get(target, property) {
          if (property === 'then') return undefined;
          if (typeof property === 'string' && !(property in target) && !declared.has(property)) {
            throw new Error('cannot get property "' + property + '" without inject');
          }
          return target[property];
        },
        has: () => true,
      },
    );
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.ok(registry.some((entry) => entry.event === 'tools/pre-execute'), 'the folder gate is installed');
  });

  it('keeps the folder gate in the source tree with the three branches', () => {
    const source = readFileSync(join(here, '..', 'src', 'plugin', 'gpw.mjs'), 'utf8');
    assert.match(source, /guard = ctx\.tools\?\.guard;/, 'the tools service is read through a defensive binding');
    assert.match(source, /planGate\(/, 'the three-class decision is shared');
    assert.match(source, /tools\/pre-execute/, 'the gate is a pre-execute listener');
  });
});
