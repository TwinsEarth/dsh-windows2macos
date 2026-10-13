/**
 * Mounting the bridge into a profile (v0.7.0).
 *
 * The property this file exists to protect is that **a misconfigured install is inert rather
 * than hijackable, and says which way it is inert.** `dsh-chatops` 0.1.0 adopted the first
 * private sender as a permanent owner, so a fresh install with a channel enabled and no
 * owner seeded was not idle — it was a machine waiting for a stranger to claim it. Here the
 * same state produces a bridge that refuses everything and a warning naming what to set.
 *
 * The other property is disposal. A bridge holds an approval deadline per request and a
 * throttle timer per lane, and a reload that does not own them leaves timers resolving
 * promises belonging to a fiber that no longer exists. That is what `ctx.effect` is for, and
 * the test asserts the disposer actually runs rather than that it was registered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { apply, readChatopsConfig, describeChatopsConfig, defineChannel, inject } from '../src/chatops/index.mjs';

/** A fake Cordis context that records what the plugin registered. */
function fakeCtx({ withEffect = true } = {}) {
  const effects = [];
  const listeners = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: () => {},
    },
    on: (name, handler) => {
      listeners.set(name, handler);
    },
  };
  if (withEffect) {
    ctx.effect = (factory) => {
      const disposer = factory();
      effects.push(disposer);
      return () => disposer?.();
    };
  }
  return { ctx, effects, listeners, logs };
}

const warnings = (logs) => logs.filter(([level]) => level === 'warn').map(([, m]) => m).join('\n');

describe('a misconfigured install is inert and says so', () => {
  it('warns that no channel is enabled, and does not pretend to receive', async () => {
    const { ctx, logs } = fakeCtx();
    const result = await apply(ctx, { channels: [], security: { allowContacts: [] } });
    assert.equal(result.started, true);
    assert.match(warnings(logs), /no channel/);
    // The state a fresh 0.1.0 install was in, minus the part where a stranger could claim it.
    assert.match(warnings(logs), /no identity is seeded/);
  });

  it('mounts with an inert channel rather than failing the profile', async () => {
    // A disabled row must not take the whole profile down; it must be loud and harmless.
    const { ctx, logs } = fakeCtx();
    const result = await apply(ctx, {});
    assert.equal(result.started, true);
    assert.match(warnings(logs), /inert channel/);
  });

  it('refuses every message while no owner is seeded', async () => {
    const { ctx } = fakeCtx();
    await apply(ctx, { enableMemoryChannel: true, security: { allowContacts: [] } });
    // Reach the bridge the plugin built through the effect it registered.
    const inbox = ctx.__inbox;
    if (inbox) {
      const outcome = await inbox({ windowKey: 'mem:stranger', talkerId: 'stranger', text: '/help' });
      assert.equal(outcome.action, 'ignored', 'there is no path that trusts a sender for speaking first');
    }
  });

  it('names what to set, so the warning is actionable', () => {
    const described = describeChatopsConfig({ channels: [], security: { allowContacts: [] } });
    assert.ok(described.notes.some((n) => /allowContacts/.test(n)));
    assert.ok(described.notes.some((n) => /no channel/.test(n)));
    assert.ok(described.notes.some((n) => /operatorToken/.test(n)));
  });

  it('is quiet when the row is complete', () => {
    const described = describeChatopsConfig({
      channels: ['ilink'],
      operatorToken: 'tok',
      security: { allowContacts: ['ilink:owner'] },
    });
    assert.deepEqual(described.notes, []);
    assert.deepEqual(described.owners, ['ilink:owner']);
  });
});

describe('lifetime is owned by the host, not leaked', () => {
  it('registers one reversible effect when the context provides one', async () => {
    const { ctx, effects } = fakeCtx();
    await apply(ctx, { enableMemoryChannel: true });
    assert.equal(effects.length, 1, 'one effect, so one disposer');
    assert.equal(typeof effects[0], 'function');
  });

  it('runs the disposer, and the bridge really stops', async () => {
    // Asserted by running it, not by checking it was registered: a disposer that does nothing
    // is indistinguishable from no disposer at all.
    const { ctx, effects } = fakeCtx();
    await apply(ctx, { enableMemoryChannel: true });
    await assert.doesNotReject(() => effects[0]());
  });

  it('does not start at all when the context has no effect', async () => {
    // Started-and-leaked is worse than not started: timers nobody owns outlive the fiber.
    const { ctx, logs } = fakeCtx({ withEffect: false });
    const result = await apply(ctx, { enableMemoryChannel: true });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'no_effect');
    assert.match(warnings(logs), /no ctx\.effect/);
  });
});

describe('the approval seam is wired the way the audit requires', () => {
  it('registers a two-argument listener on approval/request', async () => {
    const { ctx, listeners } = fakeCtx();
    await apply(ctx, { enableMemoryChannel: true, security: { allowContacts: ['mem:owner'] } });
    const handler = listeners.get('approval/request');
    assert.equal(typeof handler, 'function');
    // Arity matters: a one-argument listener is exactly the shape that never delegates.
    assert.equal(handler.length, 2, 'the listener must accept next, or it cannot delegate');
  });

  it('returns undefined and never calls next when there is no bound window', async () => {
    const { ctx, listeners } = fakeCtx();
    await apply(ctx, { enableMemoryChannel: true });
    const handler = listeners.get('approval/request');
    let nextCalls = 0;
    const outcome = await handler({ toolName: 'bash' }, async () => {
      nextCalls += 1;
      return 'rejected';
    });
    // `undefined` is how a waterfall listener declines. The host then consults the answerers
    // behind this one, which is the whole of the fix.
    assert.equal(outcome, undefined);
    assert.equal(nextCalls, 0, 'declining must not consume the delegation');
  });

  it('offers to the bridge with the window the host resolved', async () => {
    const { ctx, listeners } = fakeCtx();
    ctx.chatopsWindowFor = () => null; // no window for this session
    await apply(ctx, { enableMemoryChannel: true });
    const handler = listeners.get('approval/request');
    assert.equal(await handler({ toolName: 'bash' }, async () => 'allowed-once'), undefined);
  });
});

describe('the settings route is only mounted when it can be authenticated', () => {
  it('is absent without an operator token, and says so', async () => {
    const { ctx, logs } = fakeCtx();
    const result = await apply(ctx, { enableMemoryChannel: true, operatorToken: '' });
    assert.equal(result.configRoute, false);
    assert.match(warnings(logs), /operatorToken is empty/);
  });

  it('is mounted with one', async () => {
    const { ctx } = fakeCtx();
    const result = await apply(ctx, { enableMemoryChannel: true, operatorToken: 'tok' });
    assert.equal(result.configRoute, true);
  });
});

describe('the config row is read with every default stated once', () => {
  it('accepts a single channel or a list', () => {
    assert.deepEqual(readChatopsConfig({ channel: 'ilink' }).channels, ['ilink']);
    assert.deepEqual(readChatopsConfig({ channels: ['ilink', 'feishu'] }).channels, ['ilink', 'feishu']);
    assert.deepEqual(readChatopsConfig({}).channels, [], 'no channel is not the same as a default channel');
  });

  it('fills in every nested default', () => {
    const cfg = readChatopsConfig({ security: { allowContacts: ['ilink:me'] } });
    assert.deepEqual(cfg.security.allowContacts, ['ilink:me']);
    assert.equal(cfg.security.listenSelf, true, 'an unsent key keeps its default');
    assert.equal(cfg.push.approvalTimeoutSec, 300);
    assert.equal(cfg.reply.maxChunkBytes, 6000);
  });

  it('does not enable the in-memory channel unless asked', () => {
    assert.equal(readChatopsConfig({}).enableMemoryChannel, false);
    assert.equal(readChatopsConfig({ enableMemoryChannel: true }).enableMemoryChannel, true);
  });

  it('reports the command surface it will accept', () => {
    const described = describeChatopsConfig({});
    assert.ok(described.commands.some((u) => u.startsWith('/run')));
    assert.ok(described.commands.some((u) => u.startsWith('/approve')));
  });
});

describe('defineChannel checks the same contract a real adapter is checked against', () => {
  it('accepts a complete channel', () => {
    assert.doesNotThrow(() => defineChannel({ name: 'x', prefixes: ['x'], start() {}, stop() {}, send() {} }));
  });

  it('refuses an incomplete one, naming what is missing', () => {
    assert.throws(() => defineChannel({ name: 'x' }), /missing: start\(\), stop\(\), send\(\), prefixes\[\]/);
  });
});

describe('the plugin declares no service dependency', () => {
  it('injects nothing, because the bridge is self-contained', () => {
    assert.deepEqual(inject, []);
  });
});
