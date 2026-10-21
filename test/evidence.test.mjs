/**
 * Acceptance evidence tests (M7, v1.3.10-beta.24 slice).
 *
 * Includes the evidence files actually committed under docs/acceptance: a schema that rejects the project evidence would be a
 * schema written for a fictional project.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeEvidence, validateEvidence } from '../src/acceptance/evidence.mjs';

const valid = {
  version: "1.3.10-beta.10",
  case: "M1-LIVE-DIAG",
  kind: "positive",
  requirement: "a signed maintenance request runs on a real machine",
  machines: ["1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc"],
  commands: [["node", "--version"]],
  task_id: "01M5G3HVZPNN8ES63NJPV7MRN5",
  ledger_seq: [100, 104],
  result: { outcome: "ok", assertions: { version: "1.3.10-beta.10" } },
  artifacts: [{ sha256: "a".repeat(64), bytes: 1234 }],
  executed_at: "2026-10-21T20:47:00Z",
  executor: "lead",
  reproduce: "docs/acceptance/1.3.10-beta.10/RUNBOOK.md#M1-LIVE-DIAG",
};

describe("acceptance evidence", () => {
  it("accepts a complete positive record", () => {
    assert.deepEqual(validateEvidence(valid), { ok: true, errors: [] });
  });
  it("reports every missing field at once", () => {
    const verdict = validateEvidence({});
    assert.equal(verdict.ok, false);
    const codes = verdict.errors.map((error) => error.code);
    for (const code of ["VERSION_MISSING", "CASE_INVALID", "KIND_INVALID", "REQUIREMENT_MISSING", "MACHINES_INVALID", "EXECUTED_AT_INVALID", "EXECUTOR_INVALID", "RESULT_MISSING"]) assert.ok(codes.includes(code), code + " should be reported");
  });
  it("refuses a positive case with no task id and a bad kind", () => {
    const noTask = validateEvidence({ ...valid, task_id: "" });
    assert.equal(noTask.ok, false);
    assert.deepEqual(noTask.errors.map((error) => error.code), ["TASK_ID_MISSING"]);
    const badKind = validateEvidence({ ...valid, kind: "magic" });
    assert.deepEqual(badKind.errors.map((error) => error.code), ["KIND_INVALID"]);
  });
  it("validates ledger ranges, artifacts and commands", () => {
    assert.equal(validateEvidence({ ...valid, ledger_seq: [5, 4] }).errors[0].code, "LEDGER_SEQ_INVALID");
    assert.equal(validateEvidence({ ...valid, artifacts: [{ sha256: "nope", bytes: 1 }] }).errors[0].code, "ARTIFACTS_INVALID");
    assert.equal(validateEvidence({ ...valid, commands: [[""]] }).errors[0].code, "COMMANDS_INVALID");
  });
  it("summarises valid records and names the invalid ones", () => {
    const summary = summarizeEvidence([valid, { ...valid, case: "M2-NEGATIVE", kind: "negative", task_id: undefined }, { case: "BROKEN" }]);
    assert.equal(summary.total, 3);
    assert.equal(summary.valid, 2);
    assert.equal(summary.invalid.length, 1);
    assert.equal(summary.byKind.positive, 1);
    assert.equal(summary.byKind.negative, 1);
  });
  it("validates every evidence file committed under docs/acceptance", () => {
    const root = "docs/acceptance";
    const files = readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".json"));
    assert.ok(files.length >= 1, "at least one committed evidence file must exist");
    for (const name of files) {
      const record = JSON.parse(readFileSync(join(root, String(name)), "utf8"));
      const verdict = validateEvidence(record);
      assert.equal(verdict.ok, true, String(name) + " is not valid evidence: " + JSON.stringify(verdict.errors));
    }
  });
});
