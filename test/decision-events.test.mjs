// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — decision-events：bus 事件 → SSE 流（ready/ticket/ping、断线清理、帧解析）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createBus } from '../src/decision-center/kernel.mjs'
import { DECISION_EVENT_TOPICS, openDecisionEventStream, parseSseFrames } from '../src/decision-center/lib/decision-events.mjs'

function makeReq() {
  const listeners = new Map()
  return {
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn) },
    removeListener(event, fn) { listeners.get(event)?.delete(fn) },
    emit(event) { for (const fn of listeners.get(event) ?? []) fn() },
    listenerCount(event) { return listeners.get(event)?.size ?? 0 },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}) },
    flushHeaders() {},
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end() { this.ended = true },
    on() {},
    get text() { return this.chunks.join('') },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('decision-events: ready frame, ticket events, heartbeat, and listener cleanup on close', async () => {
  const bus = createBus()
  const req = makeReq()
  const res = makeRes()
  const stream = openDecisionEventStream({
    req, res, bus,
    center: { list: () => ({ rev: 7, counts: { red: 1, yellow: 0 } }) },
    heartbeatMs: 20,
  })
  try {
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    assert.equal(res.headers['x-accel-buffering'], 'no')

    const initial = parseSseFrames(res.text).frames
    assert.equal(initial[0].event, 'ready')
    assert.equal(initial[0].data.rev, 7)
    assert.deepEqual(initial[0].data.counts, { red: 1, yellow: 0 })

    bus.emit('fang/decision-created', { id: 'dec_sse', level: 'red', status: 'pending', rev: 8 })
    bus.emit('fang/decision-updated', { id: 'dec_sse', level: 'red', status: 'pending', rev: 9, ai: { summary: 'x' } })
    const { frames } = parseSseFrames(res.text)
    const tickets = frames.filter((frame) => frame.event === 'ticket')
    assert.equal(tickets.length, 2)
    assert.equal(tickets[0].data.type, 'created')
    assert.equal(tickets[0].data.ticket.id, 'dec_sse')
    assert.equal(tickets[1].data.type, 'updated')
    assert.equal(tickets[1].data.ticket.rev, 9)
    assert.equal(tickets[1].data.rev, 9, 'compact rev for incremental pull')
    assert.deepEqual(tickets[1].data.ids, ['dec_sse'])

    await sleep(40)
    assert.ok(parseSseFrames(res.text).frames.some((frame) => frame.event === 'ping'), 'heartbeat keeps proxies from closing the stream')
    assert.equal(req.listenerCount('close'), 1)
  } finally {
    stream.close()
  }
  assert.equal(res.ended, true)
  assert.equal(bus.listenerCount('fang/decision-created'), 0)
  assert.equal(bus.listenerCount('fang/decision-updated'), 0)
  assert.equal(DECISION_EVENT_TOPICS.length, 2)
})

test('decision-events: request close closes the stream and unsubscribes', () => {
  const bus = createBus()
  const req = createBus ? makeReq() : null
  const res = makeRes()
  const stream = openDecisionEventStream({ req, res, bus, heartbeatMs: 1000 })
  assert.equal(bus.listenerCount('fang/decision-created'), 1)
  req.emit('close')
  assert.equal(stream.closed, true)
  assert.equal(res.ended, true)
  assert.equal(bus.listenerCount('fang/decision-created'), 0)
  // close 幂等
  stream.close()
  assert.equal(stream.closed, true)
})

test('decision-events: parseSseFrames keeps a partial frame for the next chunk', () => {
  const first = 'event: ready\ndata: {"rev":3}\n\nevent: ticket\ndata: {"ticket":{"id":"a"'
  const parsed = parseSseFrames(first)
  assert.equal(parsed.frames.length, 1)
  assert.equal(parsed.frames[0].event, 'ready')
  assert.match(parsed.rest, /event: ticket/)
  const next = parseSseFrames(parsed.rest + '}}\n\nevent: ping\ndata: {"at":1}\n\n')
  assert.equal(next.frames.length, 2)
  assert.equal(next.frames[0].event, 'ticket')
  assert.equal(next.frames[0].data.ticket.id, 'a')
  assert.equal(next.frames[1].event, 'ping')
  assert.equal(next.rest, '')
})

test('decision-events: missing req/res/bus is rejected by name', () => {
  assert.throws(() => openDecisionEventStream({}), /req\/res\/bus required/)
  assert.throws(() => openDecisionEventStream({ req: makeReq(), res: makeRes() }), /req\/res\/bus required/)
})
