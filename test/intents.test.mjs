/**
 * The intent catalog: the closed set that turns "run the tests" into an allow-listed argv -- and refuses everything else
 * by name. These tests exist because the whole point of the catalog is what it will NOT do.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS, listIntents, resolveIntent } from '../src/plugin/intents.mjs';

const ALLOWED = ['node --test', 'node --version', 'git status --porcelain', 'git rev-parse HEAD'];

describe('known intents map to their documented argv', () => {
  it('maps each read intent exactly', () => {
    assert.deepEqual(resolveIntent({ action: 'run-tests' }).argv, ['node', '--test']);
    assert.deepEqual(resolveIntent({ action: 'git-head' }).argv, ['git', 'rev-parse', 'HEAD']);
  });

  it('carries a parameter through a typed intent', () => {
    const resolved = resolveIntent({ action: 'shard-probe', params: { n: 3 } });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.argv, ['node', 'src/shard.mjs', '3']);
  });

  it('lists the catalog without duplicating it', () => {
    const listed = listIntents();
    assert.equal(listed.length, Object.keys(INTENTS).length);
    assert.ok(listed.every((item) => typeof item.action === 'string' && typeof item.description === 'string'));
  });
});

describe('everything else is refused by name', () => {
  it('refuses a missing action', () => {
    assert.equal(resolveIntent({}).code, 'INTENT_MISSING');
  });

  it('refuses an unknown action and lists what exists', () => {
    const refused = resolveIntent({ action: 'delete-everything' });
    assert.equal(refused.code, 'INTENT_UNKNOWN');
    assert.ok(refused.detail.known.includes('run-tests'));
  });

  it('refuses an unknown parameter instead of ignoring it', () => {
    assert.equal(resolveIntent({ action: 'run-tests', params: { shell: 'rm -rf /' } }).code, 'INTENT_PARAM_UNKNOWN');
  });

  it('refuses a parameter that is not the declared type', () => {
    assert.equal(resolveIntent({ action: 'shard-probe', params: { n: -1 } }).code, 'INTENT_PARAM_INVALID');
    assert.equal(resolveIntent({ action: 'shard-probe', params: { n: '3; rm -rf /' } }).code, 'INTENT_PARAM_INVALID');
  });

  it('refuses a command the machine allow-list does not carry', () => {
    const refused = resolveIntent({ action: 'fleet-facts' }, { allowedCommands: ALLOWED });
    assert.equal(refused.code, 'INTENT_NOT_ALLOWED');
    assert.ok(refused.detail.allowedCommands.includes('node --test'));
  });

  it('allows a command the machine allow-list does carry', () => {
    assert.equal(resolveIntent({ action: 'run-tests' }, { allowedCommands: ALLOWED }).ok, true);
  });
});
