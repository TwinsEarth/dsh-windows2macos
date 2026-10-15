/**
 * Validate the Agent Plugins 1.0.0 manifests this package ships.
 *
 * ## Why the constraints are written out instead of fetched
 *
 * The canonical schemas live at `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and
 * `.../mcp.schema.json`, and they were read from there. **They are not fetched at check time on purpose**: a
 * validator that needs the network cannot run offline, and one that silently skips itself when a fetch fails
 * is worse than no validator, because it reports success for the case it could not measure. The constraints
 * below are the ones those documents state.
 *
 * ## What this cannot check
 *
 * The schema's own description says it plainly: *"The Agent Plugins specification defines additional semantic
 * and operational requirements."* Path containment, symlink resolution, MCP transport support and the
 * `PLUGIN_ROOT`/`PLUGIN_DATA` expansion rules are **not** expressible here. **They are unverified by this
 * script and are not claimed by it.**
 *
 * ## The one rule that is not from a schema
 *
 * `plugin.json`'s `version` must equal `package.json`'s. A manifest with no consumer has no way to notice it
 * is stale, so this is the only thing keeping the two in step -- and it caught its own author on the first
 * run, which is the evidence that it works.
 *
 * ## No side effects on import
 *
 * The rules are exported and the CLI lives in `main()`, so a test asserts them without spawning a child.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `plugin.json` section 5. `additionalProperties: false` is the schema's own, so this set is closed. */
export const PLUGIN_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
export const PLUGIN_REQUIRED = ['$schema', 'name'];
export const PLUGIN_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** From the schema's `name.pattern`: no `--`, no `..`, alphanumeric at both ends. */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);

/** `mcp.json` section 7.2. */
export const MCP_FIELDS = new Set(['$schema', 'mcpServers']);
export const MCP_REQUIRED = ['$schema', 'mcpServers'];
export const MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const SERVER_TYPES = new Set(['stdio', 'streamable-http', 'sse']);
export const SERVER_FIELDS = {
  stdio: new Set(['type', 'command', 'args', 'env', 'cwd']),
  'streamable-http': new Set(['type', 'url', 'headers']),
  sse: new Set(['type', 'url', 'headers']),
};
export const SERVER_REQUIRED = {
  stdio: ['type', 'command'],
  'streamable-http': ['type', 'url'],
  sse: ['type', 'url'],
};
/** Reserved by the specification: a plugin may not declare either as an `env` key. */
export const RESERVED_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);
/** `cwd` must be plugin-relative or rooted at one of the two reserved directories. */
export const MCP_CWD = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/** Read one JSON file, reporting a parse failure rather than throwing. */
const readJson = (root, name, problems) => {
  const path = join(root, name);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { problems.push(`${name}: not valid JSON -- ${error.message}`); return null; }
};

const checkClosed = (obj, allowed, label, problems) => {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) problems.push(`${label}: unknown field ${JSON.stringify(key)} -- the field set is closed`);
};

/**
 * Validate both manifests in `root`.
 *
 * @param {string} root directory holding `plugin.json`, `mcp.json` and `package.json`
 * @returns {{ok: string[], problems: string[]}}
 */
export function checkManifests(root) {
  const problems = [];
  const ok = [];

  // -------------------------------------------------------------- plugin.json
  const plugin = readJson(root, 'plugin.json', problems);
  if (plugin === undefined) {
    ok.push('plugin.json absent -- nothing to validate');
  } else if (plugin !== null) {
    if (typeof plugin !== 'object' || Array.isArray(plugin)) problems.push('plugin.json: must be a JSON object');
    else {
      for (const field of PLUGIN_REQUIRED) if (!(field in plugin)) problems.push(`plugin.json: required field ${JSON.stringify(field)} is missing`);
      checkClosed(plugin, PLUGIN_FIELDS, 'plugin.json', problems);
      if (plugin.$schema !== PLUGIN_SCHEMA_ID) problems.push(`plugin.json: $schema must be exactly ${PLUGIN_SCHEMA_ID}`);
      if (typeof plugin.name === 'string') {
        if (plugin.name.length < 1 || plugin.name.length > 64) problems.push(`plugin.json: name must be 1-64 characters, got ${plugin.name.length}`);
        if (!PLUGIN_NAME.test(plugin.name)) problems.push(`plugin.json: name ${JSON.stringify(plugin.name)} fails the schema pattern (no "--" or "..", alphanumeric ends)`);
      }
      if ('author' in plugin) {
        if (typeof plugin.author !== 'object' || plugin.author === null || Array.isArray(plugin.author)) problems.push('plugin.json: author must be an object');
        else for (const key of Object.keys(plugin.author)) if (!AUTHOR_FIELDS.has(key)) problems.push(`plugin.json: author.${key} is not a documented field`);
      }
      if ('keywords' in plugin && (!Array.isArray(plugin.keywords) || plugin.keywords.some((k) => typeof k !== 'string'))) {
        problems.push('plugin.json: keywords must be an array of strings');
      }
      if ('extensions' in plugin && (typeof plugin.extensions !== 'object' || plugin.extensions === null || Array.isArray(plugin.extensions))) {
        problems.push('plugin.json: extensions must be an object keyed by reverse-domain namespace');
      }
      // Not a schema rule: the manifests must not drift apart.
      const pkg = readJson(root, 'package.json', problems);
      if (pkg !== null && pkg !== undefined && typeof pkg.version === 'string' && typeof plugin.version === 'string' && plugin.version !== pkg.version) {
        problems.push(`plugin.json: version ${plugin.version} does not match package.json ${pkg.version}`);
      }
      ok.push(`plugin.json: schema 1.0.0, name ${plugin.name}, version ${plugin.version}`);
    }
  }

  // ----------------------------------------------------------------- mcp.json
  const mcp = readJson(root, 'mcp.json', problems);
  if (mcp === undefined) {
    ok.push('mcp.json absent -- no MCP servers are declared');
  } else if (mcp !== null) {
    if (typeof mcp !== 'object' || Array.isArray(mcp)) problems.push('mcp.json: must be a JSON object');
    else {
      for (const field of MCP_REQUIRED) if (!(field in mcp)) problems.push(`mcp.json: required field ${JSON.stringify(field)} is missing`);
      checkClosed(mcp, MCP_FIELDS, 'mcp.json', problems);
      if (mcp.$schema !== MCP_SCHEMA_ID) problems.push(`mcp.json: $schema must be exactly ${MCP_SCHEMA_ID}`);

      const servers = mcp.mcpServers;
      if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) problems.push('mcp.json: mcpServers must be an object');
      else {
        for (const [name, server] of Object.entries(servers)) {
          const label = `mcp.json: mcpServers.${name}`;
          if (typeof server !== 'object' || server === null || Array.isArray(server)) { problems.push(`${label}: must be an object`); continue; }
          const type = server.type;
          if (!SERVER_TYPES.has(type)) { problems.push(`${label}: type must be one of ${[...SERVER_TYPES].join(', ')}`); continue; }
          for (const field of SERVER_REQUIRED[type]) if (!(field in server)) problems.push(`${label}: required field ${JSON.stringify(field)} is missing`);
          checkClosed(server, SERVER_FIELDS[type], label, problems);
          if (type === 'stdio') {
            if (typeof server.command !== 'string' || server.command.length < 1) problems.push(`${label}: command must be a non-empty string`);
            if ('args' in server && (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string'))) problems.push(`${label}: args must be an array of strings`);
            if ('env' in server) {
              if (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env)) problems.push(`${label}: env must be an object`);
              else for (const key of Object.keys(server.env)) {
                if (RESERVED_ENV.has(key)) problems.push(`${label}: env may not declare the reserved name ${key}`);
                if (typeof server.env[key] !== 'string') problems.push(`${label}: env.${key} must be a string`);
              }
            }
            if ('cwd' in server && !MCP_CWD.test(String(server.cwd))) problems.push(`${label}: cwd must start with "./", "\${PLUGIN_ROOT}" or "\${PLUGIN_DATA}"`);
          } else {
            if (typeof server.url !== 'string' || server.url.length < 1) problems.push(`${label}: url must be a non-empty string`);
            if ('headers' in server && (typeof server.headers !== 'object' || server.headers === null || Array.isArray(server.headers))) problems.push(`${label}: headers must be an object`);
          }
        }
        ok.push(`mcp.json: schema 1.0.0, ${Object.keys(servers).length} server(s)`);
      }
    }
  }

  return { ok, problems };
}

function main(argv) {
  const root = argv[2] ?? '.';
  const { ok, problems } = checkManifests(root);
  console.log('  Agent Plugins 1.0.0 manifests');
  for (const line of ok) console.log(`    ok    ${line}`);
  for (const line of problems) console.log(`    FAIL  ${line}`);
  console.log(`  problems: ${problems.length}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
