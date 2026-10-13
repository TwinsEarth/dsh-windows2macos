/**
 * Hand-off: what happens when the machine holding a task does not answer (v0.7.7).
 *
 * ## What this decides
 *
 * "The default PC did not reply, so another PC takes over" is a rule with a sharp edge that is
 * easy to miss while implementing it, and the edge is this:
 *
 * > **Hand-off turns execution from at-most-once into at-least-once.**
 *
 * A command may now run on **two** machines. That is harmless for `node --test` and it is not
 * harmless for anything that writes — a `write: true` task could apply its change twice, and the
 * second application happens on a machine that has no idea the first one already ran. The design
 * document forbids automatic hand-off for writing tasks until a fencing token exists, and this
 * module **is** that prohibition: `write: true` plus `halt: 'now'` is refused outright rather than
 * quietly allowed.
 *
 * ## The four cases, and why each needs its own answer
 *
 * | case | what it means | what happens |
 * |---|---|---|
 * | **done** | the machine answered | nothing; the aggregate is decided |
 * | **silent** | connected but its heartbeat stopped | takes over only under `halt: 'now'` |
 * | **offline** | the connection dropped | same as silent, but immediately — this is the main path |
 * | **late** | the original reported *after* a takeover | recorded, and **never** overwrites the successor |
 *
 * The late case is the one worth stating: a result that arrives after its lease was reassigned is
 * **evidence**, not an answer. Overwriting the successor's result with it would mean the verdict
 * depends on which machine was slower to reply, which is not a property anyone asked for.
 *
 * ## Refusals are named
 *
 * "Why did nothing take over" has several different answers — the task was cancelled, the caller
 * asked not to halt, the task writes, there is no other machine — and they have different fixes.
 * Collapsing them into "no hand-off" is how an operator concludes the feature is broken.
 */

/** Why a takeover did not happen. Every value is a thing an operator can act on. */
export const NO_HANDOFF = Object.freeze({
  /** Nothing to do: the lease finished. */
  DONE: 'done',
  /** The caller asked the relay not to reassign (`halt: 'never'`). */
  HALT_NEVER: 'halt_never',
  /** The task writes, so a second run could apply the same change twice. */
  WRITE_NOT_IDEMPOTENT: 'write_not_idempotent',
  /** The task was cancelled; taking it over would resurrect it. */
  CANCELLED: 'cancelled',
  /** No other machine in this fleet is online. */
  NO_ALTERNATE_MACHINE: 'no_alternate_machine',
  /** Every other machine has already tried this slice. */
  ALL_TRIED: 'all_tried',
  /** The lease has not expired yet, so the holder is presumed to be working. */
  NOT_YET_EXPIRED: 'not_yet_expired',
});

/** Which attempt a lease is on. Kept explicit so a late result can be recognised by number. */
export const LEASE_STATE = Object.freeze({
  OFFERED: 'offered',
  CLAIMED: 'claimed',
  DONE: 'done',
  EXPIRED: 'expired',
  REFUSED: 'refused',
  CANCELLED: 'cancelled',
});

/**
 * Is this lease finished, one way or another?
 *
 * `expired` and `refused` are terminal for the *lease* but not for the *task* — the slice may
 * still be handed to another machine, which is the whole point. `done` is terminal for both.
 */
export function isLeaseTerminal(state) {
  return state === LEASE_STATE.DONE || state === LEASE_STATE.CANCELLED;
}

/**
 * Should this slice be handed to another machine?
 *
 * @param {object} input
 * @param {{state: string, machine_id: string, attempt: number, lease_until_ms?: number}} input.lease
 * @param {boolean} input.write Whether the task writes. Decides whether hand-off is safe at all.
 * @param {'never'|'now'} input.halt The caller's stated policy.
 * @param {boolean} input.cancelled
 * @param {string[]} input.triedMachineIds Machines that have already held this slice.
 * @param {Array<{machine_id: string, fleet_id?: string, online?: boolean, caps?: object}>} input.candidates
 *        Devices that may take over. Already fleet-filtered by the caller.
 * @param {number} [input.now]
 * @param {number} [input.takeoverGraceMs] Extra delay before a takeover, so a machine that is
 *        merely slow is not pre-empted. A slow machine is not a dead one.
 */
export function shouldHandOff({
  lease,
  write,
  halt,
  cancelled,
  triedMachineIds,
  candidates,
  now = Date.now(),
  takeoverGraceMs = 0,
}) {
  if (lease === null || typeof lease !== 'object') {
    return { takeOver: false, reason: NO_HANDOFF.DONE, text: '没有租约。' };
  }
  if (cancelled === true) {
    // Reassigning a cancelled task would resurrect it, and the operator cancelled it on purpose.
    return { takeOver: false, reason: NO_HANDOFF.CANCELLED, text: '任务已取消，不会重派。' };
  }
  if (isLeaseTerminal(lease.state)) {
    return { takeOver: false, reason: NO_HANDOFF.DONE, text: '这一片已经有结果了。' };
  }
  if (halt !== 'now') {
    // The default. A stopped machine is *recorded* rather than replaced, because for anything
    // that writes, a second runner is worse than a missing result.
    return { takeOver: false, reason: NO_HANDOFF.HALT_NEVER, text: '这个任务没有开启接手（halt 不是 now）。' };
  }
  if (write === true) {
    // The sharp edge. Refused, not warned about: a second application of the same write is a
    // data-loss shape, and the caller cannot tell it happened from the verdict alone.
    return {
      takeOver: false,
      reason: NO_HANDOFF.WRITE_NOT_IDEMPOTENT,
      text: '这是写任务，自动接手会让同一条命令执行两次，因此拒绝。',
    };
  }

  /**
   * A lease that has not expired is presumed to be progressing.
   *
   * Two separate questions, in this order — and the first version of this got the arithmetic
   * backwards by adding the grace to the wrong side, which a test caught:
   *
   *   1. **Is the lease still valid?** If `now < lease_until`, the holder is within its window and
   *      nothing is taken over, whatever the grace says.
   *   2. **Has the grace elapsed since it expired?** Only then is a takeover considered. A machine
   *      that is merely slow is not a machine that is gone.
   *
   * The boundary is inclusive on the decline side, so the outcome does not depend on which side of
   * a millisecond the scheduler landed.
   */
  const until = Number(lease.lease_until_ms);
  if (Number.isFinite(until)) {
    if (now < until) {
      return { takeOver: false, reason: NO_HANDOFF.NOT_YET_EXPIRED, text: '租约还没到期，先假定它在正常工作。' };
    }
    if (now < until + takeoverGraceMs) {
      return { takeOver: false, reason: NO_HANDOFF.NOT_YET_EXPIRED, text: '租约刚到期，还在宽限期内。' };
    }
  }

  const tried = new Set(Array.isArray(triedMachineIds) ? triedMachineIds : []);
  // The current holder is "tried" whether or not the caller said so: handing the slice back to the
  // machine that just went silent is the one reassignment guaranteed to be useless.
  if (typeof lease.machine_id === 'string') tried.add(lease.machine_id);

  // "Available" means untried **and online**. An offline machine is not an alternate, and counting
  // it as one is what would make the two refusals below indistinguishable.
  const available = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && typeof c.machine_id === 'string' && !tried.has(c.machine_id) && c.online !== false,
  );
  const alternate = available[0];

  if (alternate === undefined) {
    /**
     * Two different situations, and the distinction is *how many machines exist*, not how many
     * are untried.
     *
     * A test found the first version of this checking "is there an untried machine", which is
     * always false in the all-tried case — so the two refusals were indistinguishable and the
     * named reason was unreachable. The question an operator is actually asking is:
     *
     *   * the fleet has other machines and every one of them has had a turn → `ALL_TRIED`
     *     (fix: wait, or make one succeed)
     *   * the fleet holds only this machine → `NO_ALTERNATE_MACHINE`
     *     (fix: add a machine to the fleet)
     *
     * The current holder is excluded from *availability* but not from *existence*: a fleet of one
     * has no alternate and never will.
     */
    const others = (Array.isArray(candidates) ? candidates : []).filter(
      (c) => c && typeof c.machine_id === 'string' && c.machine_id !== lease.machine_id,
    );
    return others.length > 0
      ? { takeOver: false, reason: NO_HANDOFF.ALL_TRIED, text: '这条舰队里其他机器都已经试过这一片了。' }
      : { takeOver: false, reason: NO_HANDOFF.NO_ALTERNATE_MACHINE, text: '这条舰队里没有其他机器可以接手。' };
  }

  return {
    takeOver: true,
    machineId: alternate.machine_id,
    attempt: (Number.isFinite(lease.attempt) ? lease.attempt : 1) + 1,
    text: `交给 ${alternate.machine_name ?? alternate.machine_id} 接手（第 ${(Number.isFinite(lease.attempt) ? lease.attempt : 1) + 1} 次尝试）。`,
  };
}

/**
 * Which attempt's result counts, when more than one arrived.
 *
 * The rule is **highest attempt wins**, not "last to arrive" and not "first to arrive". Arrival
 * order is a property of the network, and a verdict that depends on it is a verdict nobody can
 * reason about. The attempt number is assigned by the relay, so it is the one ordering that does
 * not depend on who was faster.
 *
 * Results from superseded attempts are **returned rather than dropped**: a late result from the
 * machine that went silent is diagnostic — it says the machine was alive and slow, not dead —
 * and discarding it turns a diagnosable situation into an unexplained one.
 */
export function reconcileResults(results) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r === 'object');
  if (list.length === 0) return { winner: null, superseded: [], arrivedLate: [] };

  // A missing attempt number is treated as **0**, not as infinity. A frame with no attempt is an
  // old frame whose attempt was not recorded — treating it as the newest would let a stale result
  // from a superseded lease win the aggregate, which is the exact inversion this function exists
  // to prevent. A test asserts the direction.
  const attemptOf = (r) => (Number.isFinite(r.attempt) ? r.attempt : 0);

  let winner = list[0];
  for (const result of list) {
    const better = attemptOf(result);
    const best = attemptOf(winner);
    if (better > best) {
      winner = result;
    } else if (better === best) {
      // Same attempt twice: only possible when one machine delivered twice. Either delivery is
      // equivalent, so the first is kept — which makes the outcome stable across a replay of the
      // ledger rather than dependent on ingest order.
      continue;
    }
  }

  const superseded = list.filter((r) => r !== winner && attemptOf(r) < attemptOf(winner));
  const arrivedLate = superseded.filter((r) => r.arrivedAfterHandoff === true);
  return { winner, superseded, arrivedLate };
}

/**
 * The slice's story, in the order the relay saw it, for a report.
 *
 * Kept as a list rather than a summary because "which machine tried, in what order, and why the
 * next one did or did not" is the question an operator actually asks, and a summarised answer
 * cannot be interrogated.
 */
export function handoffTrace(events) {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const machine = e.machine_name ?? e.machine_id ?? '?';
      if (e.event === 'offer') return `attempt ${e.attempt ?? '?'}: offered to ${machine}`;
      if (e.event === 'done') return `attempt ${e.attempt ?? '?'}: ${machine} answered (${e.status ?? 'ok'})`;
      if (e.event === 'expired') return `attempt ${e.attempt ?? '?'}: ${machine} went silent`;
      if (e.event === 'refused') return `attempt ${e.attempt ?? '?'}: ${machine} refused (${e.reason ?? '?'})`;
      if (e.event === 'handoff') return `attempt ${e.attempt ?? '?'}: handed to ${machine}`;
      if (e.event === 'handoff-declined') return `no hand-off: ${e.reason ?? '?'}`;
      if (e.event === 'late') return `attempt ${e.attempt ?? '?'}: ${machine} reported late, not counted`;
      return `${e.event ?? '?'}: ${machine}`;
    });
}
