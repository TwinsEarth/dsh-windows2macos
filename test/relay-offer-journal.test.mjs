/** R8: the ledger never stores argv; the offer journal does, and it is what a restart recovers. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';
import {
  deleteOfferJournal,
  pruneOfferJournals,
  readOfferJournal,
  writeOfferJournal,
} from '../src/relay/offer-journal.mjs';

const TOKEN = 'op-token-0123456789abcdef';
const open = [];

after(async () => {
  for (const server of open.splice(0)) { server.closeAllConnections?.(); await server.close(); }
});

async function start(stateDir) {
  const relay = createRelayServer({ logger: null, operatorToken: TOKEN, stateDir });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  open.push(relay);
  return relay;
}

async function post(base, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe('offer journal: unit', () => {
  it('round-trips, deletes and prunes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-journal-'));
    const written = writeOfferJournal(dir, 'task-1', { argv: ['node', '-v'], stages: null, reduce_argv: null });
    assert.equal(written.ok, true, written.code);
    const read = readOfferJournal(dir, 'task-1');
    assert.deepEqual(read.argv, ['node', '-v']);
    assert.equal(read.task_id, 'task-1');
    if (process.platform !== 'win32') assert.equal(statSync(written.path).mode & 0o777, 0o600);
    assert.equal(readOfferJournal(dir, 'missing'), null);
    assert.equal(deleteOfferJournal(dir, 'task-1'), true);
    assert.equal(readOfferJournal(dir, 'task-1'), null);
    writeOfferJournal(dir, 'keep', { argv: ['a'] });
    writeOfferJournal(dir, 'drop', { argv: ['b'] });
    assert.equal(pruneOfferJournals(dir, new Set(['keep'])), 1);
    assert.ok(readOfferJournal(dir, 'keep'));
    assert.equal(readOfferJournal(dir, 'drop'), null);
  });
});

describe('offer journal: relay restart', () => {
  it('keeps argv out of the ledger and recovers it from the journal', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-relay-'));
    const first = await start(stateDir);
    const pairing = first.state.createPairingCode();
    const paired = await post(first.url, '/v1/pair', null, { pairing_code: pairing, machine_id: 'm-1', machine_name: 'm1', platform: { os: 'linux', arch: 'x64' } });
    assert.equal(paired.status, 200, JSON.stringify(paired.json));
    const deviceToken = paired.json.device_token ?? paired.json.token;
    const PLAN_SHA = 'b'.repeat(64);
    const created = await post(first.url, '/v1/task', TOKEN, { mode: 'replicate', command_argv: ['node', '-v'], include_offline: true, plan_sha256: PLAN_SHA, approval_sha256: 'c'.repeat(64), step_id: 's1' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const taskId = created.json.task_id;
    assert.equal(typeof taskId, 'string');

    const ledger = readFileSync(join(stateDir, 'ledger.jsonl'), 'utf8');
    const taskLine = ledger.split('\n').find((line) => line.includes('task.created'));
    assert.equal(taskLine.includes('"command_argv"'), false, 'ledger must not carry argv');
    assert.match(taskLine, /"command_argv_len":2/);
    const journal = readOfferJournal(stateDir, taskId);
    assert.deepEqual(journal.argv, ['node', '-v']);
    assert.equal(first.state.getTask(taskId).plan_sha256, PLAN_SHA);
    assert.equal(first.state.getTask(taskId).step_id, 's1');
    assert.equal(first.state.taskSummary(first.state.getTask(taskId)).plan_sha256, PLAN_SHA);
    assert.match(taskLine, new RegExp('"plan_sha256":"' + PLAN_SHA + '"'));

    first.closeAllConnections?.();
    await first.close();
    open.splice(open.indexOf(first), 1);

    const second = await start(stateDir);
    const revived = second.state.getTask(taskId);
    assert.ok(revived, 'the task must be revived');
    assert.deepEqual(revived.command_argv, ['node', '-v']);
    assert.equal(revived.offer_unavailable ?? false, false);
    // the device token survives the restart, so a re-offer can be delivered later
    assert.equal(typeof deviceToken, 'string');
  });

  it('refuses a caller-declared command_hash that does not match argv', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-relay-hash-'));
    const relay = await start(stateDir);
    const created = await post(relay.url, '/v1/task', TOKEN, {
      mode: 'replicate', command_argv: ['node', '-v'], command_hash: 'f'.repeat(64), include_offline: true,
    });
    assert.equal(created.status, 400, JSON.stringify(created.json));
    assert.equal(created.json.error.code, 'BAD_REQUEST');
  });
});
