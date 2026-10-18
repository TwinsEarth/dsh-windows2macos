/**
 * Which material a fleet-chat conversation is keyed from.
 *
 * The bug this covers reached a user: the panel answered "this machine has no fleet-chat identity yet" on a machine that
 * was paired and online. Two causes, both structural -- identity was read with a reader that returns empty when
 * `stateDir` is unset, and the account material was read from a scope that cannot see the fleet key. The second one is
 * what these tests pin: a missing account key must degrade to the machine scope and SAY so, never refuse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationBasis } from '../src/plugin/fleet-chat-route.mjs';

describe('a conversation is keyed from the account when it can be', () => {
  it('uses the account material and reports that basis', () => {
    assert.deepEqual(conversationBasis({ machineId: 'm-1', accountMaterial: 'fleet-key' }), {
      basis: 'account:fleet-key',
      source: 'account',
    });
  });

  it('falls back to the machine scope, and says so, when the account is not resolved yet', () => {
    // This is the shape that used to be a refusal. A panel that cannot answer at all is worse than one that answers for
    // this machine until the account join lands.
    assert.deepEqual(conversationBasis({ machineId: 'm-1', accountMaterial: null }), {
      basis: 'machine:m-1',
      source: 'machine',
    });
    assert.equal(conversationBasis({ machineId: 'm-1', accountMaterial: '   ' }).source, 'machine');
  });

  it('refuses only when there is no machine at all', () => {
    assert.equal(conversationBasis({ machineId: null, accountMaterial: 'fleet-key' }), null);
    assert.equal(conversationBasis({}), null);
  });

  it('separates two machines on the machine basis, and unites them on the account basis', () => {
    const a = conversationBasis({ machineId: 'm-1', accountMaterial: null }).basis;
    const b = conversationBasis({ machineId: 'm-2', accountMaterial: null }).basis;
    assert.notEqual(a, b, 'without an account, two machines are two conversations');
    const x = conversationBasis({ machineId: 'm-1', accountMaterial: 'K' }).basis;
    const y = conversationBasis({ machineId: 'm-2', accountMaterial: 'K' }).basis;
    assert.equal(x, y, 'with an account, two machines in one project share the conversation');
  });
});
