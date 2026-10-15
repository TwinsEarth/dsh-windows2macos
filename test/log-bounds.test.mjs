/**
 * Log-bounds suite: the rate detector, the method choice, and the refusals.
 *
 * What these protect, said once: this module exists because two machines filled up, and the way it goes wrong
 * is not "it missed a large file" — it is **it deleted something that could not be regenerated**. So the
 * refusals and the method choice carry most of the tests here, and the two rate cases are built from the
 * measured incidents rather than from round numbers.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FILE_CRITICAL_BYTES,
  FILE_WARN_BYTES,
  METHOD,
  PROTECTED_NAMES,
  RATE_WARN_BYTES_PER_DAY,
  apply,
  classFor,
  growth,
  isProtected,
  logrotateConfig,
  methodFor,
  plan,
  snapshot,
} from '../src/agent/log-bounds.mjs';

const GB = 1024 ** 3;
const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

/**
 * A fixture root that is a plain directory, not a system temp directory.
 *
 * Two reasons, and the second one is why this changed:
 *
 *   * `mkdtempSync(tmpdir())` puts a `tmp` segment in the path, and `methodFor` treats a `tmp` segment as
 *     removable — so a fixture written to test a *refusal* was legitimately classified as removable. The
 *     code was right and the fixture was wrong.
 *   * **`/var/tmp` on macOS is a symlink to `/private/var/tmp`**, and `resolve()` does not follow symlinks, so
 *     a path built from the symlinked form does not share a prefix with the resolved one and the protection
 *     check computes the wrong relative path. That is what made this suite fail on MacMini while passing
 *     here — a platform difference that only a real second machine exposes.
 *
 * A plain subdirectory of the repository avoids both. The suite's `after` hook removes what it created, and a
 * `.gitignore` in the parent means an interrupted run cannot leave anything committed.
 */
function tree() {
  const base = fileURLToPath(new URL('../.test-fixtures/', import.meta.url));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, '.gitignore'), '*\n');
  const root = mkdtempSync(join(base, 'logs-'));
  cleanup.push(root);
  return root;
}

/**
 * ## There is no macOS skip here any more, and the reason it existed was a bug in my parser
 *
 * This suite was skipped on macOS for three rounds because it appeared to fail there with an
 * \`AssertionError\`. **It never failed.** The tooling that read its result was looking for a summary line
 * beginning \`# fail 0\`, and node v24 writes \`fail 0\` behind an information symbol instead. With the guard
 * temporarily removed on MacMini and the corrected parser in place, the measured result was **28 tests, 0
 * failures** -- and the same run reported \`28 test(s), 0 failed\`, read from stdout in the \`info\` format.
 *
 * What that cost, recorded so the shape of the mistake is recognisable next time: two rounds of probes that
 * ruled out every filesystem hypothesis (all correctly -- repository present, module loads, \`mkdirSync\`,
 * \`mkdtempSync\` and \`writeFileSync\` all fine), because the hypothesis being tested had been derived from a
 * bad premise. **The premise was never measured.** One command that printed the raw output would have shown
 * the prefix immediately, and should have been the first thing run rather than the last.
 *
 * The parser now lives in \`src/agent/test-report.mjs\` with its own suite, accepts both prefixes, reads both
 * streams and reports which one answered -- so the next person does not have to discover this again.
 */

describe('log bounds: a rate is measured between two samples, not read from mtime', () => {
  it('reports a file that grew past the threshold, with the rate it grew at', () => {
    // The MacMini case: 40x in a day. Modelled as 4 GB over 6 hours, which is 16 GB/day.
    const before = new Map([['/x/relay-test.log', 100 * 1024 * 1024]]);
    const after = new Map([['/x/relay-test.log', (100 * 1024 * 1024) + 4 * GB]]);
    const r = growth(before, after, 6 * 60 * 60 * 1000);
    assert.equal(r.unreadable, false);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].bytes_per_day, 16 * GB);
    assert.equal(r.findings[0].new_file, false);
  });

  it('marks a file that did not exist before as a new writer', () => {
    // A writer that appeared is a different diagnosis from one that accelerated: the first is a new process,
    // the second is a changed process, and they are investigated differently.
    const r = growth(new Map(), new Map([['/x/new.log', 2 * GB]]), 24 * 60 * 60 * 1000);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].new_file, true);
  });

  it('ignores a file that shrank, because a rotation is not growth', () => {
    const before = new Map([['/x/a.log', 8 * GB]]);
    const after = new Map([['/x/a.log', 1024]]);
    assert.deepEqual(growth(before, after, 86_400_000).findings, []);
  });

  it('is exactly at the threshold both ways', () => {
    const at = (bytes) => growth(new Map([['/x/a.log', 0]]), new Map([['/x/a.log', bytes]]), 86_400_000).findings.length;
    assert.equal(at(RATE_WARN_BYTES_PER_DAY - 1), 0);
    assert.equal(at(RATE_WARN_BYTES_PER_DAY), 1);
  });

  it('refuses to compute a rate from an unusable interval', () => {
    // Zero or negative elapsed means the samples are simultaneous or reversed. Reporting a rate from either
    // would be arithmetic on a number that means nothing.
    for (const bad of [0, -1, Number.NaN, undefined]) {
      const r = growth(new Map([['/x/a.log', 0]]), new Map([['/x/a.log', 5 * GB]]), bad);
      assert.equal(r.unreadable, true, `elapsedMs=${bad}`);
      assert.deepEqual(r.findings, []);
    }
  });

  it('orders findings by rate, so the worst writer is first', () => {
    const before = new Map([['/x/slow.log', 0], ['/x/fast.log', 0]]);
    const after = new Map([['/x/slow.log', 2 * GB], ['/x/fast.log', 9 * GB]]);
    const r = growth(before, after, 86_400_000);
    assert.equal(r.findings[0].path, '/x/fast.log');
  });
});

describe('log bounds: the method is chosen, and truncate exists for a reason', () => {
  it('truncates a log rather than removing it', () => {
    // The 2026-10-14 recovery: `rm` on a file rsyslog still held open freed nothing while appearing to
    // succeed. For anything a process is writing, truncation is the correct method.
    for (const p of ['/var/log/syslog.log', '/x/relay-test.out', '/var/log/w2m/daemon.err', 'C:\\logs\\a.log']) {
      assert.equal(methodFor(p), METHOD.TRUNCATE, p);
    }
  });

  it('removes build output and temp files, which nothing is writing', () => {
    for (const p of ['/x/node_modules', '/x/dist', '/x/target', '/tmp/scratch.tmp']) {
      assert.equal(methodFor(p), METHOD.REMOVE, p);
    }
  });

  it('reports anything that is not a log, a build artefact or a temp file', () => {
    // The default is to do nothing. A file this module does not recognise is a file somebody has to look at.
    for (const p of ['/x/data.sqlite', '/x/archive.tar.gz', '/x/notes.md']) {
      assert.equal(methodFor(p), METHOD.REPORT_ONLY, p);
    }
  });

  it('classifies rebuildable separately from disposable, so the rebuildable is preferred', () => {
    assert.equal(classFor('/x/node_modules'), 'rebuildable');
    assert.equal(classFor('/x/dist/bundle.js'), 'rebuildable');
    assert.equal(classFor('/x/a.log'), 'disposable');
    assert.equal(classFor('/x/mystery.bin'), 'unknown');
  });
});

describe('log bounds: what is protected, and the reason is carried', () => {
  it('protects the named irreplaceable files wherever they are', () => {
    // memory.jsonl is the only durable copy of what a command printed; the relay keeps hashes and never the
    // text. Losing device.key makes every peer holding the old one refuse this machine with no visible cause.
    const root = tree();
    for (const name of PROTECTED_NAMES) {
      const guard = isProtected(join(root, 'some', 'deep', name), root);
      assert.equal(guard.protected, true, name);
      assert.ok(guard.reason.length > 0, `${name} must carry a reason`);
    }
  });

  it('protects the tree and the data directory by prefix, not by name', () => {
    const root = tree();
    for (const p of ['src/agent/agent.mjs', '.git/objects/x', 'profiles/desktop/state.json']) {
      assert.equal(isProtected(join(root, p), root).protected, true, p);
    }
  });

  it('does not protect node_modules or dist, which is what makes them cleanup targets', () => {
    const root = tree();
    assert.equal(isProtected(join(root, 'node_modules/x/index.js'), root).protected, false);
    assert.equal(isProtected(join(root, 'dist/bundle.js'), root).protected, false);
  });

  it('lists a protected path it found rather than silently omitting it', () => {
    // A report that drops the database is indistinguishable from one where the database was not there.
    const root = tree();
    const sizes = new Map([[join(root, 'profiles', 'desktop', 'memory.jsonl'), 5 * GB]]);
    const p = plan({ root, sizes });
    assert.equal(p.proposals.length, 0);
    assert.equal(p.protected.length, 1);
    assert.match(p.protected[0].reason, /irreplaceable/);
    assert.equal(p.protected[0].triggered_by, 'absolute');
  });
});

describe('log bounds: acting refuses what it must', () => {
  it('refuses a protected path even when asked directly', () => {
    // `apply` re-checks the guard rather than trusting the plan: a plan is data that may have been
    // serialised, filtered or hand-edited between being made and being applied.
    const root = tree();
    const r = apply(join(root, 'profiles', 'desktop', 'memory.jsonl'), root, { truncate: () => 'truncated' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /refused/);
  });

  it('refuses a path it would only report on', () => {
    // The fixture path must not contain a `tmp`/`temp` segment, or the file is legitimately a removal target.
    // `tree()` now guarantees that; the first version used `tmpdir()` and was wrong twice over.
    const root = tree();
    const r = apply(join(root, 'data.sqlite'), root, { truncate: () => 'truncated' });
    assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
    assert.equal(r.method, METHOD.REPORT_ONLY);
  });

  it('refuses to act at all without a truncate function', () => {
    // No filesystem side effect should be reachable from a call that did not supply the mechanism.
    const root = tree();
    const r = apply(join(root, 'a.log'), root, {});
    assert.equal(r.ok, false);
    assert.match(r.detail, /no truncate function/);
  });

  it('performs the chosen method and reports it', () => {
    const root = tree();
    const seen = [];
    const logs = apply(join(root, 'a.log'), root, { truncate: (p, m) => { seen.push([p, m]); return 'truncated 10 bytes'; } });
    assert.equal(logs.ok, true);
    assert.equal(logs.method, METHOD.TRUNCATE);
    const dist = apply(join(root, 'dist'), root, { truncate: (p, m) => { seen.push([p, m]); return 'removed'; } });
    assert.equal(dist.method, METHOD.REMOVE);
    assert.deepEqual(seen.map(([, m]) => m), [METHOD.TRUNCATE, METHOD.REMOVE]);
  });

  it('reports a failure rather than throwing', () => {
    const root = tree();
    const r = apply(join(root, 'a.log'), root, { truncate: () => { throw new Error('EACCES'); } });
    assert.equal(r.ok, false);
    assert.match(r.detail, /EACCES/);
  });
});

describe('log bounds: the plan orders by severity then size', () => {
  it('puts the incident above the tidying', () => {
    const root = tree();
    const sizes = new Map([
      [join(root, 'a.log'), FILE_WARN_BYTES + 1],
      [join(root, 'b.log'), FILE_CRITICAL_BYTES + 1],
    ]);
    const p = plan({ root, sizes });
    assert.equal(p.proposals.length, 2);
    assert.equal(p.proposals[0].severity, 'critical');
    assert.match(p.proposals[0].path, /b\.log/);
  });

  it('is at the size threshold both ways', () => {
    const root = tree();
    const at = (bytes) => plan({ root, sizes: new Map([[join(root, 'a.log'), bytes]]) }).proposals.length;
    assert.equal(at(FILE_WARN_BYTES - 1), 0);
    assert.equal(at(FILE_WARN_BYTES), 1);
    assert.equal(at(FILE_CRITICAL_BYTES), 1);
    assert.equal(plan({ root, sizes: new Map([[join(root, 'a.log'), FILE_CRITICAL_BYTES]]) }).proposals[0].severity, 'critical');
  });

  it('carries method and class on every proposal, so the caller needs no second lookup', () => {
    const root = tree();
    const p = plan({ root, sizes: new Map([[join(root, 'node_modules'), FILE_CRITICAL_BYTES]]) });
    assert.equal(p.proposals[0].method, METHOD.REMOVE);
    assert.equal(p.proposals[0].class, 'rebuildable');
    assert.equal(p.proposals[0].triggered_by, 'absolute');
  });
});

describe('log bounds: the logrotate configuration says the things that matter', () => {
  it('sets copytruncate, without which rotation leaves the disk full', () => {
    // Rename-only rotation keeps the daemon writing to the old descriptor: the new file stays empty and the
    // space is not freed. That is the 2026-10-14 failure in a different costume.
    const cfg = logrotateConfig(['/var/log/w2m/*.log']);
    assert.match(cfg, /copytruncate/);
    assert.match(cfg, /maxsize 256M/);
    assert.match(cfg, /compress/);
    assert.match(cfg, /missingok/);
    assert.match(cfg, /\/var\/log\/w2m\/\*\.log \{/);
  });

  it('sets maxsize as well as a schedule, for the 40x-a-day case', () => {
    const cfg = logrotateConfig(['/x/a.log'], { maxsize: '64M', frequency: 'hourly', rotate: 3 });
    assert.match(cfg, /hourly/);
    assert.match(cfg, /maxsize 64M/);
    assert.match(cfg, /rotate 3/);
    assert.doesNotMatch(cfg, /daily/);
  });

  it('emits one block per path and nothing for an empty list', () => {
    assert.equal(logrotateConfig([]).trim().split('\n').every((l) => l.startsWith('#') || l === ''), true);
    const two = logrotateConfig(['/a.log', '/b.log']);
    assert.equal((two.match(/\{/g) ?? []).length, 2);
  });
});

describe('log bounds: a snapshot is bounded, and says when it was cut short', () => {
  it('reads real sizes from a real tree', () => {
    const root = tree();
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.log'), 'x'.repeat(100));
    writeFileSync(join(root, 'sub', 'b.log'), 'y'.repeat(50));
    const s = snapshot(root);
    assert.equal(s.get(join(root, 'a.log')), 100);
    assert.equal(s.get(join(root, 'sub', 'b.log')), 50);
  });

  it('stops at maxFiles rather than walking a whole filesystem', () => {
    // The reason this bound exists is on record: the health check that walked a home directory exceeded the
    // fleet's ~50-second lease ceiling and failed with no result at all.
    const root = tree();
    for (let i = 0; i < 20; i += 1) writeFileSync(join(root, `f${i}.log`), 'x');
    assert.equal(snapshot(root, { maxFiles: 5 }).size, 5);
    assert.equal(snapshot(root, { maxFiles: 100 }).size, 20);
  });

  it('returns nothing for a path that does not exist, rather than throwing', () => {
    assert.equal(snapshot(join(tree(), 'no-such-dir')).size, 0);
  });
});
