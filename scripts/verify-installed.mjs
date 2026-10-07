/**
 * Verify the *installed* plugin loads and registers its tools.
 *
 * "It installed" is not "it loads": the earlier DSH plugin in this workspace
 * shipped with peer-only dependencies and failed at import time, after a
 * successful install. So this probe imports the copy that pnpm actually placed
 * in the profile, calls `apply()` against a stub tools registry, and asserts the
 * registered tool count -- the same check the docs tell users to run.
 *
 * Usage: node verify-installed.mjs <profile-node_modules-path>
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: node verify-installed.mjs <node_modules/@twinsearth/w2m-dsh-plugin>\n');
  process.exit(2);
}

const entry = join(root, 'lib', 'tools.js');
if (!existsSync(entry)) {
  process.stderr.write(`missing entry: ${entry}\n`);
  process.exit(2);
}

const mod = await import(pathToFileURL(entry).href);

process.stdout.write(`inject        : ${JSON.stringify(mod.inject)}\n`);
process.stdout.write(`apply         : ${typeof mod.apply}\n`);

const registered = [];
const warnings = [];
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  logger: {
    info: (m) => warnings.push(`info: ${m}`),
    warn: (m) => warnings.push(`warn: ${m}`),
    error: (m) => warnings.push(`error: ${m}`),
  },
  // The plugin only needs `tools` for registration; services it resolves lazily
  // (connection, agents) are absent here on purpose, which is also the case in a
  // minimal profile.
  get: () => undefined,
};

await mod.apply(ctx, { rabbitUrl: 'http://127.0.0.1:8787', stateDir: '/tmp/w2m-verify' });

const names = registered.map((d) => d.name).sort();
process.stdout.write(`registered    : ${registered.length}\n`);
for (const name of names) process.stdout.write(`  - ${name}\n`);
if (warnings.length > 0) {
  process.stdout.write(`warnings:\n${warnings.map((w) => `  ${w}`).join('\n')}\n`);
}

const expected = ['w2m_devices', 'w2m_report', 'w2m_run', 'w2m_status', 'w2m_update', 'w2m_wait'];
const ok = registered.length === expected.length && expected.every((e) => names.includes(e));
process.stdout.write(
  ok
    ? `\nPASS: ${expected.length} tools registered\n`
    : `\nFAIL: expected ${expected.length} tools (${expected.join(', ')}), got ${names.join(', ')}\n`,
);
process.exit(ok ? 0 : 1);
