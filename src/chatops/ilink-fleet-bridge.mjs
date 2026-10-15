/**
 * The bridge: a WeChat message becomes a fleet task, and the verdict goes back (v0.7.12).
 *
 * ## Every field name here was measured, not guessed
 *
 * Four separate wrong guesses about this protocol made a working feature look broken — including a
 * false conclusion that the login token lived only 30 seconds. So the wire shapes are recorded with
 * where they came from, and a test asserts them rather than the documentation:
 *
 * | shape | measured value |
 * |---|---|
 * | poll response | `{ msgs, sync_buf, get_updates_buf }` — the cursor is `get_updates_buf`, **not** `buf` |
 * | message text | `item_list[0].text_item.text` — **not** `content` |
 * | sender | `from_user_id` |
 * | reply success | `{ message_id }` with **no** `ret` and **no** `errcode` |
 * | login confirmation | status `confirmed`, **not** `scaned` |
 *
 * ## What this module does not do
 *
 * It does not decide authorisation. `parseInvocation` reports which **capability** a form needs, and
 * the caller supplies an `authorize` function — because the rule "authorisation is checked before
 * the handler runs, never inside it" is what stops a handler becoming reachable by forgetting its
 * own guard, and a bridge that checked its own permission would be exactly that mistake.
 */

import { parseInvocation, renderVerdict, renderDispatchFailure } from './run-command.mjs';

/**
 * What a run with `--dry-run` set is allowed to do.
 *
 * ## The defect this exists to make unreachable
 *
 * `scripts/ilink-fleet-bridge.mjs` guarded exactly one thing under `--dry-run`: the **reply**. The
 * dispatch itself ran unconditionally, so **two dry runs sent `node--version` to all five machines**
 * — and one of them produced a real task record with five real leases. The flag's name promises that
 * nothing happens, and the promise was false in the direction that matters: **a rehearsal executed
 * commands on production machines.**
 *
 * ## Why "skip the dispatch" rather than "rename the flag"
 *
 * This repository already fixes the meaning of the word. `update-install`'s `dryRun` is asserted to
 * **write nothing and call no package manager**, and `auto-update`'s is asserted to **write nothing to
 * the profile**. So a second `dry-run` that means "do the dangerous part anyway" is not a naming
 * preference — it is two flags with one name and opposite meanings, and the bridge held the unsafe one.
 *
 * **Renaming would have left the flag. Aligning keeps the word and removes the hazard**, and it means
 * a reader who knows `dryRun` from anywhere else in this project is already right about this one.
 *
 * ## Why this is a function rather than an `if` in the script
 *
 * `scripts/` is not in `package.json#files`, so nothing there is covered by a test that ships. A safety
 * property expressed as one line inside an untested script is a property nobody re-checks. As an
 * exported function with a name, it is asserted in `chatops-ilink-fleet-bridge.test.mjs` beside the
 * wire shapes — **a script is not where a guard should live if the guard is the point.**
 *
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ dispatch: boolean, reply: boolean, reason: string|null }}
 */
export function dryRunPolicy(options = {}) {
  if (options.dryRun !== true) return { dispatch: true, reply: true, reason: null };
  return {
    dispatch: false,
    reply: false,
    // Carried so the caller logs *why* nothing happened rather than printing a bare "[dry-run]".
    reason: 'dry run: the fleet was not dispatched to, and no reply was sent',
  };
}

/** The header every authenticated call needs; undocumented and mandatory. */
export const AUTH_TYPE = 'ilink_bot_token';
export const APP_ID = 'bot';
/** 2.4.6, as the reference client sends. */
export const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

/** Message item types. Only text is dispatched; the rest are acknowledged and ignored. */
export const ITEM_TYPE = Object.freeze({ TEXT: 1 });
/** `2` is BOT-originated, which is what our replies are. */
export const MESSAGE_TYPE = Object.freeze({ USER: 1, BOT: 2 });
/** `2` is FINISH — a complete message rather than a streaming fragment. */
export const MESSAGE_STATE_FINISH = 2;

/**
 * Build the request headers.
 *
 * `X-WECHAT-UIN` is a fresh random uint32 as a decimal string, base64-encoded, on **every** request.
 * It is not a session id and must not be cached.
 *
 * @param {object} input
 * @param {string} [input.token]
 * @param {() => string} [input.makeUin]
 */
export function buildHeaders({ token, makeUin }) {
  const headers = {
    'content-type': 'application/json',
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    AuthorizationType: AUTH_TYPE,
  };
  if (typeof makeUin === 'function') headers['X-WECHAT-UIN'] = makeUin();
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The text of a message, or null when it carries none. */
export function textOf(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    if (item?.type === ITEM_TYPE.TEXT) {
      const text = item?.text_item?.text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

/**
 * The reply envelope.
 *
 * `context_token` is **mandatory and comes from the inbound message**: without it the reply is not
 * associated with the conversation. `message_state: 2` is FINISH — a first version omitted it and
 * the endpoint answered `ret: -2, invalid arguments` for eight different payload shapes before the
 * documented envelope was found.
 */
export function buildReply({ toUserId, contextToken, text }) {
  return {
    msg: {
      to_user_id: toUserId,
      message_type: MESSAGE_TYPE.BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text } }],
    },
  };
}

/** Whether a send succeeded. Success carries a `message_id` and **no** `ret`. */
export function sendSucceeded(response) {
  if (response === null || typeof response !== 'object') return false;
  if (typeof response.message_id !== 'undefined' && response.message_id !== null) return true;
  return response.ret === 0 || response.errcode === 0;
}

/**
 * What to say when a message is not a command.
 *
 * ## The requirement this satisfies, and the part of it that had to be refused
 *
 * *"Every sentence from WeChat must get a reply; a mistake must get help."* Before this, **five measured
 * inputs were silently dropped**: a plain sentence, an image, a voice note, an empty `item_list`, and an
 * empty string. The operator sees a bot that reads messages and answers nothing, which is
 * indistinguishable from a bot that is broken.
 *
 * The request also asked the help to advertise *"text, voice and images"*. **Two of those three are not
 * supported**, and `textOf` reading only `type: 1` is the proof: an image and a voice note both answer
 * `not a text message`. So the boundary section says what is true — **a help text that promises a
 * capability the bridge does not have would be read as a bug the first time somebody sent a photo.**
 *
 * ## Why the boundary is a section rather than a footnote
 *
 * A user cannot discover a limitation they are never told about. **"Voice is not supported" arriving in
 * the same breath as the command syntax is the difference between a limitation and a mystery.**
 *
 * @param {{reason?: string|null}} [context]
 * @returns {string}
 */
export function helpText(context = {}) {
  const why = typeof context.reason === 'string' && context.reason !== '' ? context.reason : null;
  const lines = [];
  if (why !== null) lines.push(`没有执行这条消息：${why}`, '');

  lines.push(
    '【1】开关指令',
    '  /run <命令>            把一个命令派发到编队（默认所有在线机器）',
    '  /run --ask <一句话>    问一句话，不执行任何东西',
    '  /run --on <机器> <命令>  只派发到指定机器（逗号分隔）',
    '  /run --timeout <毫秒> <命令>  覆盖等待上限',
    '  /run --mode <模式> <命令>  replicate | split | broadcast | pipeline',
    '',
    '  —— 关于权限：这个窗口当前的能力是 operate、fleet.dispatch。',
    '     若被拒绝，回复里会写明缺哪一个能力；能力由启动桥接的人通过',
    '     W2M_CAPABILITIES 授予，聊天窗口本身不能自行激活。',
    '',
    '【2】指令规则与格式',
    '  · 只能以 /run 开头，其余文字一律当作普通消息并回这条帮助。',
    '  · /run 之后是 argv（逐个词），不是 shell 字符串：',
    '    管道 | 、重定向 > 、&& 都不会生效，会被拒绝。',
    '  · 每个词里的空格要用引号包起来。',
    '  · 举例： /run node --version',
    '          /run git rev-parse --short HEAD',
    '          /run --ask 现在编队里有几台机器在线？',
    '',
    '【3】参考与边界',
    '  · 支持：文字。中文可以。',
    '  · 不支持：语音、图片、文件、表情——它们只会得到这条帮助。',
    '  · 命令是否被允许由目标机器自己的允许清单决定；',
    '    被拒绝时回复会带上原因码（如 COMMAND_NOT_ALLOWED）。',
  );
  return lines.join('\n');
}

/**
 * Decide what to do with one inbound message.
 *
 * Returns a **plan** rather than performing it, so the decision is testable without a relay, a
 * socket, or a clock — and so the caller can see authorisation checked in one place.
 *
 * @param {object} input
 * @param {object} input.message One `msgs[]` entry.
 * @param {(capability: string) => boolean} input.authorize
 * @returns {{act: 'ignore', why: string}
 *          | {act: 'reply', to: string, contextToken: string, text: string}
 *          | {act: 'dispatch', to: string, contextToken: string, argv: string[], flags: object, ack: string}}
 */
export function planMessage({ message, authorize }) {
  const from = message?.from_user_id;
  const contextToken = message?.context_token;
  const text = textOf(message);

  /**
   * The only two real silences, and both are structural rather than a decision.
   *
   * With no `from_user_id` or no `context_token` there is nowhere to send an answer to — so a `reply`
   * here would be a promise the caller cannot keep. **These stay `ignore`, and they are the reason the
   * vocabulary still has one**: collapsing them into `reply` would make the plan lie about what the
   * script can do. Everything below this line gets an answer, because it can.
   */
  if (typeof from !== 'string' || from === '') return { act: 'ignore', why: 'no sender' };
  if (typeof contextToken !== 'string' || contextToken === '') return { act: 'ignore', why: 'no context_token' };

  // A non-text message is answered rather than dropped: "every sentence must get a reply" includes the
  // sentences the bridge cannot read.
  if (text === null) {
    return { act: 'reply', to: from, contextToken, text: helpText({ reason: '这条消息不是文字（语音/图片/文件暂不支持）' }) };
  }

  const trimmed = text.trim();
  // Only the exact `/run` prefix is an action, and that rule is unchanged: a typo must never become a
  // fleet execution. What changed is that it now gets an answer instead of silence.
  if (!/^\/run(\s|$)/i.test(trimmed)) {
    return {
      act: 'reply',
      to: from,
      contextToken,
      text: helpText({ reason: trimmed === '' ? '空消息' : '这条消息没有以 /run 开头' }),
    };
  }

  const body = trimmed.replace(/^\/run\s*/i, '');
  const invocation = parseInvocation(body);

  if (invocation.kind === 'refused') {
    return { act: 'reply', to: from, contextToken, text: invocation.text };
  }

  const capability = invocation.capability;
  if (typeof authorize === 'function' && authorize(capability) !== true) {
    return {
      act: 'reply',
      to: from,
      contextToken,
      text: `这个窗口没有 ${capability} 权限，不能执行。`,
    };
  }

  if (invocation.kind === 'ask') {
    /**
     * The beginner form is answered, not executed.
     *
     * It does **not** reach the fleet from here: the request is a sentence, and turning a sentence
     * into a command inside the bridge would reintroduce exactly the inference `/run --ask` exists
     * to avoid. The reply says what to send instead, so the low-privilege path stays a path to a
     * *proposal* rather than to an execution.
     */
    return {
      act: 'reply',
      to: from,
      contextToken,
      text:
        `收到你的请求：${invocation.text}\n\n`
        + '这是低权限的「提问」模式，我不会直接执行。\n'
        + '如果要真的运行，请把确切的命令发给我，例如：\n'
        + `  /run ${invocation.text.split(/\s+/).slice(0, 3).join(' ')}`,
    };
  }

  return {
    act: 'dispatch',
    to: from,
    contextToken,
    argv: invocation.argv,
    flags: invocation.flags,
    // Acknowledged before dispatch: a fleet run can take a minute, and silence reads as "broken".
    ack: `已派发：${invocation.argv.join(' ')}\n模式：${invocation.flags.mode}\n等我回报结果…`,
  };
}

/**
 * Render a completed task for the chat window.
 *
 * Reuses `renderVerdict`, which already caps the machine list and states the truncation — a list
 * that silently stops at ten reads as "ten machines" rather than "ten shown".
 */
export function renderTaskOutcome({ taskId, body }) {
  const verdict = body?.aggregate?.status ?? body?.status ?? body?.verdict ?? 'unknown';
  const rows = body?.machines ?? body?.leases ?? body?.results ?? [];
  return `${renderVerdict({ taskId, verdict, machines: rows }).text}`;
}

/** Render a dispatch that never became a task. */
export function renderFailure(error) {
  return renderDispatchFailure({
    code: error?.code ?? error?.error?.code,
    reason: error?.detail?.reason ?? error?.error?.detail?.reason,
    detail: error?.detail?.hint ?? error?.error?.detail?.hint ?? error?.message,
  });
}
