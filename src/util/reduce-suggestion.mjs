/**
 * The reduce suggestion: what a reader can do about a finished map phase, without deciding it for them.
 *
 * ## Why a suggestion instead of a dispatch
 *
 * A reduce is a command run on a machine. Every other part of this fleet keeps "who decides to run a command" in the caller: the
 * relay offers, the agent executes, the plugin dispatches when asked. A tool that dispatched the reduce itself would make a read
 * into a write, and the caller would lose the ability to say "not on that machine" or "not with those inputs". So this function
 * answers three questions and stops: is the data complete, who could reduce it, and what is the caller expected to do next.
 *
 * ## Why it is derived, not stored
 *
 * Two readers of the same aggregate must get the same suggestion, and reading must not change relay state. Everything here comes
 * from the machine facts the aggregate already publishes (`blob_sha256`, `output_mode`, `stdout_head`, `stdout_bytes`) and the
 * task's own `index_total`; nothing is written anywhere.
 */
import { buildReducePlan } from './dataflow.mjs';

/** The literal next step, kept in the payload so a caller cannot mistake the suggestion for an action. */
export const REDUCE_NEXT_STEP = 'dispatch the reduce yourself; this tool does not run it';

/**
 * @param {object} machine a machine entry from the aggregate (full or compact shape)
 * @returns {boolean} true when this machine actually reported a result
 */
export function machineReported(machine) {
  if (machine === null || typeof machine !== 'object') return false;
  if ((machine.envelope ?? machine.result ?? null) !== null) return true;
  return typeof machine.blob_sha256 === 'string'
    || typeof machine.stdout_head === 'string'
    || Number.isFinite(machine.stdout_bytes)
    || (typeof machine.status === 'string' && machine.status !== '' && Number.isFinite(machine.exit_code));
}

/**
 * @param {object} machine
 * @returns {{machine_id: string, index: number|null, mode: 'inline'|'blob', stdout?: string, blob_sha256?: string}}
 */
export function reduceInputOf(machine) {
  const envelope = machine?.envelope ?? machine?.result ?? null;
  const blobSha256 = typeof envelope?.blob_sha256 === 'string' ? envelope.blob_sha256
    : (typeof machine?.blob_sha256 === 'string' ? machine.blob_sha256 : null);
  const head = typeof envelope?.stdout_head === 'string' && envelope.stdout_head !== '' ? envelope.stdout_head
    : (typeof machine?.stdout_head === 'string' && machine.stdout_head !== '' ? machine.stdout_head : null);
  const index = Number.isInteger(machine?.index) ? machine.index
    : (Number.isInteger(envelope?.index) ? envelope.index : null);
  return {
    machine_id: typeof machine?.machine_id === 'string' ? machine.machine_id : '',
    index,
    mode: blobSha256 === null ? 'inline' : 'blob',
    ...(head === null ? {} : { stdout: head }),
    ...(blobSha256 === null ? {} : { blob_sha256: blobSha256 }),
  };
}

/**
 * @param {{machines?: object[], reducerMachineId?: string|null, expectedIndexTotal?: number|null}} input
 * @returns {{
 *   ready: boolean,
 *   plan: object,
 *   candidates: Array<{machine_id: string, reason: string}>,
 *   missing: number[],
 *   next: string,
 * }}
 */
export function suggestReduce(input = {}) {
  const machines = Array.isArray(input.machines) ? input.machines : [];
  const reducerMachineId = typeof input.reducerMachineId === 'string' && input.reducerMachineId !== ''
    ? input.reducerMachineId
    : null;
  const expectedIndexTotal = Number.isInteger(input.expectedIndexTotal) && input.expectedIndexTotal > 0
    ? input.expectedIndexTotal
    : null;

  const reported = machines.filter(machineReported);
  const results = reported.map(reduceInputOf);
  const candidates = reported.map((machine) => ({
    machine_id: typeof machine?.machine_id === 'string' ? machine.machine_id : '',
    reason: 'reported-shard',
  }));

  /**
   * The reducer is a caller decision. A named reducer that never reported is a refusal with a name, not a suggestion to pick
   * somebody else: changing the machine changes what the reduce runs against.
   */
  let plan;
  if (reducerMachineId !== null && !candidates.some((candidate) => candidate.machine_id === reducerMachineId)) {
    plan = { ok: false, code: 'REDUCER_UNREPORTED', detail: { reducerMachineId } };
  } else {
    plan = buildReducePlan({
      results,
      reducerMachineId,
      expectedIndexTotal,
    });
  }

  const missing = plan.ok === false && plan.code === 'MISSING_SHARD' && Array.isArray(plan.detail?.missing)
    ? [...plan.detail.missing]
    : [];
  return {
    ready: plan.ok === true,
    plan,
    candidates,
    missing,
    next: REDUCE_NEXT_STEP,
  };
}
