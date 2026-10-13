/**
 * The action set the chat bridge calls, and how a fleet result becomes a sentence (v0.7.2).
 *
 * ## What this file is for
 *
 * `bridge.mjs` takes an `actions` object and hands it to `commands.mjs`. Until now nothing
 * produced one for the real fleet, so `/run` could only ever answer "this install has no fleet".
 * This is that producer: it takes the executor from `fleet.mjs` and the DSH-facing operations
 * the host supplies, and returns something a command handler can call.
 *
 * ## The formatting rule
 *
 * A chat reply is read on a phone, once, and often while walking. So a verdict is never
 * paraphrased into "done" or "failed" — the relay's own word is shown, with the machine names
 * that produced it, because `divergent-platform` and `divergent` mean different things and
 * collapsing them turns a platform difference into a bug report. Long output is truncated at a
 * line boundary with the omission **stated**, never silently cut.
 *
 * ## What is injected and what is real
 *
 * The fleet half is real: it talks to the relay. The session half (`listSessions`, `bind`,
 * `tail`, `prompt`, `setPolicy`) is the DSH host's, because only the host knows its sessions —
 * so it is injected, and a host that supplies none gets named refusals rather than silence.
 */

import { CAPABILITY } from './commands.mjs';

/** How much of a task's output is worth putting on a phone. */
export const DEFAULT_TAIL_LINES = 24;

/** Truncate at a line boundary and say so. A silent cut reads as "that was all of it". */
export function tailLines(text, limit = DEFAULT_TAIL_LINES) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= limit) return lines.join('\n');
  const kept = lines.slice(-limit);
  return [`…（省略前 ${lines.length - limit} 行）`, ...kept].join('\n');
}

/**
 * A one-line-per-machine summary, using the field names a live relay actually returns.
 *
 * Measured on a report: each row carries `machine_name`, `outcome` (the per-machine verdict),
 * `status` (what the process did — `nonzero_exit`, `ok`), `lease_state`, and `exit_code`. The
 * first version of this read `machine`/`verdict`, which are both `undefined` in a real response,
 * so every machine would have printed as `?: ?` while the task completed perfectly.
 */
export function describeMachines(body) {
  const rows = [];
  for (const key of ['machines', 'leases', 'results']) {
    if (Array.isArray(body?.[key])) {
      rows.push(...body[key]);
      break;
    }
  }
  if (rows.length === 0 && body && typeof body === 'object' && !Array.isArray(body)) {
    // A map keyed by machine name, which some shapes use. An empty object is not a map of zero
    // machines and must not be reported as one — `[]` and "no per-machine shape at all" are the
    // same answer, and the empty case is the one an unstarted task produces.
    const entries = Object.entries(body).filter(([, v]) => v && typeof v === 'object');
    if (entries.length > 0 && entries.every(([, v]) => 'verdict' in v || 'status' in v || 'outcome' in v)) {
      rows.push(...entries.map(([name, value]) => ({ machine_name: name, ...value })));
    }
  }
  return rows.map((entry) => {
    const name = entry.machine_name ?? entry.machine ?? entry.name ?? entry.machine_id ?? '?';
    // The per-machine verdict is `outcome`; `status` is what the process did, which is a
    // different fact and is shown alongside rather than instead of it.
    const parts = [`${name}: ${entry.outcome ?? entry.verdict ?? entry.lease_state ?? '?'}`];
    if (entry.status !== undefined && entry.status !== entry.outcome) parts.push(`status ${entry.status}`);
    if (entry.exit_code !== undefined && entry.exit_code !== null) parts.push(`exit ${entry.exit_code}`);
    return parts.join('  ');
  });
}

/**
 * Turn a completed wait into the sentence that goes to the phone.
 *
 * Kept separate from the executor so it is testable without a relay, and so the wording lives
 * in one place instead of being assembled at three call sites.
 */
export function formatRunResult({ taskId, wait, report = null, argv = [] }) {
  if (!wait?.ok) return `派发失败：${wait?.text ?? wait?.reason ?? '未知原因'}`;
  const verdict = wait.verdict ?? 'unknown';
  const lines = [`任务 ${String(taskId).slice(0, 8)} — ${verdict}`];
  if (argv.length > 0) lines.push(`命令：${argv.join(' ')}`);

  const machines = describeMachines(wait.body) ?? [];
  if (machines.length > 0) lines.push(...machines);

  if (!wait.terminal) {
    // Said plainly, because "no verdict" and "a verdict of timeout" are different and the
    // operator can act on only one of them.
    lines.push(`（等满 ${Math.round((wait.maxMs ?? 0) / 1000)}s 仍未结束，任务还在跑）`);
  }
  if (report) {
    const failures = (report.failed ?? []).slice(0, 5);
    if (failures.length > 0) {
      lines.push('失败机器：');
      for (const f of failures) lines.push(`  ${f.machine ?? f.machine_name ?? '?'}: ${f.reason ?? f.detail ?? '?'}`);
    }
  }
  const output = report?.stdout ?? wait.body?.stdout ?? null;
  if (typeof output === 'string' && output.trim() !== '') {
    lines.push('输出：', tailLines(output));
  }
  return lines.join('\n');
}

/**
 * Build the action set.
 *
 * @param {object} options
 * @param {object} options.executor From `createFleetExecutor`.
 * @param {object} [options.host] The DSH-facing half: listSessions, boundSession, bind, tail,
 *        prompt, setPolicy. Anything absent becomes a named refusal.
 * @param {object} [options.policy] From `policy.mjs`, for /trust and /untrust.
 * @param {number} [options.waitMs] How long /run will hold the phone before answering.
 * @param {boolean} [options.autoWait] Whether /run waits at all, or only dispatches.
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createChatopsActions(options) {
  const executor = options.executor;
  if (!executor) throw new TypeError('createChatopsActions requires an executor');
  const host = options.host ?? {};
  const policy = options.policy ?? null;
  const waitMs = options.waitMs ?? 90_000;
  const autoWait = options.autoWait !== false;
  const audit = options.audit ?? (() => {});

  /** A host operation that is absent, named rather than silently returning nothing. */
  const missing = (what) => () => {
    throw new Error(`这个安装没有接入 ${what}`);
  };

  const actions = {
    // ---- the DSH half: injected, because only the host knows its sessions ----
    listSessions: typeof host.listSessions === 'function' ? host.listSessions : missing('会话列表'),
    boundSession: typeof host.boundSession === 'function' ? host.boundSession : async () => null,
    bind: typeof host.bind === 'function' ? host.bind : missing('会话绑定'),
    tail: typeof host.tail === 'function' ? host.tail : missing('会话输出'),
    prompt: typeof host.prompt === 'function' ? host.prompt : undefined,
    setPolicy: typeof host.setPolicy === 'function' ? host.setPolicy : missing('策略设置'),

    // ---- the fleet half: real, and the reason this release exists ----

    /** Machines, mapped onto the shape `/machines` prints. */
    async listMachines() {
      const result = await executor.devices();
      if (!result.ok) throw new Error(result.text ?? result.reason);
      return result.devices.map((device) => ({
        id: device.machine_id ?? device.id ?? '?',
        name: device.name ?? device.machine_name ?? '?',
        os: device.platform ?? device.os ?? null,
        arch: device.arch ?? null,
        online: device.online !== false && device.state !== 'stale',
      }));
    },

    /**
     * `/run` — dispatch, then either wait or say where to look.
     *
     * The argv is passed through untouched. It is **not** joined into a shell string anywhere:
     * a chat message is attacker-influenced text, and the whole reason this fleet takes an argv
     * array is that no shell ever sees it.
     */
    async dispatch(argv) {
      const dispatched = await executor.run(argv);
      if (!dispatched.ok) return { taskId: null, summary: dispatched.text };
      audit('chatops/run-dispatched', { task_id: dispatched.taskId, argv });

      if (!autoWait) {
        return {
          taskId: dispatched.taskId,
          summary: `已派发：${argv.join(' ')}\n任务 ${String(dispatched.taskId).slice(0, 8)}，用 /report ${String(dispatched.taskId).slice(0, 8)} 查看结果。`,
        };
      }

      const waited = await executor.wait(dispatched.taskId, { maxMs: waitMs });
      let report = null;
      if (waited.ok && waited.terminal) {
        const fetched = await executor.report(dispatched.taskId);
        if (fetched.ok) report = fetched.raw;
      }
      return {
        taskId: dispatched.taskId,
        summary: formatRunResult({ taskId: dispatched.taskId, wait: { ...waited, maxMs: waitMs }, report, argv }),
      };
    },

    /** `/where` — which machine answered, and with what. */
    async where(taskId) {
      const read = await executor.status(taskId);
      if (!read.ok) return { text: read.text ?? read.reason };
      const body = read.raw ?? {};
      const verdict = body.verdict ?? body.status ?? 'unknown';
      const lines = [`任务 ${String(taskId).slice(0, 8)} — ${verdict}`];
      const machines = describeMachines(body);
      if (machines.length > 0) lines.push(...machines);
      else lines.push('（还没有机器回报）');
      return { text: lines.join('\n') };
    },

    /** `/report` — the full per-machine report, truncated for a phone. */
    async fullReport(taskId) {
      const fetched = await executor.report(taskId);
      if (!fetched.ok) return { text: fetched.text ?? fetched.reason };
      const body = fetched.raw ?? {};
      const lines = [`任务 ${String(taskId).slice(0, 8)} 报告`];
      const verdict = body.verdict ?? body.status ?? null;
      if (verdict) lines.push(`结论：${verdict}`);
      const machines = describeMachines(body);
      if (machines.length > 0) lines.push(...machines);
      const output = body.stdout ?? body.output ?? null;
      if (typeof output === 'string' && output.trim() !== '') lines.push('输出：', tailLines(output));
      return { text: lines.join('\n') };
    },

    // ---- trust, delegated to policy so there is one source of truth ----
    trust: policy ? (channel, id) => policy.trust(channel, id) : () => ({ ok: false, reason: 'no policy is wired' }),
    distrust: policy ? (channel, id) => policy.distrust(channel, id) : () => ({ ok: false, reason: 'no policy is wired' }),
  };

  return actions;
}

/** Capabilities a chat identity holds once admitted. Re-exported so the host has one import. */
export const OWNER = CAPABILITY;
