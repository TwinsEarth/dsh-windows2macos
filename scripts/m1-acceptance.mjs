#!/usr/bin/env node
/**
 * M1 acceptance driver (v1.3.10-beta.2).
 *
 * What it can prove without privilege: the relay accepts a signed maintenance request plus the operator key, carries it to
 * the target machine's offer, and exposes the request id on the task summary.
 *
 * What it cannot prove without a one-time privileged install on the target: that a root/SYSTEM runner executes the action.
 * That half needs the unit/scheduled task installed and is recorded by the runbook (`docs/COLLAB/M1-MAINTENANCE.md` §8).
 */
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith('--')) args[key.slice(2)] = process.argv[++i];
}
const RELAY = args.relay ?? 'http://202.182.123.154:8787';
const OP_TOKEN = args['operator-token'] ?? process.env.W2M_OPERATOR_TOKEN;
const DEV_TOKEN = args['device-token'] ?? process.env.W2M_DEVICE_TOKEN;
const MACHINE = args['machine-id'];
const keyFile = args['operator-key-file'] ?? join(process.cwd(), 'operator-key.json');
if (!OP_TOKEN || !DEV_TOKEN || !MACHINE) {
  console.error('usage: m1-acceptance.mjs --operator-token .. --device-token .. --machine-id .. [--relay ..] [--operator-key-file ..]');
  process.exit(2);
}

const OP_H = { authorization: 'Bearer ' + OP_TOKEN, 'content-type': 'application/json' };
const DEV_H = { authorization: 'Bearer ' + DEV_TOKEN };
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}
function keyIdOf(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

let keys;
if (existsSync(keyFile)) {
  keys = JSON.parse(readFileSync(keyFile, 'utf8'));
} else {
  const pair = generateKeyPairSync('ed25519');
  keys = {
    keyId: keyIdOf(pair.publicKey),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  writeFileSync(keyFile, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  console.log('generated operator key at ' + keyFile + ' (key_id ' + keys.keyId + ')');
}

const nowMs = Date.now();
const request = {
  protocol: 'w2m-maintenance/v1',
  request_id: 'mr-' + nowMs.toString(36) + '-' + Math.random().toString(16).slice(2, 10),
  action: 'diag',
  params: {},
  machine_id: MACHINE,
  nonce: createHash('sha256').update(String(Math.random()) + String(nowMs)).digest('hex').slice(0, 32),
  issued_at: new Date(nowMs).toISOString(),
  expires_at: new Date(nowMs + 5 * 60 * 1000).toISOString(),
  issued_by: 'm1-acceptance',
};
const payload = canonicalize(request);
const signature = signBytes(null, Buffer.from(payload, 'utf8'), keys.privateKeyPem).toString('base64');
request.signature = { alg: 'ed25519', key_id: keys.keyId, value_base64: signature };

const dispatched = await j(await fetch(RELAY + '/v1/task', {
  method: 'POST', headers: OP_H,
  body: JSON.stringify({
    mode: 'broadcast', executor_machine_id: MACHINE, command_argv: ['node', '--version'],
    cwd_rel: '.', index_total: 1, timeout_ms: 120000, write: false,
    maintenance: request,
    operator_key: { key_id: keys.keyId, public_key_pem: keys.publicKeyPem, created_at: new Date(nowMs).toISOString() },
  }),
}));
console.log('  dispatch: HTTP ' + dispatched.status + ' task_id=' + (dispatched.body.task_id ?? '(none)'));
if (!dispatched.body.task_id) { console.log(JSON.stringify(dispatched.body).slice(0, 400)); process.exit(1); }

let summary = null;
for (let i = 0; i < 40; i += 1) {
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  const got = await j(await fetch(RELAY + '/v1/tasks/' + encodeURIComponent(dispatched.body.task_id), { headers: DEV_H }));
  summary = got.body?.task ?? null;
  const status = summary?.status ?? '?';
  if (i % 3 === 0) console.log('  [' + i + '] task status=' + status + ' maintenance_request_id=' + (summary?.maintenance_request_id ?? '(missing)'));
  if (status === 'done' || status === 'failed' || status === 'partial') break;
}

const evidence = {
  version: '1.3.10-beta.2',
  case: 'M1-RELAY-PASSTHROUGH',
  kind: 'positive',
  requirement: 'the relay accepts a signed maintenance request + operator key and carries it to the target offer',
  machines: [MACHINE],
  commands: [],
  task_id: dispatched.body.task_id,
  result: {
    task_status: summary?.status ?? null,
    maintenance_request_id: summary?.maintenance_request_id ?? null,
    request_matches: summary?.maintenance_request_id === request.request_id,
    operator_key_id: keys.keyId,
  },
  executed_at: new Date().toISOString(),
  executor: 'lead',
  note: 'Relay-side case only. Root/SYSTEM execution of update/restart/diag requires the one-time privileged install described in docs/COLLAB/M1-MAINTENANCE.md §8 and is not covered by this evidence file.',
};
const dir = join(process.cwd(), 'docs', 'acceptance', evidence.version);
mkdirSync(dir, { recursive: true });
const file = join(dir, 'M1-RELAY-PASSTHROUGH.json');
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
console.log('  evidence written: ' + file);
console.log('  request carried: ' + evidence.result.request_matches);
process.exit(evidence.result.request_matches && summary?.status === 'done' ? 0 : 1);
