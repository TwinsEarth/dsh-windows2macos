/**
 * Execution-grant issuance tests (v1.3.12-beta.1).
 *
 * The model only exists if an operator can actually produce a grant and it verifies: the CLI is spawned as a child process and
 * its JSON is checked against the same signing payload the agent verifies, rather than against a hand-rolled expectation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey, verify as verifyBytes } from 'node:crypto';
import { generateOperatorKeyPair } from '../src/maintenance/operator-key.mjs';
import { argvHash, signingPayload } from '../src/maintenance/grant.mjs';

const NODE = process.execPath;
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'w2m-grant.mjs');

function issue(args, keyPath) {
  return execFileSync(NODE, [CLI, '--key', keyPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function issueFailure(args, keyPath) {
  try {
    issue(args, keyPath);
    return null;
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr ?? '') };
  }
}

function setup() {
  const keys = generateOperatorKeyPair();
  const dir = mkdtempSync(join(tmpdir(), 'w2m-grant-cli-'));
  const keyPath = join(dir, 'operator.pem');
  writeFileSync(keyPath, keys.privateKeyPem, 'utf8');
  return { keys, keyPath };
}

const TASK = '01M5GRANTCLI0000000000000001';
const MACHINES = ['m-1', 'm-2'];
const ARGV = ['node', '--version'];

function signatureVerifies(grant, publicKeyPem) {
  return verifyBytes(null, Buffer.from(signingPayload(grant), 'utf8'), createPublicKey(publicKeyPem), Buffer.from(grant.signature.value_base64, 'base64'));
}

describe('execution-grant issuance', () => {
  it('issues a grant bound to one task, argv and machine list, and the signature verifies', () => {
    const { keys, keyPath } = setup();
    const grant = JSON.parse(issue(['--task-id', TASK, '--machines', MACHINES.join(','), '--argv', JSON.stringify(ARGV), '--ttl-ms', '60000'], keyPath));
    assert.equal(grant.task_id, TASK);
    assert.deepEqual(grant.machine_ids, MACHINES);
    assert.equal(grant.argv_hash, argvHash(ARGV));
    assert.equal(grant.max_uses, 1);
    assert.equal(signatureVerifies(grant, keys.publicKeyPem), true);
    assert.match(String(grant.expires_at), /Z$/);
  });

  it('refuses to issue without a task id or machines, and refuses an oversized TTL', () => {
    const { keyPath } = setup();
    const noTask = issueFailure(['--machines', 'm-1', '--argv', JSON.stringify(ARGV)], keyPath);
    assert.ok(noTask !== null && noTask.stderr.includes('task-id'));
    const noMachine = issueFailure(['--task-id', TASK, '--argv', JSON.stringify(ARGV)], keyPath);
    assert.ok(noMachine !== null && noMachine.stderr.includes('machines'));
    const longTtl = issueFailure(['--task-id', TASK, '--machines', 'm-1', '--argv', JSON.stringify(ARGV), '--ttl-ms', '600001'], keyPath);
    assert.ok(longTtl !== null && longTtl.stderr.includes('10 minutes'));
  });

  it('binds the signature to the argv, so a different command has a different hash', () => {
    const { keys, keyPath } = setup();
    const grant = JSON.parse(issue(['--task-id', TASK, '--machines', 'm-1', '--argv', JSON.stringify(ARGV)], keyPath));
    assert.notEqual(grant.argv_hash, argvHash(['node', '--test']));
    assert.equal(signatureVerifies(grant, keys.publicKeyPem), true);
  });
});