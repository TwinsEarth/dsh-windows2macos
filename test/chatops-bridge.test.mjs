/**
 * The whole pipeline, end to end (v0.7.0).
 *
 * The five chatops modules each have their own suite and each proves its own property. This
 * file proves they compose: a message arrives on a channel, is admitted or not, becomes an
 * action, and produces a reply — with no host, no network and no real IM platform.
 *
 * That is the claim worth testing here, because every previous suite could pass while the
 * wiring was wrong. The specific things that can only fail at this level:
 *
 *   * **a stranger gets silence, an admitted identity gets an answer.** Replying to a
 *     stranger confirms the bot exists and spends the anti-flood budget on someone who will
 *     never be admitted; going silent on an admitted identity is indistinguishable from a
 *     bridge that has crashed. Both halves are asserted, because only one of them is
 *     obvious.
 *   * **the reply goes back out on the channel the message came in on**, resolved from the
 *     registry rather than from anything hard-coded.
 *   * **declining an approval never touches `next`**, and answering never calls it. This is
 *     the wiring for the defect that reached beyond the plugin, and it is one boolean.
 *   * **a channel that fails to start does not stop the others**, and is reported as
 *     unconfigured rather than as merely not-online.
 *   * **a file count is the number that was delivered**, not the number of windows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge } from '../src/chatops/bridge.mjs';
import { createMemoryChannel, CHANNEL_STATE, CHANNEL_FEATURE } from '../src/chatops/channel.mjs';
import { DENIAL } from '../src/chatops/policy.mjs';
import { ROUTE_REFUSAL } from '../src/chatops/commands.mjs';

/** A bridge with one memory channel owning the `mem` prefix, and an owner already seeded. */
function harness({ actions = {}, channels, projectRoot, readerIo } = {}) {
  const audit = [];
  const dispatched = [];
  const prompts = [];
  const ch =
    channels ??
    [
      createMemoryChannel({
        name: 'memory',
        prefixes: ['mem'],
        capabilities: { [CHANNEL_FEATURE.FILES]: true },
      }),
    ];

  const bridge = createBridge({
    channels: ch,
    projectRoot,
    readerIo,
    // Large enough that chunking never participates in a *routing* assertion. Chunking has
    // its own suite; letting it split every reply here would make each `sent.length` an
    // assertion about the byte budget rather than about the pipeline.
    chunkBytes: 4096,
    throttleMs: 0,
    audit: (event, detail) => audit.push({ event, ...detail }),
    actions: {
      listSessions: async () => [{ id: 'sess-1aaaaaaa', title: 'the parser' }],
      boundSession: async () => 'sess-1aaaaaaa',
      bind: async () => {},
      tail: async () => ['a line'],
      listMachines: async () => [{ id: 'm-1', name: 'win-desktop', os: 'windows', arch: 'x64', online: true }],
      dispatch: async (argv) => {
        dispatched.push(argv);
        return { taskId: 'task-9', summary: `已派发：${argv.join(' ')}` };
      },
      prompt: async (window, text) => {
        prompts.push({ window, text });
        return { ack: '已发送给会话。' };
      },
      setPolicy: async () => {},
      trust: () => ({ ok: true }),
      distrust: () => ({ ok: true }),
      ...actions,
    },
  });

  // Seeded, not adopted. There is no path that trusts a sender for speaking first.
  bridge.policy.trust('memory', 'owner');
  return { bridge, ch: ch[0], channels: ch, audit, dispatched, prompts };
}

const from = (text, over = {}) => ({ windowKey: 'mem:owner', talkerId: 'owner', text, ...over });

describe('the pipeline composes', () => {
  it('takes a command from an inbound message to a reply on the same channel', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('/whoami'));
    assert.equal(outcome.action, 'ok');
    assert.equal(h.ch.sent.length, 1, 'exactly one reply, on the channel the message arrived on');
    assert.match(h.ch.sent[0].text, /memory:owner/);
    assert.equal(h.ch.sent[0].window, 'mem:owner');
  });

  it('delivers a command that dispatches to the fleet', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('/run node --test'));
    assert.equal(outcome.action, 'ok');
    assert.equal(outcome.taskId, 'task-9');
    assert.deepEqual(h.dispatched, [['node', '--test']]);
    assert.match(h.ch.sent.at(-1).text, /已派发/);
  });

  it('treats ordinary text as a prompt and acknowledges it', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('翻译一下 README'));
    assert.equal(outcome.action, 'prompt');
    assert.deepEqual(h.prompts, [{ window: 'mem:owner', text: '翻译一下 README' }]);
    assert.match(h.ch.sent.at(-1).text, /已发送给会话/);
  });

  it('says so when there is no session to prompt', async () => {
    // A bridge with no session surface is a real configuration, and it must answer rather
    // than go quiet.
    const h = harness({ actions: { prompt: undefined } });
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('hello'));
    assert.equal(outcome.action, 'unavailable');
    assert.match(h.ch.sent.at(-1).text, /没有接入会话/);
  });
});

describe('a stranger is ignored, an admitted identity is answered', () => {
  it('says nothing at all to the first private sender', async () => {
    // The C1 defect, observed from the outside: 0.1.0 made this sender the owner.
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound({ windowKey: 'mem:stranger', talkerId: 'stranger', text: '/help' });
    assert.equal(outcome.action, 'ignored');
    assert.equal(outcome.reason, DENIAL.SENDER_UNTRUSTED);
    assert.deepEqual(h.ch.sent, [], 'a stranger learns nothing, not even that the bot exists');
    assert.equal(h.bridge.policy.ownerCount, 1, 'and is certainly not adopted');
  });

  it('ignores a message that arrives before any owner exists', async () => {
    const h = harness();
    // Undo the seeded owner to reach the pre-adoption state.
    h.bridge.policy.distrust('memory', 'owner');
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('/help'));
    assert.equal(outcome.action, 'ignored');
    assert.equal(outcome.reason, DENIAL.NOT_ADOPTED);
    assert.deepEqual(h.ch.sent, []);
  });

  it('answers a malformed window, because for an operator that is a config bug', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound({ windowKey: 'nonsense', text: '/help' });
    assert.equal(outcome.action, 'refused');
    assert.equal(outcome.reason, DENIAL.CHANNEL_UNKNOWN);
    // Routed to the audit channel rather than by guessing a channel from the key: a message
    // must not be able to choose its own reply path. What matters is that it is answered at
    // all, because a silent drop here is indistinguishable from a broken bot.
    assert.equal(h.ch.sent.length, 1, 'a named reason is the difference between broken and silent');
    assert.match(h.ch.sent[0].text, /channel_unknown/);
  });

  it('names the channel it does not know rather than dropping it', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound({ windowKey: 'telegram:someone', text: 'hi' });
    assert.equal(outcome.reason, DENIAL.CHANNEL_UNKNOWN);
    assert.match(h.ch.sent.at(-1).text, /channel_unknown/);
  });
});

describe('declining an approval never touches next, answering never calls it', () => {
  it('declines synchronously when the session has no bound window', async () => {
    const h = harness();
    await h.bridge.start();
    let nextCalls = 0;
    const result = await h.bridge.offerApproval({
      request: { toolName: 'bash' },
      windowKey: null,
      next: async () => {
        nextCalls += 1;
        return 'rejected';
      },
    });
    assert.equal(result.claimed, false);
    // `next` must not even be *called* here: the host's answerers decide this one, and a
    // bridge that awaits before declining has taken the decision.
    assert.equal(nextCalls, 0);
  });

  it('claims when a window is bound, and does not consult the host', async () => {
    const h = harness();
    await h.bridge.start();
    let nextCalls = 0;
    const offering = h.bridge.offerApproval({
      request: { toolName: 'bash', callId: 'c1' },
      windowKey: 'mem:owner',
      next: async () => {
        nextCalls += 1;
        return 'rejected';
      },
    });
    const pending = h.bridge.broker.listFor('mem:owner');
    assert.equal(pending.length, 1);
    assert.equal(h.bridge.broker.decide(pending[0].approval_id, 'allowed-once').ok, true);
    const result = await offering;
    assert.equal(result.claimed, true);
    assert.equal(result.outcome, 'allowed-once');
    assert.equal(nextCalls, 0, 'an answered request must not also ask the host');
  });

  it('delegates on its own deadline instead of denying', async () => {
    // The property that decides whether a silent phone blocks work the host would allow.
    let now = 0;
    const ch = createMemoryChannel({ name: 'memory', prefixes: ['mem'] });
    const bridge = createBridge({
      channels: [ch],
      throttleMs: 0,
      now: () => now,
      broker: {
        now: () => now,
        setTimer: (fn, ms) => {
          // Fire on the next turn, so `advance` stands in the window a real loop has.
          const handle = setTimeout(fn, 0);
          handle._due = now + ms;
          return handle;
        },
        clearTimer: (h) => clearTimeout(h),
      },
    });
    bridge.policy.trust('memory', 'owner');
    await bridge.start();

    let nextCalls = 0;
    const offering = bridge.offerApproval({
      request: { toolName: 'bash' },
      windowKey: 'mem:owner',
      timeoutMs: 10,
      next: async () => {
        nextCalls += 1;
        return 'allowed-once';
      },
    });
    now = 11;
    const result = await offering;
    assert.equal(result.claimed, true);
    assert.equal(result.outcome, 'allowed-once', 'the host allowed it; the bridge did not deny it');
    assert.equal(nextCalls, 1, 'a deadline delegates exactly once');
  });
});

describe('the channel decides what it can do, and is asked rather than probed', () => {
  it('reports a file as failed on a channel that cannot send files', async () => {
    const ch = createMemoryChannel({
      name: 'memory',
      prefixes: ['mem'],
      capabilities: { [CHANNEL_FEATURE.FILES]: false },
    });
    // A project root is required for the fence to exist at all; without one the bridge
    // refuses before it reaches a channel, which is a different answer from "this channel
    // cannot carry files" and is asserted separately below.
    const h = harness({
      channels: [ch],
      projectRoot: '/proj',
      // A filesystem that says yes to everything: this test is about which channel can carry
      // a file and what the caller is told, not about the fence. The fence's symlink
      // behaviour has its own suite, which can run a POSIX fixture on any host.
      readerIo: {
        realpath: async (p) => p,
        lstat: async () => ({ isFile: () => true, isDirectory: () => false, size: 4 }),
        readFile: async () => Buffer.from('logs'),
      },
    });
    await h.bridge.start();
    const outcome = await h.bridge.sendFile({ relPath: 'build.log', windows: ['mem:owner'] });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.sent, 0);
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0].window, 'mem:owner');
    assert.equal(outcome.failed[0].reason, 'channel_cannot_send_files');
  });

  it('says there is no project root rather than reporting an empty success', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.sendFile({ relPath: 'build.log', windows: ['mem:owner'] });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'no_project_root');
  });

  it('refuses to build a bridge with no channels', () => {
    assert.throws(() => createBridge({ channels: [], actions: {} }), /at least one channel/);
  });

  it('refuses a channel that does not satisfy the contract, at construction', () => {
    // The failure this prevents: a channel that starts, reports itself registered, accepts
    // routed messages, and throws only when a feature is first used.
    assert.throws(() => createBridge({ channels: [{ name: 'half' }], actions: {} }), /invalid channel/);
  });

  it('refuses two channels claiming one prefix, because routing would depend on order', () => {
    const a = createMemoryChannel({ name: 'a', prefixes: ['mem'] });
    const b = createMemoryChannel({ name: 'b', prefixes: ['mem'] });
    assert.throws(() => createBridge({ channels: [a, b], actions: {} }), /claimed by both/);
  });

  it('refuses a channel whose prefix the registry does not know', () => {
    // Otherwise every message from it is refused as `channel_unknown` forever, which looks
    // like a broken bot rather than a misconfigured one.
    const ch = createMemoryChannel({ name: 'rogue', prefixes: ['zzz'] });
    assert.throws(() => createBridge({ channels: [ch], actions: {} }), /channel_unknown/);
  });
});

describe('one broken channel does not silence the others', () => {
  it('starts the rest when one fails, and names its state', async () => {
    const good = createMemoryChannel({ name: 'memory', prefixes: ['mem'] });
    const bad = createMemoryChannel({ name: 'broken', prefixes: ['fsu'] });
    bad.start = async () => {
      throw new Error('no credentials');
    };
    const h = harness({ channels: [good, bad] });
    const result = await h.bridge.start();
    assert.equal(result.started, 1);
    assert.equal(result.total, 2);

    // And the working one still works.
    await h.bridge.handleInbound(from('/whoami'));
    assert.equal(good.sent.length, 1);

    // The failed one is `unconfigured`, not merely "offline" — the state 0.1.0 collapsed.
    const status = h.bridge.status();
    assert.equal(status.channels.find((c) => c.name === 'broken').state, CHANNEL_STATE.UNCONFIGURED);
    assert.equal(status.channels.find((c) => c.name === 'memory').state, CHANNEL_STATE.READY);
  });
});

describe('shutdown is clean', () => {
  it('stops every channel and settles pending approvals', async () => {
    const h = harness();
    await h.bridge.start();
    await h.bridge.handleInbound(from('/whoami'));
    const offering = h.bridge.offerApproval({
      request: { toolName: 'bash' },
      windowKey: 'mem:owner',
      next: async () => 'rejected',
    });
    await h.bridge.stop();
    const result = await offering;
    // Settled rather than abandoned: a promise left pending past a disposer belongs to a
    // fiber that no longer exists.
    assert.equal(result.claimed, true);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(h.ch.state, CHANNEL_STATE.STOPPED);
    assert.equal(h.bridge.status().pendingApprovals, 0);
  });
});

describe('a refusal is a reply, and carries its code', () => {
  it('reports an unknown command without sending it to the model', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('/sesions'));
    assert.equal(outcome.refusal, ROUTE_REFUSAL.UNKNOWN_COMMAND);
    assert.deepEqual(h.prompts, [], 'a typo must not become model work');
    assert.match(h.ch.sent.at(-1).text, /未知指令/);
  });

  it('reports a bad argument rather than failing silently', async () => {
    const h = harness();
    await h.bridge.start();
    const outcome = await h.bridge.handleInbound(from('/use 99'));
    assert.equal(outcome.refusal, ROUTE_REFUSAL.BAD_ARGUMENTS);
    assert.match(h.ch.sent.at(-1).text, /找不到会话/);
  });
});
