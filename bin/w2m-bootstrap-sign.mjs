#!/usr/bin/env node
/**
 * w2m-bootstrap-sign (v1.5.2) — produce one signed relay-list answer for static hosting.
 *
 * The bootstrap endpoint serves a document; its only trust anchor is the Ed25519 signature the
 * installed plugin verifies against its pinned operator key. Signing is therefore an operator
 * action, run with the operator private key, and the output is a plain JSON file a static server
 * can serve. `expires_at` is part of the signed payload, so a stale file stops being accepted
 * without anyone having to remember to delete it.
 *
 * usage:
 *   w2m-bootstrap-sign.mjs --relays '[{"relays":["https://a:8787","https://b:8787"]}]' ...  *     --relays <json|file> --fleet-key <key> --operator-key <private.pem> [--ttl-hours 24] [--out file]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign as signBytes } from 'node:crypto';
import { canonicalBootstrapPayload, BOOTSTRAP_PROTOCOL, fleetIdOf } from '../src/plugin/bootstrap.mjs';
import { decodeFleetKey } from '../src/chatops/fleet-join.mjs';

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

const relaysArg = arg(process.argv, '--relays');
const fleetKey = arg(process.argv, '--fleet-key');
const operatorKeyPath = arg(process.argv, '--operator-key');
const ttlHours = Number(arg(process.argv, '--ttl-hours') ?? '24');
const outPath = arg(process.argv, '--out');
if (!relaysArg || !fleetKey || !operatorKeyPath) {
  process.stderr.write('usage: w2m-bootstrap-sign.mjs --relays <json|file> --fleet-key <key> --operator-key <private.pem> [--ttl-hours 24] [--out file]\n');
  process.exit(2);
}
if (decodeFleetKey(fleetKey) === null) { process.stderr.write('w2m-bootstrap-sign: --fleet-key is not a 32-byte base64url key\n'); process.exit(2); }
let document;
try { document = JSON.parse(relaysArg.trim().startsWith('{') || relaysArg.trim().startsWith('[') ? relaysArg : readFileSync(relaysArg, 'utf8')); }
catch (error) { process.stderr.write('w2m-bootstrap-sign: cannot parse --relays: ' + error.message + '\n'); process.exit(2); }
const relayList = Array.isArray(document) ? document : document.relays;
const relays = [...new Set((Array.isArray(relayList) ? relayList : []).filter((u) => typeof u === 'string' && u.trim() !== '').map((u) => u.trim().replace(/\/+$/, '')))];
if (relays.length === 0) { process.stderr.write('w2m-bootstrap-sign: no relay URLs in --relays\n'); process.exit(2); }
const fleetId = fleetIdOf(fleetKey);
const now = Date.now();
const issuedAt = new Date(now).toISOString();
const expiresAt = new Date(now + Math.max(1, Math.round(ttlHours * 3600_000))).toISOString();
const payload = canonicalBootstrapPayload({ fleet_id: fleetId, relays, issued_at: issuedAt, expires_at: expiresAt });
const key = createPrivateKey(readFileSync(operatorKeyPath));
const signature = signBytes(null, Buffer.from(payload, 'utf8'), key).toString('base64');
const answer = { protocol: BOOTSTRAP_PROTOCOL, fleet_id: fleetId, relays, issued_at: issuedAt, expires_at: expiresAt, signature: { alg: 'ed25519', value: signature } };
const text = JSON.stringify(answer, null, 2) + '\n';
if (outPath) { writeFileSync(outPath, text, 'utf8'); process.stdout.write('w2m-bootstrap-sign: wrote ' + outPath + ' (fleet ' + fleetId.slice(0, 16) + '…, expires ' + expiresAt + ')\n'); }
else process.stdout.write(text);
