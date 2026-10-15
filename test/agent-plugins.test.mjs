/**
 * The Agent Skills and Agent Plugins manifests (v0.51.0, v0.52.0).
 *
 * ## Why these are asserted at all
 *
 * A skill that violates its loader's contract is **not an error**: the loader logs a warning and returns, so
 * the skill never appears while the directory still looks shipped. A manifest that violates its schema is
 * worse, because **nothing in this host reads `plugin.json` at all** — DSH loads plugins through
 * `package.json#dsh` and a Cordis bundle patch. **A file nobody reads is a file that cannot be wrong**, which
 * is exactly why the rules need a test rather than a reader.
 *
 * ## Why the validators are imported instead of executed
 *
 * Both scripts take a root argument and both are runnable from a shell, so the tempting test is to spawn them.
 * That test would fail wherever piped child stdio is refused — and then the check would be skipped in exactly
 * the environments that need it. **The rules are exported as pure functions for that reason**, and the CLI is
 * a thin wrapper covered by the pre-flight instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkSkills, frontmatter, SKILL_NAME, AGENT_SKILLS_NAME, NAME_MAX, DESCRIPTION_MAX, REJECTED, KNOWN, PORTABLE } from '../scripts/skill-check.mjs';
import {
  checkManifests,
  PLUGIN_NAME,
  PLUGIN_SCHEMA_ID,
  MCP_SCHEMA_ID,
  PLUGIN_FIELDS,
  PLUGIN_REQUIRED,
  SERVER_TYPES,
  SERVER_FIELDS,
  SERVER_REQUIRED,
  RESERVED_ENV,
  MCP_CWD,
} from '../scripts/plugin-manifest-check.mjs';

const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the four shipped skills satisfy both hosts', () => {
  const { names, problems } = checkSkills(SKILLS_DIR);

  it('finds every skill and reports no problem', () => {
    assert.deepEqual(names, ['fleet-control', 'memory-sync', 'resource-schedule', 'session-ref']);
    assert.deepEqual(problems, []);
  });

  it('keeps every name and description inside the limits only one host declares', () => {
    // DSH's loader has no length limits at all. These are Agent Skills' rules, so a skill can pass the loader
    // and still be non-portable -- which is the failure this assertion exists to prevent.
    for (const name of names) {
      const text = readFileSync(`${SKILLS_DIR}/${name}/SKILL.md`, 'utf8');
      const { data } = frontmatter(text);
      assert.ok(data.name.length <= NAME_MAX, `${name}: name ${data.name.length}`);
      assert.ok(data.description.length <= DESCRIPTION_MAX, `${name}: description ${data.description.length}`);
    }
  });
});

describe('the skill validator accepts what the loaders accept, and refuses what they refuse', () => {
  it('agrees with DSH on the name pattern', () => {
    for (const good of ['fleet-control', 'a', 'a1-b2']) assert.equal(SKILL_NAME.test(good), true, good);
    // A double hyphen is refused by the loader's segment pattern and by the Agent Skills pattern alike.
    for (const bad of ['Fleet', 'fleet_control', 'fleet--control', '-fleet', 'fleet-', '']) {
      assert.equal(SKILL_NAME.test(bad), false, `SKILL_NAME accepted ${bad}`);
    }
  });

  it('applies the Agent Skills name pattern, which is looser about hyphens than the loader', () => {
    // The two patterns are NOT the same rule. Agent Skills forbids a leading or trailing hyphen and allows
    // interior runs; the loader forbids an empty segment. A name must satisfy both, so the difference matters
    // only for the names each one refuses -- and `fleet--control` is the case that separates them.
    for (const good of ['fleet-control', 'a', 'a1-b2']) assert.equal(AGENT_SKILLS_NAME.test(good), true, good);
    for (const bad of ['Fleet', 'fleet_control', '-fleet', 'fleet-', '']) {
      assert.equal(AGENT_SKILLS_NAME.test(bad), false, `AGENT_SKILLS_NAME accepted ${bad}`);
    }
    assert.equal(AGENT_SKILLS_NAME.test('fleet--control'), true, 'the portable pattern permits it');
    assert.equal(SKILL_NAME.test('fleet--control'), false, 'the loader does not -- which is why both are checked');
  });

  it('mirrors the three renamed invocation spellings the loader rejects outright', () => {
    // `rejectLegacyInvocationKey` throws on these, so a skill using one is dropped rather than downgraded.
    assert.deepEqual([...REJECTED].sort(), ['disableModelInvocation', 'modelInvocable', 'userInvocable']);
    for (const key of REJECTED) assert.equal(KNOWN.has(key), false, `${key} must not also be accepted`);
  });

  it('accepts the fields either host defines, and no others', () => {
    for (const key of ['name', 'description']) assert.ok(KNOWN.has(key) && PORTABLE.has(key), key);
    // Loader-only fields.
    assert.ok(KNOWN.has('whenToUse') && KNOWN.has('disable-model-invocation'));
    // Specification-only fields.
    assert.ok(PORTABLE.has('license') && PORTABLE.has('compatibility') && PORTABLE.has('allowed-tools'));
    // A field in neither is what the validator reports.
    assert.equal(KNOWN.has('bogus') || PORTABLE.has('bogus'), false);
  });

  it('reads frontmatter, and reports the shapes it cannot read', () => {
    assert.deepEqual(frontmatter('---\nname: a\n---\nbody').data, { name: 'a' });
    // Both unreadable shapes return null: no opening delimiter, and a block that is never closed. The loader
    // treats both as "no frontmatter" and ignores the file, so the validator must not read them as empty data.
    assert.equal(frontmatter('no frontmatter'), null, 'a file without --- is ignored by the loader');
    assert.equal(frontmatter('---\nname: a\n'), null, 'an unclosed block is not frontmatter');
    // A folded continuation belongs to the previous key, which is how the long descriptions are written.
    const folded = frontmatter('---\nname: a\ndescription: one\n  two\n---\nbody');
    assert.equal(folded.data.description, 'one two');
    // A line that is neither a key nor a continuation is reported rather than guessed at.
    assert.equal(frontmatter('---\nname: a\n!! broken\n---\nbody').invalid, true);
  });
});

describe('the Agent Plugins manifests', () => {
  const { ok, problems } = checkManifests(ROOT);

  it('satisfy their schemas and agree with package.json', () => {
    assert.deepEqual(problems, []);
    assert.equal(ok.length, 2, ok.join(' | '));
  });

  it('binds the same schema identifiers the specification publishes', () => {
    assert.equal(PLUGIN_SCHEMA_ID, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(MCP_SCHEMA_ID, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  });

  it('keeps the plugin field set closed, as additionalProperties: false requires', () => {
    assert.equal(PLUGIN_FIELDS.has('bogus'), false);
    assert.deepEqual([...PLUGIN_REQUIRED], ['$schema', 'name']);
  });

  it('refuses the names the schema pattern refuses', () => {
    // Measured from the schema: `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`
    for (const good of ['twinsearth-w2m-dsh', 'a', 'a.b', 'w2m']) assert.equal(PLUGIN_NAME.test(good), true, good);
    for (const bad of ['a--b', 'a..b', '-a', 'a-', 'A', 'a_b', '']) {
      assert.equal(PLUGIN_NAME.test(bad), false, `PLUGIN_NAME accepted ${bad}`);
    }
  });

  it('knows the closed transport set and each variant\'s required fields', () => {
    assert.deepEqual([...SERVER_TYPES].sort(), ['sse', 'stdio', 'streamable-http']);
    assert.deepEqual(SERVER_REQUIRED.stdio, ['type', 'command']);
    assert.deepEqual(SERVER_REQUIRED['streamable-http'], ['type', 'url']);
    // `cwd` is a stdio-only field; the remote variants accept url and headers.
    assert.equal(SERVER_FIELDS.stdio.has('cwd'), true);
    assert.equal(SERVER_FIELDS['streamable-http'].has('cwd'), false);
  });

  it('reserves the two environment names a plugin may not declare', () => {
    assert.deepEqual([...RESERVED_ENV].sort(), ['PLUGIN_DATA', 'PLUGIN_ROOT']);
  });

  it('requires cwd to be plugin-relative or rooted at a reserved directory', () => {
    // Written with concatenation rather than a template literal: `${PLUGIN_ROOT}` inside a template string is
    // the very mistake `no-template-curly-in-string` exists to catch, and here the braces are literal.
    const rootRef = '${' + 'PLUGIN_ROOT}';
    const dataRef = '${' + 'PLUGIN_DATA}';
    for (const good of ['./sub', rootRef, `${rootRef}/x`, `${dataRef}/y`]) assert.equal(MCP_CWD.test(good), true, good);
    for (const bad of ['/abs', '../out', 'sub', '${' + 'PLUGIN_ROOTX}/x']) assert.equal(MCP_CWD.test(bad), false, `MCP_CWD accepted ${bad}`);
  });

  it('detects a version that has drifted from package.json', () => {
    // The one rule that is not from a schema, and the one that fired on its own author: the manifest was
    // written as 0.52.0 while package.json still said 0.51.0, and nothing else would ever have noticed.
    const { problems: drifted } = checkManifests(fileURLToPath(new URL('./fixtures/manifest-drift', import.meta.url)));
    assert.ok(drifted.some((p) => /does not match package\.json/.test(p)), drifted.join(' | '));
  });
});
