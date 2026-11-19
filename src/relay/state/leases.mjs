/**
 * Relay state — lease grant/renew/expire/takeover and heartbeat bookkeeping.
 *
 * Split out of `state.mjs` (P1 refactor slice S5). Every function takes the owning
 * `RabbitState` as its first argument: the state remains owned by the facade (one copy of
 * every field), and this module only operates on it. The deferred-offer timers are the
 * pre-existing ones (`_scheduleOffer`), still unref()ed and still owned by the instance.
 */

import { ACTIVE_LEASE_STATES, LEASE_PHASES, ProtocolError, computeDedupeKey, rfc3339 } from './shared.mjs';
import { gateMachine } from './members.mjs';

/** §4.3 lease window = 2 missed heartbeats (20s) + grace (30s) = 50s. */
export function leaseWindowMs(state) { return state.heartbeatIntervalMs * state.missedHeartbeats + state.leaseGraceMs; }

/**
 * v0.4.0: should the relay hold its offer back for this task?
 *
 * Only when the dispatcher said two things: that it is a machine (`origin_machine_id`), and that
 * the direct path is in play (`p2p.mode` of `auto` or `direct`). A `relay` mode or a v0.3.9
 * dispatcher gets the old behaviour exactly, which is why this predicate is the only gate on the
 * change and every pre-existing test still sees an immediate offer.
 *
 * @param {object} task
 * @returns {number} milliseconds to hold, or 0 for "offer now"
 */
export function _p2pOfferGraceMs(state, task) {
  if (state.p2pOfferGraceMs <= 0) return 0;
  const origin = task?.origin_machine_id;
  if (typeof origin !== 'string' || origin === '') return 0;
  const mode = task?.p2p?.mode;
  if (mode !== 'auto' && mode !== 'direct') return 0;
  return state.p2pOfferGraceMs;
}

/**
 * v0.4.0: emit `lease`'s offer after `delayMs`, unless the direct path got there first.
 *
 * "Got there first" is one fact and it is already tracked: the executor renews the lease
 * (`POST /v1/heartbeat`) as its first act on any offer it accepts, and a renewal moves the lease
 * out of `queued`. So the check is the lease's own state — no new message, no new endpoint, and
 * nothing the executor has to know about.
 *
 * The timer is `unref()`ed: a relay with nothing else to do must still be able to exit, and a
 * pending offer is not a reason to keep a process alive.
 */
export function _scheduleOffer(state, task, lease, delayMs) {
  const key = `${task.task_id}:${lease.machine_id}`;
  const timer = setTimeout(() => {
    state._pendingOffers.delete(key);
    // A lease that was re-created (takeover) or swept is not this one any more.
    if (task.leases.get(lease.machine_id) !== lease) return;
    if (lease.state !== 'queued') return; // the direct copy won; nothing to fall back to
    if (state.isLeaseExpired(lease, state.nowMs())) return; // the sweep owns it now
    state.emitOffer(task, lease);
  }, delayMs);
  timer.unref?.();
  state._pendingOffers.set(key, timer);
}

/** Drop every deferred offer. Called by the relay's own teardown path. */
export function clearPendingOffers(state) {
  for (const timer of state._pendingOffers.values()) clearTimeout(timer);
  state._pendingOffers.clear();
}

export function emitOffer(state, task, lease) {
  if (task.offer_unavailable === true || (Array.isArray(task.command_argv) && task.command_argv.length === 0)) {
    // R8: a replayed task without its journal cannot be offered with an unknown command.
    if (ACTIVE_LEASE_STATES.includes(lease.state)) { lease.state = 'expired'; lease.finished_at_ms = state.nowMs(); }
    return;
  }
  const event = state.emit('task.offer', {
    task_id: task.task_id,
    attempt: lease.attempt,
    mode: task.mode,
    index: lease.index,
    index_total: task.index_total,
    command_argv: task.command_argv,
    // v0.3.3: present only for `pipeline`, and only then does the machine run a chain. Omitted
    // entirely otherwise, so an offer for a single-command task is byte-identical to before --
    // which is what keeps a v0.2.3 agent working against this relay.
    ...(task.stages ? { stages: task.stages } : {}),
    /**
     * v0.4.0: always present, `null` when the caller supplied nothing.
     *
     * Deliberately NOT conditional (unlike `stages` above, which is omitted so a single-command
     * offer stays byte-identical for an old agent): the contract fixes the shape of these two as
     * `string|null` and `{mode}|null`, and `null` is the honest value for "the dispatcher did not
     * say" — which is exactly the v0.3.9 case. They are additive keys in an event whose consumers
     * already ignore unknown fields.
     */
    origin_machine_id: task.origin_machine_id ?? null,
    p2p: task.p2p ?? null,
    // v1.2.10: present only on a reduce task, so a normal offer stays byte-identical.
    ...(task.reduce_of !== null ? { reduce_of: task.reduce_of, reduce_inputs: task.reduce_inputs } : {}),
    // v1.3.10-beta.2: the signed request and its operator key travel together; the agent pins the key on first sight.
    ...(task.maintenance !== null && task.maintenance !== undefined ? { maintenance: task.maintenance } : {}),
    // v1.4.1: a grant on a machine that has never pinned the operator key is useless unless the offer carries the key it should
    // trust. Maintenance requests always shipped it; grants must too, or the TOFU pin path is unreachable.
    ...(task.operator_key !== null && task.operator_key !== undefined ? { operator_key: task.operator_key } : {}),
    ...(task.workspace !== null && task.workspace !== undefined ? { workspace: task.workspace } : {}),
    ...(task.grant !== null && task.grant !== undefined ? { grant: task.grant } : {}),
    cwd_rel: task.cwd_rel,
    // Omitted when false, so a single-command offer for every existing caller stays byte-identical -- the
    // same reason `stages` above is conditional.
    ...(task.cwd_outside_project === true ? { cwd_outside_project: true } : {}),
    write: task.write,
    timeout_ms: task.timeout_ms,
    base_commit: task.base_commit,
    base_tree: task.base_tree,
    requirements: task.requirements,
    compare_policy: task.compare_policy,
    dedupe_key: lease.dedupe_key,
    deadline: rfc3339(task.deadline_ms),
  }, { target: lease.machine_id });
  lease.state = 'offered';
  lease.offered_seq = event.seq;
  lease.last_heartbeat_ms = state.nowMs();
  lease.lease_until_ms = lease.last_heartbeat_ms + state.leaseWindowMs();
  return event;
}

/**
 * Re-offer the work a machine was handed but has not yet started (v0.1.2 §8.6).
 *
 * WHY THIS EXISTS
 *
 * An offer is a point-in-time event on a stream. `createTask` publishes
 * `task.offer` once, and if the target machine's stream happens to be down at
 * that instant -- the ordinary situation after a relay restart, a tunnel drop,
 * or any cross-network interruption -- the event is simply gone. The lease sits
 * in `offered` until the sweep expires it, the task never runs, and the
 * operator sees a timeout with no explanation. Measured: the machine is back
 * online with a live stream within milliseconds, and still receives nothing.
 *
 * So the relay re-states unclaimed work when a machine connects. This is safe
 * because the state it acts on is durable: the lease the offer refers to is
 * still in the ledger.
 *
 * WHY ONLY `offered` AND `queued`
 *
 * `running` is deliberately excluded, and that exclusion is the whole safety
 * argument. A running lease means a machine has already STARTED the command --
 * it acknowledged the offer and is heartbeating. Re-offering it would make that
 * machine execute the work a second time, so the fix for a lost offer would
 * introduce the one failure this project is built to avoid: two machines, or
 * one machine twice, running the same side-effecting command.
 *
 * A machine that dies mid-run therefore does not get its work back here; that
 * path stays with the sweep, which expires the lease and hands the index to
 * another machine with `attempt + 1`.
 *
 * Re-emitted offers are new events and are replayed like any other, so a client
 * that reconnects repeatedly can see the same offer more than once. That is
 * intentional: the agent already de-duplicates by `task_id` (it ignores an
 * offer whose task is queued or running), and an at-least-once offer with a
 * client-side dedupe is strictly better than an at-most-once offer that is
 * silently dropped.
 *
 * @param {string} machineId
 * @returns {{count: number, task_ids: string[]}}
 */
export function redeliverPendingOffers(state, machineId) {
  const taskIds = [];
  const now = state.nowMs();

  for (const task of state.tasks.values()) {
    if (task.cancelled === true) continue;
    const lease = task.leases.get(machineId);
    if (!lease) continue;
    // Only work the machine has not begun. See the note above: `running` is
    // excluded on purpose, not by omission.
    if (lease.state !== 'offered' && lease.state !== 'queued') continue;
    // Do not resurrect a lease the sweep has already written off; the takeover
    // path owns that decision.
    if (state.isLeaseExpired(lease, now)) continue;

    state.emitOffer(task, lease);
    taskIds.push(task.task_id);
  }

  return { count: taskIds.length, task_ids: taskIds };
}

/* ---------------- leases / heartbeat (§4.3) ---------------- */

/** Shared `phase`/`progress` validation for both heartbeat modes. */
export function _validatePhaseProgress(state, input) {
  if (input.phase !== undefined && input.phase !== null && !LEASE_PHASES.includes(input.phase)) {
    throw new ProtocolError('BAD_REQUEST', 'phase must be preparing|running|finalizing', { phase: input.phase });
  }
  if (input.progress !== undefined && input.progress !== null
    && (typeof input.progress !== 'number' || input.progress < 0 || input.progress > 1)) {
    throw new ProtocolError('BAD_REQUEST', 'progress must be a number in [0,1]', { progress: input.progress });
  }
}

/**
 * v0.3.0 IDLE (diagnostic) heartbeat — an agent with no lease keeps its latency
 * and liveness visible to other machines.
 *
 * This path deliberately NEVER looks at `state.tasks`. That is the whole safety
 * argument, and it is structural rather than a matter of remembering a rule: an
 * idle heartbeat cannot renew, resurrect or otherwise touch a lease because it
 * never obtains one. Without that, an idle ping from a machine whose lease had
 * expired would flip `expired` back to `running` and manufacture a live task out
 * of nothing -- a fake "the work is still being done" signal, which is the most
 * dangerous lie this relay can tell.
 */
/**
 * Merge a small, typed bag of machine-advertised capabilities into the device row.
 *
 * Only scalars are copied (strings <= 64 chars, booleans, null) and only a bounded number of
 * keys, so a heartbeat cannot turn the roster into an unbounded side channel.
 */
export function _mergeAdvertisedCaps(state, device, caps) {
  if (device === null || typeof device !== 'object') return;
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) return;
  const next = { ...(device.caps ?? {}) };
  let count = 0;
  for (const [key, value] of Object.entries(caps)) {
    if (count >= 32) break;
    if (typeof key !== 'string' || key.length === 0 || key.length > 32) continue;
    if (typeof value === 'string' && value.length <= 64) { next[key] = value; count += 1; continue; }
    if (typeof value === 'boolean' || value === null) { next[key] = value; count += 1; }
  }
  device.caps = next;
}

export function diagnosticHeartbeat(state, input = {}) {
  const machineId = typeof input.machine_id === 'string' && input.machine_id !== ''
    ? input.machine_id : null;
  if (machineId === null) {
    throw new ProtocolError('BAD_REQUEST', 'machine_id is required', {});
  }
  if (!state.devices.has(machineId)) {
    throw new ProtocolError('NOT_FOUND', 'unknown machine_id', { machine_id: machineId });
  }
  state._validatePhaseProgress(input);

  const device = state.touchDevice(machineId);
  state._mergeAdvertisedCaps(device, input.caps);
  state.recordHeartbeatMetrics(machineId, input);
  return {
    // No lease is involved, and the response says so instead of inventing one.
    lease_until: null,
    cancel: false,
    diagnostic: true,
    machine_id: machineId,
    rtt_ms: device?.rtt_ms ?? null,
  };
}

/**
 * §4.3 POST /v1/heartbeat — renews the lease using SERVER time only.
 *
 * Two modes since v0.3.0:
 *   - `task_id` present            -> LEASE heartbeat (unchanged §4.3 behaviour)
 *   - `diagnostic: true`, no task  -> IDLE heartbeat (diagnostics only, no lease)
 *   - neither                      -> 400. A heartbeat that silently renewed
 *     nothing would let an agent whose `task_id` went missing stop renewing while
 *     believing it was fine, ending in a falsely `expired` task. §0 forbids
 *     silent degradation, so this is loud.
 *
 * @returns {{lease_until:string|null, cancel:boolean, phase?:string, progress?:number, diagnostic?:boolean}}
 */
export function heartbeat(state, input = {}) {
  const hasTask = typeof input.task_id === 'string' && input.task_id !== '';
  if (!hasTask) {
    if (input.diagnostic !== true) {
      throw new ProtocolError('BAD_REQUEST',
        'a heartbeat must carry task_id (lease renewal) or diagnostic:true (idle diagnostics); '
        + 'refusing to treat a missing task_id as a no-op renewal', {
          received_keys: Object.keys(input).sort(),
        });
    }
    return state.diagnosticHeartbeat(input);
  }
  if (input.diagnostic === true) {
    // task_id wins: a heartbeat that names a task IS a lease heartbeat.
    // (documented; the flag is simply redundant here)
  }
  return state.leaseHeartbeat(input);
}

export function leaseHeartbeat(state, input = {}) {
  const task = state.requireTask(input.task_id);
  const lease = task.leases.get(input.machine_id);
  if (!lease) {
    throw new ProtocolError('NOT_FOUND', 'no lease for this machine on this task', {
      task_id: input.task_id, machine_id: input.machine_id,
    });
  }
  state._validatePhaseProgress(input);

  const now = state.nowMs();
  state.touchDevice(input.machine_id);
  state.recordHeartbeatMetrics(input.machine_id, input, now);

  if (task.cancelled) {
    return { lease_until: rfc3339(lease.lease_until_ms), cancel: true, reason: task.cancel_reason };
  }

  // §4.3: once halt=now has handed this index to another attempt, the old owner
  // must stop — a late heartbeat from the expired machine is not a valid re-claim.
  if (lease.state === 'expired' && task.attempt > lease.attempt) {
    return { lease_until: rfc3339(lease.lease_until_ms), cancel: true, reason: 'LEASE_EXPIRED_TAKEN_OVER' };
  }

  const stateBefore = lease.state;
  lease.last_heartbeat_ms = now;
  lease.lease_until_ms = now + state.leaseWindowMs();
  lease.heartbeat_count += 1;
  if (input.phase !== undefined && input.phase !== null) lease.phase = input.phase;
  if (input.progress !== undefined && input.progress !== null) lease.progress = input.progress;
  if (Number.isInteger(input.attempt) && input.attempt >= 1) lease.attempt = input.attempt;
  if (lease.state === 'queued' || lease.state === 'offered') lease.state = 'running';
  // A live heartbeat is stronger evidence than a timer: with halt=never nobody took
  // the work away, so the late-but-alive agent re-claims its own lease.
  if (lease.state === 'expired') { lease.state = 'running'; lease.expired_at_ms = null; }

  // §7 ledger records lease STATE changes, not every 10s heartbeat.
  if (lease.state !== stateBefore) state._ledgerLease(task, lease);

  return { lease_until: rfc3339(lease.lease_until_ms), cancel: false, phase: lease.phase, progress: lease.progress };
}

/** §4.3: expiry is decided by Rabbit's clock only. */
export function isLeaseExpired(state, lease, nowMs = state.nowMs()) {
  if (!ACTIVE_LEASE_STATES.includes(lease.state)) return false;
  return nowMs >= lease.lease_until_ms;
}

/**
 * §4.3 expiry sweep.
 *  - halt=never → book-keeping only, task is marked `partial`
 *  - halt=now   → notify remaining machines immediately that they may take over
 */
export function sweepExpired(state, nowMs = state.nowMs()) {
  const expired = [];
  for (const task of state.tasks.values()) {
    if (task.cancelled) continue;
    let changed = false;
    for (const lease of task.leases.values()) {
      if (!state.isLeaseExpired(lease, nowMs)) continue;
      lease.state = 'expired';
      lease.expired_at_ms = nowMs;
      changed = true;
      expired.push({ task, lease });
      state._ledgerLease(task, lease);
      state.emit('notice', {
        level: 'warn',
        code: 'LEASE_EXPIRED',
        message: `lease expired: machine=${lease.machine_id} task=${task.task_id} attempt=${lease.attempt}`,
        task_id: task.task_id,
        machine_id: lease.machine_id,
      });
      // v1.2.4: a caller that named "expired" in retry_on gets the hand-off halt=now always had, as long as it
      // has attempts left. Without the policy this stays book-keeping only -- the pre-1.2.4 behaviour.
      const retryExpired = task.halt === 'now'
        || (Number.isInteger(task.max_attempts) && task.attempt < task.max_attempts
          && Array.isArray(task.retry_on) && task.retry_on.includes('expired'));
      if (retryExpired) {
        task.attempt += 1;
        state._takeover(task, lease, nowMs);
      }
    }
    if (changed) task.degraded = 'partial';
  }
  // v1.2.7: a lease that expires (or a machine that refuses) is a settlement too -- the dependent graph must move.
  state._releaseDependents();

  return expired;
}

/**
 * §4.3 `halt=now`: "立即通知其他机器可接管".
 *
 * v0.0.1's PROTOCOL defines no per-index lease reassignment, so takeover is
 * implemented as: re-offer the freed `index` (attempt+1) to every live machine
 * that is idle — no lease yet, or a lease still queued/offered — and broadcast a
 * notice. Machines already `running` are never re-offered, to avoid double
 * execution of the same index.
 */
export function _takeover(state, task, expiredLease, nowMs = state.nowMs()) {
  /**
   * v0.7.8: the two safety guards this path was missing.
   *
   * `_takeover` already existed and is invoked on `halt=now`, so hand-off was not absent — but it
   * would re-offer a dead machine's index to **every idle device the relay holds**, with no fleet
   * filter and no consideration of whether the task writes. Both are reachable defects:
   *
   *   1. **A device in another account could be handed the work.** On a relay serving several
   *      fleets, `state.devices` includes all of them, so a takeover crossed accounts — which is
   *      the isolation this release series is about, broken in the one path that is easy to miss
   *      because it only runs when something has already gone wrong.
   *   2. **A writing task could be run a second time.** Hand-off makes execution at-least-once,
   *      which is harmless for `node --test` and is a duplicated write for anything else. The
   *      design forbids automatic hand-off for writing tasks until a fencing token exists.
   *
   * The re-offer shape itself is unchanged: PROTOCOL v0.0.1 defines no per-index lease
   * reassignment, so takeover is expressed as a re-offer to idle machines. Narrowing that to a
   * single successor is a protocol revision, not a wiring change, and is not made here.
   */
  if (task.write === true) {
    state.emit('notice', {
      level: 'warn',
      code: 'LEASE_TAKEOVER_REFUSED',
      message:
        `task ${task.task_id} index ${expiredLease.index} is a writing task, so no machine takes it over: `
        + 'a second run could apply the same change twice, and the caller cannot tell from the verdict',
      task_id: task.task_id,
      reason: 'write_not_idempotent',
    });
    return [];
  }

  const requesterFleet = state.fleetId ?? null;

  const candidates = [];
  for (const device of state.devices.values()) {
    if (device.machine_id === expiredLease.machine_id) continue;
    /**
     * Fleet membership, when the relay is scoped.
     *
     * A device with its own `fleet_id` must match. A device with none cannot take over on a
     * scoped relay, because there is no fleet to match it against — the same rule `targetsFor`
     * applies to dispatch, kept identical here so the two paths cannot disagree.
     */
    if (requesterFleet !== null) {
      const deviceFleet = typeof device.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id : null;
      if (deviceFleet !== requesterFleet) {
        state.log?.('debug', 'takeover candidate skipped: not in this fleet', {
          task_id: task.task_id,
          machine_id: device.machine_id,
          device_fleet: deviceFleet,
          relay_fleet: requesterFleet,
        });
        continue;
      }
    }
    const lease = task.leases.get(device.machine_id);
    if (lease && !['queued', 'offered'].includes(lease.state)) continue;
    if (!lease && gateMachine(task, device)) continue;
    candidates.push({ device, lease: lease ?? null });
  }

  for (const { device, lease } of candidates) {
    const target = lease ?? {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      index: expiredLease.index,
      attempt: task.attempt,
      state: 'queued',
      refusal_reason: null,
      refusal_detail: null,
      dedupe_key: null,
      last_heartbeat_ms: nowMs,
      claimed_at_ms: nowMs,
      lease_until_ms: nowMs + state.leaseWindowMs(),
      phase: null,
      progress: null,
      offered_seq: null,
      expired_at_ms: null,
      finished_at_ms: null,
      heartbeat_count: 0,
    };
    target.index = expiredLease.index;
    target.attempt = task.attempt;
    target.dedupe_key = computeDedupeKey(task.task_id, target.index, task.command_hash, task.base_tree);
    task.leases.set(device.machine_id, target);
    state.emitOffer(task, target);
    state._ledgerLease(task, target);
  }

  state.emit('notice', {
    level: 'info',
    code: candidates.length > 0 ? 'LEASE_TAKEOVER' : 'LEASE_TAKEOVER_UNAVAILABLE',
    message: candidates.length > 0
      ? `task ${task.task_id} index ${expiredLease.index} re-offered at attempt ${task.attempt} to: `
        + candidates.map((c) => c.device.machine_id).join(',')
      : `task ${task.task_id} index ${expiredLease.index} has no idle machine to take over`,
    task_id: task.task_id,
  });
  return candidates.map((c) => c.device.machine_id);
}
