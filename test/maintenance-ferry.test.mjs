/**
 * Maintenance ferry unit tests (v1.3.10-beta.2).
 *
 * The ferry is the seam between an untrusted task offer and a privileged root runner. These tests pin its two safety
 * properties: it never writes the queue before verification, and every refusal is a named value the agent can report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, signRequest } from '../src/maintenance/protocol.mjs';
import { createPinStore, generateOperatorKeyPair, registrationPayload } from '../src/maintenance/operator-key.mjs';
import { ferryMaintenance, maintenancePaths } from '../src/agent/maintenance-ferry.mjs';

const MACHINE = '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc';
const NOW = Date.parse('2026-10-21T13:00:00Z');

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-ferry-'));
  const queueDir = join(dir, 'queue');
  const doneDir = join(dir, 'done');
  const pinFile = join(dir, 'pins.json');
  const store = createPinStore(pinFile);
  return { dir, queueDir, doneDir, pinFile, store, overrides };
}

function signedOffer(keys, extra = {}) {
  const request = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW }), keys.privateKeyPem);
  return {
    offer: { maintenance: request, operator_key: registrationPayload(keys), machine_id: MACHINE, ...extra },
  };
}

describe('maintenance ferry', () => {
  it('pins the operator key, writes the queue file, waits for the runner and returns its result', async () => {
    const keys = generateOperatorKeyPair();
    const { queueDir, doneDir, pinFile } = fixture();
    const { offer } = signedOffer(keys);
    let observed = null;
    const ferry = ferryMaintenance({
      offer,
      machineId: MACHINE,
      queueDir,
      doneDir,
      pinFile,
      now: () => NOW,
      sleep: async () => {
        if (observed === null) {
          observed = 'waiting';
          const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
          assert.equal(files.length, 1, 'the request was written to the queue');
          assert.equal(existsSync(join(doneDir, 'x.json')), false);
          writeFileSync(join(doneDir, encodeURIComponent(offer.maintenance.request_id) + '.json'), JSON.stringify({ status: 'ok', request_id: offer.maintenance.request_id }), 'utf8');
        }
      },
    });
    const result = await ferry;
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'ok');
    assert.equal(existsSync(pinFile), true);
    const pins = JSON.parse(readFileSync(pinFile, 'utf8'));
    assert.equal(pins.pinned.key_id, keys.keyId);
  });

  it('refuses before touching the queue when no operator key is pinned or supplied', async () => {
    const keys = generateOperatorKeyPair();
    const { queueDir, doneDir, pinFile } = fixture();
    const request = signRequest(buildRequest({ action: 'diag', params: {}, machineId: MACHINE, nowMs: NOW }), keys.privateKeyPem);
    const result = await ferryMaintenance({ offer: { maintenance: request, machine_id: MACHINE }, machineId: MACHINE, queueDir, doneDir, pinFile, now: () => NOW, sleep: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MAINTENANCE_NO_PINNED_KEY');
    assert.equal(existsSync(queueDir), false, 'no queue write on refusal');
  });

  it('refuses a tampered request and does not enqueue it', async () => {
    const keys = generateOperatorKeyPair();
    const { queueDir, doneDir, pinFile } = fixture();
    const { offer } = signedOffer(keys);
    const tampered = { ...offer, maintenance: { ...offer.maintenance, params: { sections: ['disk'] } } };
    const result = await ferryMaintenance({ offer: tampered, machineId: MACHINE, queueDir, doneDir, pinFile, now: () => NOW, sleep: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MAINTENANCE_BAD_SIGNATURE');
    assert.equal(existsSync(queueDir), false);
  });

  it('uses platform-appropriate default paths and honours environment overrides', () => {
    const linux = maintenancePaths({ W2M_MAINTENANCE_QUEUE: '/custom/q' }, 'linux');
    assert.equal(linux.queueDir, '/custom/q');
    assert.equal(linux.doneDir, '/var/lib/w2m/maintenance/done');
    const win = maintenancePaths({}, 'win32');
    assert.equal(win.queueDir, 'C:\\ProgramData\\w2m\\maintenance\\queue');
    assert.equal(win.pinFile, 'C:\\ProgramData\\w2m\\maintenance\\operator-pins.json');
  });
});
