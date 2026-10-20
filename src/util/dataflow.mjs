/**
 * Data flow across the fleet: map results that are too big to return inline travel as blobs, and the reduce step names
 * exactly which blob it read.
 *
 * ## Why a plan instead of a pipe
 *
 * Machines do not send data to each other directly: the relay is the only channel every machine can reach, and it already
 * stores content-addressed blobs. So the shape is map -> PUT blob -> reduce by sha256. The decisions worth testing are the
 * boundaries: when an output is inline, when it becomes a blob, and what happens when a blob a reduce depends on is not
 * there. A pipeline that silently drops a shard is worse than one that fails.
 */

/** Stage stdout at or below this travels inline in the result envelope. */
export const MAX_INLINE_BYTES = 64 * 1024;

/** Past this a stage output is not a result any more: it is a data problem the operator has to see. */
export const HARD_CAP_BYTES = 16 * 1024 * 1024;

/**
 * Decide how one machine's stage output travels.
 *
 * @param {{machineId?: string, stageIndex?: number, stdoutBytes?: number}} input
 * @returns {{ok: true, mode: 'inline'|'blob', stdoutBytes: number} | {ok: false, code: string, detail: object}}
 */
export function planStageOutput(input = {}) {
  const machineId = typeof input.machineId === 'string' && input.machineId !== '' ? input.machineId : null;
  if (machineId === null) return { ok: false, code: 'STAGE_MACHINE_MISSING', detail: {} };
  const stdoutBytes = Number.isFinite(input.stdoutBytes) ? Math.max(0, Math.floor(input.stdoutBytes)) : 0;
  if (stdoutBytes > HARD_CAP_BYTES) {
    return { ok: false, code: 'STAGE_OUTPUT_TOO_LARGE', detail: { machineId, stdoutBytes, hardCapBytes: HARD_CAP_BYTES } };
  }
  return { ok: true, mode: stdoutBytes <= MAX_INLINE_BYTES ? 'inline' : 'blob', stdoutBytes };
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Build the reduce input list from the map results.
 *
 * Every map machine must contribute exactly one entry: inline text is carried as-is, a blob result must name a sha256.
 * A missing or malformed hash is refused by name -- the reduce step must never run on a partial fleet and call the answer
 * complete.
 *
 * @param {{results?: Array<{machine_id?: string, mode?: string, stdout?: string, blob_sha256?: string, index?: number}>,
 *          expectedIndexTotal?: number|null,
 *          reducerMachineId?: string}} input
 * @returns {{ok: true, reducerMachineId: string, inputs: Array<{machine_id: string, mode: 'inline'|'blob', stdout?: string, sha256?: string}>} |
 *           {ok: false, code: string, detail: object}}
 */
export function buildReducePlan(input = {}) {
  const reducer = typeof input.reducerMachineId === 'string' && input.reducerMachineId !== '' ? input.reducerMachineId : null;
  if (reducer === null) return { ok: false, code: 'REDUCER_MISSING', detail: {} };
  const results = Array.isArray(input.results) ? input.results : null;
  if (results === null || results.length === 0) return { ok: false, code: 'NO_MAP_RESULTS', detail: {} };
  /**
   * v1.2.7: what the task SAID would be produced, not just what arrived.
   *
   * Without an expected count the plan can only describe the reports it was handed, so a split run where one shard never
   * reported produced a plan that looked complete. The count comes from the task (index_total); a missing index is refused
   * by name before the reduce step can run on a partial fleet.
   */
  const expectedTotal = Number.isInteger(input.expectedIndexTotal) && input.expectedIndexTotal > 0 ? input.expectedIndexTotal : null;
  const seenIndexes = new Set();

  const seen = new Set();
  const inputs = [];
  for (const result of results) {
    const machineId = typeof result?.machine_id === 'string' && result.machine_id !== '' ? result.machine_id : null;
    if (machineId === null) return { ok: false, code: 'MAP_MACHINE_MISSING', detail: {} };
    if (seen.has(machineId)) return { ok: false, code: 'MAP_MACHINE_DUPLICATE', detail: { machineId } };
    seen.add(machineId);
    if (expectedTotal !== null) {
      const index = Number.isInteger(result?.index) ? result.index : null;
      if (index === null) return { ok: false, code: 'MAP_INDEX_MISSING', detail: { machineId } };
      if (index < 0 || index >= expectedTotal) {
        return { ok: false, code: 'MAP_INDEX_OUT_OF_RANGE', detail: { machineId, index, expectedIndexTotal: expectedTotal } };
      }
      seenIndexes.add(index);
    }
    const mode = result?.mode === 'blob' ? 'blob' : 'inline';
    if (mode === 'blob') {
      const sha = typeof result?.blob_sha256 === 'string' ? result.blob_sha256.toLowerCase() : '';
      if (!SHA256.test(sha)) return { ok: false, code: 'BLOB_MISSING', detail: { machineId, sha256: result?.blob_sha256 ?? null } };
      inputs.push({ machine_id: machineId, mode, sha256: sha });
    } else {
      inputs.push({ machine_id: machineId, mode, stdout: typeof result?.stdout === 'string' ? result.stdout : '' });
    }
  }
  if (expectedTotal !== null) {
    const missing = [];
    for (let index = 0; index < expectedTotal; index += 1) if (!seenIndexes.has(index)) missing.push(index);
    if (missing.length > 0) return { ok: false, code: 'MISSING_SHARD', detail: { missing, expectedIndexTotal: expectedTotal } };
  }
  return { ok: true, reducerMachineId: reducer, inputs };
}
