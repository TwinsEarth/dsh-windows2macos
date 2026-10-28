/** S2: only HMACs leave the machine; the relay compares silently and stores only hashes. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { identityHmac, saltIdOf } from '../src/util/tofuture-hmac.mjs';
import { loadWhitelist, whitelistMatches } from '../src/relay/tofuture-whitelist.mjs';
import { buildIdentifyBody, collectIdentityEntries } from '../src/plugin/tofuture/report.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

const KEY = 'fleet-key-for-s2-tests';
const M1 = 'm-1';
const M2 = 'm-2';
const open = [];
after(async () => { for (const server of open.splice(0)) { server.closeAllConnections?.(); await server.close(); } });

const post = async (base, path, token, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
};

describe('identity HMAC', () => {
  it('derives a stable salt and HMAC without exposing the value', () => {
    const salt = saltIdOf(KEY, M1);
    assert.match(salt, /^[0-9a-f]{16}$/);
    const a = identityHmac(KEY, M1, 'mac', 'aa:bb:cc:dd:ee:ff');
    const b = identityHmac(KEY, M1, 'mac', 'aa:bb:cc:dd:ee:ff');
    assert.deepEqual(a, b);
    assert.equal(a.hmac.includes('aa:bb'), false);
    assert.equal(a.kind, 'mac');
  });

  it('builds a body with no MAC or IP plaintext', () => {
    const body = buildIdentifyBody({ machineId: M1, fleetKey: KEY, now: 1_700_000_000_000 });
    const text = JSON.stringify(body);
    assert.match(body.nonce, /^[0-9a-f]{24}$/);
    assert.equal(/([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/.test(text), false);
    assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text), false);
    assert.ok(body.entries.every((entry) => typeof entry.hmac === 'string' && entry.kind && entry.salt_id));
  });

  it('collects every NIC but keeps only HMAC entries', () => {
    const entries = collectIdentityEntries(M1, KEY);
    assert.ok(entries.length > 0, 'at least one interface should produce an entry');
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ['hmac', 'kind', 'salt_id']);
  });
});

describe('relay whitelist', () => {
  it('loads HMAC rows only and matches silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-wl-'));
    const entry = identityHmac(KEY, M1, 'mac', 'aa:bb:cc:dd:ee:ff');
    writeFileSync(join(dir, 'tofuture-whitelist.json'), JSON.stringify({ v: 1, rows: [{ ...entry, mac: 'aa:bb:cc:dd:ee:ff' }] }), 'utf8');
    const whitelist = loadWhitelist(dir);
    assert.equal(whitelist.ok, true);
    assert.equal(whitelist.rows.length, 1);
    assert.equal('mac' in whitelist.rows[0], false, 'a leaked identifier field is dropped');
    assert.equal(whitelistMatches(whitelist, [entry]), true);
    assert.equal(whitelistMatches(whitelist, [identityHmac(KEY, M1, 'mac', 'ff:ee:dd:cc:bb:aa')]), false);
    assert.equal(whitelistMatches(whitelist, []), false);
  });
});

describe('silent relay endpoint', () => {
  it('answers identically, keeps eligibility internal and stores no plaintext', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-s2-relay-'));
    const relay = createRelayServer({ logger: null, operatorToken: 'op-token-0123456789abcdef', stateDir });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    open.push(relay);
    const pair = async (machineId) => {
      const response = await post(relay.url, '/v1/pair', null, { pairing_code: relay.state.createPairingCode(), machine_id: machineId, machine_name: machineId, platform: { os: 'linux', arch: 'x64' } });
      assert.equal(response.status, 200, response.text);
      return JSON.parse(response.text).device_token;
    };
    const token1 = await pair(M1);
    const token2 = await pair(M2);
    const entry = identityHmac(KEY, M1, 'mac', 'aa:bb:cc:dd:ee:ff');
    writeFileSync(join(stateDir, 'tofuture-whitelist.json'), JSON.stringify({ v: 1, rows: [entry] }), 'utf8');

    const now = Date.now();
    const good = { v: 1, machine_id: M1, ts_ms: now, nonce: 'aaaaaaaaaaaaaaaaaaaaaaaa', entries: [entry] };
    const okResponse = await post(relay.url, '/v1/tofuture/identify', token1, good);
    assert.equal(okResponse.status, 204);
    assert.equal(okResponse.text, '');
    assert.equal(relay._tofutureEligible?.has(M1), true, 'a match only marks internal eligibility');

    const bad = { ...good, machine_id: M2, nonce: 'bbbbbbbbbbbbbbbbbbbbbbbb', entries: [identityHmac(KEY, M2, 'mac', '11:22:33:44:55:66')] };
    const badResponse = await post(relay.url, '/v1/tofuture/identify', token2, bad);
    assert.equal(badResponse.status, 204);
    assert.equal(badResponse.text, okResponse.text, 'success and failure are indistinguishable');
    assert.equal(relay._tofutureEligible?.has(M2), false);

    const replay = await post(relay.url, '/v1/tofuture/identify', token1, good);
    assert.equal(replay.status, 204);
    assert.equal(relay._tofutureNonces.size, 2, 'the replayed nonce was not accepted again');

    const plaintext = await post(relay.url, '/v1/tofuture/identify', token1, { ...good, nonce: 'cccccccccccccccccccccccc', mac: 'aa:bb:cc:dd:ee:ff' });
    assert.equal(plaintext.status, 400);

    // nothing on disk carries the fixture MAC/IP plaintext
    const files = [];
    const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path); } };
    walk(stateDir);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes('aa:bb:cc:dd:ee:ff'), false, file + ' must not contain a MAC');
    }
  });

});
