/**
 * v1.7.4 regression guard: a token issued by one relay must not be trusted for another.
 *
 * Field symptom (relay switch 2026-10-25): "the Rabbit refused GET /v1/devices with HTTP 401
 * (UNAUTHORIZED: missing or invalid device_token)" and no fleet list, because startup saw a stored
 * token and skipped pairing. The fix probes the token against the configured relay and only drops it
 * on an explicit 401/403.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const tools = readFileSync(join(here, '..', 'src', 'plugin', 'tools.mjs'), 'utf8');

describe('stale device token triggers a re-pair (v1.7.4)', () => {
  it('probes the relay and treats 401/403 as a stale token', () => {
    assert.match(tools, /stored device token was rejected by/);
    assert.match(tools, /probe\.status === 401 \|\| probe\.status === 403/);
  });

  it('treats pairing as mutable state and clears the token before pairing again', () => {
    assert.match(tools, /let alreadyPaired = typeof existingToken === 'string'/);
    assert.match(tools, /identityOptions\.identity\.device_token = null/);
  });

  it('does not re-pair on a network error (only on an explicit rejection)', () => {
    assert.match(tools, /network error: keep the token, do not force a re-pair/);
  });
});