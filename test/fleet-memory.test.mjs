/**
 * Shared memory writes: the CAS is the whole feature, so the tests are about what a stale writer sees and what it must
 * NOT be allowed to do -- silently overwrite a record it never read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFleetMemory } from '../src/relay/fleet-memory.mjs';

const memory = () => createFleetMemory({ now: () => 1000 });

describe('append with compare-and-swap', () => {
  it('appends records and bumps the revision', () => {
    const m = memory();
    assert.deepEqual(m.append({ doc: 'd', author_machine_id: 'm-1', records: ['a'] }), { ok: true, revision: 1, appended: 1 });
    assert.equal(m.get('d').revision, 1);
    assert.equal(m.get('d').records[0].text, 'a');
  });

  it('accepts a writer that saw the current revision', () => {
    const m = memory();
    m.append({ doc: 'd', author_machine_id: 'm-1', records: ['a'] });
    assert.equal(m.append({ doc: 'd', author_machine_id: 'm-2', records: ['b'], if_revision: 1 }).ok, true);
    assert.equal(m.get('d').records.length, 2);
  });

  it('refuses a stale writer with the revision and the records it has not read', () => {
    const m = memory();
    m.append({ doc: 'd', author_machine_id: 'm-1', records: ['a'] });
    m.append({ doc: 'd', author_machine_id: 'm-1', records: ['b'] });
    const refused = m.append({ doc: 'd', author_machine_id: 'm-2', records: ['c'], if_revision: 1 });
    assert.equal(refused.code, 'REVISION_CONFLICT');
    assert.equal(refused.detail.revision, 2);
    assert.equal(refused.detail.behind_by, 1);
    assert.equal(refused.detail.unread_records, 1);
    assert.equal(m.get('d').records.length, 2, 'a refused write changes nothing');
  });

  it('refuses empty or malformed input by name', () => {
    const m = memory();
    assert.equal(m.append({ author_machine_id: 'm-1', records: ['a'] }).code, 'BAD_DOC');
    assert.equal(m.append({ doc: 'd', records: ['a'] }).code, 'BAD_AUTHOR');
    assert.equal(m.append({ doc: 'd', author_machine_id: 'm-1', records: [] }).code, 'NO_RECORDS');
    assert.equal(m.append({ doc: 'd', author_machine_id: 'm-1', records: ['a', 5] }).code, 'BAD_RECORD');
  });

  it('refuses past the record cap instead of dropping old records', () => {
    const m = createFleetMemory({ now: () => 1, maxRecords: 2 });
    m.append({ doc: 'd', author_machine_id: 'm-1', records: ['a', 'b'] });
    assert.equal(m.append({ doc: 'd', author_machine_id: 'm-2', records: ['c'] }).code, 'MEMORY_FULL');
    assert.equal(m.get('d').records.length, 2);
  });

  it('keeps documents separate', () => {
    const m = memory();
    m.append({ doc: 'one', author_machine_id: 'm-1', records: ['a'] });
    assert.equal(m.get('two').revision, 0);
  });
});
