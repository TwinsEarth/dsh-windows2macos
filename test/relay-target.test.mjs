import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createViewSide, openViewFrame } from '../src/agent/view/session-key.mjs';
import { startRelayViewTarget } from '../src/agent/view/relay-target.mjs';

describe('target relay view polling', () => {
  it('takes one request, captures, seals and posts ciphertext', async () => {
    const viewer = createViewSide();
    const posts = [];
    let targetSideSeen = null;
    const fetchImpl = async (url, options = {}) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, session_id: 's1', viewer_public_key: viewer.public_key }) };
    };
    const capture = () => ({ ok: true, mime: 'image/jpeg', base64: Buffer.alloc(2048, 5).toString('base64'), bytes: 2048 });
    const runner = startRelayViewTarget({ rabbitUrl: 'http://relay.invalid', token: () => 't', machineId: 'm1', capture, fetchImpl, intervalMs: 20, maxFrames: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.stop();
    assert.equal(posts.length >= 1, true);
    assert.equal(typeof posts[0].ct, 'string');
    assert.equal(posts[0].target, 'm1');
    assert.equal(posts[0].session_id, 's1');
    targetSideSeen = posts[0].public_key;
    const key = viewer.finish(targetSideSeen).key;
    const plaintext = openViewFrame(key, posts[0].ct);
    assert.equal(plaintext.length, 2048);
  });
});
