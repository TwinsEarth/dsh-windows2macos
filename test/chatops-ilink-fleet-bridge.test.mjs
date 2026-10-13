/**
 * The WeChat → fleet bridge (v0.7.12).
 *
 * Two properties are under test, and both were expensive to learn:
 *
 * **1. The wire shapes are the measured ones.** Four wrong guesses about this protocol made a
 * working feature look broken — a token that "expired in 30 seconds" and was valid for 280, a body
 * read from `content` when it lives in `item_list[0].text_item.text`, a cursor called `buf` when it
 * is `get_updates_buf`, a reply that failed eight ways because it was not nested under `msg`. So the
 * shapes are asserted here rather than trusted to a comment.
 *
 * **2. A low-privilege window cannot reach execution by asking.** `/run --ask` is answered, never
 * dispatched. If the bridge turned a sentence into a command it would reintroduce exactly the
 * inference the two-form design exists to avoid.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHeaders,
  buildReply,
  textOf,
  sendSucceeded,
  planMessage,
  renderTaskOutcome,
  AUTH_TYPE,
  MESSAGE_TYPE,
  MESSAGE_STATE_FINISH,
  ITEM_TYPE,
} from '../src/chatops/ilink-fleet-bridge.mjs';

/** An inbound message in the shape the live service actually returns. */
const inbound = (text, over = {}) => ({
  seq: 5,
  message_id: 7515897382018854000,
  from_user_id: 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat',
  to_user_id: 'f2b8ea0f48d4@im.bot',
  message_type: 1,
  message_state: 2,
  context_token: 'AARzJWAFAAABAAAAAAAp',
  item_list: [{ type: 1, text_item: { text } }],
  ...over,
});

const allowAll = () => true;
const denyAll = () => false;

describe('the wire shapes are the ones measured from the live service', () => {
  it('reads the body from item_list[0].text_item.text, not from `content`', () => {
    // The reading bug that made an arriving message look like an empty one.
    assert.equal(textOf(inbound('你好呀！')), '你好呀！');
    assert.equal(textOf({ content: '你好呀！' }), null, 'a top-level `content` is not where it lives');
  });

  it('returns null for a message that carries no text', () => {
    assert.equal(textOf({ item_list: [{ type: 2, image_item: {} }] }), null);
    assert.equal(textOf({ item_list: [] }), null);
    assert.equal(textOf({}), null);
    assert.equal(textOf(null), null);
  });

  it('sends the three mandatory headers plus the fresh UIN', () => {
    const h = buildHeaders({ token: 'tok', makeUin: () => 'uin-abc' });
    assert.equal(h.AuthorizationType, AUTH_TYPE, 'undocumented and mandatory; without it: 401 with no reason');
    assert.equal(h['iLink-App-Id'], 'bot');
    assert.equal(h['X-WECHAT-UIN'], 'uin-abc');
    assert.equal(h.authorization, 'Bearer tok');
  });

  it('omits authorization when there is no token, rather than sending an empty bearer', () => {
    assert.equal('authorization' in buildHeaders({ token: '' }), false);
    assert.equal('authorization' in buildHeaders({}), false);
  });

  it('nests the reply under `msg` with message_type 2 and message_state 2', () => {
    // Eight payload shapes failed with `ret: -2, invalid arguments` before this envelope was found.
    const body = buildReply({ toUserId: 'u@im.wechat', contextToken: 'ctx', text: 'hi' });
    assert.deepEqual(Object.keys(body), ['msg'], 'the envelope is nested, not flat');
    assert.equal(body.msg.message_type, MESSAGE_TYPE.BOT);
    assert.equal(body.msg.message_state, MESSAGE_STATE_FINISH, 'omitted in the version that failed');
    assert.equal(body.msg.context_token, 'ctx', 'without it the reply is not associated with the conversation');
    assert.deepEqual(body.msg.item_list, [{ type: ITEM_TYPE.TEXT, text_item: { text: 'hi' } }]);
  });

  it('treats a reply as successful when it carries a message_id, with no ret and no errcode', () => {
    // Success on this endpoint returns ONLY `{message_id}`. A check for `ret === 0` reports a
    // delivered message as a failure.
    assert.equal(sendSucceeded({ message_id: 7515898391556775000 }), true);
    assert.equal(sendSucceeded({ ret: 0 }), true);
    assert.equal(sendSucceeded({ errcode: 0 }), true);
    assert.equal(sendSucceeded({ ret: -2, errmsg: 'invalid arguments' }), false);
    assert.equal(sendSucceeded({}), false);
    assert.equal(sendSucceeded(null), false);
  });
});

describe('only an explicit /run line is an action', () => {
  it('ignores ordinary conversation', () => {
    for (const text of ['你好', 'hello', 'node --version', '/help', '/runner x']) {
      assert.equal(planMessage({ message: inbound(text), authorize: allowAll }).act, 'ignore', text);
    }
  });

  it('ignores a message with no sender or no context_token', () => {
    assert.equal(planMessage({ message: inbound('x', { from_user_id: '' }), authorize: allowAll }).act, 'ignore');
    assert.equal(planMessage({ message: inbound('x', { context_token: '' }), authorize: allowAll }).act, 'ignore');
  });

  it('ignores a non-text message instead of guessing at it', () => {
    const msg = { from_user_id: 'u', context_token: 'c', item_list: [{ type: 2 }] };
    assert.equal(planMessage({ message: msg, authorize: allowAll }).act, 'ignore');
  });

  it('accepts the prefix case-insensitively and with any spacing', () => {
    for (const text of ['/run node --version', '/RUN node --version', '/run   node --version']) {
      assert.equal(planMessage({ message: inbound(text), authorize: allowAll }).act, 'dispatch', text);
    }
  });
});

describe('the expert form dispatches, and needs fleet.dispatch', () => {
  it('produces argv from the message', () => {
    const plan = planMessage({ message: inbound('/run node --version'), authorize: allowAll });
    assert.equal(plan.act, 'dispatch');
    assert.deepEqual(plan.argv, ['node', '--version']);
    assert.equal(plan.to, 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat');
    assert.equal(plan.contextToken, 'AARzJWAFAAABAAAAAAAp');
  });

  it('asks for fleet.dispatch, not for a weaker capability', () => {
    let asked = null;
    planMessage({ message: inbound('/run node --version'), authorize: (c) => { asked = c; return true; } });
    assert.equal(asked, 'fleet.dispatch');
  });

  it('refuses when the window lacks it, without dispatching', () => {
    const plan = planMessage({ message: inbound('/run node --version'), authorize: denyAll });
    assert.equal(plan.act, 'reply');
    assert.match(plan.text, /fleet\.dispatch/);
    assert.equal(plan.argv, undefined, 'a refused plan must carry no argv');
  });

  it('acknowledges before the run, because silence reads as broken', () => {
    const plan = planMessage({ message: inbound('/run node --version'), authorize: allowAll });
    assert.match(plan.ack, /已派发/);
    assert.match(plan.ack, /node --version/);
  });

  it('replies to a malformed command rather than dispatching a guess', () => {
    for (const text of ['/run', '/run ls | grep x', '/run cat "unclosed']) {
      const plan = planMessage({ message: inbound(text), authorize: allowAll });
      assert.equal(plan.act, 'reply', text);
      assert.equal(plan.argv, undefined);
    }
  });
});

describe('the beginner form is answered, never executed', () => {
  it('needs only `operate`', () => {
    let asked = null;
    const plan = planMessage({ message: inbound('/run --ask 看看各机器的 node 版本'), authorize: (c) => { asked = c; return true; } });
    assert.equal(asked, 'operate');
    assert.equal(plan.act, 'reply', 'an ask never dispatches');
  });

  it('carries no argv at all, so it cannot reach the fleet', () => {
    // The property that makes a low-privilege ask safe.
    for (const text of ['/run --ask 运行 rm -rf /', '/run --ask 帮我删掉所有文件', '/run --ask node --version']) {
      const plan = planMessage({ message: inbound(text), authorize: allowAll });
      assert.equal(plan.act, 'reply', text);
      assert.equal(plan.argv, undefined);
    }
  });

  it('says how to turn the request into a command', () => {
    const plan = planMessage({ message: inbound('/run --ask 看看各机器的 node 版本'), authorize: allowAll });
    assert.match(plan.text, /提问/);
    assert.match(plan.text, /\/run /);
  });

  it('does not let a denied window learn anything by asking', () => {
    const plan = planMessage({ message: inbound('/run --ask anything'), authorize: denyAll });
    assert.equal(plan.act, 'reply');
    assert.match(plan.text, /operate/);
  });
});

describe('a verdict is rendered for a phone', () => {
  it('reads the aggregate status, which is the measured field', () => {
    const text = renderTaskOutcome({ taskId: 'T1', body: { aggregate: { status: 'consistent' }, leases: [] } });
    assert.match(text, /判定：consistent/);
  });

  it('names the machines and their outcomes', () => {
    const text = renderTaskOutcome({
      taskId: 'T',
      body: {
        aggregate: { status: 'divergent' },
        machines: [{ machine_name: 'macmini', outcome: 'ok', exit_code: 0 }, { machine_name: 'jp-shared', outcome: 'refused', refusal_reason: 'COMMAND_NOT_ALLOWED' }],
      },
    });
    assert.match(text, /macmini: ok exit=0/);
    assert.match(text, /jp-shared: refused \(COMMAND_NOT_ALLOWED\)/);
  });

  it('says unknown rather than inventing a verdict from a missing field', () => {
    const text = renderTaskOutcome({ taskId: 'T', body: {} });
    assert.match(text, /判定：unknown/);
  });
});
