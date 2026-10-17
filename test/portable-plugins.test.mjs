/**
 * The platform manifests are part of the product, so they are measured rather than assumed.
 *
 * ## What this prevents
 *
 * Every manifest here is a claim about a file that exists somewhere else: a server path, a version, a package name.
 * Each of those can be **silently wrong in a way that only breaks at the client** -- the plugin installs, the client
 * starts, and the server is not found, or a stale version is pinned. A manifest is cheap to add and cheap to get
 * wrong, so the cross-references are asserted here.
 *
 * ## The specific trap this suite was written for
 *
 * The top-level `mcp.json` uses the agent-plugins schema's `${PLUGIN_ROOT}`. **Claude Code does not substitute that
 * variable** -- it substitutes `${CLAUDE_PLUGIN_ROOT}`. A manifest that reused the top-level file verbatim would ship
 * a literal `${PLUGIN_ROOT}` string as the server command's first argument, and the failure would read as a missing
 * server rather than as a wrong variable name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const PACKAGE = readJson('package.json');

describe('the Claude Code plugin manifest', () => {
  const plugin = readJson('.claude-plugin/plugin.json');

  it('declares a name and a version that agree with the package', () => {
    assert.equal(typeof plugin.name, 'string');
    assert.ok(plugin.name.length > 0);
    assert.equal(plugin.version, PACKAGE.version, 'the plugin manifest and package.json must not drift');
  });

  it('points its MCP server at a file that exists, through the variable Claude Code substitutes', () => {
    const server = plugin.mcpServers?.['w2m-fleet'];
    assert.ok(server, 'no w2m-fleet server is declared');
    assert.equal(server.command, 'node');
    const arg = server.args?.[0];
    assert.ok(typeof arg === 'string', 'the server has no argument to run');
    assert.match(arg, /^\$\{CLAUDE_PLUGIN_ROOT\}\//, `the argument must resolve inside the plugin, got ${arg}`);
    assert.doesNotMatch(arg, /\$\{PLUGIN_ROOT\}/, '$' + '{PLUGIN_ROOT} is the agent-plugins variable, not Claude Code\u2019s');
    const rel = arg.replace('$' + '{CLAUDE_PLUGIN_ROOT}/', '');
    assert.ok(existsSync(join(ROOT, rel)), `the manifest points at ${rel}, which is not in the package`);
  });

  it('keeps the server read-only: no execution tool may appear in the manifest', () => {
    // The manifest does not list tools, so this asserts the thing it *could* get wrong: a server entry for a
    // runner. `w2m_run` is not a tool of the MCP server, and the README says so.
    const manifestText = JSON.stringify(plugin);
    assert.doesNotMatch(manifestText, /w2m_run/);
  });
});

describe('the Claude Code marketplace manifest', () => {
  const market = readJson('.claude-plugin/marketplace.json');

  it('lists this repository as the plugin source, at the same version', () => {
    assert.equal(market.name, 'twinsearth-w2m');
    assert.equal(market.owner?.name, 'TwinsEarth');
    const plugin = market.plugins?.find((p) => p.name === 'w2m-fleet');
    assert.ok(plugin, `plugins listed: ${JSON.stringify(market.plugins?.map((p) => p.name))}`);
    assert.equal(plugin.source, './', 'the plugin lives at the repository root, so ./ is the source');
    assert.equal(plugin.version, PACKAGE.version);
  });
});

describe('the Codex configuration snippet', () => {
  const toml = readFileSync(join(ROOT, 'codex/mcp-servers.toml'), 'utf8');

  it('is a snippet for a file this project does not own, and says so', () => {
    assert.match(toml, /snippet, not a config/);
    assert.match(toml, /~\/\.codex\/config\.toml/);
  });

  it('runs the published package\u2019s MCP bin, pinned to this version', () => {
    assert.match(toml, /^\[mcp_servers\.w2m-fleet\]$/m, 'no [mcp_servers.w2m-fleet] table');
    assert.match(toml, /command = "npx"/);
    assert.ok(
      toml.includes(`@twinsearth/w2m-dsh-plugin@${PACKAGE.version}`),
      'the snippet must pin the version being released, or it is a proxy for whatever is latest',
    );
    assert.match(toml, /"w2m-mcp"\]/, 'the snippet must name the bin that package.json declares');
  });
});

describe('the package actually carries what the manifests reference', () => {
  it('declares the MCP server as a bin, pointing at a real file', () => {
    assert.equal(PACKAGE.bin['w2m-mcp'], 'bin/w2m-mcp.mjs');
    assert.ok(existsSync(join(ROOT, 'bin/w2m-mcp.mjs')));
  });

  it('ships the platform manifests in the tarball', () => {
    for (const entry of ['.claude-plugin', 'codex']) {
      assert.ok(PACKAGE.files.includes(entry), `${entry} is not in package.json#files, so it is not published`);
    }
    // docs/ is already shipped whole; the platform document must be in it.
    assert.ok(existsSync(join(ROOT, 'docs/PLATFORMS.md')));
  });

  it('keeps the existing agent-plugins manifest valid, and separate', () => {
    const mcp = readJson('mcp.json');
    assert.ok(mcp.mcpServers?.['w2m-fleet'], 'the top-level mcp.json lost its stdio server');
    assert.equal(mcp.mcpServers['w2m-fleet'].type, 'stdio');
    // Two manifests, two schemas: the top-level one is not the Claude Code one.
    assert.ok(existsSync(join(ROOT, '.claude-plugin/plugin.json')));
  });
});

describe('the platform document covers every platform it claims to', () => {
  const doc = readFileSync(join(ROOT, 'docs/PLATFORMS.md'), 'utf8');

  it('names each platform and where the submission really stands', () => {
    for (const platform of ['Claude Code', 'Codex', 'openai/plugins', 'anthropics/']) {
      assert.ok(doc.includes(platform), `PLATFORMS.md never mentions ${platform}`);
    }
    // The honesty check: a submission that has not happened must not read as done.
    assert.match(doc, /prepared, not submitted/i);
    assert.match(doc, /not done/i);
  });
});
