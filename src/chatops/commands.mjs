/**
 * Turning a chat message into an action (v0.7.0).
 *
 * ## What this replaces
 *
 * `dsh-chatops` 0.1.0 kept its eleven commands in a twelve-arm `switch` inside a 1,060-line
 * class that also held the session catalogue, the approval broker, the file delivery and
 * the vendor card probes. Three consequences, all of which this file is shaped to avoid:
 *
 *   * **authorisation was a property of the caller, not the command.** Every command was
 *     reachable by every trusted window, so `/sessions`, `/use`, `/policy 2` and `/approve`
 *     sat behind one undifferentiated check. Here each command declares the capability it
 *     needs, and the router refuses by name when the caller lacks it — which is also what
 *     makes "who can do what" answerable without reading the implementations.
 *   * **the surface was undiscoverable.** `/help` was a hand-maintained string that could
 *     drift from the `switch`. Here the table *is* the help, so a command that exists is
 *     documented and a command that is documented exists.
 *   * **nothing was testable in isolation.** A command handler now receives a plain object
 *     of injected actions and returns a plain result. No host, no clock, no network.
 *
 * ## The fleet commands
 *
 * A chat bridge for this project has a reason to exist beyond the plugin it was ported
 * from: `w2m` already runs commands on every machine. So the router exposes the fleet —
 * `machines` to see it, `run` to use it, `where` to ask which machine a task ran on — and
 * those are the commands that make a phone a usable console rather than a notification
 * feed. They are also the reason `run` needs `fleet.dispatch`: dispatching is the one
 * action here with effects on other machines, and it is gated separately from everything
 * that merely reads.
 */

/** Capabilities a command may require. A caller holds a set of these. */
export const CAPABILITY = Object.freeze({
  /** Nothing beyond being an admitted identity. */
  VIEW: 'view',
  /** Ask a session to do work, or bind a window to one. */
  OPERATE: 'operate',
  /** Read a session's transcript, which can contain anything the model has seen. */
  TRANSCRIPT: 'transcript',
  /** Move a file out of the project. */
  FILES: 'files',
  /** Answer an approval, including one for a privileged operation. */
  APPROVE: 'approve',
  /** Change a session's sandbox policy. */
  POLICY: 'policy',
  /** Dispatch a command to the fleet. */
  FLEET_DISPATCH: 'fleet.dispatch',
  /** Change who is trusted. The one capability that can widen all the others. */
  ADMIN: 'admin',
});

/** Which capabilities a freshly admitted owner holds. */
export const OWNER_CAPABILITIES = Object.freeze([
  CAPABILITY.VIEW,
  CAPABILITY.OPERATE,
  CAPABILITY.TRANSCRIPT,
  CAPABILITY.FILES,
  CAPABILITY.APPROVE,
  CAPABILITY.POLICY,
  CAPABILITY.FLEET_DISPATCH,
  CAPABILITY.ADMIN,
]);

/** Why a command was not run. Returned as a code, so a test can assert on it. */
export const ROUTE_REFUSAL = Object.freeze({
  /** Not a command — the caller wants to send it as a prompt. */
  NOT_A_COMMAND: 'not_a_command',
  /** A `/name` that no command claims. */
  UNKNOWN_COMMAND: 'unknown_command',
  /** The command needs a capability the caller does not hold. */
  FORBIDDEN: 'forbidden',
  /** The arguments do not fit the command. */
  BAD_ARGUMENTS: 'bad_arguments',
  /** The command exists but this install has not wired its action. */
  UNAVAILABLE: 'unavailable',
});

/**
 * The command table.
 *
 * Each entry: `name`, `usage`, `summary`, `capability`, and `run(args, ctx)`. Keeping the
 * help text in the entry is what stops it drifting from the implementation.
 */
export function commandTable() {
  return [
    {
      name: 'help',
      usage: '/help [command]',
      summary: 'List the commands, or explain one.',
      capability: CAPABILITY.VIEW,
      run(args, ctx) {
        if (args.length === 0) {
          const lines = ctx.commands.map((c) => `${c.usage} — ${c.summary}`);
          return { text: [`可用指令：`, ...lines.map((l) => `  ${l}`)].join('\n') };
        }
        const wanted = args[0].replace(/^\//, '');
        const command = ctx.commands.find((c) => c.name === wanted);
        if (!command) return { text: `没有名为 ${wanted} 的指令。` };
        return { text: `${command.usage}\n${command.summary}\n所需权限：${command.capability}` };
      },
    },
    {
      name: 'whoami',
      usage: '/whoami',
      summary: 'Show the identity this window is bound to and what it may do.',
      capability: CAPABILITY.VIEW,
      run(_args, ctx) {
        return {
          text: [
            `身份：${ctx.identity.channel}:${ctx.identity.id}`,
            `窗口：${ctx.identity.window}`,
            `权限：${[...ctx.capabilities].sort().join(', ') || '（无）'}`,
          ].join('\n'),
        };
      },
    },
    {
      name: 'sessions',
      usage: '/sessions',
      summary: 'List the sessions this window could act on.',
      capability: CAPABILITY.VIEW,
      async run(_args, ctx) {
        const sessions = await ctx.actions.listSessions();
        if (sessions.length === 0) return { text: '没有任何会话。' };
        const bound = await ctx.actions.boundSession(ctx.identity.window);
        const lines = sessions.map((s, i) => {
          const marker = s.id === bound ? '*' : ' ';
          return `${marker}${i + 1}. ${s.title || s.id} (${s.id.slice(0, 8)})`;
        });
        return { text: ['会话（* 为当前绑定）：', ...lines].join('\n') };
      },
    },
    {
      name: 'use',
      usage: '/use <序号|会话 id 前缀>',
      summary: 'Bind this window to a session.',
      capability: CAPABILITY.OPERATE,
      async run(args, ctx) {
        if (args.length !== 1) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/use <序号|会话 id 前缀>' };
        const sessions = await ctx.actions.listSessions();
        const key = args[0];
        let target = null;
        if (/^\d+$/.test(key)) {
          target = sessions[Number(key) - 1] ?? null;
        } else {
          // Prefix matching is deliberately strict about ambiguity: binding the wrong
          // session because two share a prefix is a silent misroute, and the caller cannot
          // tell it happened.
          const matches = sessions.filter((s) => s.id.startsWith(key));
          if (matches.length > 1) {
            return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: `${key} 匹配到 ${matches.length} 个会话，请写更长的前缀。` };
          }
          target = matches[0] ?? null;
        }
        if (!target) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: `找不到会话 ${key}。` };
        await ctx.actions.bind(ctx.identity.window, target.id);
        return { text: `已绑定到：${target.title || target.id}` };
      },
    },
    {
      name: 'log',
      usage: '/log [行数]',
      summary: 'Show the tail of the bound session.',
      capability: CAPABILITY.TRANSCRIPT,
      async run(args, ctx) {
        const limit = args.length === 0 ? 20 : Number(args[0]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '行数需为 1..200。' };
        }
        const sessionId = await ctx.actions.boundSession(ctx.identity.window);
        if (!sessionId) return { text: '这个窗口还没绑定会话，先 /use。' };
        const lines = await ctx.actions.tail(sessionId, limit);
        return { text: lines.length === 0 ? '(没有输出)' : lines.join('\n') };
      },
    },
    {
      name: 'machines',
      usage: '/machines',
      summary: 'List the machines the fleet currently holds.',
      capability: CAPABILITY.VIEW,
      async run(_args, ctx) {
        if (!ctx.actions.listMachines) return { refusal: ROUTE_REFUSAL.UNAVAILABLE, text: '这台机器没有连接编队。' };
        const machines = await ctx.actions.listMachines();
        if (machines.length === 0) return { text: '编队里没有在线机器。' };
        const lines = machines.map((m) => `${m.online ? '●' : '○'} ${m.name}  ${m.os ?? '?'}/${m.arch ?? '?'}  ${m.id.slice(0, 8)}`);
        return { text: ['编队：', ...lines].join('\n') };
      },
    },
    {
      name: 'run',
      usage: '/run <命令…>',
      summary: 'Run a command on the whole fleet and report the verdict.',
      capability: CAPABILITY.FLEET_DISPATCH,
      async run(args, ctx) {
        if (args.length === 0) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/run <命令…>' };
        if (!ctx.actions.dispatch) return { refusal: ROUTE_REFUSAL.UNAVAILABLE, text: '这台机器没有连接编队。' };
        const outcome = await ctx.actions.dispatch(args);
        return { text: outcome.summary, taskId: outcome.taskId };
      },
    },
    {
      name: 'where',
      usage: '/where <任务 id>',
      summary: 'Show how a task is doing, machine by machine.',
      capability: CAPABILITY.VIEW,
      async run(args, ctx) {
        if (args.length !== 1) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/where <任务 id>' };
        if (!ctx.actions.where) return { refusal: ROUTE_REFUSAL.UNAVAILABLE, text: '这台机器没有连接编队。' };
        const outcome = await ctx.actions.where(args[0]);
        return { text: outcome.text };
      },
    },
    {
      name: 'report',
      usage: '/report <任务 id>',
      summary: 'Show a task\'s full per-machine report.',
      capability: CAPABILITY.VIEW,
      async run(args, ctx) {
        if (args.length !== 1) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/report <任务 id>' };
        if (!ctx.actions.fullReport) return { refusal: ROUTE_REFUSAL.UNAVAILABLE, text: '这台机器没有连接编队。' };
        const outcome = await ctx.actions.fullReport(args[0]);
        return { text: outcome.text };
      },
    },
    {
      name: 'approve',
      usage: '/approve [审批 id]',
      summary: 'Approve the oldest pending request for this window.',
      capability: CAPABILITY.APPROVE,
      async run(args, ctx) {
        return decideApproval(args, ctx, 'allowed-once');
      },
    },
    {
      name: 'reject',
      usage: '/reject [审批 id]',
      summary: 'Reject the oldest pending request for this window.',
      capability: CAPABILITY.APPROVE,
      async run(args, ctx) {
        return decideApproval(args, ctx, 'rejected');
      },
    },
    {
      name: 'pending',
      usage: '/pending',
      summary: 'Show what this window is being asked to approve.',
      capability: CAPABILITY.APPROVE,
      run(_args, ctx) {
        const waiting = ctx.actions.pending(ctx.identity.window);
        if (waiting.length === 0) return { text: '没有待审批的请求。' };
        const lines = waiting.map(
          (p) => `${p.approval_id.slice(0, 8)}  ${p.tool}  ${Math.ceil(p.remaining_ms / 1000)}s 后超时${p.reason ? `  (${p.reason})` : ''}`,
        );
        return { text: ['待审批：', ...lines].join('\n') };
      },
    },
    {
      name: 'policy',
      usage: '/policy <0|1|2>',
      summary: 'Set the bound session\'s sandbox policy. 0 read-only, 1 ask, 2 danger-full-access.',
      capability: CAPABILITY.POLICY,
      async run(args, ctx) {
        if (args.length !== 1) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/policy <0|1|2>' };
        // Numeric index, never a string: a policy name taken from chat text would let the
        // caller choose an arbitrary value if the enum ever grows a member the model should
        // not be able to select.
        const mode = ctx.policyModes[Number(args[0])];
        if (!mode) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '策略需为 0、1 或 2。' };
        const sessionId = await ctx.actions.boundSession(ctx.identity.window);
        if (!sessionId) return { text: '这个窗口还没绑定会话，先 /use。' };
        await ctx.actions.setPolicy(sessionId, mode);
        return { text: `已把 ${sessionId.slice(0, 8)} 的策略设为 ${mode}。` };
      },
    },
    {
      name: 'trust',
      usage: '/trust <channel:id>',
      summary: 'Trust an identity. Widens access, so it needs admin.',
      capability: CAPABILITY.ADMIN,
      async run(args, ctx) {
        if (args.length !== 1 || !args[0].includes(':')) {
          return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/trust <channel:id>，例如 feishu:ou_abc' };
        }
        const cut = args[0].indexOf(':');
        const channel = args[0].slice(0, cut);
        const id = args[0].slice(cut + 1);
        const result = ctx.actions.trust(channel, id);
        return result.ok ? { text: `已信任 ${channel}:${id}。` } : { text: `未变更：${result.reason}` };
      },
    },
    {
      name: 'untrust',
      usage: '/untrust <channel:id>',
      summary: 'Revoke an identity. Needs admin.',
      capability: CAPABILITY.ADMIN,
      async run(args, ctx) {
        if (args.length !== 1 || !args[0].includes(':')) {
          return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '用法：/untrust <channel:id>' };
        }
        const cut = args[0].indexOf(':');
        const channel = args[0].slice(0, cut);
        const id = args[0].slice(cut + 1);
        const result = ctx.actions.distrust(channel, id);
        return result.ok ? { text: `已撤销 ${channel}:${id}。` } : { text: `未变更：${result.reason}` };
      },
    },
  ];
}

/** Shared by `/approve` and `/reject`, so the two cannot drift apart. */
async function decideApproval(args, ctx, outcome) {
  const waiting = ctx.actions.pending(ctx.identity.window);
  if (waiting.length === 0) return { text: '没有待审批的请求。' };
  // An explicit id is honoured only if it belongs to *this* window: an id from another
  // conversation would otherwise let a trusted identity answer a request it was never
  // shown, which is the attribution problem in miniature.
  let target;
  if (args.length === 1) {
    target = waiting.find((p) => p.approval_id.startsWith(args[0]));
    if (!target) return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: '这个窗口没有匹配的待审批请求。' };
  } else {
    target = waiting[0];
  }
  const result = ctx.actions.decideApproval(target.approval_id, outcome);
  if (!result.ok) {
    // Reported as a failure rather than a cheerful confirmation. 0.1.0 replied
    // "✅ 已批准，继续执行" on the strength of a promise resolving, with nothing tying it to
    // the request it was supposedly authorising.
    return { refusal: ROUTE_REFUSAL.BAD_ARGUMENTS, text: `未生效：${result.reason}` };
  }
  return { text: outcome === 'allowed-once' ? '已批准。' : '已拒绝。' };
}

/**
 * Parse one inbound message.
 *
 * @param {string} text
 * @returns {{kind: 'command', name: string, args: string[]} | {kind: 'prompt', text: string}}
 *          A leading `/` that names nothing is **not** a prompt: sending `/sesions` to the
 *          model because it was misspelled is how a typo becomes unexpected model work.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return { kind: 'prompt', text: '' };
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'prompt', text: trimmed };
  const [head, ...args] = trimmed.split(/\s+/);
  return { kind: 'command', name: head.slice(1).toLowerCase(), args };
}

/**
 * Route one message.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {Set<string>} ctx.capabilities
 * @param {{channel: string, id: string, window: string}} ctx.identity
 * @param {object} ctx.actions
 * @param {Array} [ctx.commands] Defaults to the full table.
 * @returns {Promise<{kind: string, name?: string, text?: string, taskId?: string, refusal?: string}>}
 */
export async function route(text, ctx) {
  const parsed = parseCommand(text);
  if (parsed.kind === 'prompt') return { kind: 'prompt', text: parsed.text };

  const commands = ctx.commands ?? commandTable();
  const command = commands.find((c) => c.name === parsed.name);
  if (!command) {
    return {
      kind: 'refused',
      name: parsed.name,
      refusal: ROUTE_REFUSAL.UNKNOWN_COMMAND,
      text: `未知指令 /${parsed.name}。发送 /help 查看可用指令。`,
    };
  }
  // Authorisation is checked before the handler runs, never inside it, so a handler
  // cannot accidentally become reachable by forgetting its own check.
  if (!ctx.capabilities?.has(command.capability)) {
    return {
      kind: 'refused',
      name: command.name,
      refusal: ROUTE_REFUSAL.FORBIDDEN,
      text: `/${command.name} 需要 ${command.capability} 权限，当前身份没有。`,
    };
  }

  const full = { ...ctx, commands };
  let result;
  try {
    result = await command.run(parsed.args, full);
  } catch (error) {
    // A handler that throws is a defect, and it is reported as one rather than as a refusal
    // the operator might mistake for a permission decision.
    return {
      kind: 'error',
      name: command.name,
      text: `/${command.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result?.refusal) {
    return { kind: 'refused', name: command.name, refusal: result.refusal, text: result.text };
  }
  return { kind: 'ok', name: command.name, text: result?.text ?? '', taskId: result?.taskId };
}

/** The help text, generated from the table so it cannot drift. */
export function helpText(commands = commandTable()) {
  return commands.map((c) => `${c.usage.padEnd(28)} ${c.summary}`).join('\n');
}
