#!/usr/bin/env node
/**
 * Verify that a relay has retired its data-plane endpoints.
 *
 *   node scripts/verify-blob-retirement.mjs http://host:8787 [http://host2:8787 ...]
 *
 * The new relay refuses `PUT /v1/fleet/blobs/<sha>` before authentication, so the expected answer
 * is 403 DATA_PLANE_REFUSED with no credentials. An old relay (1.6.4) answers 401/201/404 instead;
 * any of those means "upgrade this relay before purging its blobs".
 *
 * Exit code 0 when every relay is retired, 1 otherwise.
 */
const TIMEOUT_MS = 8000;
const SHA = 'a'.repeat(64);

const relays = process.argv.slice(2).filter((arg) => arg !== '');
if (relays.length === 0) {
  process.stderr.write('usage: node scripts/verify-blob-retirement.mjs <relay-base-url> [...]\n');
  process.exit(2);
}

const results = [];
for (const relay of relays) {
  const url = relay.replace(/\/+$/, '') + '/v1/fleet/blobs/' + SHA;
  let status = null;
  let code = null;
  let error = null;
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    try { code = (await response.json())?.error?.code ?? null; } catch { code = null; }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const retired = status === 403 && code === 'DATA_PLANE_REFUSED';
  results.push({ relay, url, status, code, retired, error });
}

process.stdout.write(JSON.stringify({ ok: results.every((r) => r.retired), relays: results }, null, 2) + '\n');
process.exit(results.every((r) => r.retired) ? 0 : 1);
