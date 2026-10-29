import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chunkFile, createRefV2 } from '../src/agent/transfer/ferry.mjs';
import { listPublishedRefs, publishRef } from '../src/agent/transfer/publish.mjs';

const makeRef = () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-publish-'));
  const file = join(dir, 'a.bin');
  writeFileSync(file, Buffer.from('ferry-publish-test'));
  const chunked = chunkFile(file, { chunkBytes: 16 * 1024 });
  return createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: 'm-1' }).ref;
};

const fakeRelay = () => {
  const decisions = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/projects/default/decisions') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const decision = { id: 'd-' + (decisions.length + 1), title: body.title, kind: body.kind, text: body.text, refs: body.refs };
      decisions.push(decision);
      return { ok: true, status: 200, json: async () => ({ ok: true, decision }) };
    }
    if (String(url).endsWith('/v1/projects/default/decisions')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, decisions }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) };
  };
  return { fetchImpl, decisions, calls };
};

describe('C2 artifact ref publication over the existing relay decision channel', () => {
  it('publishes a ref and lists it back, without sending bytes', async () => {
    const ref = makeRef();
    const { fetchImpl, decisions, calls } = fakeRelay();
    const published = await publishRef({ relayUrl: 'http://relay.test', token: 'op', ref, fetchImpl });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(decisions.length, 1);
    const rawBody = calls[0].init.body;
    assert.equal(rawBody.includes('ferry-publish-test'), false, 'the control plane never carries file bytes');
    assert.match(rawBody, /artifact\.available/);
    const listed = await listPublishedRefs({ relayUrl: 'http://relay.test', token: 'dev', fetchImpl });
    assert.equal(listed.ok, true);
    assert.equal(listed.refs.length, 1);
    assert.deepEqual(listed.refs[0], ref);
  });

  it('refuses a malformed ref, missing credentials and a refused relay', async () => {
    const ref = makeRef();
    assert.equal((await publishRef({ relayUrl: 'http://relay.test', token: 'op', ref: { v: 2 }, fetchImpl: fakeRelay().fetchImpl })).ok, false);
    assert.equal((await publishRef({ relayUrl: 'http://relay.test', token: '', ref, fetchImpl: fakeRelay().fetchImpl })).code, 'OPERATOR_TOKEN_REQUIRED');
    const refused = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'OPERATOR_REQUIRED' } }) });
    const result = await publishRef({ relayUrl: 'http://relay.test', token: 'op', ref, fetchImpl: refused });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RELAY_REFUSED');
    assert.equal((await listPublishedRefs({ relayUrl: '', token: 'x' })).code, 'RELAY_URL_REQUIRED');
  });

  it('ignores decisions that are not artifact_available or whose ref is invalid', async () => {
    const ref = makeRef();
    const decisions = [
      { title: 'artifact.available', kind: 'artifact_available', text: JSON.stringify(ref) },
      { title: 'artifact.available', kind: 'artifact_available', text: '{bad' },
      { title: 'decision', kind: 'decision', text: JSON.stringify(ref) },
    ];
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, decisions }) });
    const listed = await listPublishedRefs({ relayUrl: 'http://relay.test', token: 'dev', fetchImpl });
    assert.equal(listed.refs.length, 1);
    assert.deepEqual(listed.refs[0], ref);
  });
});
