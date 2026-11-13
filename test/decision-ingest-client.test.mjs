// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — 独立进程的 fork 侧 ingest 客户端：endpoint/token 发现 + 直连 + 失败落 outbox。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createForkIngestClient } from '../src/decision-center/lib/decision-ingest-client.mjs'

function setup() {
  const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ingest-client-'))
  const motherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ingest-mother-'))
  fs.writeFileSync(path.join(motherDir, 'endpoint.json'), JSON.stringify({ url: 'http://mother.test:4321' }), 'utf8')
  fs.writeFileSync(path.join(motherDir, 'fang-auth.json'), JSON.stringify({ token: 'ingest-token-0123456789abcdef' }), 'utf8')
  return { outboxDir, motherDir }
}

test('decision-ingest-client: discovers mother target and submits directly', async () => {
  const { outboxDir, motherDir } = setup()
  const calls = []
  try {
    const client = createForkIngestClient({
      dataDir: outboxDir, motherDataDir: motherDir,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_remote_9' } }) } }
      },
    })
    const target = client.target()
    assert.equal(target.ok, true)
    assert.equal(target.url, 'http://mother.test:4321')
    const result = await client.submit({ producer: 'PJM', kind: 'pjm-timeout', title: 'timeout', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(result.queued, false)
    assert.equal(result.ticket.id, 'dec_remote_9')
    assert.equal(calls[0].url, 'http://mother.test:4321/fang/api/decisions/ingest')
    assert.equal(calls[0].init.headers['x-fang-auth'], 'ingest-token-0123456789abcdef')
    assert.equal(client.pending(), 0)
  } finally {
    fs.rmSync(outboxDir, { recursive: true, force: true })
    fs.rmSync(motherDir, { recursive: true, force: true })
  }
})

test('decision-ingest-client: failed direct submit is queued and flushable', async () => {
  const { outboxDir, motherDir } = setup()
  try {
    let mode = 'fail'
    const client = createForkIngestClient({
      dataDir: outboxDir, motherDataDir: motherDir,
      fetchImpl: async () => {
        if (mode === 'fail') throw new Error('ECONNREFUSED')
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_after_retry' } }) } }
      },
    })
    const queued = await client.submit({ producer: 'Worker', kind: 'worker-deviation', title: 'drift', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(queued.queued, true)
    assert.equal(client.pending(), 1)
    mode = 'ok'
    const flushed = await client.flush()
    assert.equal(flushed.sent, 1)
    assert.equal(client.pending(), 0)
  } finally {
    fs.rmSync(outboxDir, { recursive: true, force: true })
    fs.rmSync(motherDir, { recursive: true, force: true })
  }
})

test('decision-ingest-client: missing dataDir is rejected', () => {
  assert.throws(() => createForkIngestClient({}), /dataDir required/)
})
