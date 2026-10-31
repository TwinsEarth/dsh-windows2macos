import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createViewSide, openViewFrame, sealViewFrame } from '../src/agent/view/session-key.mjs';

describe('P1.5 view-session keys', () => {
  it('derives the same key on both sides and seals a frame', () => {
    const viewer = createViewSide();
    const target = createViewSide();
    const viewerKey = viewer.finish(target.public_key).key;
    const targetKey = target.finish(viewer.public_key).key;
    assert.deepEqual(viewerKey, targetKey);
    const plaintext = Buffer.from('jpeg-bytes');
    const sealed = sealViewFrame(viewerKey, plaintext);
    assert.equal(sealed.includes('jpeg-bytes'), false);
    assert.deepEqual(openViewFrame(targetKey, sealed), plaintext);
  });

  it('refuses a tampered ciphertext and a wrong key', () => {
    const viewer = createViewSide();
    const target = createViewSide();
    const key = viewer.finish(target.public_key).key;
    const sealed = sealViewFrame(key, Buffer.from('frame'));
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => openViewFrame(key, raw.toString('base64')));
    assert.throws(() => openViewFrame(Buffer.alloc(32, 1), sealed));
  });
});
