/**
 * Test-report suite: the shapes node actually writes, and the one it does not.
 *
 * What these protect, said once: this module exists because a parser assumed `# fail 0` and node v24 writes
 * `ℹ fail 0`. The result was three rounds spent diagnosing a macOS failure that did not exist. So the cases
 * below are the real output shapes, taken from a real run rather than invented, plus the negative case that
 * matters most: **a report that cannot be read must not be reported as a failure.**
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LABELS,
  PREFIXES,
  parseSummaryLine,
  parseTestReport,
  verdict,
} from '../src/agent/test-report.mjs';

/** Verbatim from `node --test --test-force-exit test/exit-channel.test.mjs` on node v24.21.0. */
const REAL_V24_OUTPUT = [
  '',
  '  \u2139 tests 17',
  '  \u2139 pass 17',
  '  \u2139 fail 0',
  '  \u2139 duration_ms 84.5',
  '',
].join('\n');

/** The TAP-shaped form earlier node versions used. Kept because both must be accepted. */
const LEGACY_HASH_OUTPUT = ['# tests 12', '# pass 11', '# fail 1', '# skipped 1'].join('\n');

describe('test report: the shape node actually writes', () => {
  it('parses the real v24 output, which uses the info prefix and not a hash', () => {
    // The exact strings from a real run. The `#` form was the assumption that cost three rounds.
    const r = parseTestReport(REAL_V24_OUTPUT);
    assert.equal(r.ok, true);
    assert.equal(r.format, 'info');
    assert.equal(r.source, 'stdout');
    assert.equal(r.tests, 17);
    assert.equal(r.pass, 17);
    assert.equal(r.fail, 0);
    assert.equal(verdict(r), true);
  });

  it('still parses the legacy hash form', () => {
    // Accepting both is the point. Replacing one strict pattern with another would repeat the mistake.
    const r = parseTestReport(LEGACY_HASH_OUTPUT);
    assert.equal(r.ok, true);
    assert.equal(r.format, 'hash');
    assert.equal(r.tests, 12);
    assert.equal(r.fail, 1);
    assert.equal(r.skipped, 1);
    assert.equal(verdict(r), false);
  });

  it('accepts a bare label with no prefix', () => {
    // "No prefix" is a shape node has not used yet; refusing it would be the same mistake in a new costume.
    const r = parseTestReport('tests 3\npass 3\nfail 0');
    assert.equal(r.ok, true);
    assert.equal(r.format, 'bare');
    assert.equal(r.tests, 3);
  });

  it('reports which stream answered, because a caller that cannot tell will misread the next change', () => {
    const fromErr = parseTestReport({ stdout: '', stderr: REAL_V24_OUTPUT });
    assert.equal(fromErr.source, 'stderr');
    const fromBoth = parseTestReport({ stdout: REAL_V24_OUTPUT, stderr: LEGACY_HASH_OUTPUT });
    assert.equal(fromBoth.source, 'both');
    assert.equal(fromBoth.tests, 17, 'stdout wins when both carry a summary');
  });
});

describe('test report: an unreadable report is not a failure', () => {
  it('says so rather than inventing a verdict', () => {
    // The bug's second act: with no line ever matching, the absence was read as "crashed", which pointed the
    // investigation at module scope. Absence of evidence was treated as evidence.
    const r = parseTestReport('');
    assert.equal(r.ok, false);
    assert.equal(r.source, 'none');
    assert.equal(r.fail, null);
    assert.equal(verdict(r), null, 'null, not false -- a report that could not be read is not a failed suite');
    assert.match(r.detail, /NOT the same as a failing suite/);
  });

  it('is three-valued: true, false, and null are all distinct', () => {
    assert.equal(verdict(parseTestReport('tests 1\nfail 0')), true);
    assert.equal(verdict(parseTestReport('tests 1\nfail 2')), false);
    assert.equal(verdict(parseTestReport('nothing useful here')), null);
    assert.equal(verdict(null), null);
    assert.equal(verdict(undefined), null);
  });

  it('does not call a summary without a fail count a pass', () => {
    // `tests 5` says five tests ran and nothing about how they went. Reporting that as passing is the
    // optimistic version of the original mistake.
    //
    // The first version of this test asserted the detail mentioned a missing count, which was wrong: the test
    // *count* was read fine, it is the *fail* count that is absent. What matters is that the detail shows the
    // absence rather than a zero -- `? failed`, not `0 failed`.
    const r = parseTestReport('tests 5');
    assert.equal(r.ok, true);
    assert.equal(r.fail, null);
    assert.equal(verdict(r), null);
    assert.match(r.detail, /\? failed/, `detail must show the absence, got: ${r.detail}`);
    assert.doesNotMatch(r.detail, /0 failed/, 'an unread fail count must never be rendered as zero');
  });

  it('ignores prose that merely resembles a summary', () => {
    // A test named "fail 3 things" must not be read as a summary line. Requiring the label to be one node
    // uses, and the value to be the whole rest of the line, is what prevents it.
    for (const junk of ['not ok 3 - fail 3 things', 'the fail 3 mode is documented', 'tests: 17', 'tests=17']) {
      assert.equal(parseSummaryLine(junk), null, JSON.stringify(junk));
    }
  });
});

describe('test report: line-level parsing', () => {
  it('accepts both prefixes, with and without the space', () => {
    assert.deepEqual(parseSummaryLine('\u2139 tests 17'), { label: 'tests', value: 17 });
    assert.deepEqual(parseSummaryLine('# tests 17'), { label: 'tests', value: 17 });
    assert.deepEqual(parseSummaryLine('\u2139 tests 17'.replace(' ', '')), { label: 'tests', value: 17 });
    assert.deepEqual(parseSummaryLine('   # fail 0   '), { label: 'fail', value: 0 });
  });

  it('parses a fractional duration, because node reports milliseconds with a decimal', () => {
    assert.deepEqual(parseSummaryLine('\u2139 duration_ms 84.5'), { label: 'duration_ms', value: 84.5 });
  });

  it('rejects a label node does not use', () => {
    assert.equal(parseSummaryLine('\u2139 waffles 3'), null);
  });

  it('rejects a non-string rather than throwing', () => {
    for (const bad of [null, undefined, 42, {}]) assert.equal(parseSummaryLine(bad), null);
  });

  it('declares both prefixes and every label it accepts', () => {
    // The vocabulary is data so a reader can check it without reading the parser, and so adding a label is a
    // deliberate edit rather than an accident of a regular expression.
    assert.deepEqual([...PREFIXES], ['\u2139', '#']);
    assert.ok(LABELS.includes('tests') && LABELS.includes('fail') && LABELS.includes('skipped'));
  });
});
