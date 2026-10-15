/**
 * Tiered storage suite.
 *
 * The harness is a local copy rather than a shared import, matching the convention in test/health.test.mjs
 * and test/fleet-sync.test.mjs.
 *
 * What these tests protect, said once: this module exists because a filesystem filled to 100% while the
 * only available policy was "never delete", and the fix is that a file's lifetime is declared when it is
 * stored. So the cases below are mostly about **refusals** — a tier that may not be deleted, a key that
 * would escape its directory, a blob that no longer matches its hash. The happy path is one test; the
 * ways it must say no are the rest.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_TEMP_TTL_MS,
  STORAGE_REFUSAL,
  StorageRefusal,
  TIERS,
  UNDELETABLE_TIERS,
  amendLaw,
  createStore,
  putSkill,
} from '../src/agent/storage.mjs';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

/** A controllable clock, so TTL is tested without waiting. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function store(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-store-'));
  cleanup.push(dir);
  const c = options.clock ?? clock();
  return { s: createStore({ dir, now: c.now }), dir, clock: c };
}

describe('storage: temporary data expires on its own', () => {
  it('round-trips a temp blob before its TTL', () => {
    const { s } = store();
    const put = s.put(TIERS.TEMP, 'scratch.txt', 'hello');
    assert.equal(put.ok, true);
    const got = s.get(TIERS.TEMP, 'scratch.txt');
    assert.equal(got.ok, true);
    assert.equal(got.bytes.toString('utf8'), 'hello');
  });

  it('sweeps an expired temp blob and leaves an unexpired one alone', () => {
    const { s, clock: c } = store();
    s.put(TIERS.TEMP, 'old.txt', 'old', { ttlMs: 1000 });
    c.advance(500);
    s.put(TIERS.TEMP, 'fresh.txt', 'fresh', { ttlMs: 10_000 });
    c.advance(600); // old is now 1100ms old, past its 1000ms TTL; fresh is 600ms into 10000ms

    const result = s.sweep();
    assert.deepEqual(result.removed, ['temp/old.txt']);
    assert.equal(s.get(TIERS.TEMP, 'old.txt').ok, false);
    assert.equal(s.get(TIERS.TEMP, 'fresh.txt').ok, true);
  });

  it('defaults the TTL rather than storing something that never expires', () => {
    const { s } = store();
    s.put(TIERS.TEMP, 'a', 'x');
    const entry = s.list(TIERS.TEMP)[0];
    assert.ok(entry.expires_at !== null, 'a temp blob with no expiry is not temporary');
    assert.equal(Date.parse(entry.expires_at) - Date.parse(entry.stored_at), DEFAULT_TEMP_TTL_MS);
  });
});

describe('storage: permanent data cannot be deleted, and that is the feature', () => {
  it('refuses to remove from every undeletable tier', () => {
    // The refusal is the point. `memory.jsonl` is the only durable copy of what a command printed -- the
    // relay keeps hashes and never the text -- so deleting it deletes the fleet's ability to answer what it
    // already tried, and nothing else in the system notices.
    const { s } = store();
    for (const tier of UNDELETABLE_TIERS) {
      s.put(tier, 'thing', 'content');
      assert.throws(
        () => s.remove(tier, 'thing'),
        (e) => e instanceof StorageRefusal && e.code === STORAGE_REFUSAL.UNDELETABLE,
        `${tier} must refuse removal`,
      );
      assert.equal(s.get(tier, 'thing').ok, true, `${tier}/thing must still be there after a refusal`);
    }
  });

  it('names what is at stake in the refusal, rather than saying only "not allowed"', () => {
    const { s } = store();
    s.put(TIERS.PERMANENT, 'memory.jsonl', 'x');
    try {
      s.remove(TIERS.PERMANENT, 'memory.jsonl');
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.detail, /only durable copy/);
      assert.match(e.detail, /Amend rather than delete/);
    }
  });

  it('allows a forced removal, because a rule with no escape hatch gets bypassed instead', () => {
    const { s } = store();
    s.put(TIERS.PERMANENT, 'thing', 'x');
    const forced = s.remove(TIERS.PERMANENT, 'thing', { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.forced, true);
    assert.equal(s.get(TIERS.PERMANENT, 'thing').ok, false);
  });

  it('sweeps only temp, never a permanent blob whose expiry is null', () => {
    // The only automatic deletion in the module, and it is narrow on purpose: it removes what was stored
    // with a TTL that has passed, and nothing decides that a permanent thing became unimportant.
    const { s, clock: c } = store();
    s.put(TIERS.PERMANENT, 'keep', 'p');
    s.put(TIERS.LAW, 'rule', 'r');
    s.put(TIERS.SKILL, 'skill', 's');
    s.put(TIERS.COMPRESSED, 'archive', 'a');
    c.advance(10 * DEFAULT_TEMP_TTL_MS);
    const result = s.sweep();
    assert.deepEqual(result.removed, [], 'nothing outside temp may be swept');
    for (const tier of [TIERS.PERMANENT, TIERS.LAW, TIERS.SKILL, TIERS.COMPRESSED]) {
      assert.equal(s.get(tier, tier === TIERS.PERMANENT ? 'keep' : tier === TIERS.LAW ? 'rule' : tier === TIERS.SKILL ? 'skill' : 'archive').ok, true, tier);
    }
  });
});

describe('storage: compressed stores an archive whole and reads it whole', () => {
  it('round-trips through gzip and reports both sizes', () => {
    const { s } = store();
    const text = 'compressible '.repeat(500);
    const put = s.put(TIERS.COMPRESSED, 'blob.txt', text);
    assert.equal(put.bytes, Buffer.byteLength(text), 'bytes is the uncompressed size');
    assert.ok(put.stored_bytes < put.bytes, `gzip should shrink this (${put.stored_bytes} vs ${put.bytes})`);
    const got = s.get(TIERS.COMPRESSED, 'blob.txt');
    assert.equal(got.ok, true);
    assert.equal(got.bytes.toString('utf8'), text);
    assert.equal(got.entry.encoding, 'gzip');
  });

  it('removes a compressed archive whole, never partially', () => {
    // A partially-deleted archive is not a smaller archive, it is a broken one.
    //
    // The first version of this test ended with `existsSync(join(..., 'nope'))`, an assertion that could
    // never be false and therefore asserted nothing. What it should have checked is that removal leaves no
    // orphan: the blob is gone from disk as well as from the index, because an index that forgets a file
    // still on disk is how a store grows without anything being able to name what is in it.
    const { s, dir } = store();
    s.put(TIERS.COMPRESSED, 'archive', 'x');
    assert.equal(existsSync(join(dir, TIERS.COMPRESSED, 'archive')), true);
    assert.equal(s.remove(TIERS.COMPRESSED, 'archive').ok, true);
    assert.equal(s.get(TIERS.COMPRESSED, 'archive').ok, false);
    assert.equal(existsSync(join(dir, TIERS.COMPRESSED, 'archive')), false, 'the blob must leave the disk too');
    assert.deepEqual(s.list(TIERS.COMPRESSED), [], 'and the index must not remember it');
  });
});

describe('storage: a blob that no longer matches its hash is refused, not returned', () => {
  it('detects tampering and refuses to hand it back under that identity', () => {
    // Returning it would be worse than failing: the caller asked for content by identity, and handing back
    // something else under that identity is how a corrupted archive becomes a wrong answer nobody traces.
    const { s, dir } = store();
    s.put(TIERS.PERMANENT, 'important', 'original');
    writeFileSync(join(dir, TIERS.PERMANENT, 'important'), 'tampered');
    const got = s.get(TIERS.PERMANENT, 'important');
    assert.equal(got.ok, false);
    assert.equal(got.reason_code, STORAGE_REFUSAL.HASH_MISMATCH);
    assert.notEqual(got.expected, got.actual);
  });

  it('reports a missing blob as not found rather than as empty', () => {
    const { s } = store();
    const got = s.get(TIERS.PERMANENT, 'never-stored');
    assert.equal(got.ok, false);
    assert.equal(got.reason_code, STORAGE_REFUSAL.NOT_FOUND);
    assert.equal('bytes' in got, false, 'absence must not look like empty content');
  });

  it('names what verify finds rather than counting it', () => {
    const { s, dir } = store();
    s.put(TIERS.PERMANENT, 'present', 'a');
    s.put(TIERS.PERMANENT, 'corrupted', 'b');
    s.put(TIERS.PERMANENT, 'vanished', 'c');
    writeFileSync(join(dir, TIERS.PERMANENT, 'corrupted'), 'changed');
    rmSync(join(dir, TIERS.PERMANENT, 'vanished'));

    const v = s.verify();
    assert.equal(v.checked, 3);
    assert.deepEqual(v.missing, ['permanent/vanished']);
    assert.deepEqual(v.mismatched, ['permanent/corrupted']);
    assert.equal(v.ok, false);
  });

  it('is ok when everything matches, so a clean result is distinguishable from a broken one', () => {
    const { s } = store();
    s.put(TIERS.PERMANENT, 'a', 'x');
    s.put(TIERS.COMPRESSED, 'b', 'y');
    const v = s.verify();
    assert.equal(v.ok, true);
    assert.deepEqual(v.missing, []);
    assert.deepEqual(v.mismatched, []);
  });
});

describe('storage: keys cannot escape their tier directory', () => {
  it('refuses a key containing .. or one that is absolute', () => {
    // Keys become filenames. A key that can escape its tier is a way to write anywhere the process can.
    const { s } = store();
    for (const bad of ['../escape', 'a/../../b', '/etc/passwd', 'C:/Windows/x', '', '   ']) {
      assert.throws(() => s.put(TIERS.TEMP, bad, 'x'), (e) => e.code === STORAGE_REFUSAL.NO_KEY, `put ${JSON.stringify(bad)}`);
      assert.throws(() => s.get(TIERS.TEMP, bad), (e) => e.code === STORAGE_REFUSAL.NO_KEY, `get ${JSON.stringify(bad)}`);
    }
  });

  it('accepts a nested key and creates the parent directory', () => {
    const { s } = store();
    const put = s.put(TIERS.PERMANENT, 'a/b/c.txt', 'nested');
    assert.equal(put.ok, true);
    assert.equal(s.get(TIERS.PERMANENT, 'a/b/c.txt').bytes.toString('utf8'), 'nested');
  });

  it('refuses an unknown tier rather than inventing a directory', () => {
    const { s } = store();
    assert.throws(() => s.put('nowhere', 'k', 'x'), (e) => e.code === STORAGE_REFUSAL.UNKNOWN_TIER);
  });
});

describe('storage: laws are amended, never replaced', () => {
  it('keeps the chain, because "what did it used to say" explains the old behaviour', () => {
    const { s, clock: c } = store();
    const first = amendLaw(s, 'fleet-rule-1', 'merge automatically', { by: 'operator', why: 'initial', now: c.now });
    assert.equal(first.superseded, false);
    assert.equal(first.amendments, 1);

    c.advance(1000);
    const second = amendLaw(s, 'fleet-rule-1', 'merge automatically except when published', { by: 'operator', why: 'found the published-divergence hazard', now: c.now });
    assert.equal(second.superseded, true);
    assert.equal(second.amendments, 2);

    const got = s.get(TIERS.LAW, 'fleet-rule-1');
    const body = JSON.parse(got.bytes.toString('utf8'));
    assert.equal(body.text, 'merge automatically except when published');
    assert.equal(body.amendments.length, 2);
    assert.equal(body.amendments[0].why, 'initial');
    assert.equal(body.amendments[1].why, 'found the published-divergence hazard');
    assert.equal(body.amendments[1].supersedes_sha256, first.sha256, 'the chain must name what it replaced');
  });

  it('still refuses deletion afterwards, because amending is not removing', () => {
    const { s } = store();
    amendLaw(s, 'rule', 'v1');
    amendLaw(s, 'rule', 'v2');
    assert.throws(() => s.remove(TIERS.LAW, 'rule'), (e) => e.code === STORAGE_REFUSAL.UNDELETABLE);
  });
});

describe('storage: skills are capabilities, kept forever', () => {
  it('stores and refuses to delete one', () => {
    const { s } = store();
    const written = putSkill(s, 'run-ci', { description: 'run the builtin gates', body: 'node --test', entry: 'scripts/ci.sh' });
    assert.equal(written.ok, true);
    const got = s.get(TIERS.SKILL, 'run-ci');
    const record = JSON.parse(got.bytes.toString('utf8'));
    assert.equal(record.name, 'run-ci');
    assert.equal(record.entry, 'scripts/ci.sh');
    assert.throws(() => s.remove(TIERS.SKILL, 'run-ci'), (e) => e.code === STORAGE_REFUSAL.UNDELETABLE);
  });

  it('survives a sweep with no TTL, unlike temp', () => {
    const { s, clock: c } = store();
    putSkill(s, 'keep-me', { description: 'x' });
    s.put(TIERS.TEMP, 'drop-me', 'x', { ttlMs: 10 });
    c.advance(1000);
    s.sweep();
    assert.equal(s.get(TIERS.SKILL, 'keep-me').ok, true);
    assert.equal(s.get(TIERS.TEMP, 'drop-me').ok, false);
  });
});

describe('storage: the manifest is the index and it survives', () => {
  it('reports usage per tier, so a health check can see growth', () => {
    const { s } = store();
    s.put(TIERS.PERMANENT, 'a', 'x'.repeat(100));
    s.put(TIERS.COMPRESSED, 'b', 'y'.repeat(1000));
    const usage = s.usage();
    assert.equal(usage[TIERS.PERMANENT].files, 1);
    assert.equal(usage[TIERS.PERMANENT].bytes, 100);
    assert.equal(usage[TIERS.COMPRESSED].files, 1);
    assert.ok(usage[TIERS.COMPRESSED].bytes < 1000, 'compressed usage should be the stored size');
  });

  it('survives a reopen, so a restart does not lose the index', () => {
    const { s, dir } = store();
    s.put(TIERS.PERMANENT, 'a', 'value');
    const reopened = createStore({ dir });
    const got = reopened.get(TIERS.PERMANENT, 'a');
    assert.equal(got.ok, true);
    assert.equal(got.bytes.toString('utf8'), 'value');
  });

  it('reports a corrupt manifest rather than rebuilding by guessing', () => {
    // Rebuilding would silently adopt files nobody declared, which is the opposite of the property the
    // manifest is for.
    const { s, dir } = store();
    s.put(TIERS.PERMANENT, 'a', 'value');
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    assert.equal(s._internals.readManifest().corrupt, true);
    // And a get on a blob whose entry is gone returns the content without a hash to check it against,
    // rather than pretending the manifest was fine.
    const got = s.get(TIERS.PERMANENT, 'a');
    assert.equal(got.ok, true);
    assert.equal(got.entry, null);
  });

  it('writes the manifest atomically, so a crash cannot leave a half-written index', () => {
    const { s, dir } = store();
    s.put(TIERS.PERMANENT, 'a', 'x');
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal(existsSync(join(dir, 'manifest.json.tmp')), false, 'the temp file must have been moved into place');
    assert.ok(statSync(join(dir, 'manifest.json')).size > 0);
  });
});
