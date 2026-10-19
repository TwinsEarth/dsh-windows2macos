/**
 * A council whose members are machines, not callers in one process.
 *
 * ## What is shared with the single-machine council, and what is not
 *
 * The RULE is shared: a vote's weight is a pure function of the numbers on its ballot (authority and reputation), so any
 * machine that holds the same ballots computes the same outcome; and a tie is a REFUSAL, not a coin toss, because a split
 * council is exactly the case a person has to look at.
 *
 * The TRANSPORT is different. A single-machine council holds its ballots in memory; a fleet council's ballots arrive as
 * chat messages on a thread (\`council-<id>\`), which is what the 1.2.1 relay already supports. So this module is the state
 * and the arithmetic, and {@link fleetCouncilRequest} / {@link fleetCouncilBallot} are the two messages it exchanges --
 * plain JSON in text, because the fleet chat contract is "plain text" and inventing a binary frame would need a relay
 * change for no benefit.
 *
 * ## Why late ballots are refused rather than ignored
 *
 * Silently dropping a ballot makes a voter believe their vote counted. Refusing it by name can be told to them.
 */
export const FLEET_COUNCIL_REFUSAL = Object.freeze({
  UNKNOWN: 'FLEET_COUNCIL_UNKNOWN',
  ALREADY_OPEN: 'FLEET_COUNCIL_ALREADY_OPEN',
  ALREADY_DECIDED: 'FLEET_COUNCIL_ALREADY_DECIDED',
  NO_BALLOTS: 'FLEET_COUNCIL_NO_BALLOTS',
  BAD_BALLOT: 'FLEET_COUNCIL_BAD_BALLOT',
  DUPLICATE_VOTER: 'FLEET_COUNCIL_DUPLICATE_VOTER',
  LATE_BALLOT: 'FLEET_COUNCIL_LATE_BALLOT',
  TIED: 'FLEET_COUNCIL_TIED',
  BAD_MESSAGE: 'FLEET_COUNCIL_BAD_MESSAGE',
});

/** The weight of one ballot. Deliberately the same formula as \`agent/council.mjs#weightOf\`, restated here because importing
 * the single-machine module would drag its phase machine into a fleet decision that does not have phases. */
export function fleetWeightOf({ authority, reputation } = {}) {
  const level = Number.isFinite(authority) ? authority : null;
  if (level === null || level < 0 || level > 100) return null;
  const rep = Number.isFinite(reputation) ? reputation : 0;
  return level * (1 + rep / 100);
}

/**
 * Count the stored ballots. Pure: same ballots, same outcome, on any machine.
 *
 * @param {Array<{choice: string, authority: number, reputation: number, machine_id?: string}>} ballots
 * @returns {{ok: true, choice: string, weight: number, dissent: object[]} | {ok: false, code: string, detail?: object}}
 */
export function tallyFleetBallots(ballots) {
  const list = Array.isArray(ballots) ? ballots : [];
  if (list.length === 0) return { ok: false, code: FLEET_COUNCIL_REFUSAL.NO_BALLOTS };
  const totals = new Map();
  for (const ballot of list) {
    const choice = typeof ballot?.choice === 'string' ? ballot.choice.trim() : '';
    if (choice === '') return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { ballot } };
    const weight = fleetWeightOf(ballot);
    if (weight === null) return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { authority: ballot?.authority } };
    totals.set(choice, (totals.get(choice) ?? 0) + weight);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const [topChoice, topWeight] = ranked[0];
  const tied = ranked.slice(1).filter(([, weight]) => weight === topWeight);
  if (tied.length > 0) {
    return {
      ok: false,
      code: FLEET_COUNCIL_REFUSAL.TIED,
      detail: { tied: [topChoice, ...tied.map(([choice]) => choice)], weight: topWeight },
    };
  }
  return {
    ok: true,
    choice: topChoice,
    weight: topWeight,
    dissent: list.filter((ballot) => ballot.choice !== topChoice).map((ballot) => ({ ...ballot })),
  };
}

/**
 * @param {{now?: () => number}} [options]
 */
export function createFleetCouncil(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** councilId -> { id, question, openedBy, atMs, decidedAtMs, ballots, decision } */
  const councils = new Map();

  function open({ councilId, question, openedByMachineId } = {}) {
    const id = typeof councilId === 'string' && councilId.trim() !== '' ? councilId.trim() : null;
    if (id === null) return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { field: 'councilId' } };
    const questionText = typeof question === 'string' ? question.trim() : '';
    if (questionText === '') return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { field: 'question' } };
    const existing = councils.get(id);
    if (existing !== undefined && existing.decision === null) return { ok: false, code: FLEET_COUNCIL_REFUSAL.ALREADY_OPEN };
    const council = {
      id,
      question: questionText,
      openedBy: typeof openedByMachineId === 'string' ? openedByMachineId : null,
      atMs: now(),
      decidedAtMs: null,
      ballots: [],
      decision: null,
    };
    councils.set(id, council);
    return { ok: true, council: snapshot(council) };
  }

  function vote({ councilId, machineId, choice, reason = null, authority = null, reputation = null } = {}) {
    const council = councils.get(typeof councilId === 'string' ? councilId.trim() : '');
    if (council === undefined) return { ok: false, code: FLEET_COUNCIL_REFUSAL.UNKNOWN, detail: { councilId } };
    if (council.decision !== null) return { ok: false, code: FLEET_COUNCIL_REFUSAL.LATE_BALLOT, detail: { decidedAtMs: council.decidedAtMs } };
    const voter = typeof machineId === 'string' && machineId !== '' ? machineId : null;
    if (voter === null) return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { field: 'machineId' } };
    if (council.ballots.some((ballot) => ballot.machine_id === voter)) {
      return { ok: false, code: FLEET_COUNCIL_REFUSAL.DUPLICATE_VOTER, detail: { machineId: voter } };
    }
    const ballot = {
      machine_id: voter,
      choice: typeof choice === 'string' ? choice.trim() : '',
      reason: typeof reason === 'string' ? reason : null,
      authority: Number.isInteger(authority) && authority >= 0 && authority <= 100 ? authority : null,
      reputation: Number.isFinite(reputation) ? reputation : null,
      at_ms: now(),
    };
    if (ballot.choice === '' || ballot.authority === null) {
      return { ok: false, code: FLEET_COUNCIL_REFUSAL.BAD_BALLOT, detail: { ballot } };
    }
    council.ballots.push(ballot);
    return { ok: true, council: snapshot(council) };
  }

  function decide({ councilId } = {}) {
    const council = councils.get(typeof councilId === 'string' ? councilId.trim() : '');
    if (council === undefined) return { ok: false, code: FLEET_COUNCIL_REFUSAL.UNKNOWN, detail: { councilId } };
    if (council.decision !== null) return { ok: true, council: snapshot(council), alreadyDecided: true };
    const counted = tallyFleetBallots(council.ballots);
    if (counted.ok !== true) return counted;
    council.decision = {
      choice: counted.choice,
      weight: counted.weight,
      dissent: counted.dissent,
      ballots: council.ballots.length,
    };
    council.decidedAtMs = now();
    return { ok: true, council: snapshot(council) };
  }

  function state({ councilId } = {}) {
    const council = councils.get(typeof councilId === 'string' ? councilId.trim() : '');
    if (council === undefined) return { ok: false, code: FLEET_COUNCIL_REFUSAL.UNKNOWN, detail: { councilId } };
    return { ok: true, council: snapshot(council) };
  }

  function list() {
    return { ok: true, councils: [...councils.values()].map(snapshot) };
  }

  function snapshot(council) {
    return {
      id: council.id,
      question: council.question,
      opened_by: council.openedBy,
      open: council.decision === null,
      at_ms: council.atMs,
      decided_at_ms: council.decidedAtMs,
      ballots: council.ballots.map((ballot) => ({ ...ballot })),
      decision: council.decision === null ? null : { ...council.decision, dissent: council.decision.dissent.map((b) => ({ ...b })) },
    };
  }

  return { open, vote, decide, state, list, _councils: councils };
}

/** The thread every message about one council travels on. */
export function fleetCouncilThread(councilId) {
  return 'council-' + String(councilId ?? '').trim();
}

/** The message that opens a vote on the fleet chat. */
export function fleetCouncilRequest({ councilId, question, openedByMachineId = null } = {}) {
  return JSON.stringify({
    v: 1,
    kind: 'council-request',
    council_id: String(councilId ?? ''),
    question: String(question ?? ''),
    opened_by: openedByMachineId,
  });
}

/** The message that carries one ballot. */
export function fleetCouncilBallot({ councilId, machineId, choice, reason = null, authority = null, reputation = null } = {}) {
  return JSON.stringify({
    v: 1,
    kind: 'council-ballot',
    council_id: String(councilId ?? ''),
    machine_id: String(machineId ?? ''),
    choice: String(choice ?? ''),
    reason,
    authority,
    reputation,
  });
}

/**
 * Read one fleet-chat message: is it a council request, a ballot, or neither?
 *
 * @param {string} text
 * @returns {{kind: 'request'|'ballot', payload: object} | {kind: 'none'} | {kind: 'bad', reason: string}}
 */
export function parseFleetCouncilMessage(text) {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'none' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { kind: 'none' }; }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) return { kind: 'none' };
  if (parsed.kind === 'council-request') {
    if (typeof parsed.council_id !== 'string' || parsed.council_id.trim() === '') return { kind: 'bad', reason: 'council_id' };
    return { kind: 'request', payload: parsed };
  }
  if (parsed.kind === 'council-ballot') {
    if (typeof parsed.council_id !== 'string' || parsed.council_id.trim() === '') return { kind: 'bad', reason: 'council_id' };
    if (typeof parsed.machine_id !== 'string' || parsed.machine_id.trim() === '') return { kind: 'bad', reason: 'machine_id' };
    return { kind: 'ballot', payload: parsed };
  }
  return { kind: 'none' };
}
