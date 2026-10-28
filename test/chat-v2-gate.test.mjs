import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { chatEncV2Supported, resetChatV2Cache } from '../src/plugin/chat-v2-gate.mjs';

const response = (features) => ({ ok: true, json: async () => ({ features }) });

describe('chat-enc-v2 gate', () => {
  beforeEach(() => resetChatV2Cache());
  it('is off by default and when the feature is absent', async () => {
    resetChatV2Cache();
    assert.equal(await chatEncV2Supported({ rabbitUrl: '', fetchImpl: async () => response([]) }), false);
    assert.equal(await chatEncV2Supported({ rabbitUrl: 'http://relay.test', fetchImpl: async () => response(['chat-text-only-v1']) }), false);
  });
  it('turns on only for chat-enc-v2 and caches briefly', async () => {
    resetChatV2Cache();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response(['chat-enc-v2']); };
    assert.equal(await chatEncV2Supported({ rabbitUrl: 'http://relay.test', fetchImpl }), true);
    assert.equal(await chatEncV2Supported({ rabbitUrl: 'http://relay.test', fetchImpl }), true);
    assert.equal(calls, 1);
    resetChatV2Cache();
    assert.equal(await chatEncV2Supported({ rabbitUrl: 'http://relay.test', fetchImpl: async () => { throw new Error('down'); } }), false);
  });
});