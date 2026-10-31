import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createViewClient, createViewTarget, VIEW_CODE, VIEW_FRAME } from '../src/agent/view/frame-channel.mjs';

const fakeCapture = () => ({ ok: true, mime: 'image/jpeg', base64: Buffer.alloc(2048, 3).toString('base64'), bytes: 2048 });

describe('P2P view frame channel', () => {
  it('denies a request by default and never calls capture', () => {
    const sent = [];
    let captured = 0;
    const target = createViewTarget({ capture: () => { captured += 1; return fakeCapture(); }, send: (frame) => sent.push(JSON.parse(frame)) });
    target.handle(JSON.stringify({ type: VIEW_FRAME.REQUEST, session_id: 's1' }));
    assert.equal(captured, 0);
    assert.equal(sent[0].type, VIEW_FRAME.ERROR);
    assert.equal(sent[0].code, VIEW_CODE.CONSENT_REQUIRED);
  });

  it('does a hello handshake and delivers an encrypted frame', () => {
    const targetSent = [];
    const target = createViewTarget({ capture: fakeCapture, allow: true, send: (frame) => targetSent.push(JSON.parse(frame)) });
    const frames = [];
    const clientSent = [];
    const client = createViewClient({ send: (frame) => clientSent.push(JSON.parse(frame)), onFrame: (frame) => frames.push(frame), maxBytes: 96 * 1024 });
    client.request({ machineId: 'm1', session: 's1' });
    assert.equal(clientSent[0].type, VIEW_FRAME.HELLO);
    assert.equal(typeof clientSent[0].public_key, 'string');
    target.handle(clientSent[0]);
    assert.equal(targetSent[0].type, VIEW_FRAME.HELLO_ACK);
    client.accept(targetSent[0]);
    assert.equal(clientSent[1].type, VIEW_FRAME.REQUEST);
    target.handle(clientSent[1]);
    assert.equal(targetSent[1].type, VIEW_FRAME.FRAME);
    assert.equal(targetSent[1].enc, 'aes-256-gcm');
    assert.equal(targetSent[1].data_b64, undefined);
    client.accept(targetSent[1]);
    assert.equal(frames[0].ok, true);
    assert.equal(frames[0].bytes, 2048);
    assert.equal(frames[0].encrypted, true);
  });

  it('refuses input frames and encrypted frames before the handshake', () => {
    const sent = [];
    const target = createViewTarget({ capture: fakeCapture, allow: true, send: (frame) => sent.push(JSON.parse(frame)) });
    target.handle(JSON.stringify({ type: 'mouse.move', session_id: 's1' }));
    assert.equal(sent[0].code, VIEW_CODE.INPUT_FORBIDDEN);
    const frames = [];
    const client = createViewClient({ send: () => {}, onFrame: (frame) => frames.push(frame) });
    client.accept({ type: VIEW_FRAME.FRAME, session_id: null, seq: 1, ct: 'AAAA' });
    assert.equal(frames[0].code, VIEW_CODE.VK_REQUIRED);
  });
});
