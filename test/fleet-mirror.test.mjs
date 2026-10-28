/**
 * D7/S1: the session-prompt mirror is opt-in.
 *
 * Before this change the route mirrored every local user prompt to the relay every 2 s in plaintext,
 * with no operator consent. The default is now off; an operator may opt into 'plaintext' explicitly,
 * and 'encrypted' is reserved for the AEAD v2 slice.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DEFAULT_MIRROR_MODE, mirrorModeOf, registerChatRoutes } from '../src/plugin/fleet-chat-route.mjs';

const disposers = [];
after(() => { for (const dispose of disposers.splice(0)) dispose(); });

function mount(overrides = {}) {
  const calls = [];
  const routes = [];
  const ctx = {
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    inject: (_names, callback) => callback({ connection: { fetch: { register: (route) => routes.push(route) } } }),
    logger: { warn: () => {}, info: () => {} },
  };
  const deps = {
    cfg: () => ({ rabbitUrl: 'http://relay.test', projectDir: '' }),
    request: async (options) => { calls.push(options); return { ok: true, status: 200, json: {} }; },
    resolveToken: async () => 'device-token',
    localIdentity: async () => ({ machine_id: 'm-1', machine_name: 'm-1' }),
    ...overrides,
  };
  const status = registerChatRoutes(ctx, deps);
  return { status, calls, routes, ctx, deps };
}

describe('session mirror mode', () => {
  it('defaults to off and only accepts explicit plaintext/encrypted', () => {
    assert.equal(DEFAULT_MIRROR_MODE, 'off');
    assert.equal(mirrorModeOf(undefined), 'off');
    assert.equal(mirrorModeOf({}), 'off');
    assert.equal(mirrorModeOf({ fleetChatMirror: 'on' }), 'off');
    assert.equal(mirrorModeOf({ fleetChatMirror: 'plaintext' }), 'plaintext');
    assert.equal(mirrorModeOf({ fleetChatMirror: 'encrypted' }), 'encrypted');
  });

  it('does not post a mirrored prompt when the mode is off (default)', async () => {
    const { status, calls } = mount();
    assert.equal(status.mounted, true);
    await new Promise((resolve) => { setTimeout(resolve, 2300); });
    assert.equal(calls.length, 0, 'the default must not mirror anything to the relay');
  });
});
