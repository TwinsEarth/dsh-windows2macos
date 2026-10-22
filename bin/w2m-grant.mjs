#!/usr/bin/env node
/**
 * w2m-grant — issue one signed execution grant (execution-authorization model, v1.3.12-beta.1).
 *
 * The static allow-list is a standing decision made by the machine owner. A grant is a decision made now, by the operator, for
 * exactly one task, one argv and named machines, with a short TTL. This command is the missing half of that model: before it, a
 * grant could only be produced by hand-written code, so in practice only the allow-list existed.
 *
 * Usage:
 *   node bin/w2m-grant.mjs --key <operator-private-key.pem> --task-id <task_id> \
 *        --machines <id1,id2> --argv '["node","--version"]' [--ttl-ms N] [--mode replicate] [--cwd-rel .] [--write]
 *
 * stdout: the grant JSON, ready to place in the POST /v1/task body as "grant". Diagnostics go to stderr so the JSON can be piped.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { argvHash, buildGrant, MAX_GRANT_TTL_MS, signGrant } from '../src/maintenance/grant.mjs';

function die(message) {
  process.stderr.write('w2m-grant: ' + message + '\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    'task-id': { type: 'string' },
    machines: { type: 'string' },
    argv: { type: 'string' },
    'ttl-ms': { type: 'string' },
    mode: { type: 'string', default: 'replicate' },
    'cwd-rel': { type: 'string', default: '.' },
    write: { type: 'boolean', default: false },
    'write-scope': { type: 'string' },
    'max-uses': { type: 'string', default: '1' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stderr.write('w2m-grant: issue one signed execution grant (see the header of bin/w2m-grant.mjs)\n');
  process.exit(0);
}

if (typeof values.key !== 'string' || values.key === '') die('--key <operator-private-key.pem> is required');
if (typeof values['task-id'] !== 'string' || values['task-id'] === '') die('--task-id is required: a grant authorises one execution, so it binds to one task');
if (typeof values.machines !== 'string' || values.machines === '') die('--machines <id1,id2> is required');
if (typeof values.argv !== 'string' || values.argv === '') die('--argv must be a JSON array such as ["node","--version"]');

let argv;
try {
  const parsed = JSON.parse(values.argv);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === 'string' && item !== '')) throw new Error('not a non-empty string array');
  argv = parsed;
} catch (error) {
  die('--argv is not a valid argv array: ' + (error?.message ?? error));
}

const machines = values.machines.split(',').map((id) => id.trim()).filter((id) => id !== '');
if (machines.length === 0) die('--machines needs at least one machine id');

let ttlMs = 5 * 60 * 1000;
if (values['ttl-ms'] !== undefined) {
  ttlMs = Number(values['ttl-ms']);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) die('--ttl-ms must be a positive integer');
  if (ttlMs > MAX_GRANT_TTL_MS) die('--ttl-ms exceeds the maximum of ' + MAX_GRANT_TTL_MS + ' ms (10 minutes)');
}
const maxUses = Number(values['max-uses']);
if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) die('--max-uses must be an integer from 1 to 10');

let privateKeyPem;
try {
  privateKeyPem = readFileSync(values.key, 'utf8');
} catch (error) {
  die('cannot read --key: ' + (error?.message ?? error));
}

let signed;
try {
  const grant = buildGrant({
    taskId: values['task-id'],
    machineIds: machines,
    argv,
    mode: values.mode,
    cwdRel: values['cwd-rel'],
    write: values.write === true,
    writeScope: values['write-scope'] === undefined ? undefined : values['write-scope'].split(',').map((s) => s.trim()).filter((s) => s !== ''),
    maxUses,
    ttlMs,
  });
  signed = signGrant(grant, privateKeyPem);
} catch (error) {
  die('cannot build/sign the grant: ' + (error?.message ?? error));
}

process.stderr.write('w2m-grant: task_id=' + signed.task_id + ' argv_hash=' + argvHash(argv) + ' machines=' + machines.join(',') + ' expires_at=' + signed.expires_at + '\n');
process.stdout.write(JSON.stringify(signed, null, 2) + '\n');