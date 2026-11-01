import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { planJoin } from '../src/chatops/fleet-join.mjs';
import { FLEET_CONFIG_FILE, readFleetConfig, writeFleetConfig } from '../src/plugin/fleet-config.mjs';

const KEY_A = planJoin({ userId: 'fleet-config-test-a' });
const KEY_B = planJoin({ userId: 'fleet-config-test-b' });

let work;
before(() => { work = mkdtempSync(join(tmpdir(), 'w2m-fleet-config-')); });
after(() => { rmSync(work, { recursive: true, force: true }); });

function file(name) { return join(work, name); }

describe('fleet-config.json: an independent pin with backup and rollback', () => {
  it('a missing file is not configured, not an error', () => {
    assert.deepEqual(readFleetConfig(file(FLEET_CONFIG_FILE)), {
      ok: true,
      config: null,
      path: file(FLEET_CONFIG_FILE),
    });
  });

  it('writes and reads the pin; a second write keeps the first as a timestamped backup', () => {
    const path = file('pin.json');
    const first = writeFleetConfig(path, { fleetKey: KEY_A.fleetKey, fleetId: KEY_A.fleetId });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.backup, null);
    const read = readFleetConfig(path);
    assert.equal(read.ok, true);
    assert.equal(read.config.fleetKey, KEY_A.fleetKey);
    assert.equal(read.config.fleetId, KEY_A.fleetId);
    assert.equal(read.config.policy, 'config');

    const second = writeFleetConfig(path, { fleetKey: KEY_B.fleetKey, fleetId: KEY_B.fleetId, now: Date.parse('2026-11-01T10:00:00Z') });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.ok(second.backup !== null && existsSync(second.backup));
    assert.equal(readFileSync(second.backup, 'utf8').includes(KEY_A.fleetKey), true, 'the backup is the previous pin');
    assert.equal(readFleetConfig(path).config.fleetId, KEY_B.fleetId);
  });

  it('refuses to overwrite a corrupt pin, because that is the only recovery copy', () => {
    const path = file('corrupt-pin.json');
    writeFileSync(path, '{not json', 'utf8');
    const read = readFleetConfig(path);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'FLEET_CONFIG_CORRUPT');
    const wrote = writeFleetConfig(path, { fleetKey: KEY_A.fleetKey, fleetId: KEY_A.fleetId });
    assert.equal(wrote.ok, false);
    assert.equal(wrote.code, 'FLEET_CONFIG_CORRUPT');
    assert.equal(readFileSync(path, 'utf8'), '{not json');
  });

  it('rejects a malformed fleet id or policy before touching the file', () => {
    const path = file('invalid.json');
    assert.equal(writeFleetConfig(path, { fleetKey: 'x', fleetId: 'not-a-fleet-id' }).code, 'FLEET_CONFIG_BAD_FLEET_ID');
    assert.equal(writeFleetConfig(path, { fleetKey: 'x', fleetId: KEY_A.fleetId, policy: 'pin' }).code, 'FLEET_CONFIG_BAD_POLICY');
    assert.equal(existsSync(path), false);
  });
});
