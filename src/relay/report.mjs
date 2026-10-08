/**
 * W2M Rabbit relay — §6.3 six-state aggregation + markdown/JSON reports.
 *
 * The step order is part of the contract: Step 0 → Step 1 → Step 2 → Step 3.
 * Steps are NEVER merged, because the order changes the verdict.
 */

import {
  COMPARABLE_FIELDS,
  FAILURE_STATUSES,
  ProtocolError,
  PROTOCOL_VERSION,
  jcs,
  rfc3339,
} from './state.mjs';

/** Aggregate statuses this module can return. */
export const AGGREGATE_STATUSES = Object.freeze([
  // ---- the six verdicts of §6.3 ----
  'consistent',
  'divergent',
  'divergent-platform',
  'failed',
  'partial',
  'unverifiable',
  // ---- added in v0.3.0 ----
  //
  // These three are *verdicts*, not phase flags, which is why they belong in this list rather than
  // beside `pending`. Each answers a question the original six could not express:
  //
  //   timeout    nobody reported and the work is no longer waiting on anybody. `partial` said "some
  //              machines are still out"; `timeout` says "we waited as long as we agreed to wait,
  //              and the machines that never answered are not coming back".
  //   cancelled  the operator stopped it. Distinct from `failed`: nothing went wrong, we chose this.
  //              A cancellation must not be reported as a defect, or every intentional stop becomes
  //              noise that trains people to ignore the status.
  //   degraded   every machine reported, some succeeded and some failed. `partial` used to carry
  //              this, but `partial` also means "still in flight", so a reader could not tell a
  //              finished task in a bad state from one that had not finished. Both are now explicit.
  'timeout',
  'cancelled',
  'degraded',
  // ---- not verdicts: no terminal answer exists yet, or none was ever possible ----
  'refused',
  'pending',
]);

/** Comparable fields that are derived purely from the stdout byte stream. */
const STDOUT_DERIVED_FIELDS = Object.freeze([
  'stdout_sha256',
  'stdout_bytes',
  'stdout_normalized_sha256',
]);

function valueOf(envelope, field) {
  return envelope === null || envelope === undefined ? undefined : envelope[field];
}

function canon(value) {
  return value === undefined ? '<absent>' : jcs(value);
}

function truncate(text, max = 160) {
  const s = typeof text === 'string' ? text : String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * §6.3 six-state aggregation.
 *
 * @param {object} task            Rabbit task record (state.mjs `createTask` result)
 * @param {Iterable<object>} resultRecords  result records from `RabbitState#results`
 * @param {{nowMs?:number}} [opts]
 * @returns {object} aggregation report data
 */
export function aggregate(task, resultRecords = [], opts = {}) {
  if (!task) throw new ProtocolError('NOT_FOUND', 'task is required for aggregation');
  const nowMs = opts.nowMs ?? Date.now();

  const records = [...resultRecords].filter((r) => r?.envelope?.task_id === task.task_id);
  // latest attempt per machine wins
  const byMachine = new Map();
  for (const rec of records) {
    const prev = byMachine.get(rec.machine_id);
    if (!prev || rec.received_at_ms >= prev.received_at_ms) byMachine.set(rec.machine_id, rec);
  }

  const expected = {
    base_commit: task.base_commit ?? null,
    base_tree: task.base_tree ?? null,
    command_hash: task.command_hash ?? null,
  };

  const machines = [];
  for (const lease of task.leases.values()) {
    const rec = byMachine.get(lease.machine_id) ?? null;
    machines.push({
      machine_id: lease.machine_id,
      machine_name: lease.machine_name ?? null,
      index: lease.index,
      attempt: lease.attempt,
      lease_state: lease.state,
      lease_expired: lease.state === 'expired',
      refused_reason: lease.refusal_reason ?? null,
      gate_refused: lease.state === 'refused',
      // v0.3.3 `broadcast`: a machine that was told the outcome but never handed the command. It has
      // no envelope and never will, so without this marker the anchor step classified it `pending`
      // and the task could never reach a verdict -- a broadcast would hang forever.
      observing: lease.state === 'observing',
      result: rec,
      envelope: rec?.envelope ?? null,
      outcome: null,
      reasons: [],
    });
  }
  // results from machines with no lease (e.g. takeover / manual upload)
  for (const [machineId, rec] of byMachine) {
    if (machines.some((m) => m.machine_id === machineId)) continue;
    machines.push({
      machine_id: machineId,
      machine_name: rec.envelope.machine_name ?? null,
      index: rec.envelope.index ?? null,
      attempt: rec.attempt,
      lease_state: 'unleased',
      lease_expired: false,
      refused_reason: rec.envelope.refusal_reason ?? null,
      gate_refused: false,
      result: rec,
      envelope: rec.envelope,
      outcome: null,
      reasons: [],
    });
  }

  const steps = [];
  const notes = [];

  /* -------- Step 0: refusals are booked per machine, they never block others -------- */
  const step0 = { step: 0, name: 'refusal', refused: [], passed: [], observing: [] };
  for (const m of machines) {
    if (m.observing) {
      // Not a participant: it was never asked to run, so it cannot refuse, cannot pass, and must
      // never be counted as agreeing. Recording the outcome is the whole reason it is listed.
      m.outcome = 'observing';
      step0.observing.push(m.machine_id);
      continue;
    }
    const refusedByGate = m.gate_refused;
    const refusedByEnvelope = m.envelope?.status === 'refused';
    if (refusedByGate || refusedByEnvelope) {
      m.outcome = 'refused';
      m.refusal_reason = refusedByGate
        ? (m.refused_reason ?? 'REFUSED')
        : (m.envelope.refusal_reason ?? 'REFUSED');
      step0.refused.push({ machine_id: m.machine_id, refusal_reason: m.refusal_reason });
    } else {
      step0.passed.push(m.machine_id);
    }
  }
  steps.push(step0);

  const participants = machines.filter((m) => m.outcome !== 'refused' && m.outcome !== 'observing');

  /* -------- Step 1: anchors — any violation refuses aggregation entirely -------- */
  const step1 = { step: 1, name: 'anchors', violations: [], passed: [], pending: [] };
  for (const m of participants) {
    const env = m.envelope;
    if (!env) {
      const expired = m.lease_expired;
      m.outcome = expired ? 'expired' : 'pending';
      step1.pending.push(m.machine_id);
      continue;
    }
    const validation = m.result?.validation ?? { missing: [], problems: [] };
    const missing = [...(validation.missing ?? [])];
    if (m.result?.effective_status === 'unverifiable' && missing.length === 0) {
      m.reasons.push('envelope status = unverifiable');
    }
    if (missing.length > 0) m.reasons.push(`missing required fields: ${missing.join(',')}`);
    if (canon(valueOf(env, 'base_commit')) !== canon(expected.base_commit)) {
      m.reasons.push(`base_commit ${truncate(canon(env.base_commit), 24)} != expected ${truncate(canon(expected.base_commit), 24)}`);
    }
    if (expected.base_tree !== null && canon(valueOf(env, 'pre_tree_fingerprint')) !== canon(expected.base_tree)) {
      m.reasons.push('pre_tree_fingerprint != base_tree');
    }
    if (canon(valueOf(env, 'command_hash')) !== canon(expected.command_hash)) {
      m.reasons.push('command_hash mismatch');
    }
    if (env.status === 'unverifiable' && m.reasons.length === 0) {
      m.reasons.push('envelope status = unverifiable');
    }
    if (m.reasons.length > 0) {
      m.outcome = 'unverifiable';
      step1.violations.push({ machine_id: m.machine_id, reasons: [...m.reasons] });
    } else {
      m.outcome = 'ok-pending-step2';
      step1.passed.push(m.machine_id);
    }
  }
  steps.push(step1);

  const runnable = participants.filter((m) => m.outcome === 'ok-pending-step2');
  const expiredMachines = participants.filter((m) => m.outcome === 'expired');
  const pendingMachines = participants.filter((m) => m.outcome === 'pending');

  let status;
  const step2 = { step: 2, name: 'execution', ok: [], failed: [], partial: false, expired: [], pending: [] };
  const step3 = { step: 3, name: 'comparison', differences: [], consistent: false, platform_only: false };

  if (step1.violations.length > 0) {
    /* §6.3 Step 1: 拒绝汇总 */
    status = 'unverifiable';
    step2.skipped = 'step1_unverifiable';
    step3.skipped = 'step1_unverifiable';
    notes.push('aggregation refused: Step 1 anchor violation (see unverifiable machines)');
  } else if (task.cancelled === true) {
    /* v0.3.0: the operator stopped it. A chosen stop is not a defect. */
    //
    // Checked before `unverifiable`-adjacent outcomes and before any timeout: once someone has
    // deliberately stopped the work, reporting "failed" or "timed out" would describe a decision as
    // a malfunction, and enough of those trains a reader to ignore the status entirely.
    status = 'cancelled';
    step2.skipped = 'task_cancelled';
    step3.skipped = 'task_cancelled';
    notes.push(
      task.cancel_reason ? `cancelled by the operator: ${task.cancel_reason}` : 'cancelled by the operator',
    );
  } else if (runnable.length === 0 && expiredMachines.length === 0 && pendingMachines.length === 0 && step0.refused.length > 0) {
    status = 'refused';
    step2.skipped = 'all_refused';
    step3.skipped = 'all_refused';
  } else if (runnable.length === 0 && expiredMachines.length === 0) {
    /* v0.3.0: distinguish "still waiting" from "waited long enough". */
    //
    // `pending` means the task is live and more envelopes may still arrive. Once the deadline the
    // caller set has passed and machines are still silent, that is a verdict, and calling it
    // `pending` forever leaves a reader unable to tell a stuck task from a slow one.
    const deadline = Number.isFinite(task.deadline_ms) ? task.deadline_ms : 0;
    if (deadline > 0 && nowMs >= deadline) {
      status = 'timeout';
      step2.skipped = 'deadline_passed';
      step3.skipped = 'deadline_passed';
      notes.push(
        `no result envelope by the ${task.timeout_ms}ms deadline (${pendingMachines.length} machine(s) still silent)`,
      );
    } else {
      status = 'pending';
      step2.skipped = 'no_results_yet';
      step3.skipped = 'no_results_yet';
      notes.push('no result envelope has been received yet');
    }
  } else {
    for (const m of runnable) {
      const s = m.envelope.status;
      if (s === 'ok') { m.outcome = 'ok'; step2.ok.push(m.machine_id); }
      else {
        // {nonzero_exit,timeout,crashed} plus anything outside the §5.1 enum
        m.outcome = 'failed';
        step2.failed.push({
          machine_id: m.machine_id,
          status: s,
          exit_code: m.envelope.exit_code ?? null,
          known_failure: FAILURE_STATUSES.includes(s),
        });
      }
    }
    for (const m of expiredMachines) step2.expired.push(m.machine_id);
    for (const m of pendingMachines) step2.pending.push(m.machine_id);

    if (step2.expired.length > 0) {
      /* §4.3: halt=never → booked and marked partial */
      status = 'partial';
      step2.partial = true;
      notes.push(`lease expired on ${step2.expired.length} machine(s) → partial (§4.3)`);
      step3.skipped = 'lease_expired';
    } else if (step2.pending.length > 0) {
      status = 'partial';
      step2.partial = true;
      notes.push(`waiting for ${step2.pending.length} machine(s) to report`);
      step3.skipped = 'machines_pending';
    } else if (step2.failed.length === 0 && step2.ok.length > 0) {
      /* §6.3 Step 2: 全部 ok → Step 3 */
      const okMachines = runnable.filter((m) => m.outcome === 'ok');

      // Compare **within a shard**, not across the whole task.
      //
      // `index` is a comparable field, and `split` assigns it per machine by design -- so comparing
      // every machine against every other made `index` differ on any successful fan-out, and every
      // split task was reported `divergent`. That is a false alarm on the normal case: `divergent`
      // tells an operator the machines disagreed, when in fact they did exactly what was asked.
      //
      // Grouping by `index` fixes it without special-casing the field: machines meant to produce the
      // same output are compared with each other, and machines given different slices are not
      // compared at all. For `replicate` every machine has index 0, so there is a single group and
      // the behaviour is exactly as before -- which is why the existing 140 relay tests still pass
      // unchanged.
      const shards = new Map();
      for (const m of okMachines) {
        const key = m.index ?? 0;
        if (!shards.has(key)) shards.set(key, []);
        shards.get(key).push(m);
      }

      const comparable = {};
      for (const field of COMPARABLE_FIELDS) {
        comparable[field] = {};
        for (const m of okMachines) {
          const v = valueOf(m.envelope, field);
          if (v !== undefined) comparable[field][m.machine_id] = v;
        }
      }

      /**
       * Fields that differ within some shard, with the shard that disagreed.
       *
       * `index` is reported with the shard so a genuine mixed-mode divergence ("shard 0 agreed,
       * shard 1 did not") stays unambiguous.
       */
      const differences = [];
      for (const [shardIndex, members] of shards) {
        if (members.length < 2) continue; // one machine cannot disagree with itself
        for (const field of COMPARABLE_FIELDS) {
          const values = members.map((m) => canon(valueOf(m.envelope, field)));
          if (values.some((v) => v !== values[0])) {
            differences.push({
              field,
              index: shardIndex,
              values: Object.fromEntries(members.map((m) => [m.machine_id, valueOf(m.envelope, field)])),
            });
          }
        }
      }
      step3.comparable = comparable;
      step3.differences = differences;

      /** Metadata drift within any shard, for the `divergent-platform` branch. */
      const metaDiffers = (field) => {
        for (const members of shards.values()) {
          if (members.length < 2) continue;
          const vals = members.map((m) => canon(valueOf(m.envelope, field)));
          if (vals.some((v) => v !== vals[0])) return true;
        }
        return false;
      };
      const platformMetaDiffers = metaDiffers('toolchain') || metaDiffers('platform');

      if (differences.length === 0) {
        status = 'consistent';
        step3.consistent = true;
      } else if (platformMetaDiffers && differences.every((d) => STDOUT_DERIVED_FIELDS.includes(d.field))) {
        /* §6.3 Step 3: expected — only toolchain/platform differ and the drift is stdout-only */
        status = 'divergent-platform';
        step3.platform_only = true;
        notes.push('divergence is confined to stdout bytes across differing toolchain/platform (expected, no alert)');
      } else {
        status = 'divergent';
        notes.push(`divergent fields: ${differences.map((d) => d.field).join(', ')}`);
      }
    } else if (step2.ok.length > 0) {
      /* v0.3.0 §6.3 Step 2: 部分 ok、部分失败 → degraded */
      //
      // This used to be `partial`, which was wrong in a way that mattered: `partial` is also the
      // answer while machines are still out, so "finished, and half of it failed" was
      // indistinguishable from "still running" in the one field a reader looks at first. Every
      // machine here has reported, so the task is over and the verdict is `degraded` -- some of the
      // work succeeded, the rest did not, and nothing further is coming.
      status = 'degraded';
      step2.partial = true;
      notes.push(`${step2.ok.length} machine(s) succeeded and ${step2.failed.length} failed`);
    } else {
      /* §6.3 Step 2: 全部失败 → failed */
      status = 'failed';
    }
  }

  steps.push(step2);
  steps.push(step3);

  return {
    protocol_version: PROTOCOL_VERSION,
    task_id: task.task_id,
    status,
    computed_at: rfc3339(nowMs),
    mode: task.mode,
    index_total: task.index_total,
    halt: task.halt,
    write: task.write,
    created_at: rfc3339(task.created_at_ms),
    created_by: task.created_by ?? null,
    cancelled: task.cancelled === true,
    expected,
    machines: machines.map((m) => ({
      machine_id: m.machine_id,
      machine_name: m.machine_name,
      index: m.index,
      attempt: m.attempt,
      lease_state: m.lease_state,
      outcome: m.outcome,
      status: m.envelope?.status ?? null,
      refusal_reason: m.refusal_reason ?? null,
      exit_code: m.envelope?.exit_code ?? null,
      reasons: m.reasons,
    })),
    steps,
    differences: step3.differences ?? [],
    notes,
    counts: {
      refused: step0.refused.length,
      unverifiable: step1.violations.length,
      ok: step2.ok?.length ?? 0,
      failed: step2.failed?.length ?? 0,
      expired: step2.expired?.length ?? 0,
      pending: step2.pending?.length ?? 0,
    },
  };
}

/** Convenience wrapper: pull the task + its results out of a RabbitState. */
export function aggregateTask(state, taskId, opts = {}) {
  const task = state.getTask(taskId);
  if (!task) throw new ProtocolError('NOT_FOUND', 'unknown task_id', { task_id: taskId });
  return aggregate(task, state.results.values(), opts);
}

const STATUS_LABEL = Object.freeze({
  consistent: '✅ consistent',
  divergent: '❌ divergent',
  'divergent-platform': '🟡 divergent-platform',
  failed: '❌ failed',
  partial: '🟠 partial',
  unverifiable: '⚠️ unverifiable',
  // v0.3.0 verdicts. Each keeps a distinct shape because these are read at a glance: `partial`
  // (still out), `degraded` (finished badly) and `timeout` (never answered) must not look alike.
  degraded: '🟧 degraded',
  timeout: '⏱️ timeout',
  cancelled: '🚫 cancelled',
  refused: '⛔ refused',
  pending: '⏳ pending',
});

function fmt(value) {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  return truncate(jcs(value), 80);
}

/** Markdown summary report (GET /v1/tasks/{id}/report?format=md). */
export function renderReportMarkdown(agg, task = null) {
  const L = [];
  L.push(`# W2M 汇总报告 — \`${agg.task_id}\``);
  L.push('');
  L.push(`**判定：${STATUS_LABEL[agg.status] ?? agg.status}**`);
  L.push('');
  L.push('| 字段 | 值 |');
  L.push('|---|---|');
  L.push(`| protocol_version | ${agg.protocol_version} |`);
  L.push(`| 模式 | ${agg.mode} |`);
  L.push(`| index_total | ${agg.index_total} |`);
  L.push(`| 写入 | ${agg.write} |`);
  L.push(`| halt | ${agg.halt} |`);
  L.push(`| 创建者 | ${fmt(agg.created_by)} |`);
  L.push(`| 创建时间 | ${agg.created_at} |`);
  L.push(`| 汇总时间 | ${agg.computed_at} |`);
  L.push(`| base_commit | \`${fmt(agg.expected.base_commit)}\` |`);
  L.push(`| base_tree | \`${fmt(agg.expected.base_tree)}\` |`);
  L.push(`| command_hash | \`${fmt(agg.expected.command_hash)}\` |`);
  L.push('');
  L.push('## 逐机结果');
  L.push('');
  L.push('| machine_id | index | lease | 判定 | status | exit_code | 说明 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of agg.machines) {
    L.push(`| \`${m.machine_id}\` | ${fmt(m.index)} | ${m.lease_state} | ${m.outcome ?? '—'} | ${fmt(m.status)} `
      + `| ${fmt(m.exit_code)} | ${m.reasons.length ? m.reasons.join('; ') : (m.refusal_reason ?? '')} |`);
  }
  L.push('');
  if (agg.differences.length > 0) {
    L.push('## 可比字段差异');
    L.push('');
    for (const d of agg.differences) {
      L.push(`### \`${d.field}\``);
      L.push('');
      L.push('| machine_id | value |');
      L.push('|---|---|');
      for (const [machine, value] of Object.entries(d.values)) {
        L.push(`| \`${machine}\` | \`${fmt(value)}\` |`);
      }
      L.push('');
    }
  }
  L.push('## 判定步骤（§6.3，顺序不可合并）');
  L.push('');
  for (const s of agg.steps) {
    L.push(`- **Step ${s.step} · ${s.name}** — ${truncate(jcs(s), 400)}`);
  }
  L.push('');
  if (agg.notes.length > 0) {
    L.push('## 备注');
    L.push('');
    for (const n of agg.notes) L.push(`- ${n}`);
    L.push('');
  }
  if (task) {
    L.push('## 原始命令');
    L.push('');
    L.push('```');
    L.push(jcs(task.command_argv));
    L.push('```');
    L.push('');
  }
  return L.join('\n');
}

/** JSON report (GET /v1/tasks/{id}/report?format=json). */
export function renderReportJson(agg) {
  return JSON.stringify(agg, null, 2);
}

/**
 * Build a report of the requested format.
 * @returns {{contentType:string, body:string, aggregate:object}}
 */
export function buildReport(state, taskId, { format = 'json', nowMs } = {}) {
  const agg = aggregateTask(state, taskId, { nowMs });
  const task = state.getTask(taskId);
  if (format === 'md' || format === 'markdown') {
    return { contentType: 'text/markdown; charset=utf-8', body: renderReportMarkdown(agg, task), aggregate: agg };
  }
  if (format === 'json') {
    return { contentType: 'application/json; charset=utf-8', body: renderReportJson(agg), aggregate: agg };
  }
  throw new ProtocolError('BAD_REQUEST', 'format must be md|json', { format });
}

/** Machine-readable verdict used by GET /v1/tasks/{id}. */
export function taskStatus(state, taskId, opts = {}) {
  return aggregateTask(state, taskId, opts);
}
