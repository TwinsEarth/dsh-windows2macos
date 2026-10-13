/**
 * `/run` — dispatch one command from a chat window to the fleet (v0.7.12).
 *
 * ## Why an explicit prefix, and not "every message is a command"
 *
 * The alternative is treating any incoming message as a command, which makes a typo a fleet-wide
 * execution and makes ordinary conversation dangerous. A prefix means **sending a message is never
 * an action**; acting requires saying so. That is the same reason the other commands here are
 * prefixed, and it is the property most of these tests are about.
 *
 * ## What this module is, and what it is not
 *
 * It **parses** a `/run` line and **renders** a verdict. It does not talk to the relay — that is
 * `fleet.mjs`, whose executor is injected as `deps.run`. Keeping the two apart is what makes the
 * parsing and the rendering testable without a live fleet, and it is where the mistakes in this
 * kind of feature actually live: quoting, refusing empty commands, deciding what a refusal reads
 * like when a human is holding a phone.
 *
 * ## The argv question, which is the real design decision
 *
 * `/run node --version` has to become `['node', '--version']`. Splitting on whitespace is wrong the
 * moment a path has a space, and invoking a shell is wrong always — the fleet's units take an
 * **argv array** and never a shell string, deliberately, because a shell here would turn every
 * chat message into arbitrary command execution on every machine.
 *
 * So quoting is honoured for the simple cases (single and double, no escapes), and anything the
 * parser cannot be sure about is a **named refusal** rather than a guess. A wrong guess executes
 * something on a fleet; a refusal costs one retry.
 */

/** Why a `/run` line was not dispatched. */
export const RUN_REFUSAL = Object.freeze({
  EMPTY: 'empty_command',
  UNBALANCED_QUOTE: 'unbalanced_quote',
  SHELL_METACHARACTER: 'shell_metacharacter',
  TOO_LONG: 'too_long',
  NOT_PERMITTED: 'not_permitted',
});

/** A command long enough to be a mistake, and long enough to be worth refusing before dispatch. */
export const MAX_ARGS = 64;
export const MAX_ARG_LENGTH = 4096;

/** Characters that only mean something to a shell, and so indicate a caller expecting one. */
const SHELL_METACHARACTERS = ['|', '&', ';', '>', '<', '`', '$', '\n', '\\'];

/**
 * Split a `/run` argument string into an argv array.
 *
 * @param {string} input Everything after `/run`.
 * @returns {{ok: true, argv: string[]} | {ok: false, reason: string, text: string}}
 */
export function parseRun(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') {
    return { ok: false, reason: RUN_REFUSAL.EMPTY, text: '用法：/run <命令>，例如 /run node --version' };
  }

  const argv = [];
  let current = '';
  let quote = null;
  let started = false;

  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      // A quoted empty argument ("") is a real argument, which is why `started` exists rather than
      // a length check: `echo "" x` is two arguments, not one.
      if (started || current !== '') { argv.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote !== null) {
    return {
      ok: false,
      reason: RUN_REFUSAL.UNBALANCED_QUOTE,
      text: `引号没有闭合（缺少 ${quote}）。把整条命令用同一对引号包起来，或去掉引号。`,
    };
  }
  if (started || current !== '') argv.push(current);

  if (argv.length === 0) {
    return { ok: false, reason: RUN_REFUSAL.EMPTY, text: '用法：/run <命令>，例如 /run node --version' };
  }

  /**
   * A shell metacharacter is refused rather than passed through.
   *
   * The fleet takes an argv array and never a shell string, so `|` or `&&` would arrive as a
   * literal argument and quietly do something other than what was typed. Refusing says so; passing
   * it through produces a command that runs and does the wrong thing.
   */
  const offending = argv.find((a) => SHELL_METACHARACTERS.some((m) => a.includes(m)));
  if (offending !== undefined) {
    return {
      ok: false,
      reason: RUN_REFUSAL.SHELL_METACHARACTER,
      text:
        `命令里含有 shell 元字符（${SHELL_METACHARACTERS.filter((m) => offending.includes(m)).join(' ')}）。`
        + '编队接收的是 argv 数组、不是 shell 字符串，所以管道和重定向不会生效。'
        + '请分别运行，或把逻辑放进一个脚本。',
    };
  }

  if (argv.length > MAX_ARGS) {
    return { ok: false, reason: RUN_REFUSAL.TOO_LONG, text: `参数太多（${argv.length} > ${MAX_ARGS}）。` };
  }
  const long = argv.find((a) => a.length > MAX_ARG_LENGTH);
  if (long !== undefined) {
    return { ok: false, reason: RUN_REFUSAL.TOO_LONG, text: `单个参数过长（${long.length} > ${MAX_ARG_LENGTH}）。` };
  }

  return { ok: true, argv };
}

/**
 * Parse the flags `/run` accepts alongside the command.
 *
 * Kept separate from `parseRun` because the command itself is opaque: `/run node --timeout 5` is a
 * node invocation whose argument happens to look like a flag, and pulling it out would run a
 * different command than the one typed. Flags are only recognised **before** the command.
 */
export function parseRunFlags(args) {
  const flags = { mode: 'replicate', timeoutMs: null, machines: null, ask: false };
  const rest = [...args];
  while (rest.length > 0 && rest[0].startsWith('--')) {
    const flag = rest.shift();
    /**
     * `--ask` switches the argument from a command to a **request in words**.
     *
     * This is the "C" form, and the flag is what keeps it from weakening the "A" form: an explicit
     * marker means natural language is never *guessed* at, so a command that happens to read like
     * a sentence is still dispatched as a command, and a sentence is never dispatched.
     */
    if (flag === '--ask' || flag === '-a') { flags.ask = true; continue; }
    if (flag === '--on' || flag === '--machine') {
      const value = rest.shift();
      if (value !== undefined) flags.machines = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
      continue;
    }
    if (flag === '--timeout') {
      const value = Number(rest.shift());
      if (Number.isFinite(value) && value > 0) flags.timeoutMs = Math.min(value, 3_600_000);
      continue;
    }
    if (flag === '--mode') {
      const value = rest.shift();
      if (['replicate', 'split', 'broadcast', 'pipeline'].includes(value)) flags.mode = value;
      continue;
    }
    // An unrecognised leading `--flag` is handed back to the command: it may be a real argument
    // (`node --version`), and swallowing it would run something else.
    rest.unshift(flag);
    break;
  }
  return { flags, command: rest.join(' ') };
}

/**
 * The two forms, as **privilege levels** rather than two spellings of one action.
 *
 * | form | who | what it does | capability |
 * |---|---|---|---|
 * | `/run <argv>` | expert | dispatches those arguments, uninterpreted | `fleet.dispatch` |
 * | `/run --ask <words>` | beginner | asks; the agent answers, and **proposes** a command | `operate` |
 *
 * The asymmetry is the point. A beginner describing what they want is *not* executing anything: the
 * request goes to a session, the session answers in prose, and if it wants something run it emits
 * `/run <argv>` — which still needs `fleet.dispatch` to actually happen. So a low-privilege window
 * can ask freely and cannot cause a fleet execution by asking.
 *
 * That is why the two are not one command with a flag for the *syntax*: they are two capabilities,
 * and a window that may do one must not thereby be able to do the other.
 */
export const RUN_FORM = Object.freeze({
  /** Expert: dispatch exactly these arguments. */
  DISPATCH: 'dispatch',
  /** Beginner: state what you want; the agent interprets and proposes. */
  ASK: 'ask',
});

/** Which capability each form needs. Names match `commands.mjs`'s `CAPABILITY`. */
export const FORM_CAPABILITY = Object.freeze({
  [RUN_FORM.DISPATCH]: 'fleet.dispatch',
  [RUN_FORM.ASK]: 'operate',
});

/**
 * Which capability a form requires.
 *
 * Returns the capability rather than checking it, so the check stays in the router where every
 * other command's check lives — "authorisation is checked before the handler runs, never inside
 * it", which is what stops a handler becoming reachable by forgetting its own guard.
 */
export function requiredCapability(form) {
  return FORM_CAPABILITY[form] ?? null;
}

/**
 * Decide what one `/run` line is asking for.
 *
 * Two forms, and the distinction is **declared, not inferred**:
 *
 *   * **A — `/run <argv>`** dispatches exactly those arguments. Nothing interprets them.
 *   * **C — `/run --ask <words>`** is a request the session's agent reads. The agent may answer in
 *     prose, and if it wants something run it must emit `/run <argv>` — which the human then sees
 *     as a command before it happens, and which needs the higher capability to execute.
 *
 * The reason `--ask` is a flag rather than a heuristic: an inferred distinction gets it wrong in
 * both directions, and the direction that matters is dispatching a sentence as if it were a
 * program. Declaring the form means the dangerous interpretation never happens by accident — and
 * here it also means the *privilege level* is declared, not guessed from how the text reads.
 *
 * @returns {{kind: 'dispatch', argv: string[], flags: object, capability: string}
 *          | {kind: 'ask', text: string, flags: object, capability: string}
 *          | {kind: 'refused', reason: string, text: string}}
 */
export function parseInvocation(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') {
    return { kind: 'refused', reason: RUN_REFUSAL.EMPTY, text: '用法：/run <命令>，或 /run --ask <用一句话描述你要做什么>' };
  }

  const { flags, command } = parseRunFlags(raw.split(/\s+/));

  if (flags.ask) {
    if (command.trim() === '') {
      return {
        kind: 'refused',
        reason: RUN_REFUSAL.EMPTY,
        text: '用法：/run --ask <用一句话描述你要做什么>，例如 /run --ask 看看各机器的 node 版本',
      };
    }
    return { kind: 'ask', text: command.trim(), flags, capability: FORM_CAPABILITY[RUN_FORM.ASK] };
  }

  const parsed = parseRun(command);
  if (!parsed.ok) return { kind: 'refused', reason: parsed.reason, text: parsed.text };
  return { kind: 'dispatch', argv: parsed.argv, flags, capability: FORM_CAPABILITY[RUN_FORM.DISPATCH] };
}

/** A one-line summary of what was dispatched, for the acknowledgement. */
export function describeDispatch({ argv, mode, machines }) {
  const parts = [`mode=${mode}`];
  if (Array.isArray(machines) && machines.length > 0) parts.push(`on=${machines.join(',')}`);
  return `${argv.join(' ')}  (${parts.join(' ')})`;
}

/**
 * Render a fleet verdict for a phone screen.
 *
 * Two constraints shape this, and both come from where the text is read rather than from the data:
 * a verdict can name a dozen machines, and a chat message is not a terminal. So the per-machine
 * detail is **capped**, the aggregate verdict leads, and a truncation is **stated** — a list that
 * silently stops at ten reads as "ten machines" rather than "ten shown".
 */
export function renderVerdict({ taskId, verdict, machines, maxMachines = 10 }) {
  const lines = [`判定：${verdict}`, `任务：${taskId}`];
  const rows = Array.isArray(machines) ? machines : [];
  if (rows.length === 0) {
    lines.push('（还没有逐机结果）');
    return { text: lines.join('\n'), truncated: 0 };
  }

  const shown = rows.slice(0, maxMachines);
  lines.push('', '逐机结果：');
  for (const m of shown) {
    const name = m.machine_name ?? m.machine_id ?? '?';
    const outcome = m.outcome ?? m.state ?? '?';
    const code = m.exit_code === null || m.exit_code === undefined ? '' : ` exit=${m.exit_code}`;
    const why = m.refusal_reason ? ` (${m.refusal_reason})` : '';
    lines.push(`  ${name}: ${outcome}${code}${why}`);
  }
  const truncated = rows.length - shown.length;
  if (truncated > 0) lines.push(`  …另有 ${truncated} 台未显示`);
  return { text: lines.join('\n'), truncated };
}

/**
 * Render the failure of a dispatch that never became a task.
 *
 * `fleet.mjs` reports `NO_ONLINE_DEVICE` for several different situations, and the useful sentence
 * differs: "no machine is paired" and "the machines are paired but silent" call for different
 * actions from whoever is holding the phone.
 */
export function renderDispatchFailure({ code, reason, detail }) {
  if (code === 'NO_ONLINE_DEVICE') {
    if (reason === 'requester_has_no_fleet') {
      return '这个 relay 已绑定舰队，而发起方不属于任何舰队，所以不能派发。';
    }
    if (reason === 'target_outside_fleet') {
      return '指定的机器不在这条舰队里。';
    }
    return '没有可用的在线设备。请确认每台机器上的 Localside agent 都在运行。';
  }
  if (code === 'COMMAND_NOT_ALLOWED') {
    return `这条命令不在目标机器的 allow-list 里${detail ? `：${detail}` : ''}。`;
  }
  return `派发失败：${code ?? '未知错误'}${detail ? ` — ${detail}` : ''}`;
}
