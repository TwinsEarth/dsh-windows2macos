/**
 * The exit-code packet: two bits per file, so a machine that can report one number still answers four questions.
 *
 * What these protect is the *encoding*, because the encoding is the part that fails silently. A wrong bit
 * order does not throw -- it reports file A's result as file B's, and the reader has no way to tell. So the
 * tests are written from both ends: pack a known set of outcomes, unpack the code, and require the same set
 * back, per file and in order.
 *
 * The refusal at `126`/`127` is asserted too. Those two values belong to a shell, so a packet that landed on
 * one would be reported as "command not executable" rather than as a measurement -- a failure that looks like
 * a different failure is worse than a loud one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BUDGET_MS, FILE_CAP_MS, OUTCOME, allPassedCode, main, packOutcomes, unpackOutcomes } from '../scripts/machine-test-packet.mjs';
describe('machine test packet: the total budget, because an expired lease carries no answer', () => {
  it('names a file it ran out of budget for, rather than dropping it', () => {
    // The failure this prevents: four files against a 50-second lease ceiling expired on the real machine,
    // and an expired lease carries NO exit code -- so the measurement was lost rather than reported negative.
    // A packet that quietly omitted the last file would look like a clean run of the ones it managed.
    const seen = [];
    const code = main(['test/permission.test.mjs', 'test/fleet-scale.test.mjs', 'test/fleet-state.test.mjs'], {
      budgetMs: 2_500,
      runner: (file) => { seen.push(file); return { outcome: OUTCOME.PASSED, detail: 'stub' }; },
    });
    // The stub is instant, so the budget never runs out here; what is asserted is that the budget is read at
    // all and that the code still describes three files.
    assert.equal(seen.length, 3);
    assert.equal(code, allPassedCode(3));
  });

  it('stops asking for more once the budget is gone, and says so per file', () => {
    const asked = [];
    const code = main(['test/permission.test.mjs', 'test/fleet-scale.test.mjs', 'test/fleet-state.test.mjs'], {
      budgetMs: 1,
      runner: (file) => { asked.push(file); return { outcome: OUTCOME.PASSED, detail: 'stub' }; },
    });
    assert.equal(asked.length, 0, 'nothing should be run once the budget is spent');
    assert.equal(code, packOutcomes([OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.WAITED]).code);
  });

  it('defaults the budget below the lease ceiling it has to survive', () => {
    // Measured on this fleet: heartbeatIntervalMs 10s x missedHeartbeats 2 + leaseGraceMs 30s ~= 50s. The
    // default must leave room for the answer to travel, so it is asserted against that number rather than
    // left as a comment.
    assert.ok(DEFAULT_BUDGET_MS <= 40_000, `a ${DEFAULT_BUDGET_MS}ms budget risks an expired lease`);
    assert.ok(FILE_CAP_MS <= DEFAULT_BUDGET_MS, 'one hung file must not be able to eat the whole packet');
  });
});

describe('machine test packet: two bits per file, in order', () => {
  it('round-trips every outcome for a single file', () => {
    for (const outcome of [OUTCOME.PASSED, OUTCOME.FAILED, OUTCOME.ABSENT, OUTCOME.WAITED]) {
      const packed = packOutcomes([outcome]);
      assert.equal(packed.refused, false, packed.detail);
      const back = unpackOutcomes(packed.code, 1);
      assert.deepEqual(back.outcomes, [outcome], `outcome ${outcome} did not survive`);
    }
  });

  it('keeps the files in order, which is the failure a wrong bit shift causes', () => {
    // The order is the whole contract: a swapped pair reports the wrong file as broken, and the report looks
    // perfectly plausible. Asserted with four distinct outcomes so no two files agree by accident.
    const given = [OUTCOME.PASSED, OUTCOME.ABSENT, OUTCOME.WAITED, OUTCOME.FAILED];
    const packed = packOutcomes(given);
    assert.equal(packed.refused, false, packed.detail);
    assert.deepEqual(unpackOutcomes(packed.code, 4).outcomes, given);
    assert.deepEqual(unpackOutcomes(packed.code, 4).passed, [0]);
    assert.deepEqual(unpackOutcomes(packed.code, 4).absent, [1]);
    assert.deepEqual(unpackOutcomes(packed.code, 4).waited, [2]);
    assert.deepEqual(unpackOutcomes(packed.code, 4).failed, [3]);
  });

  it('has NO single all-clear value, which is what the first version of this got wrong', () => {
    // The docstring used to say "zero is the all-clear, and that is deliberate". That is true for ZERO files
    // and false for every count including one: a single passing file leaves `0b10`, which is 2. Four passing
    // files are 170, and zero means all four were ABSENT -- a total deployment failure that the old claim
    // would have had a reader take as a clean run.
    assert.equal(allPassedCode(1), 0b10);
    assert.equal(allPassedCode(2), 0b1010);
    assert.equal(allPassedCode(4), 0b10101010);
    assert.equal(allPassedCode(4), 170);

    const packed = packOutcomes([OUTCOME.PASSED, OUTCOME.PASSED, OUTCOME.PASSED, OUTCOME.PASSED]);
    assert.equal(packed.code, allPassedCode(4));
    assert.equal(packed.refused, false);
    assert.match(packed.detail, /every one of 4 file\(s\) ran and passed/);

    // And the value the old comment called an all-clear is the worst possible finding at this size.
    const none = packOutcomes([OUTCOME.ABSENT, OUTCOME.ABSENT, OUTCOME.ABSENT, OUTCOME.ABSENT]);
    assert.equal(none.code, 0, 'zero with four files asked for means NOTHING was on the machine');
  });

  it('never emits 126 or 127, and says it refused rather than returning one', () => {
    // A shell owns those two. A packet that landed on one would arrive as "command not executable".
    // Found by enumerating all four-file combinations rather than by guessing: these two are the only ones
    // in the whole two-bit space that land on a shell-owned value, and the first pair I tried landed on
    // neither, so the guard went untested until the enumeration said which inputs reach it.
    const cases = [
      [OUTCOME.PASSED, OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.FAILED],
      [OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.FAILED],
    ];
    let sawARefusal = false;
    for (const outcomes of cases) {
      const packed = packOutcomes(outcomes);
      if (!packed.refused) {
        assert.notEqual(packed.code, 126);
        assert.notEqual(packed.code, 127);
        continue;
      }
      sawARefusal = true;
      assert.equal(packed.code, 0, 'a refused packet must not carry a code that could be read as a result');
      assert.match(packed.detail, /a shell owns/);
    }
    assert.equal(sawARefusal, true, 'at least one of these should reach the refusal, or the guard is untested');
  });

  it('reports absent separately from failed, because they mean different things', () => {
    // "The file is not on this machine" and "the file ran and failed" are both non-zero and completely
    // different findings -- one is a deployment problem, the other a code problem.
    const packed = packOutcomes([OUTCOME.ABSENT, OUTCOME.FAILED]);
    assert.notEqual(packed.code, 0);
    const back = unpackOutcomes(packed.code, 2);
    assert.deepEqual(back.absent, [0]);
    assert.deepEqual(back.failed, [1]);
    assert.deepEqual(back.passed, []);
  });

  it('does not read beyond the file count it was given', () => {
    // Unpacking two files from a code packed for four must not invent results for the other two.
    const packed = packOutcomes([OUTCOME.PASSED, OUTCOME.FAILED, OUTCOME.PASSED, OUTCOME.PASSED]);
    const back = unpackOutcomes(packed.code, 2);
    assert.equal(back.outcomes.length, 2);
  });

  it('packs four files into one byte, which is the reason for the limit', () => {
    // Five files would need ten bits and would be silently truncated by the mask. The script refuses five for
    // that reason; here the arithmetic is pinned so the limit is a fact rather than a comment.
    const packed = packOutcomes([OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.WAITED, OUTCOME.WAITED]);
    assert.equal(packed.code, 0xff);
    assert.ok(packed.code <= 255);
  });

  it('handles an empty run without claiming success', () => {
    // `packOutcomes([])` is 0, which reads as "everything passed". An empty set passing is technically true
    // and practically misleading, so the script refuses to run with no files and exits 2 instead.
    const packed = packOutcomes([]);
    assert.equal(packed.code, 0);
    // …and the message must not call that a pass, or the one code that reads as success would be attached to
    // the one input that measured nothing.
    assert.doesNotMatch(packed.detail, /ran and passed/);
  });
});
