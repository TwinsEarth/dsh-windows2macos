/**
 * End-to-end smoke for request signing over a real HTTP server.
 *
 * Written because the relay's unit suite tests the verifier and the agent's tests the signer, but
 * nothing joined them: relay-dev found that the two sides had been built against *different* signing
 * paths, which unit tests on either side pass happily and which breaks only when a real request
 * crosses. That is the class of defect this file exists to catch.
 *
 * It also covers the deployment shape that made the bug visible: a sub-path mount, where the relay
 * sees `/w2m/v1/...` and a client signing the raw URL fails while one signing the routed path works.
 *
 * Uses no test helpers from other suites on purpose -- it must keep working while they are edited.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSigner, canonicalString, signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER } from '../src/signing.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const SECRET = 'e2e-signing-secret';

/**
 * The frozen vectors from PROTOCOL-v0.3.0.md §9.4.1, recomputed here rather than imported.
 *
 * The relay pins these on its side too. Two independent computations of the same literals is the
 * point: if either implementation drifts, one of the two suites goes red. Importing a shared
 * constant would let both agree on a wrong value.
 */
const VECTORS = [
  {
    label: '§9.4.1 vector 1',
    secret: 'test-secret-abc',
    method: 'POST',
    path: '/v1/heartbeat',
    timestamp: 1780000000,
    nonce: 'abcdef0123456789',
    body: '{"task_id":"T1","machine_id":"m1"}',
    canonical: [
      'v1',
      'POST',
      '/v1/heartbeat',
      '1780000000',
      'abcdef0123456789',
      'c132705f2342284320b7e59ef2f32f9d580f6ecf1b83116ae22b71ad6fa09d28',
    ].join('\n'),
    signature: 'v1=a8de86289154861c7289b87e3bb4f39121c5ca0f59d50f819285efe3265778db',
  },
  {
    label: '§9.4.1 vector 2 (query string)',
    secret: 'test-secret-abc',
    method: 'GET',
    path: '/v1/stream?machine_id=m1&seq=4',
    timestamp: 1780000001,
    nonce: '0123456789abcdef',
    body: '',
    canonical: [
      'v1',
      'GET',
      '/v1/stream?machine_id=m1&seq=4',
      '1780000001',
      '0123456789abcdef',
      'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
    ].join('\n'),
    signature: 'v1=a9c899e05b70be0c4fce37ef7cbedacd8bdf36984faeafc8499f13a135776ce6',
  },
];

const scratch = [];
const running = [];

after(async () => {
  for (const proc of running) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Start the relay CLI and wait until it reports the port it bound.
 *
 * @param {object} opts - Launch options.
 * @param {string[]} [opts.extraArgs] - Additional CLI arguments.
 * @returns {Promise<{url: string, port: number, proc: object, stderr: () => string}>}
 */
async function startRelay({ extraArgs = [] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-sign-e2e-'));
  scratch.push(stateDir);
  const proc = spawn(
    NODE,
    [
      join(REPO, 'bin', 'w2m-rabbit.mjs'),
      '--host', '127.0.0.1',
      '--port', '0',
      '--state', stateDir,
      '--json',
      '--no-persist',
      '--pair-rate-limit', '0',
      '--operator-token', 'operator-for-e2e',
      ...extraArgs,
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  running.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    out += c;
  });
  proc.stderr.on('data', (c) => {
    err += c;
  });

  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start; stderr=${err}`)), 15_000);
    const check = () => {
      const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      } else if (proc.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`relay exited ${proc.exitCode}; stderr=${err}`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  return {
    url: `http://127.0.0.1:${info.port}`,
    port: info.port,
    proc,
    stderr: () => err,
    info,
  };
}

describe('request signing over real HTTP', () => {
  it('accepts an unsigned request when no secret is configured (v0.2.3 compatibility)', async () => {
    const relay = await startRelay();
    const res = await fetch(`${relay.url}/healthz`);
    assert.equal(res.status, 200, 'a relay without a secret must behave exactly as before');
    const body = await res.json();
    assert.equal(body.signing.configured, false);
    assert.equal(body.signing.required, false);
  });

  it('verifies a signed request and refuses a tampered one', async () => {
    const relay = await startRelay({ extraArgs: ['--signing-secret', SECRET] });
    const signer = createSigner({ secret: SECRET });

    // A read endpoint is exempt unless signatures are required, so use a write endpoint: the
    // operator-token check runs first, which also proves the two credentials coexist.
    const path = '/v1/task';
    const body = JSON.stringify({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log(1)'],
      index_total: 1,
      timeout_ms: 5000,
      write: false,
    });
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer operator-for-e2e',
      ...signer.headers({ method: 'POST', path, body }),
    };
    const ok = await fetch(`${relay.url}${path}`, { method: 'POST', headers, body });
    assert.notEqual(ok.status, 401, `a correctly signed request must not be refused: ${await ok.text()}`);

    // Same signature, different body: the signature must not survive a tamper.
    const tampered = await fetch(`${relay.url}${path}`, {
      method: 'POST',
      headers,
      body: body.replace('console.log(1)', 'console.log(2)'),
    });
    assert.equal(tampered.status, 401, 'a tampered body must be refused');
    const detail = await tampered.json();
    assert.equal(detail.error.detail.code, 'SIGNATURE_MISMATCH');
  });
});

describe('request signing under a sub-path mount (the defect this file exists for)', () => {
  it('signs the routed path, so a relay behind --base-path verifies the same request', async () => {
    // The relay is mounted at /w2m, so it *sees* /w2m/v1/task while the client's API path is
    // /v1/task. Signing the raw URL would make every signed request fail here -- and only here,
    // which is exactly why the bug survived both unit suites.
    const relay = await startRelay({ extraArgs: ['--signing-secret', SECRET, '--base-path', '/w2m'] });
    const path = '/v1/task';
    const body = JSON.stringify({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log(1)'],
      index_total: 1,
      timeout_ms: 5000,
      write: false,
    });

    // Correct: sign the routed path, POST to the mounted URL.
    const good = createSigner({ secret: SECRET }).headers({ method: 'POST', path, body });
    const okRes = await fetch(`${relay.url}/w2m${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer operator-for-e2e', ...good },
      body,
    });
    assert.notEqual(okRes.status, 401, `signing the routed path must work under a sub-path mount: ${await okRes.text()}`);

    // Wrong: sign the URL as the client sees it, prefix included. This is the shape that used to be
    // implemented, so the assertion is a regression guard rather than a hypothetical.
    const wrong = createSigner({ secret: SECRET }).headers({ method: 'POST', path: `/w2m${path}`, body });
    const badRes = await fetch(`${relay.url}/w2m${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer operator-for-e2e', ...wrong },
      body,
    });
    assert.equal(badRes.status, 401, 'signing the prefixed URL must be refused, not silently accepted');
    const detail = await badRes.json();
    assert.equal(detail.error.detail.code, 'SIGNATURE_MISMATCH');
  });

  it('includes the query string in the signature', async () => {
    const relay = await startRelay({ extraArgs: ['--signing-secret', SECRET, '--require-signature'] });

    // `/healthz` and `/v1/pair` are permanently exempt (a probe must not need credentials, and at
    // pairing time the two sides share no secret yet), so the check has to use a real write path.
    const path = '/v1/task?trace=1';
    const body = JSON.stringify({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log(1)'],
      index_total: 1,
      timeout_ms: 5000,
      write: false,
    });

    // Signing the path *with* its query verifies; the operator token then carries the request past
    // the auth layer, so a signature refusal would be the only thing that could still 401.
    const includeQuery = createSigner({ secret: SECRET }).headers({ method: 'POST', path, body });
    const withQuery = await fetch(`${relay.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer operator-for-e2e', ...includeQuery },
      body,
    });
    assert.notEqual(withQuery.status, 401, `signing a path that includes its query must verify: ${await withQuery.text()}`);

    // Signing only the pathname of the same request must NOT verify. This is the regression guard:
    // it proves the query is actually covered, rather than the two happening to agree because the
    // endpoint ignores its query.
    const pathnameOnly = createSigner({ secret: SECRET }).headers({ method: 'POST', path: '/v1/task', body });
    const withoutQuery = await fetch(`${relay.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer operator-for-e2e', ...pathnameOnly },
      body,
    });
    assert.equal(withoutQuery.status, 401, 'a signature that omits the query must be refused');
    assert.equal((await withoutQuery.json()).error.detail.code, 'SIGNATURE_MISMATCH');
  });

  it('refuses to start when signatures are required but no secret is configured', async () => {
    // A contradiction must be reported at startup, not as a 500 on every request forever.
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-sign-bad-'));
    scratch.push(stateDir);
    const proc = spawn(
      NODE,
      [join(REPO, 'bin', 'w2m-rabbit.mjs'), '--state', stateDir, '--require-signature', '--no-persist'],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    running.push(proc);
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => {
      err += c;
    });
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    assert.notEqual(code, 0, 'it must not start');
    assert.match(err, /require-signature needs --signing-secret/);
  });

  it('exposes the three signature headers so both sides cannot disagree about their names', () => {
    const headers = createSigner({ secret: SECRET }).headers({ method: 'GET', path: '/healthz' });
    assert.ok(SIGNATURE_HEADER in headers);
    assert.ok(TIMESTAMP_HEADER in headers);
    assert.ok(NONCE_HEADER in headers);
  });
});

describe('the frozen protocol vectors (§9.4.1), recomputed locally', () => {
  it('recomputes the canonical string and signature byte for byte', () => {
    // Independently derived here, pinned in the relay suite too. Two computations of the same
    // literals means a drift on either side turns one of them red, which a shared constant would not.
    for (const v of VECTORS) {
      assert.equal(
        canonicalString({ method: v.method, path: v.path, timestamp: v.timestamp, nonce: v.nonce, body: v.body }),
        v.canonical,
        `${v.label}: canonical string drifted`,
      );
      assert.equal(
        signRequest({ secret: v.secret, method: v.method, path: v.path, timestamp: v.timestamp, nonce: v.nonce, body: v.body }),
        v.signature,
        `${v.label}: signature drifted`,
      );
    }
  });

  it('shows that the deployment prefix changes the signature', () => {
    // The evidence behind relay-dev's contract: signing the prefixed URL cannot verify against a
    // relay that signs the routed path, and vice versa. Recorded explicitly so the rule is not
    // re-litigated from memory.
    const base = { secret: 'test-secret-abc', method: 'POST', timestamp: 1780000000, nonce: 'abcdef0123456789', body: '{"task_id":"T1","machine_id":"m1"}' };
    const routed = signRequest({ ...base, path: '/v1/heartbeat' });
    const prefixed = signRequest({ ...base, path: '/w2m/v1/heartbeat' });
    assert.notEqual(routed, prefixed, 'the prefix must be part of what is bound');
    assert.equal(routed, VECTORS[0].signature);
    assert.equal(prefixed, 'v1=20c0f143fd27a61c86d876fdd802d143645d5238a301b7d91269205e37a6300d');
  });
});

void before;
