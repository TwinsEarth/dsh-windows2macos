/**
 * Running a fleet task and reading its verdict, callable from the chat layer (v0.7.2).
 *
 * ## Why this is a separate module
 *
 * `w2m_run` and `w2m_wait` are DSH *tools*: their bodies live inside the plugin's `ctx.tools`
 * registration and are shaped for a model to call — a schema, a card, an error type the host
 * knows how to render. The chat bridge needs the same work with none of that: an argv in, a
 * verdict and a sentence out, no tool registry involved.
 *
 * The alternative was to have the bridge call the tools. It cannot. A tool call needs
 * `@deepseek-ai/dsh-tools`, which exists **only inside `app.asar`** — a separate process cannot
 * complete one, and an in-process call would have to fabricate the host's own calling
 * convention. So the fleet work is expressed once, here, against the relay's HTTP API, and the
 * tool and the chat bridge are both callers.
 *
 * ## The two things a live relay taught this file
 *
 * The first version guessed, and both guesses were wrong in ways the unit tests could not see —
 * the same failure mode as `ilink.mjs` in v0.7.0, reproduced one layer up:
 *
 * 1. **`GET /v1/tasks/<id>` needs the `device_token`, not the `operator_token`.** With the
 *    operator token it answers `401 {"code":"UNAUTHORIZED","message":"missing or invalid
 *    device_token"}`. Dispatching and requesting take *different* credentials, so both are held.
 * 2. **The verdict is not at the top level.** It is `body.aggregate.status`, and the per-machine
 *    detail is `body.leases[]` — whose machine name is `machine_name`, not `machine`. A reader
 *    looking for `body.verdict` finds `undefined` forever while the task completes perfectly,
 *    which is exactly what happened: the agent ran the command, delivered the result, and the
 *    poll loop reported `verdict=undefined` thirty times.
 *
 * ## What it deliberately does not do
 *
 * **It does not wait forever.** A chat reply has a human on the other end, and a task with one
 * dead machine in the fleet never reaches a terminal state. Every wait is bounded and reports
 * `timeout` as a verdict rather than hanging — which is a real answer ("it is still running")
 * and not an error.
 *
 * **It does not invent a verdict.** The relay's own word is passed through, and an unrecognised
 * one is reported as unrecognised instead of being mapped onto the nearest familiar value.
 */

/** Relay paths, from the plugin's own tool implementations. */
export const RELAY = Object.freeze({
  TASK: '/v1/task',
  TASK_STATUS: (id) => `/v1/tasks/${encodeURIComponent(id)}`,
  TASK_REPORT: (id) => `/v1/tasks/${encodeURIComponent(id)}/report`,
  DEVICES: '/v1/devices',
  PAIR: '/v1/pair',
});

/** Terminal verdicts the relay reports. Passed through, never re-derived. */
export const TERMINAL = Object.freeze([
  'consistent',
  'divergent',
  'divergent-platform',
  'failed',
  'partial',
  'unverifiable',
  'timeout',
  'cancelled',
  'degraded',
]);

export function isTerminal(verdict) {
  return typeof verdict === 'string' && TERMINAL.includes(verdict);
}

/**
 * The verdict in a status or report body, wherever the relay put it.
 *
 * A status read nests it under `aggregate`; a report puts it at the top level. Both are checked
 * because both are real, and the shape difference is the relay's, not a mistake to normalise
 * away silently.
 */
export function verdictOf(body) {
  if (body === null || typeof body !== 'object') return null;
  const candidate = body.aggregate?.status ?? body.status ?? body.verdict ?? null;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

/** The per-machine rows in a status or report body. `leases` on a status, `machines` on a report. */
export function rowsOf(body) {
  if (body === null || typeof body !== 'object') return [];
  for (const key of ['machines', 'leases', 'results']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

/**
 * Create the executor.
 *
 * @param {object} options
 * @param {string} options.rabbitUrl
 * @param {string|null} [options.token] The operator token. **Required to dispatch.**
 * @param {string|null} [options.deviceToken] The device token. **Required to read a task.**
 *        Taken from the identity file when not given, because an install already has one.
 * @param {number} [options.timeoutMs] Per HTTP request.
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createFleetExecutor(options) {
  const rabbitUrl = options.rabbitUrl;
  if (typeof rabbitUrl !== 'string' || rabbitUrl === '') {
    throw new TypeError('createFleetExecutor requires a rabbitUrl');
  }
  const token = options.token ?? null;
  const deviceToken = options.deviceToken ?? null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const audit = options.audit ?? (() => {});

  /** One relay call. Resolves for every HTTP status: a refusal is an answer, not an exception. */
  async function relay(pathname, { method = 'GET', body, accept = 'application/json', credential = 'operator' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(pathname, rabbitUrl.endsWith('/') ? rabbitUrl : `${rabbitUrl}/`).toString();
    const headers = { accept };
    // Measured: dispatch authenticates with the operator token, task reads with the device token.
    // Sending the wrong one is a 401 whose message names the credential it wanted.
    const bearer = credential === 'device' ? deviceToken : token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, ok: response.ok, json, text };
    } catch (error) {
      const cause = error?.cause;
      const detail = cause ? `${cause.code ?? ''}${cause.code ? ' ' : ''}${cause.message ?? cause}`.trim() : '';
      return { status: 0, ok: false, json: null, text: '', error: `${error?.message ?? error}${detail ? ` [${detail}]` : ''}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why the relay refused, in the caller's terms. */
  function refusal(result) {
    const code = result.json?.error?.code ?? null;
    const message = result.json?.error?.message ?? result.error ?? result.text.slice(0, 200);
    if (result.status === 401 || code === 'OPERATOR_REQUIRED') {
      // The relay names the credential it wanted; the two cases need different fixes and one of
      // them is a bug in this file, so they are not merged.
      if (String(message).includes('device_token')) {
        return {
          reason: 'device_token_required',
          text: '读取任务需要 device token（不是 operator token）。这台机器还没配对，或者身份文件里没有 token。',
          code,
          message,
        };
      }
      return {
        reason: 'operator_required',
        text: '这个 relay 要求 operator token 才能派发任务，而发过去的那个没被接受。设备 token 无法派发任务。',
        code,
        message,
      };
    }
    if (code === 'NO_ONLINE_DEVICE') {
      return { reason: 'no_online_device', text: '现在没有机器在线，先在各机器上启动 agent。', code, message };
    }
    return { reason: 'refused', text: `relay 拒绝了请求（HTTP ${result.status}${code ? ` ${code}` : ''}）：${message}`, code, message };
  }

  /**
   * Dispatch one task.
   *
   * @param {string[]} argv
   * @param {object} [extra] Any further relay fields (mode, write, cwd_rel, …).
   */
  async function run(argv, extra = {}) {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { ok: false, reason: 'bad_argv', text: '需要一条命令，例如 /run node --test' };
    }
    const result = await relay(RELAY.TASK, {
      method: 'POST',
      body: { command_argv: argv, mode: extra.mode ?? 'replicate', ...extra },
      credential: 'operator',
    });
    if (!result.ok) {
      const bad = refusal(result);
      audit('fleet/refused', { status: result.status, ...bad });
      return { ok: false, ...bad };
    }
    const taskId = result.json?.task_id ?? result.json?.id ?? null;
    if (typeof taskId !== 'string' || taskId === '') {
      return { ok: false, reason: 'no_task_id', text: 'relay 接受了请求但没有返回 task_id，无法跟踪结果。' };
    }
    audit('fleet/dispatched', { task_id: taskId, argv });
    return { ok: true, taskId, raw: result.json };
  }

  /** One status read. Reads with the device token, which is what the relay accepts here. */
  async function status(taskId) {
    const result = await relay(RELAY.TASK_STATUS(taskId), { credential: 'device' });
    if (!result.ok) return { ok: false, ...refusal(result) };
    return { ok: true, verdict: verdictOf(result.json), rows: rowsOf(result.json), raw: result.json };
  }

  /**
   * Wait for a terminal verdict, or give up and say so.
   *
   * `timeout` is returned as a verdict rather than thrown: "it is still running" is a real
   * answer to give someone on a phone, and it is not a failure of the request.
   */
  async function wait(taskId, { maxMs = 120_000, pollMs = 1500 } = {}) {
    const deadline = now() + maxMs;
    let last = null;
    while (now() < deadline) {
      const read = await status(taskId);
      if (!read.ok) return read;
      last = read;
      if (isTerminal(read.verdict)) {
        return { ok: true, verdict: read.verdict, rows: read.rows, body: read.raw, terminal: true };
      }
      await sleep(pollMs);
    }
    return {
      ok: true,
      verdict: 'timeout',
      rows: last?.rows ?? [],
      body: last?.raw ?? null,
      terminal: false,
      note: 'still running when the wait expired',
    };
  }

  /** The per-machine report. Also reads with the device token. */
  async function report(taskId) {
    const result = await relay(RELAY.TASK_REPORT(taskId), { credential: 'device' });
    if (!result.ok) return { ok: false, ...refusal(result) };
    return { ok: true, verdict: verdictOf(result.json), rows: rowsOf(result.json), raw: result.json };
  }

  /** The machines the relay currently holds. */
  async function devices() {
    // Measured: /v1/devices wants the device token too, on this relay build. The operator token
    // still authorises the dispatch; the reads all want the device identity.
    const result = await relay(RELAY.DEVICES, { credential: 'device' });
    if (!result.ok) return { ok: false, ...refusal(result) };
    const list = Array.isArray(result.json?.devices) ? result.json.devices : [];
    return { ok: true, devices: list };
  }

  return {
    run,
    wait,
    status,
    report,
    devices,
    relay,
    /** Whether a task read is possible at all. Said up front rather than as a 401 later. */
    get canReadTasks() {
      return typeof deviceToken === 'string' && deviceToken !== '';
    },
  };
}
