/**
 * B1: the operator CLI must survive a real dispatch.
 *
 * Before the fix the dispatch branch read `gate.approval.approval...` (one level too deep), so a
 * real dispatch threw a TypeError before any network request; only --dry-run had evidence. This
 * suite drives the real binary: plan create → approve → dispatch against a stub relay, and asserts
 * the approval is consumed exactly once and the audit holds sending/sent.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'w2m-joint.mjs');
const state = mkdtempSync(join(tmpdir(), 'w2m-joint-cli-'));
const keyFile = join(state, 'operator-key.pem');
const tokenFile = join(state, 'operator-token.txt');
writeFileSync(tokenFile, 'op-token-test\n', 'utf8');
const env = { ...process.env, W2M_JOINT_STATE: state, W2M_OPERATOR_KEY_FILE: keyFile };
let server = null;
after(async () => {
  if (server === null) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => { server.close(() => resolve()); });
});

const run = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => {
    let body = null;
    try { body = JSON.parse(stdout); } catch { body = null; }
    resolve({ status, body, stdout, stderr });
  });
});

function stubRelay() {
  const seen = [];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = String(req.url ?? '');
      if (url.startsWith('/healthz')) {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ relay_version: 'test', protocol_version: 1, features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false, configured: false } }));
        return;
      }
      if (url === '/v1/task' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seen.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ task_id: 'jd-stub', leases: [{ machine_id: 'm-1', state: 'queued' }] }));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}

describe('operator CLI dispatch', () => {
  it('creates, signs, and dispatches one plan without crashing', async () => {
    const stepsFile = join(state, 'steps.json');
    writeFileSync(stepsFile, JSON.stringify([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]), 'utf8');
    const created = await run('plan', 'create', '--state', state, '--steps', stepsFile, '--base-commit', 'a'.repeat(40));
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const planSha = created.body?.plan_sha256;
    assert.match(planSha, /^[0-9a-f]{64}$/);

    const approved = await run('approve', '--state', state, '--plan', planSha, '--approver', 'operator', '--authority', '80');
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    assert.equal(approved.body?.signed, true);

    const dry = await run('dispatch', '--state', state, '--plan', planSha, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.equal(dry.body?.dry_run, true);

    const { srv, seen, url } = await stubRelay();
    server = srv;
    const sent = await run('dispatch', '--state', state, '--plan', planSha, '--relay', url, '--token-file', tokenFile);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    assert.equal(sent.body?.ok, true, JSON.stringify(sent.body));
    assert.match(String(sent.body?.tasks?.[0]?.task_id ?? ''), /^jd-/);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0].approval_sha256 ?? ''), /^[0-9a-f]{64}$/);
    assert.match(String(seen[0].command_hash ?? ''), /^[0-9a-f]{64}$/);

    const audit = readFileSync(join(state, 'joint-dev', 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(audit[0].event, 'joint.dispatch.sending');
    assert.equal(audit[audit.length - 1].event, 'joint.dispatch.sent');

    const replay = await run('dispatch', '--state', state, '--plan', planSha, '--relay', url, '--token-file', tokenFile);
    assert.equal(replay.status, 1);
    assert.equal(seen.length, 1, 'a consumed approval must not produce a second POST');
  });

  it('rejects the removed unsigned-approval escape hatch', async () => {
    const result = await run('dispatch', '--plan', 'x', '--allow-unsigned-approval', '--dry-run');
    assert.equal(result.status, 1);
    assert.equal(result.body?.code, 'UNKNOWN_FLAG');
  });
});
