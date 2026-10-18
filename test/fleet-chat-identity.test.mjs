/**
 * Which material a fleet-chat conversation is keyed from.
 *
 * The operator's rule, after one simplification: **one relay is one group**. Every machine talking to the same relay shares
 * one conversation, whatever project it works on. Two earlier bases were tried and removed: keying on the host's
 * `process.cwd()` differed per machine, and keying on account + project name split a fleet into one stream per project.
 * Both produced the same report -- "互相收不到队员聊天信息" -- so both are now guarded by these tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationBasis } from '../src/plugin/fleet-chat-route.mjs';

describe('one relay is one group', () => {
  it('gives every machine on the same relay the same basis', () => {
    const a = conversationBasis({ machineId: 'm-1', relayUrl: 'http://relay:8787' });
    const b = conversationBasis({ machineId: 'm-2', relayUrl: 'http://relay:8787/' });
    assert.equal(a.source, 'fleet');
    assert.equal(a.basis, b.basis, 'a trailing slash is the same relay');
  });

  it('ignores the project and the account, because either would split the fleet', () => {
    const base = { machineId: 'm-1', relayUrl: 'http://relay:8787' };
    const plain = conversationBasis(base);
    const withExtras = conversationBasis({ ...base, project: 'some-project', accountMaterial: 'K' });
    assert.equal(plain.basis, withExtras.basis);
  });

  it('separates different relays', () => {
    const a = conversationBasis({ machineId: 'm-1', relayUrl: 'http://relay-a:8787' });
    const b = conversationBasis({ machineId: 'm-1', relayUrl: 'http://relay-b:8787' });
    assert.notEqual(a.basis, b.basis);
  });

  it('falls back to the machine only when no relay is configured, and refuses without a machine', () => {
    const a = conversationBasis({ machineId: 'm-1' });
    assert.equal(a.source, 'machine');
    assert.equal(conversationBasis({}), null);
    assert.equal(conversationBasis({ relayUrl: 'http://relay:8787' }), null);
  });
});