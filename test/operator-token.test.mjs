/** G0-1: operator token lives in a 0600 file, and only a fingerprint is ever reported. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  clearOperatorToken,
  fingerprintOf,
  operatorTokenPath,
  readOperatorToken,
  validateOperatorToken,
  writeOperatorToken,
} from '../src/plugin/operator-token.mjs';

const TOKEN = 'op-token-0123456789abcdef';
const dir = () => mkdtempSync(join(tmpdir(), 'w2m-op-'));
const fileIn = (d) => join(d, 'operator-token');

describe('operator token: validation and fingerprint', () => {
  it('refuses short, empty and multi-line values', () => {
    assert.equal(validateOperatorToken('short').code, 'OPERATOR_TOKEN_TOO_SHORT');
    assert.equal(validateOperatorToken('').code, 'OPERATOR_TOKEN_TOO_SHORT');
    assert.equal(validateOperatorToken('a'.repeat(20) + '\n' + 'b'.repeat(20)).code, 'OPERATOR_TOKEN_INVALID');
    assert.equal(validateOperatorToken(TOKEN).ok, true);
  });

  it('fingerprints stably and never returns the value', () => {
    const one = fingerprintOf(TOKEN);
    assert.equal(one, fingerprintOf(TOKEN));
    assert.match(one, /^[0-9a-f]{12}$/);
    assert.notEqual(one, TOKEN);
    assert.equal(fingerprintOf(''), null);
  });

  it('defaults to ~/.w2m/operator-token and honours the override', () => {
    assert.match(operatorTokenPath({}), /\.w2m[\\/]operator-token$/);
    assert.equal(operatorTokenPath({ W2M_OPERATOR_TOKEN_FILE: 'X:/t' }), 'X:/t');
  });
});

describe('operator token: secure file', () => {
  it('writes a single-line file readable back with a fingerprint', () => {
    const d = dir();
    const path = fileIn(d);
    const written = writeOperatorToken(TOKEN, { path });
    assert.equal(written.ok, true, written.code);
    assert.equal(readFileSync(path, 'utf8'), TOKEN + '\n');
    const read = readOperatorToken({ path });
    assert.equal(read.configured, true);
    assert.equal(read.token, TOKEN);
    assert.equal(read.fingerprint, fingerprintOf(TOKEN));
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it('reports not configured when the file is absent, and clear removes it', () => {
    const d = dir();
    const path = fileIn(d);
    assert.equal(readOperatorToken({ path }).configured, false);
    writeOperatorToken(TOKEN, { path });
    assert.equal(readOperatorToken({ path }).configured, true);
    const cleared = clearOperatorToken({ path });
    assert.equal(cleared.ok, true);
    assert.equal(readOperatorToken({ path }).configured, false);
  });

  it('refuses to write an invalid token and leaves no file behind', () => {
    const d = dir();
    const path = fileIn(d);
    const written = writeOperatorToken('short', { path });
    assert.equal(written.ok, false);
    assert.equal(readOperatorToken({ path }).configured, false);
  });
});
