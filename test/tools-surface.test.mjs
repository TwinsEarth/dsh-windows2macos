/**
 * Tool-surface snapshot (P1 refactor guard, S1).
 *
 * The P1 refactor splits `src/plugin/tools.mjs` (8.9k lines, one 4.2k-line `apply`) into per-domain
 * modules. That refactor is only safe if the **registered tool surface cannot drift**: name,
 * description, parameter schema and every other field the browser/model sees must stay byte-identical.
 *
 * This suite snapshots the whole `tools.register()` payload of `apply()` against a fake registry and
 * pins it by digest. It is deliberately a *contract* test, not a behaviour test: behaviour lives in
 * `test/tools.test.mjs`. When a slice of the refactor lands, this digest staying equal is the proof
 * that the move was mechanical.
 *
 * The digest covers the canonical JSON of every definition with object keys sorted, so it does not
 * depend on registration order or key order. The pin is updated only together with a reviewed,
 * intentional surface change (new tool, new parameter, changed description), never to "make CI green".
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Same isolation as the behaviour suite: these tests own their operator-token input.
process.env.W2M_OPERATOR_TOKEN_FILE = path.join(os.tmpdir(), 'w2m-tool-surface-test-no-token-' + process.pid);

import * as plugin from '../src/plugin/tools.mjs';

/** The 18 tools this release registers. Order is irrelevant; names are not. */
const EXPECTED_NAMES = [
  'w2m_approvals',
  'w2m_cancel',
  'w2m_chat',
  'w2m_council',
  'w2m_devices',
  'w2m_history',
  'w2m_intent',
  'w2m_joint_plan',
  'w2m_joint_status',
  'w2m_memory',
  'w2m_reduce',
  'w2m_report',
  'w2m_run',
  'w2m_stats',
  'w2m_status',
  'w2m_tasks',
  'w2m_update',
  'w2m_wait',
];

/**
 * Canonical JSON: object keys sorted at every depth, arrays in order. The digest must not change
 * because a definition literal was reordered by an editor or because registration order changed.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Register the plugin against a fake `ctx.tools` registry.
 *
 * @returns {Promise<{tools: Map<string, object>, warnings: string[]}>}
 */
async function registerTools() {
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string', 'register() needs a named definition');
        assert.ok(!tools.has(definition.name), `tool \`${definition.name}\` registered twice`);
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
    inject(_names, callback) {
      callback(ctx);
    },
  };
  await plugin.apply(ctx, { autoStartAgent: false });
  return { tools, warnings };
}

describe('tool surface snapshot (P1 refactor guard)', () => {
  it('registers exactly the expected tool names, once each', async () => {
    const { tools } = await registerTools();
    assert.deepEqual([...tools.keys()].sort(), EXPECTED_NAMES);
  });

  it('pins the canonical definition digest', async () => {
    const { tools } = await registerTools();
    const rows = [...tools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, definition]) => definition);
    const digest = crypto.createHash('sha256').update(canon(rows)).digest('hex');
    assert.equal(
      digest,
      '409a6652675fc66608525b4437f07e17f3a5898ab7b61297e6c0309654a82f5a',
      'the registered tool surface changed; if that is intentional, update the pin in the same reviewed change',
    );
  });

  it('gives every tool a name, a non-empty description and a parameter declaration', async () => {
    const { tools } = await registerTools();
    for (const [name, definition] of tools) {
      assert.equal(definition.name, name);
      assert.ok(typeof definition.description === 'string' && definition.description.trim() !== '', `${name}: description`);
      const schema = definition.parameters ?? definition.parametersJsonSchema;
      assert.ok(schema !== null && typeof schema === 'object', `${name}: parameter declaration`);
      // Two shapes exist in this plugin by design: a full JSON Schema (`{type:'object', properties:{...}}`)
      // and a flat property map (`{argName: {type, description}}`). Both are supported by the DSH shim, so the
      // snapshot accepts either but requires every declared property to be an object with a `type`.
      const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : schema;
      assert.ok(properties !== null && typeof properties === 'object', `${name}: parameter properties`);
      for (const [property, declaration] of Object.entries(properties)) {
        if (property === 'type' || property === 'properties' || property === 'required' || property === 'additionalProperties') continue;
        assert.ok(declaration !== null && typeof declaration === 'object', `${name}.${property}: declaration`);
        assert.ok(typeof declaration.type === 'string', `${name}.${property}: declaration.type`);
      }
    }
  });
});
