/**
 * Assert that this package's own entry points actually import.
 *
 * Why this is a separate, mandatory gate: `node --check` parses a file but does
 * not resolve its imports, so a re-export naming a symbol that does not exist
 * passes every syntax check and every unit test (which import `src/` directly)
 * and fails only when DSH mounts the plugin. That is precisely the failure this
 * project has already been bitten by once, in a different plugin.
 *
 * So: actually import `lib/tools.js` -- the exact specifier
 * `cordis.patch.yml` mounts -- and assert the plugin surface is present.
 *
 * Usage: node scripts/check-entrypoints.mjs
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
let failures = 0;

const ok = (m) => process.stdout.write(`  PASS  ${m}\n`);
const bad = (m) => { failures += 1; process.stdout.write(`  FAIL  ${m}\n`); };

process.stdout.write('entry point imports\n');

// The module `cordis.patch.yml` names. Importing it is the whole point.
const mountEntry = join(ROOT, 'lib', 'tools.js');
if (!existsSync(mountEntry)) {
  bad(`lib/tools.js is missing; cordis.patch.yml mounts a path that does not exist`);
} else {
  try {
    const mod = await import(pathToFileURL(mountEntry).href);
    if (typeof mod.apply === 'function') ok('lib/tools.js exports a callable apply');
    else bad(`lib/tools.js exports apply as ${typeof mod.apply}`);

    if (Array.isArray(mod.inject) && mod.inject.includes('tools')) {
      ok(`lib/tools.js declares inject = ${JSON.stringify(mod.inject)}`);
    } else {
      bad(`lib/tools.js inject is ${JSON.stringify(mod.inject)}; expected it to include "tools"`);
    }
  } catch (error) {
    bad(`importing lib/tools.js threw: ${error.message}`);
  }
}

// The package root, which npm resolves for `import '@twinsearth/w2m-dsh-plugin'`.
const rootEntry = join(ROOT, 'lib', 'index.js');
if (!existsSync(rootEntry)) {
  bad('lib/index.js is missing');
} else {
  try {
    await import(pathToFileURL(rootEntry).href);
    ok('lib/index.js imports (deliberately empty plugin root)');
  } catch (error) {
    bad(`importing lib/index.js threw: ${error.message}`);
  }
}

// The two CLIs. Checked as subprocesses rather than by importing them: importing
// a CLI runs `main()`, which starts a relay and would leak a listener into this
// process. `--help` is the cheapest invocation that proves the module resolved
// all its imports and reached its argument parser.
import { spawnSync } from 'node:child_process';

for (const cli of ['bin/w2m-rabbit.mjs', 'bin/w2m-localside.mjs']) {
  const path = join(ROOT, cli);
  if (!existsSync(path)) { bad(`${cli} is missing`); continue; }
  const run = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', timeout: 20_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status === 0 && /Usage:/.test(output)) {
    ok(`${cli} --help exits 0 and prints usage`);
  } else {
    bad(`${cli} --help -> exit ${run.status}; output: ${output.slice(0, 300)}`);
  }
}

process.stdout.write(failures === 0 ? '\nALL ENTRY POINTS OK\n' : `\n${failures} ENTRY POINT PROBLEM(S)\n`);
process.exit(failures === 0 ? 0 : 1);
