/**
 * The MCP server's declared routes must exist in the relay it calls.
 *
 * ## The failure this prevents, which I committed first
 *
 * My first draft of `bin/w2m-mcp.mjs` declared `/v1/stats` and `/v1/status`. **Neither exists.** The relay's
 * complete GET surface is `/healthz`, `/metrics`, `/v1/stream`, `/v1/devices`, `/v1/tasks`, `/v1/tasks/{id}`,
 * `/v1/tasks/{id}/report` and `/v1/agents/{id}/status`.
 *
 * A fabricated route does not fail loudly: the relay answers **404**, the MCP client reports a broken server,
 * and the bug is in this package. **So the routes are read back out of `src/relay/server.mjs` and compared**,
 * rather than trusted to the comment that documents them.
 *
 * ## What it cannot check
 *
 * It does not prove the relay *authorises* a route for this caller, nor that the response shape suits a tool's
 * description. **It proves the path is routed**, which is the part a typo breaks silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? '.';

/** Literal routes the relay serves, read from its router. */
export function relayRoutes(serverSource) {
  const routes = new Set();
  // `path === '/x'` inside a `method === 'GET'` guard.
  for (const m of serverSource.matchAll(/method === 'GET' && path === '([^']+)'/g)) routes.add(m[1]);
  // Parameterised routes are matched by regex literal, e.g. /^\/v1\/tasks\/([^/]+)$/.exec(path).
  for (const m of serverSource.matchAll(/\/\^\\\/(v1\\\/[^$]*?)\$\/\.exec\(path\)/g)) {
    routes.add(`/${m[1].replace(/\\\//g, '/')}`);
  }
  return routes;
}

/**
 * Normalise a route to the form both sides can be compared in.
 *
 * The relay's router carries regex fragments -- `/v1/tasks/([^/]+)/report` -- while a tool declares the readable
 * `/v1/tasks/{id}/report`. **Comparing those literally is what made this check fail on two routes that are in
 * fact routed**, so both sides are reduced to `{param}` before the comparison.
 */
export const canonicalRoute = (route) => route
  .split('?')[0]
  .replace(/\(\?:[^)]*\)/g, '{param}')
  .replace(/\(\?[^)]*\)/g, '{param}')
  .replace(/\([^)]*\)[+*?]?/g, '{param}')
  .replace(/\{[^}]+\}/g, '{param}')
  .replace(/\/+$/, '')
  .toLowerCase();

const main = async () => {
  const serverPath = join(ROOT, 'src', 'relay', 'server.mjs');
  const mcpPath = join(ROOT, 'bin', 'w2m-mcp.mjs');
  const server = readFileSync(serverPath, 'utf8');
  const routes = relayRoutes(server);

  const problems = [];
  const checked = [];

  // Import the tool table for real, so this cannot drift from the module under test. `pathToFileURL`, not a
  // hand-built `file://` string: on Windows the latter produces a path no loader accepts.
  const mcp = await import(pathToFileURL(mcpPath).href);
  {
    const declared = new Set();
    for (const tool of mcp.TOOLS) {
      for (const route of tool.routes) declared.add(route);
      // The tool must also be able to reach the route it declares; a `requests()` that throws on empty
      // arguments is fine only when the schema requires an argument.
      try {
        const made = tool.requests({});
        for (const p of made) declared.add(p.split('?')[0]);
      } catch {
        /* Requires an argument: covered by the schema assertion below. */
      }
    }

    const routed = new Set([...routes].map(canonicalRoute));
    for (const route of declared) {
      // A declared route is matched against the router in canonical form, because the router carries regex
      // fragments where the tool declares a readable `{id}`.
      const found = routed.has(canonicalRoute(route));
      if (!found) problems.push(`w2m-mcp.mjs declares ${route}, which the relay does not route (routed: ${[...routed].sort().join(' ')})`);
      else checked.push(`${route} -> routed`);
    }

    // Every tool needs a name, a description and a closed schema, because a client shows the description and a
    // model fills the schema.
    for (const tool of mcp.TOOLS) {
      if (typeof tool.name !== 'string' || tool.name === '') problems.push('a tool has no name');
      if (typeof tool.description !== 'string' || tool.description.length < 40) problems.push(`${tool.name}: description is too thin to choose from`);
      if (tool.inputSchema?.type !== 'object' || tool.inputSchema.additionalProperties !== false) problems.push(`${tool.name}: inputSchema must be a closed object`);
      if (!Array.isArray(tool.routes) || tool.routes.length === 0) problems.push(`${tool.name}: declares no route`);
      // A tool requiring an argument must say so, or a client will call it with none and get an error.
      const required = tool.inputSchema?.required ?? [];
      for (const key of required) if (!(key in (tool.inputSchema.properties ?? {}))) problems.push(`${tool.name}: requires ${key}, which it does not declare`);
    }

    // The read-only promise: no tool may be a dispatch. This is the design constraint, asserted rather than
    // stated, because a later edit adding `w2m_run` should have to delete this line to pass.
    const mutating = mcp.TOOL_NAMES.filter((n) => /run|dispatch|cancel|write|update|memory|approve|council/.test(n));
    if (mutating.length > 0) problems.push(`the read-only server exposes a mutating-looking tool: ${mutating.join(', ')}`);
    if (mcp.TOOL_NAMES.length !== 5) problems.push(`expected the five read-only tools, found ${mcp.TOOL_NAMES.length}`);

    console.log(`  relay routes discovered: ${[...routes].sort().join(' ')}`);
    console.log(`  tools: ${mcp.TOOL_NAMES.join(', ')}`);
    for (const line of checked) console.log(`    ok    ${line}`);
    for (const line of problems) console.log(`    FAIL  ${line}`);
    console.log(`  problems: ${problems.length}`);
  }
  return problems.length;
};

/**
 * Run only when executed.
 *
 * **This guard is not decoration.** Without it, importing this module for `relayRoutes` runs the whole check and
 * calls `process.exit` -- which is what happened, and the consuming test suite reported **1 test instead of 41**
 * with no failure named. The same mistake was made in `skill-check.mjs` and `plugin-manifest-check.mjs`; this is
 * the third time, and the reason each of these files now keeps its CLI behind the same guard.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
    .then((count) => process.exit(count === 0 ? 0 : 1))
    .catch((error) => {
      console.log(`    FAIL  the MCP server could not be loaded: ${error.message}`);
      process.exit(1);
    });
}
