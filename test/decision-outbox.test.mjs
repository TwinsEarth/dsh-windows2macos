// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — decision-outbox：fork → mother 提交/落盘/重放的耐久性。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDecisionOutbox, resolveMotherTarget } from '../src/decision-center/lib/decision-outbox.mjs'

function tmp(prefix = 'fang-outbox-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function motherDir({ url = 'http://127.0.0.1:9999', token = 'test-token-0123456789abcdef' } = {}) {
  const dir = tmp('fang-mother-')
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ url }), 'utf8')
  fs.writeFileSync(path.join(dir, 'fang-auth.json'), JSON.stringify({ token }), 'utf8')
  return dir
}

const payload = {
  producer: 'Worker', kind: 'deviation', dedupeKey: 'worker:1',
  level: 'yellow', title: 'worker drifted', context: 'x',
  options: [{ value: 'retry', label: 'Retry' }],
}

test('decision-outbox: mother target discovery and missing-target fallback', async () => {
  const dir = tmp()
  const mother = motherDir()
  try {
    assert.deepEqual(resolveMotherTarget(mother), { ok: true, url: 'http://127.0.0.1:9999', token: 'test-token-0123456789abcdef' })
    const missing = resolveMotherTarget(path.join(dir, 'no-such-mother'))
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'mother-endpoint-unavailable')

    const outbox = createDecisionOutbox({ dataDir: dir, fetchImpl: async () => { throw new Error('network down') } })
    const result = await outbox.submit(payload, { motherDataDir: path.join(dir, 'no-such-mother') })
    assert.equal(result.ok, true)
    assert.equal(result.queued, true)
    assert.equal(outbox.pending(), 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(mother, { recursive: true, force: true })
  }
})

test('decision-outbox: successful submit is not queued; network failure is queued and later flushed', async () => {
  const dir = tmp()
  const mother = motherDir()
  const calls = []
  try {
    let mode = 'ok'
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      if (mode === 'fail') throw new Error('ECONNREFUSED')
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_remote_1' } }) } }
    }
    const outbox = createDecisionOutbox({ dataDir: dir, fetchImpl })
    const direct = await outbox.submit(payload, { motherDataDir: mother })
    assert.equal(direct.queued, false)
    assert.equal(direct.ticket.id, 'dec_remote_1')
    assert.equal(calls[0].url, 'http://127.0.0.1:9999/fang/api/decisions/ingest')
    assert.equal(calls[0].init.headers['x-fang-auth'], 'test-token-0123456789abcdef')
    assert.equal(outbox.pending(), 0)

    mode = 'fail'
    const queued = await outbox.submit(payload, { motherDataDir: mother })
    assert.equal(queued.queued, true)
    assert.equal(outbox.pending(), 1)

    mode = 'ok'
    const flushed = await outbox.flush({ motherDataDir: mother })
    assert.equal(flushed.ok, true)
    assert.equal(flushed.sent, 1)
    assert.equal(outbox.pending(), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(mother, { recursive: true, force: true })
  }
})

test('decision-outbox: flush keeps failed entries with backoff and does not lose payload', async () => {
  const dir = tmp()
  const mother = motherDir()
  try {
    const outbox = createDecisionOutbox({ dataDir: dir, fetchImpl: async () => ({ ok: false, status: 503, async text() { return 'busy' } }) })
    const queued = await outbox.submit(payload, { motherDataDir: mother })
    assert.equal(queued.queued, true)
    const flushed = await outbox.flush({ motherDataDir: mother })
    assert.equal(flushed.ok, true)
    assert.equal(flushed.failed, 1)
    assert.equal(outbox.pending(), 1)
    const [record] = outbox.list()
    assert.equal(record.attempts, 1)
    assert.ok(record.nextAt > record.createdAt)
    assert.deepEqual(record.payload, payload)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(mother, { recursive: true, force: true })
  }
})
