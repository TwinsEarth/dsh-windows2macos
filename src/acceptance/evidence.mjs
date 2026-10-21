/**
 * Acceptance evidence validation (M7, v1.3.10-beta.24 slice).
 *
 * M7 says a capability is accepted only when its evidence is reproducible: a real task id, a real machine, an asserted result,
 * a timestamp and an executor, stored in docs/acceptance/<version>/. This module is the schema those files must satisfy and the
 * summary the release notes read. It validates the document; it cannot validate that the run happened, which is exactly why the
 * remaining fields (task_id, machines, executed_at) are required rather than optional.
 */
export const EVIDENCE_KINDS = Object.freeze(['positive', 'negative', 'chaos']);
export const EVIDENCE_EXECUTORS = Object.freeze(['lead', 'human', 'agent']);

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isArtifactSha = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isIsoTimestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);

/**
 * Validate one evidence record. Returns every problem, not just the first: a release check should list what to fix.
 */
export function validateEvidence(record) {
  const errors = [];
  const fail = (code, field, message) => errors.push({ code, field, message });
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: [{ code: "EVIDENCE_NOT_OBJECT", field: null, message: "evidence must be a JSON object" }] };
  }
  if (!isNonEmptyString(record.version)) fail("VERSION_MISSING", "version", "version is required");
  if (!isNonEmptyString(record.case) || !/^[A-Z0-9][A-Z0-9-]{0,79}$/.test(record.case)) fail("CASE_INVALID", "case", "case must be an uppercase id such as M1-LIVE-DIAG");
  if (!EVIDENCE_KINDS.includes(record.kind)) fail("KIND_INVALID", "kind", "kind must be positive, negative or chaos");
  if (!isNonEmptyString(record.requirement)) fail("REQUIREMENT_MISSING", "requirement", "requirement is required");
  if (!Array.isArray(record.machines) || record.machines.length === 0 || !record.machines.every(isNonEmptyString)) fail("MACHINES_INVALID", "machines", "machines must be a non-empty array of machine ids");
  if (!isIsoTimestamp(record.executed_at)) fail("EXECUTED_AT_INVALID", "executed_at", "executed_at must be an ISO timestamp");
  if (!EVIDENCE_EXECUTORS.includes(record.executor)) fail("EXECUTOR_INVALID", "executor", "executor must be lead, human or agent");
  if (record.commands !== undefined) {
    const commandsValid = Array.isArray(record.commands) && record.commands.every((argv) => Array.isArray(argv) && argv.length > 0 && argv.every(isNonEmptyString));
    if (!commandsValid) fail("COMMANDS_INVALID", "commands", "commands must be an array of argv arrays");
  }
  if (record.ledger_seq !== undefined) {
    const valid = Array.isArray(record.ledger_seq) && record.ledger_seq.length === 2 && record.ledger_seq.every((value) => Number.isInteger(value) && value >= 0) && record.ledger_seq[0] <= record.ledger_seq[1];
    if (!valid) fail("LEDGER_SEQ_INVALID", "ledger_seq", "ledger_seq must be [from, to] with from <= to");
  }
  if (record.artifacts !== undefined) {
    const valid = Array.isArray(record.artifacts) && record.artifacts.every((artifact) => artifact !== null && typeof artifact === "object" && isArtifactSha(artifact.sha256) && Number.isInteger(artifact.bytes) && artifact.bytes >= 0);
    if (!valid) fail("ARTIFACTS_INVALID", "artifacts", "artifacts must be [{sha256, bytes}]");
  }
  if (record.result === null || typeof record.result !== "object" || Array.isArray(record.result)) {
    fail("RESULT_MISSING", "result", "result object is required");
  } else {
    // A record may carry the verdict at the top level or under a nested task object (the live restart evidence does the latter),
    // because both are the same fact; what is not allowed is a result with no verdict anywhere.
    const outcome = isNonEmptyString(record.result.outcome) ? record.result.outcome : (record.result.task !== null && typeof record.result.task === "object" && isNonEmptyString(record.result.task.outcome) ? record.result.task.outcome : "");
    if (outcome === "") fail("RESULT_OUTCOME_MISSING", "result.outcome", "result.outcome (or result.task.outcome) is required");
    if (record.result.assertions !== undefined && (record.result.assertions === null || typeof record.result.assertions !== "object" || Array.isArray(record.result.assertions))) {
      fail("RESULT_ASSERTIONS_INVALID", "result.assertions", "result.assertions must be an object when present");
    }
  }
  if (record.kind === "positive") {
    if (!isNonEmptyString(record.task_id)) fail("TASK_ID_MISSING", "task_id", "a positive case must name the real task it ran");
  } else if (record.task_id !== undefined && record.task_id !== null && !isNonEmptyString(record.task_id)) {
    fail("TASK_ID_INVALID", "task_id", "task_id must be a string when present");
  }
  return { ok: errors.length === 0, errors };
}

/** Counts by kind and version, for a release note or a gate summary. */
export function summarizeEvidence(records) {
  const byKind = {};
  const byVersion = {};
  const invalid = [];
  for (const record of records) {
    const verdict = validateEvidence(record);
    if (!verdict.ok) {
      invalid.push({ case: record?.case ?? null, errors: verdict.errors });
      continue;
    }
    const version = record.version;
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    byVersion[version] = (byVersion[version] ?? 0) + 1;
  }
  return { total: records.length, valid: records.length - invalid.length, invalid, byKind, byVersion };
}
