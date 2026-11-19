/**
 * Moved-module relative path guard (regression for the S2/S3 tool split).
 *
 * When `src/plugin/tools.mjs` was split into `src/plugin/tools/*.mjs`, the file depth changed by one:
 * a dynamic `new URL('./bootstrap.mjs', import.meta.url)` still "looked right" but resolved to
 * `src/plugin/tools/bootstrap.mjs` instead of `src/plugin/bootstrap.mjs`, and the agent/relay URLs
 * resolved under `src/plugin/` instead of `src/`. Static imports are checked by Node when the module
 * loads; **dynamic** URLs are only checked when that code path runs, which is why the release gate's
 * `verify:join` step caught it and the normal suites did not.
 *
 * This suite scans every moved directory and asserts that each `new URL('<relative>', import.meta.url)`
 * points at an existing file. Bare specifiers (node: builtins, package names) are skipped on purpose.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOVED_DIRS = ['src/plugin/tools', 'src/agent/lifecycle', 'src/relay/state'];

const listModules = (relDir) => {
  const dir = path.join(ROOT, relDir);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join(relDir, name));
};

const relativeDynamicSpecs = (text) => {
  const specs = [];
  for (const match of text.matchAll(/new URL\('([^']+)',\s*import\.meta\.url\)/g)) specs.push(match[1]);
  for (const match of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) specs.push(match[1]);
  return specs.filter((spec) => spec.startsWith('./') || spec.startsWith('../'));
};
const dynamicUrls = relativeDynamicSpecs;

describe('moved-module relative dynamic URLs resolve (S2/S3 split guard)', () => {
  it('every new URL(relative, import.meta.url) points at an existing file', () => {
    const problems = [];
    for (const relDir of MOVED_DIRS) {
      for (const relFile of listModules(relDir)) {
        const text = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
        for (const spec of dynamicUrls(text)) {
          const target = path.resolve(path.dirname(path.join(ROOT, relFile)), spec);
          if (!fs.existsSync(target)) problems.push(`${relFile}: ${spec} -> ${path.relative(ROOT, target)} (missing)`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('pins the three split-sensitive targets', () => {
    const shared = path.join(ROOT, 'src/plugin/tools/shared.mjs');
    const text = fs.readFileSync(shared, 'utf8');
    const urls = dynamicUrls(text);
    const resolved = urls.map((spec) => path.relative(ROOT, path.resolve(path.dirname(shared), spec)).split(path.sep).join('/'));
    for (const expected of ['src/plugin/bootstrap.mjs', 'src/relay/server.mjs', 'src/agent/agent.mjs']) {
      assert.ok(resolved.includes(expected), `shared.mjs must resolve ${expected}; saw ${resolved.join(', ')}`);
    }
  });
});
