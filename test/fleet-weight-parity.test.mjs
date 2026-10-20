/**
 * Two implementations of one rule, kept honest by a test.
 *
 * The fleet council restates the single-machine council's weight formula instead of importing it, because importing that
 * module would drag its phase machine into a fleet decision that has no phases. A restatement is only acceptable while it
 * agrees, so this compares the two on the same inputs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { weightOf } from '../src/agent/council.mjs';
import { fleetWeightOf } from '../src/plugin/council-fleet.mjs';

const LEVELS = [0, 1, 10, 40, 50, 60, 99, 100];
const REPUTATIONS = [0, 25, 50, 100];

describe('the fleet weight agrees with the single-machine weight', () => {
  it('is the same number for every level and reputation that matters', () => {
    for (const authority of LEVELS) {
      for (const reputation of REPUTATIONS) {
        assert.equal(
          fleetWeightOf({ authority, reputation }),
          weightOf({ authority, reputation }),
          'authority ' + authority + ', reputation ' + reputation,
        );
      }
    }
  });
});
