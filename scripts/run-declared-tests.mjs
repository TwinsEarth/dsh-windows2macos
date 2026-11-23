#!/usr/bin/env node
/**
 * Run `package.json#scripts.test` without putting its argument list on a Windows command line.
 *
 * The declared suite is a single source of truth: `package.json#scripts.test` lists every file, and
 * both the pre-flight and the claims suite read that string. Until v3.6.0 no runner had to care how
 * long it was. Then the suite reached 337 files and Windows CI failed before a single test ran:
 * `cmd.exe` -- which npm uses to execute scripts on Windows -- rejects a command line over 8191
 * characters with "The command line is too long". The list itself is not the defect; the transport
 * is.
 *
 * This script reads the same string, extracts the same `test/*.test.mjs` paths, and spawns `node`
 * with an argv array. Windows accepts a process command line up to 32767 characters, so the limit
 * that bit npm does not apply. Nothing is copied or re-listed here: a suite added to `scripts.test`
 * is picked up with no second edit, exactly as `npm test` would pick it up.
 *
 * Exit status is the child's, so a failing suite fails this command. stdio is inherited so the TAP
 * output a reviewer reads is the runner's own, not a summary of it.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declared = pkg.scripts?.test;
if (typeof declared !== 'string') {
  process.stderr.write('run-declared-tests: package.json#scripts.test is not a string\n');
  process.exit(1);
}

const files = [...declared.matchAll(/(?:^|\s)(test\/[^\s]+\.test\.mjs)/g)].map((match) => match[1]);
if (files.length === 0) {
  process.stderr.write(
    'run-declared-tests: package.json#scripts.test names no test/*.test.mjs file, so this wrapper\n' +
      'would run nothing; that is a failure, not an empty pass\n',
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--test', '--test-force-exit', '--test-concurrency=1', ...files],
  { cwd: root, stdio: 'inherit', env: process.env },
);

child.on('error', (error) => {
  process.stderr.write(`run-declared-tests: could not start the test runner: ${error?.message ?? error}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`run-declared-tests: the test runner died from signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
