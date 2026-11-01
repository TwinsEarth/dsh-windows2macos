import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { planJoin } from '../src/chatops/fleet-join.mjs';
import { registerFleetConfigRoute } from '../src/plugin/fleet-config-route.mjs';

const KEY = planJoin({ userId: 'fleet-config-route-test' });

function mount(file) {
  let entry = null;
  const ctx = {
    inject: (names, callback) => callback({ connection: { fetch: { register: (candidate) => { entry = candidate; } } } }),
  };
  return { status: registerFleetConfigRoute(ctx, { file }), entry };
}

function post(entry, body) {
  return entry.fetch(new Request('http://host/api/w2m/fleet-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

let work;
before(() => { work = mkdtempSync(join(tmpdir(), 'w2m-fleet-config-route-')); });
after(() => { rmSync(work, { recursive: true, force: true }); });

describe('fleet-config route: preview, confirm, then save', () => {
  it('previews without writing, and previews a mismatch instead of refusing the confirmation step', async () => {
    const path = join(work, 'preview.json');
    const { status, entry } = mount(path);
    assert.equal(status.mounted, true);

    const preview = await post(entry, { action: 'preview', fleet_key: KEY.fleetKey });
    const body = await preview.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.fleet_id, KEY.fleetId);
    assert.equal(body.matches_expected, null);
    assert.equal(existsSync(path), false, 'preview must not write');

    const mismatch = await post(entry, { action: 'preview', fleet_key: KEY.fleetKey, expected_fleet_id: '0'.repeat(64) });
    assert.equal(mismatch.status, 200);
    const mismatchBody = await mismatch.json();
    assert.equal(mismatchBody.ok, true);
    assert.equal(mismatchBody.matches_expected, false);
  });

  it('saves with a backup and never echoes the key; a wrong expected id is refused', async () => {
    const path = join(work, 'save.json');
    const { entry } = mount(path);

    const wrong = await post(entry, { action: 'save', fleet_key: KEY.fleetKey, expected_fleet_id: '0'.repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(existsSync(path), false);

    const saved = await post(entry, { action: 'save', fleet_key: KEY.fleetKey, expected_fleet_id: KEY.fleetId });
    const body = await saved.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.policy, 'config');
    assert.equal(body.restart_required, true);
    assert.equal(JSON.stringify(body).includes(KEY.fleetKey), false, 'the key must never be echoed');
    assert.match(body.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(existsSync(path), true);

    const second = await post(entry, { action: 'save', fleet_key: KEY.fleetKey, expected_fleet_id: KEY.fleetId });
    const secondBody = await second.json();
    assert.equal(secondBody.ok, true);
    assert.ok(secondBody.backup !== null && existsSync(secondBody.backup));

    const get = await entry.fetch(new Request('http://host/api/w2m/fleet-config'));
    const current = await get.json();
    assert.equal(current.configured, true);
    assert.equal(current.fleet_id, KEY.fleetId);
    assert.equal(current.policy, 'config');
  });

  it('never touches the profile patch file', async () => {
    const path = join(work, 'separate.json');
    const patch = join(work, 'cordis.patch.yml');
    const original = '# operator profile patch\n';
    writeFileSync(patch, original, 'utf8');
    const { entry } = mount(path);
    await post(entry, { action: 'save', fleet_key: KEY.fleetKey, expected_fleet_id: KEY.fleetId });
    assert.equal(readFileSync(patch, 'utf8'), original);
    assert.equal(readFileSync(path, 'utf8').includes(KEY.fleetKey), true);
  });
});
