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
import { readFileSync } from 'node:fs';

import {
  buildHeaders,
  buildReply,
  textOf,
  sendSucceeded,
  planMessage,
  renderTaskOutcome,  renderBridgeError,
  dryRunPolicy,
  helpText,
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

describe('only an explicit /run line is an action -- and everything else is ANSWERED', () => {
  /**
   * These three assertions used to demand `ignore`. They were right about the rule and wrong about the
   * response: the rule is that a typo must never become a fleet execution, and that is unchanged. What
   * changed is that **silence is no longer the way the rule is expressed** -- a bot that reads messages
   * and answers nothing is indistinguishable from a bot that is broken, and the operator's only move was
   * to send the command again.
   */
  it('answers ordinary conversation with help instead of ignoring it', () => {
    for (const text of ['你好', 'hello', 'node --version', '/help', '/runner x']) {
      const plan = planMessage({ message: inbound(text), authorize: allowAll });
      assert.notEqual(plan.act, 'dispatch', `${text} must not dispatch`);
      assert.equal(plan.act, 'reply', text);
      assert.match(plan.text, /没有执行这条消息/, text);
      assert.match(plan.text, /【3】参考与边界/, text);
    }
  });

  it('still ignores where a reply is structurally impossible', () => {
    // The one surviving silence, and it is structural rather than a decision: with no sender or no
    // context_token there is nowhere to send an answer. **Calling this `reply` would make the plan lie
    // about what the caller can do**, which is why the vocabulary keeps `ignore`.
    assert.equal(planMessage({ message: inbound('x', { from_user_id: '' }), authorize: allowAll }).act, 'ignore');
    assert.equal(planMessage({ message: inbound('x', { context_token: '' }), authorize: allowAll }).act, 'ignore');
  });

  it('answers a non-text message instead of guessing at it', () => {
    // Not guessed at -- answered. The help says which types are unsupported, so the limitation arrives
    // with the reply rather than leaving the operator to work it out.
    const msg = { from_user_id: 'u', context_token: 'c', item_list: [{ type: 2 }] };
    const plan = planMessage({ message: msg, authorize: allowAll });
    assert.equal(plan.act, 'reply');
    assert.equal(plan.act === 'dispatch', false, 'and above all it is not executed');
    assert.match(plan.text, /不是文字/);
    assert.match(plan.text, /语音、图片、文件、表情/);
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

describe('--dry-run: nothing reaches the fleet, and this is the fix for a real dispatch', () => {
  /**
   * The defect, measured rather than described: two `--dry-run` runs sent `node--version` to all five
   * machines, and one produced a task record with five real leases. The flag guarded the REPLY only.
   */
  it('refuses the dispatch when dryRun is set, and says so', () => {
    const policy = dryRunPolicy({ dryRun: true });
    assert.equal(policy.dispatch, false, 'a dry run must not reach fleet.run');
    assert.equal(policy.reply, false, 'and must not reach WeChat either');
    assert.match(policy.reason, /not dispatched to/);
  });

  it('permits both when dryRun is absent or false', () => {
    for (const options of [{}, { dryRun: false }, { dryRun: undefined }]) {
      const policy = dryRunPolicy(options);
      assert.equal(policy.dispatch, true, JSON.stringify(options));
      assert.equal(policy.reply, true, JSON.stringify(options));
      assert.equal(policy.reason, null);
    }
  });

  it('opens only on the boolean true, and this function takes a PARAMETER not a CLI flag', () => {
    // My first version asserted that `'true'` (a string) must not dispatch, and it does dispatch. **The
    // code was right and the test was wrong**, and the cause is a collision of two different things
    // sharing one word:
    //
    //   * the CLI **flag** `--dry-run` is PRESENT-MEANS-TRUE (`argv.includes('--dry-run')`), and
    //   * the **parameter** `dryRun` defaults to FALSE, which is what `update-install` means by it.
    //
    // This function takes the parameter, and the script always hands it a boolean from `includes()`. The
    // assertion that matters is therefore the strict one: only `true` turns the dispatch off, so a future
    // caller cannot open the path with a truthy value.
    assert.equal(dryRunPolicy({ dryRun: true }).dispatch, false);
    for (const v of [false, undefined, null, 0, '', 'true']) {
      assert.equal(dryRunPolicy({ dryRun: v }).dispatch, true, `dryRun=${JSON.stringify(v)} permits dispatch`);
    }
  });

  it('agrees with the meaning this project already gives dryRun elsewhere', () => {
    // `update-install` asserts "dryRun must not call the package manager" and "must not write", and
    // `auto-update` asserts it writes nothing to the profile. The bridge held the opposite meaning for the
    // same word -- two flags, one name. Aligning is why the fix is a behaviour change and not a rename.
    const install = readFileSync(new URL('./update-install.test.mjs', import.meta.url), 'utf8');
    assert.match(install, /dryRun must not call the package manager/);
    assert.equal(dryRunPolicy({ dryRun: true }).dispatch, false);
  });

  it('is consumed by the script, above the only call that reaches the fleet', () => {
    // The policy is only a fix if the script reads it. A test of the pure function alone would pass while
    // the script still dispatched -- which is exactly the shape of the original defect: the guard existed
    // for the reply and not for the dispatch, and nothing noticed.
    const script = readFileSync(new URL('../scripts/ilink-fleet-bridge.mjs', import.meta.url), 'utf8');
    const guardAt = script.indexOf('if (!dry.dispatch)');
    const runAt = script.indexOf('await fleet.run(');
    assert.ok(guardAt > -1, 'the script consults the dispatch permission');
    assert.ok(runAt > -1, 'the script dispatches somewhere');
    assert.ok(guardAt < runAt, 'and consults it BEFORE the only call that can reach the fleet');
    assert.match(script, /const dry = dryRunPolicy\(\{ dryRun \}\)/, 'derived once, from the flag');
  });
});

describe('helpText: the three sections the operator asked for, one of them honest', () => {
  const help = helpText({ reason: '这条消息没有以 /run 开头' });

  it('carries the three sections, by the names that were requested', () => {
    // The request named them: 开关指令 / 指令规则与格式 / 参考与边界. Asserted by heading rather than by
    // "the text mentions commands", because a help text that loses a section still reads fine.
    assert.match(help, /【1】开关指令/);
    assert.match(help, /【2】指令规则与格式/);
    assert.match(help, /【3】参考与边界/);
  });

  it('states why it did not execute, first, before any syntax', () => {
    // A reader who sent a command wants to know what happened before they want a manual.
    const first = help.split('\n')[0];
    assert.match(first, /没有执行这条消息/);
    assert.match(first, /没有以 \/run 开头/);
    assert.equal(helpText().startsWith('没有执行'), false, 'with no reason there is no line to state');
  });

  it('lists the switches, including --ask -- the flag nobody could discover', () => {
    // The whole reason this task existed: `--ask` was reachable only by reading the source. If it ever
    // stops being in the help, the discoverability defect is back.
    assert.match(help, /\/run --ask/);
    assert.match(help, /\/run --on/);
    assert.match(help, /\/run --timeout/);
    assert.match(help, /\/run --mode/);
  });

  it('says what the window CANNOT do, and who can change that', () => {
    // "If refused, provide the activation instruction" -- and the honest answer is that a chat window
    // cannot activate itself. Saying so is the instruction; implying otherwise would send the operator
    // looking for a command that does not exist.
    assert.match(help, /W2M_CAPABILITIES/);
    assert.match(help, /聊天窗口本身不能自行激活/);
  });

  it('names text as supported and voice, images and files as NOT -- the boundary, not a footnote', () => {
    // The request asked the help to advertise "text, voice and images". Two of the three are untrue:
    // \`textOf\` reads only \`type: 1\`, measured. **A help text that promised a capability the bridge does
    // not have would be read as a bug the first time somebody sent a photo.**
    assert.match(help, /支持：文字/);
    assert.match(help, /不支持：语音、图片、文件、表情/);
  });

  it('warns that argv is not a shell, before the operator tries a pipe', () => {
    // Measured elsewhere: \`|\`, \`>\` and \`&&\` are refused by the parser. Saying so in the help turns a
    // refusal into an expectation.
    assert.match(help, /不是 shell 字符串/);
    assert.match(help, /管道/);
  });

  it('gives examples that the parser actually accepts', () => {
    // Every example in the help is put through the real parser, so the help cannot drift into advertising
    // syntax that is refused. This is the assertion that keeps the two in step.
    for (const line of help.split('\n').filter((l) => l.includes('/run '))) {
      const text = line.slice(line.indexOf('/run ')).trim();
      const plan = planMessage({ message: inbound(text), authorize: allowAll });
      assert.notEqual(plan.act, 'ignore', `help advertises "${text}" and it is ignored`);
    }
  });
});

describe('every failure gets a reply', () => {
  it('renders a failed message handling as a reply with phase, code and next step', () => {
    const error = Object.assign(new Error('relay refused'), { code: 'DISPATCH_REFUSED' });
    const text = renderBridgeError(error, 'dispatch');
    assert.match(text, /处理失败/);
    assert.match(text, /dispatch/);
    assert.match(text, /DISPATCH_REFUSED/);
    assert.match(text, /relay refused/);
    assert.match(text, /\/help/);
  });
  it('names an unknown error instead of staying silent', () => {
    const text = renderBridgeError('boom', 'parse');
    assert.match(text, /ERR_UNKNOWN/);
    assert.match(text, /boom/);
  });

});
