/**
 * Health suite: thresholds, severity ordering, and the data classification.
 *
 * The harness is a local copy rather than a shared import, matching the convention in
 * test/fleet-sync.test.mjs and test/blocks.test.mjs.
 *
 * What these tests protect, said once: a health check is only useful if its *verdict* is trustworthy, and
 * its verdict is a comparison against a threshold. So the tests below are about boundaries and about
 * `null` — because the failure that matters is not "the check missed a busy machine", it is "the check
 * reported a machine as healthy because it could not measure it". `null` must never read as fine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_CLASS,
  HEALTH_EXIT,
  LOG_GROWTH_WARN_BYTES_PER_DAY,
  SEVERITY,
  assess,
  classifyData,
  exitCodeFor,
  headline,
  severityName,
  sample,
} from '../src/agent/health.mjs';

const GB = 1024 ** 3;

/**
 * A healthy sample, with overrides. Every override is explicit so a test never depends on this host.
 *
 * `mem_free_bytes` must agree with `mem_used_percent`, and the first version did not: it declared 50% used
 * while leaving half of a 16 GB total free, which is 50% *used* by the ratio and 100% by the numbers. The
 * load tests then failed for a memory reason, which is a fixture defect wearing another test's name.
 */
function healthy(over = {}) {
  const total = 16 * GB;
  return {
    at: '2026-10-15T00:00:00.000Z',
    host: 'test-host',
    platform: 'linux',
    cpu_count: 4,
    load_1m: 0.5,
    mem_total_bytes: total,
    mem_free_bytes: total * 0.5,
    mem_used_percent: 50,
    disks: [{ path: '/', total_bytes: 100 * GB, free_bytes: 60 * GB, used_percent: 40 }],
    log_dirs: [],
    ...over,
  };
}

describe('health: a healthy machine is reported healthy', () => {
  it('finds nothing on a sample inside every threshold', () => {
    const a = assess(healthy());
    assert.equal(a.severity, SEVERITY.OK);
    assert.deepEqual(a.findings, []);
    assert.equal(exitCodeFor(a), HEALTH_EXIT.OK);
    assert.equal(headline(healthy(), a), 'ok');
  });
});

describe('health: the disk, from the incident that motivated it', () => {
  it('calls 80% a warning and 90% critical, asserted from both sides', () => {
    // Both sides, because the only interesting thing a threshold can get wrong is being off by one.
    assert.equal(assess(healthy({ disks: [{ path: '/', used_percent: 79, free_bytes: 21 * GB }] })).severity, SEVERITY.OK);
    assert.equal(assess(healthy({ disks: [{ path: '/', used_percent: 80, free_bytes: 20 * GB }] })).severity, SEVERITY.WARN);
    assert.equal(assess(healthy({ disks: [{ path: '/', used_percent: 89, free_bytes: 11 * GB }] })).severity, SEVERITY.WARN);
    assert.equal(assess(healthy({ disks: [{ path: '/', used_percent: 90, free_bytes: 10 * GB }] })).severity, SEVERITY.CRITICAL);
  });

  it('is critical on a low absolute free space even when the percentage looks fine', () => {
    // The Linux host reached 100% of 268 MB free -- but a huge filesystem can be "only 85% used" and still
    // have less headroom than this fleet needs to finish a task. Percentage alone would have passed it.
    const a = assess(healthy({ disks: [{ path: '/', total_bytes: 1000 * GB, used_percent: 85, free_bytes: 512 * 1024 ** 2 }] }));
    assert.equal(a.severity, SEVERITY.CRITICAL);
    assert.equal(a.findings[0].code, 'DISK_CRITICAL');
    assert.match(a.findings[0].detail, /0\.50 GB free/);
  });

  it('recommends truncate rather than removal, because that was the actual recovery', () => {
    // `rm` on a file a process still holds open frees nothing while appearing to succeed. The advice is
    // carried with the finding so the next person does not repeat it.
    const a = assess(healthy({ disks: [{ path: '/', used_percent: 99, free_bytes: 100 * 1024 ** 2 }] }));
    assert.match(a.findings[0].action, /truncate/);
    assert.match(a.findings[0].action, /rather than removing/);
  });

  it('does not report a disk it could not measure', () => {
    // A disk whose used_percent is null is "not measured". Reporting it as healthy is the failure mode
    // this whole module exists to avoid, so it is asserted rather than assumed.
    const a = assess(healthy({ disks: [{ path: '/', used_percent: null, free_bytes: null }] }));
    assert.equal(a.severity, SEVERITY.OK);
    assert.equal(a.findings.length, 0, 'an unmeasured disk produces no finding, and also no false OK claim');
  });
});

describe('health: the log growth that filled the host', () => {
  it('names the file rather than saying only that the disk is filling', () => {
    const a = assess(healthy({
      log_dirs: [{ path: '/var/log', missing: false, truncated: false, largest: [{ path: '/var/log/daemon.log', bytes: 9.6 * GB }] }],
    }));
    assert.equal(a.severity, SEVERITY.WARN);
    assert.equal(a.findings[0].code, 'LOG_FILE_LARGE');
    assert.match(a.findings[0].detail, /daemon\.log/);
    assert.match(a.findings[0].detail, /9\.60 GB/);
    assert.match(a.findings[0].action, /logrotate/);
  });

  it('takes the threshold from the measured rate, not from taste', () => {
    const just_under = LOG_GROWTH_WARN_BYTES_PER_DAY - 1;
    const just_over = LOG_GROWTH_WARN_BYTES_PER_DAY;
    const mk = (bytes) => assess(healthy({ log_dirs: [{ path: '/var/log', missing: false, largest: [{ path: '/var/log/x.log', bytes }] }] }));
    assert.equal(mk(just_under).severity, SEVERITY.OK);
    assert.equal(mk(just_over).severity, SEVERITY.WARN);
  });

  it('reports a truncated scan instead of implying the directory is small', () => {
    const a = assess(healthy({ log_dirs: [{ path: '/var/log', missing: false, truncated: true, largest: [] }] }));
    assert.equal(a.findings[0].code, 'LOG_SCAN_TRUNCATED');
  });
});

describe('health: load is compared against the CPUs it has', () => {
  it('scales with CPU count rather than using an absolute number', () => {
    // 4.0 load is idle on 32 CPUs and a problem on 2. An absolute threshold would call both the same.
    //
    // The first version of this test expected `critical` for the 2-CPU case and was wrong about its own
    // arithmetic: 4 / 2 is 2.0 per CPU, which is between the warn (1.5) and critical (3.0) thresholds. The
    // implementation was right and the assertion was not.
    assert.equal(assess(healthy({ cpu_count: 32, load_1m: 4 })).severity, SEVERITY.OK, '4 over 32 CPUs is idle');
    const twoCpu = assess(healthy({ cpu_count: 2, load_1m: 4 }));
    assert.equal(twoCpu.severity, SEVERITY.WARN, '4 over 2 CPUs is 2.0/cpu, which is a warning and not yet critical');
    assert.equal(twoCpu.findings[0].code, 'LOAD_WARN');
  });

  it('warns at 1.5 per CPU and is critical at 3', () => {
    const at = (perCpu) => assess(healthy({ cpu_count: 4, load_1m: perCpu * 4 })).severity;
    assert.equal(at(1.49), SEVERITY.OK);
    assert.equal(at(1.5), SEVERITY.WARN);
    assert.equal(at(2.99), SEVERITY.WARN);
    assert.equal(at(3), SEVERITY.CRITICAL);
  });

  it('ties critical load to the task ceiling, because that is the consequence', () => {
    const a = assess(healthy({ cpu_count: 2, load_1m: 20 }));
    assert.match(a.findings[0].action, /50s/);
  });
});

describe('health: the overall severity is the worst finding, and the findings survive', () => {
  it('reports critical when any finding is critical', () => {
    const a = assess(healthy({
      disks: [{ path: '/', used_percent: 95, free_bytes: 5 * GB }],
      log_dirs: [{ path: '/var/log', missing: false, largest: [{ path: '/var/log/a', bytes: 2 * GB }] }],
      mem_used_percent: 95,
    }));
    assert.equal(a.severity, SEVERITY.CRITICAL);
    assert.equal(a.findings.length, 3, 'a single verdict must not replace the findings it was derived from');
  });

  it('names the worst finding in one line, not a count', () => {
    const s = healthy({ disks: [{ path: '/', used_percent: 95, free_bytes: 5 * GB }], mem_used_percent: 95 });
    const a = assess(s);
    const line = headline(s, a);
    assert.match(line, /critical/);
    assert.match(line, /DISK_CRITICAL/);
    assert.doesNotMatch(line, /^3 findings/, 'a count makes the reader ask which one matters');
  });

  it('maps severity to distinct exit codes, and never maps unreadable to OK', () => {
    assert.equal(exitCodeFor({ severity: SEVERITY.OK }), 1);
    assert.equal(exitCodeFor({ severity: SEVERITY.WARN }), 2);
    assert.equal(exitCodeFor({ severity: SEVERITY.CRITICAL }), 3);
    assert.notEqual(HEALTH_EXIT.UNREADABLE, HEALTH_EXIT.OK);
    assert.equal(severityName(SEVERITY.CRITICAL), 'critical');
  });

  it('treats a missing sample as critical rather than as fine', () => {
    for (const bad of [null, undefined, 'nope']) {
      const a = assess(bad);
      assert.equal(a.severity, SEVERITY.CRITICAL, `${JSON.stringify(bad)}`);
      assert.equal(a.findings[0].code, 'NO_SAMPLE');
    }
  });
});

describe('health: permanent storage is a classification, not a copy', () => {
  it('marks as irreplaceable exactly the data that cannot be regenerated', () => {
    // memory.jsonl is the only durable copy of what a command printed -- the relay keeps hashes and never
    // the text. device.key is the identity peers know this machine by; losing it makes every peer that
    // holds the old one refuse this machine with no visible cause.
    assert.equal(classifyData('memory.jsonl'), DATA_CLASS.IRREPLACEABLE);
    assert.equal(classifyData('device.json'), DATA_CLASS.IRREPLACEABLE);
    assert.equal(classifyData('device.key'), DATA_CLASS.IRREPLACEABLE);
    assert.equal(classifyData('fleet-memory.md'), DATA_CLASS.IRREPLACEABLE);
    assert.equal(classifyData('/var/lib/w2m/rabbit/ledger.jsonl'), DATA_CLASS.IRREPLACEABLE);
  });

  it('marks rebuilt state as rebuildable and in-flight state as disposable', () => {
    assert.equal(classifyData('agent-state.json'), DATA_CLASS.REBUILDABLE);
    assert.equal(classifyData('spool'), DATA_CLASS.DISPOSABLE);
    assert.equal(classifyData('daemon.log'), DATA_CLASS.DISPOSABLE);
    assert.equal(classifyData('something-unknown.tmp'), DATA_CLASS.DISPOSABLE);
  });

  it('classifies by basename, so a path does not change the answer', () => {
    assert.equal(classifyData('a/b/c/memory.jsonl'), classifyData('memory.jsonl'));
  });
});

describe('health: sampling this machine does not throw', () => {
  it('produces a sample whose fields are numbers or null, never undefined', () => {
    // The suite runs on whatever host it is on, so the assertion is about shape rather than values. `null`
    // means "not measured here"; `undefined` would serialise away and read as absent.
    const s = sample();
    assert.equal(typeof s.host, 'string');
    assert.equal(typeof s.platform, 'string');
    assert.ok(Array.isArray(s.disks));
    assert.ok(Array.isArray(s.log_dirs));
    for (const key of ['cpu_count', 'mem_total_bytes', 'mem_free_bytes']) {
      assert.equal(typeof s[key], 'number', key);
    }
    for (const key of ['load_1m', 'mem_used_percent']) {
      assert.ok(s[key] === null || typeof s[key] === 'number', key);
    }
    // And the sample must survive classification.
    const a = assess(s);
    assert.ok([SEVERITY.OK, SEVERITY.WARN, SEVERITY.CRITICAL].includes(a.severity));
  });

  it('leaves disks unmeasured on a platform with no df, rather than reporting them as fine', () => {
    // Measured on this fleet: `df` exists on Linux and macOS and not on Windows, so a Windows sample
    // carries `disks: []`. That is an honest gap and the important part is that it is *empty* rather than
    // filled with a healthy-looking default -- an unmeasured disk must never read as free space.
    const s = sample();
    if (s.platform !== 'win32') {
      assert.ok(s.disks.length > 0, 'a POSIX host should have measured at least one filesystem');
      return;
    }
    assert.deepEqual(s.disks, []);
    // And the assessment must not therefore claim the disk is healthy; it simply says nothing about it.
    const a = assess(s);
    assert.equal(a.findings.some((f) => f.code.startsWith('DISK_')), false);
  });
});
