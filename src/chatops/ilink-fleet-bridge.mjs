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

  if (typeof from !== 'string' || from === '') return { act: 'ignore', why: 'no sender' };
  if (typeof contextToken !== 'string' || contextToken === '') return { act: 'ignore', why: 'no context_token' };
  if (text === null) return { act: 'ignore', why: 'not a text message' };

  const trimmed = text.trim();
  // Only the exact `/run` prefix is an action. Everything else is conversation, which is what keeps
  // a typo from becoming a fleet execution.
  if (!/^\/run(\s|$)/i.test(trimmed)) return { act: 'ignore', why: 'not a /run line' };

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
