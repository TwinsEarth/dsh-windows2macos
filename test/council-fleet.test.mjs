/**
 * Fleet council: the arithmetic that has to be identical on every machine, and the refusals that keep a split decision
 * from being resolved by accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLEET_COUNCIL_REFUSAL, createFleetCouncil, fleetCouncilBallot, fleetCouncilRequest, fleetCouncilThread,
  fleetWeightOf, parseFleetCouncilMessage, tallyFleetBallots,
} from '../src/plugin/council-fleet.mjs';

const ballot = (machine, choice, authority, reputation = 0) => ({ machine_id: machine, choice, authority, reputation });

describe('weights are reproducible from the ballot alone', () => {
  it('is a pure function of authority and reputation', () => {
    assert.equal(fleetWeightOf({ authority: 40, reputation: 50 }), 60);
    assert.equal(fleetWeightOf({ authority: 40, reputation: 50 }), fleetWeightOf({ authority: 40, reputation: 50 }));
  });

  it('refuses an out-of-range authority rather than clamping it', () => {
    assert.equal(fleetWeightOf({ authority: 101, reputation: 0 }), null);
    assert.equal(fleetWeightOf({ authority: -1, reputation: 0 }), null);
  });
});

describe('tally', () => {
  it('picks the heaviest side and keeps the dissent', () => {
    const result = tallyFleetBallots([
      ballot('m-1', 'ship', 50, 0),
      ballot('m-2', 'ship', 30, 0),
      ballot('m-3', 'hold', 20, 0),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.choice, 'ship');
    assert.equal(result.dissent.length, 1);
    assert.equal(result.dissent[0].machine_id, 'm-3');
  });

  it('refuses a tie instead of breaking it', () => {
    const result = tallyFleetBallots([ballot('m-1', 'ship', 50), ballot('m-2', 'hold', 50)]);
    assert.equal(result.code, FLEET_COUNCIL_REFUSAL.TIED);
    assert.deepEqual(result.detail.tied.sort(), ['hold', 'ship']);
  });

  it('refuses an empty council and a malformed ballot', () => {
    assert.equal(tallyFleetBallots([]).code, FLEET_COUNCIL_REFUSAL.NO_BALLOTS);
    assert.equal(tallyFleetBallots([ballot('m-1', '', 50)]).code, FLEET_COUNCIL_REFUSAL.BAD_BALLOT);
    assert.equal(tallyFleetBallots([{ machine_id: 'm-1', choice: 'x', authority: null }]).code, FLEET_COUNCIL_REFUSAL.BAD_BALLOT);
  });
});

describe('the council state machine', () => {
  const make = () => createFleetCouncil({ now: () => 1000 });

  it('opens, collects one ballot per machine, and decides', () => {
    const c = make();
    assert.equal(c.open({ councilId: 'c1', question: 'ship?', openedByMachineId: 'm-0' }).ok, true);
    assert.equal(c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'yes', authority: 60 }).ok, true);
    const decided = c.decide({ councilId: 'c1' });
    assert.equal(decided.ok, true);
    assert.equal(decided.council.decision.choice, 'yes');
    assert.equal(decided.council.open, false);
  });

  it('refuses a second ballot from the same machine', () => {
    const c = make();
    c.open({ councilId: 'c1', question: 'q' });
    c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'yes', authority: 10 });
    assert.equal(c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'no', authority: 10 }).code, FLEET_COUNCIL_REFUSAL.DUPLICATE_VOTER);
  });

  it('refuses a late ballot by name instead of dropping it silently', () => {
    const c = make();
    c.open({ councilId: 'c1', question: 'q' });
    c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'yes', authority: 10 });
    c.decide({ councilId: 'c1' });
    assert.equal(c.vote({ councilId: 'c1', machineId: 'm-2', choice: 'no', authority: 10 }).code, FLEET_COUNCIL_REFUSAL.LATE_BALLOT);
  });

  it('refuses a tie at decide time and leaves the council open', () => {
    const c = make();
    c.open({ councilId: 'c1', question: 'q' });
    c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'yes', authority: 50 });
    c.vote({ councilId: 'c1', machineId: 'm-2', choice: 'no', authority: 50 });
    assert.equal(c.decide({ councilId: 'c1' }).code, FLEET_COUNCIL_REFUSAL.TIED);
    assert.equal(c.state({ councilId: 'c1' }).council.open, true);
  });

  it('refuses an unknown council and a ballot with no authority', () => {
    const c = make();
    assert.equal(c.state({ councilId: 'nope' }).code, FLEET_COUNCIL_REFUSAL.UNKNOWN);
    c.open({ councilId: 'c1', question: 'q' });
    assert.equal(c.vote({ councilId: 'c1', machineId: 'm-1', choice: 'yes' }).code, FLEET_COUNCIL_REFUSAL.BAD_BALLOT);
  });
});

describe('the two chat messages', () => {
  it('names one thread per council', () => {
    assert.equal(fleetCouncilThread('c1'), 'council-c1');
  });

  it('round-trips a request and a ballot, and ignores anything else', () => {
    const request = parseFleetCouncilMessage(fleetCouncilRequest({ councilId: 'c1', question: 'ship?', openedByMachineId: 'm-0' }));
    assert.equal(request.kind, 'request');
    assert.equal(request.payload.council_id, 'c1');

    const parsedBallot = parseFleetCouncilMessage(fleetCouncilBallot({ councilId: 'c1', machineId: 'm-1', choice: 'yes', authority: 30, reputation: 5 }));
    assert.equal(parsedBallot.kind, 'ballot');
    assert.equal(parsedBallot.payload.authority, 30);

    assert.equal(parseFleetCouncilMessage('just chatting').kind, 'none');
    assert.equal(parseFleetCouncilMessage('{"v":1,"kind":"council-ballot","council_id":""}').kind, 'bad');
  });
});