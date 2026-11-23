#!/usr/bin/env node
/**
 * Run an npm script that is a `node --test` invocation, splitting the file list into
 * batches small enough for Windows' 8,191-character command line.
 *
 * Why this exists: `package.json#scripts.test` is the single source of truth for the
 * release suite, and it names ~380 files. `npm test` works on Linux and macOS, but on
 * Windows npm runs scripts through cmd.exe, whose command line is capped at 8,191
 * characters; the same suite fails before the first test starts with "The command line
 * is too long". Neither shortening the list for Windows (which would silently drop suites
 * from the release gate there) nor moving the list out of package.json (which the
 * pre-flight refuses) is acceptable, so this wrapper reads the one list and batches it.
 *
 * Usage: node scripts/run-suite.mjs test
 *        node scripts/run-suite.mjs test --dry-run
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARGV = 6_500; // leaves room for the executable and environment under 8,191

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/run-suite.mjs <script-name> [--dry-run]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const command = manifest.scripts?.[name];
if (typeof command !== 'string' || command === '') {
  console.error(`package.json#scripts.${name} is missing or empty`);
  process.exit(2);
}

const tokens = command.split(/\s+/).filter(Boolean);
const firstFile = tokens.findIndex((token) => token.startsWith('test/'));
if (firstFile < 0) {
  console.error(`package.json#scripts.${name} names no test file: ${command}`);
  process.exit(2);
}
const flags = tokens.slice(0, firstFile);
const files = tokens.slice(firstFile).filter((token) => token.endsWith('.test.mjs'));

const batches = [];
let current = [];
let length = flags.join(' ').length;
for (const file of files) {
  if (current.length > 0 && length + 1 + file.length > MAX_ARGV) {
    batches.push(current);
    current = [];
    length = flags.join(' ').length;
  }
  current.push(file);
  length += 1 + file.length;
}
if (current.length > 0) batches.push(current);

if (process.argv.includes('--dry-run')) {
  console.log(`${files.length} file(s), ${flags.length} flag(s), ${batches.length} batch(es)`);
  for (const [index, batch] of batches.entries()) {
    console.log(`batch ${index + 1}: ${batch.length} file(s), ${batch.join(' ').length} chars`);
  }
  process.exit(0);
}

for (const [index, batch] of batches.entries()) {
  if (batches.length > 1) console.log(`\n=== suite batch ${index + 1}/${batches.length} (${batch.length} files) ===\n`);
  const result = spawnSync(process.execPath, [...flags, ...batch], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
