#!/usr/bin/env node
/**
 * Operator token CLI (v2 G0-1).
 *
 * The token is read from stdin, never from argv, and stored in a 0600 file. Output is JSON with a
 * fingerprint and the file path only — the value is never printed back.
 *
 * Usage:
 *   echo <token> | node bin/w2m-operator.mjs set
 *   node bin/w2m-operator.mjs set --file <path>     (reads the file, still never echoes it)
 *   node bin/w2m-operator.mjs status
 *   node bin/w2m-operator.mjs clear
 *
 * Exit codes: 0 ok, 1 refusal, 2 usage.
 */
import { readFileSync } from 'node:fs';

import {
  clearOperatorToken,
  fingerprintOf,
  operatorTokenPath,
  readOperatorToken,
  writeOperatorToken,
} from '../src/plugin/operator-token.mjs';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (command === 'set') {
  const file = flag('--file');
  let token;
  try { token = file !== undefined ? readFileSync(file, 'utf8') : await readStdin(); } catch (error) {
    print({ ok: false, code: 'TOKEN_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  const written = writeOperatorToken(token);
  if (written.ok !== true) {
    print({ ok: false, code: written.code, detail: written.detail ?? null });
    process.exit(1);
  }
  print({ ok: true, path: written.path, fingerprint: written.fingerprint, source: 'file' });
  process.exit(0);
}

if (command === 'status') {
  const read = readOperatorToken();
  if (read.configured !== true) {
    print({ ok: true, configured: false, path: read.path, error: read.error ?? null });
    process.exit(0);
  }
  print({ ok: true, configured: true, path: read.path, fingerprint: fingerprintOf(read.token) });
  process.exit(0);
}

if (command === 'clear') {
  const cleared = clearOperatorToken();
  print({ ok: cleared.ok === true, path: cleared.path, code: cleared.code ?? null });
  process.exit(cleared.ok === true ? 0 : 1);
}

print({ ok: false, code: 'USAGE', path: operatorTokenPath(), usage: 'set [--file <path>] | status | clear' });
process.exit(2);
