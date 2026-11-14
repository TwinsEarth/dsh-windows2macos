// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers/fang-ctx.mjs'
import { SERVICE } from '../src/decision-center/kernel.mjs'
import { apply, Config } from '../src/decision-center/index.mjs'

function boot({ config = {}, services = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-'))
  const ctx = makeCtx({ services })
  const service = apply(ctx, { dataRoot: root, tickMs: 1000, ...config })
  return { ctx, service, root }
}

function drop(ctx, root) {
  try { ctx.dispose() } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

test('decision center: config shape and service contract', () => {
  assert.throws(() => Config({ maxTickets: 1 }))
  const { ctx, service, root } = boot()
  try {
    for (const method of ['create', 'list', 'get', 'resolve', 'abandon', 'wait', 'expire', 'cleanupExpired', 'policy', 'status']) {
      assert.equal(typeof service[method], 'function', method)
    }
    assert.deepEqual(service.policy().levels, ['red', 'yellow', 'blue', 'green', 'gray'])
    assert.deepEqual(service.policy().blockingLevels, ['red'])
  } finally {
    drop(ctx, root)
  }
})

test('decision center: create / list order / resolve / abandon', () => {
  const { ctx, service, root } = boot()
  try {
    const green = service.create({ level: 'green', title: 'done', context: 'report' })
    const blue = service.create({
      level: 'blue', title: 'optimize', context: 'could be faster',
      options: [{ value: 'yes', label: 'do it', isRecommended: true }, { value: 'no', label: 'later' }],
    })
    assert.equal(green.ok, true)
    assert.equal(blue.ok, true)
    assert.deepEqual(service.list().items.map(item => item.level), ['blue', 'green'])
    assert.equal(service.list().counts.blue, 1)

    const resolved = service.resolve(blue.ticket.id, 'yes', { by: 'tester', note: 'go' })
    assert.equal(resolved.ok, true)
    assert.equal(service.get(blue.ticket.id).status, 'resolved')
    assert.equal(service.get(blue.ticket.id).resolvedBy, 'tester')
    assert.equal(service.resolve(blue.ticket.id, 'no').reason, 'not-pending')

    const abandoned = service.abandon(green.ticket.id, { by: 'tester' })
    assert.equal(abandoned.ok, true)
    assert.equal(service.get(green.ticket.id).level, 'gray')
    assert.equal(service.get(green.ticket.id).status, 'abandoned')
    assert.equal(service.resolve(green.ticket.id, 'x').reason, 'not-pending')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: red wait resolves with the chosen option', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'red', title: 'blocked', context: 'need a human',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    })
    const pending = service.wait(created.ticket.id)
    assert.equal(service.list().items[0].isBlocking, true)
    service.resolve(created.ticket.id, 'b', { by: 'human' })
    const result = await pending
    assert.equal(result.outcome, 'resolved')
    assert.equal(result.resolvedOption, 'b')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: expiry turns pending tickets gray and wakes waiters', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'red', title: 'late', context: 'x', expiresAt: Date.now() - 1,
      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    })
    const pending = service.wait(created.ticket.id)
    assert.equal(service.cleanupExpired(), 1)
    const expired = await pending
    assert.equal(expired.outcome, 'expired')
    assert.equal(expired.level, 'gray')
    const item = service.get(created.ticket.id)
    assert.equal(item.level, 'gray')
    assert.equal(item.status, 'expired')
    assert.equal(item.outcome, 'expired')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: persisted pending tickets restore as gray, never blocking', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-restore-'))
  let ctx = makeCtx()
  try {
    const first = apply(ctx, { dataRoot: root })
    first.create({
      level: 'red', title: 'stale', context: 'x',
      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    })
    const file = path.join(root, 'decision-center.json')
    assert.ok(fs.existsSync(file))
    ctx.dispose()
    ctx = makeCtx()
    const restored = apply(ctx, { dataRoot: root })
    const item = restored.list({ includeArchived: true }).items[0]
    assert.equal(item.status, 'expired')
    assert.equal(item.level, 'gray')
    assert.equal(item.outcome, 'expired')
    assert.equal(item.resolvedOption, null)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('decision center: registers request_human_decision and non-blocking tool returns immediately', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, service, root } = boot({ services: { tools } })
  try {
    assert.equal(registered.length, 2)
    assert.deepEqual(registered.map((item) => item.name), ['request_human_decision', 'ask_user_choice'])
    const tool = registered[0]
    assert.equal(tool.name, 'request_human_decision')
    assert.equal(typeof tool.output.render, 'function')
    const result = await tool.execute(
      { level: 'green', title: 'build done', context: 'all tests pass' },
      { agent: { id: 'session-green' } },
    )
    assert.equal(result.blocking, false)
    assert.equal(result.level, 'green')
    const item = service.list().items[0]
    assert.equal(item.source.sessionId, 'session-green')
    assert.equal(item.status, 'pending')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: dedupeKey keeps external retries idempotent; ingest marks the producer untrusted', () => {
  const { ctx, service, root } = boot()
  try {
    const spec = {
      producer: 'HarnessMM', kind: 'gdr-conflict', dedupeKey: 'harnessmm:gdr:42',
      level: 'yellow', title: 'GDR conflict', context: 'two rules disagree',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      sourceRole: 'pm',
    }
    const first = service.ingest(spec)
    assert.equal(first.ok, true)
    assert.equal(first.ticket.external.producer, 'HarnessMM')
    assert.equal(first.ticket.external.kind, 'gdr-conflict')
    assert.equal(first.ticket.source.agentRole, 'pm', 'role is display-only for external tickets')
    assert.equal(first.ticket.source.roleTrusted, false)
    assert.match(first.ticket.source.roleSource, /^external:HarnessMM/)

    const retry = service.ingest(spec)
    assert.equal(retry.ok, true)
    assert.equal(retry.deduped, true)
    assert.equal(retry.ticket.id, first.ticket.id, 'retry must not create a second ticket')

    service.resolve(first.ticket.id, 'a')
    const next = service.ingest(spec)
    assert.equal(next.ok, true)
    assert.equal(next.deduped, true, 'replay after resolution must stay idempotent, not create a new ticket')
    assert.equal(next.ticket.id, first.ticket.id)
    assert.equal(next.ticket.status, 'resolved')

    const unknownRole = service.ingest({
      producer: 'SuperAgent', level: 'blue', title: 'fallback role', context: 'x',
      options: [{ value: 'a', label: 'A' }], sourceRole: 'root',
    })
    assert.equal(unknownRole.ticket.source.agentRole, 'worker', 'role whitelist rejects unknown roles')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: batch abandon archives non-red pending tickets and reports per-item failures', () => {
  const { ctx, service, root } = boot()
  try {
    const yellow = service.create({ level: 'yellow', title: 'y', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const blue = service.create({ level: 'blue', title: 'b', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const red = service.create({ level: 'red', title: 'r', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const out = service.abandonMany([yellow.ticket.id, blue.ticket.id, red.ticket.id, 'dec_missing'], { by: 'tester' })
    assert.equal(out.ok, false, 'partial failure must not claim全成功')
    const byId = Object.fromEntries(out.results.map((item) => [item.id, item]))
    assert.equal(byId[yellow.ticket.id].ok, true)
    assert.equal(byId[blue.ticket.id].ok, true)
    assert.equal(byId[red.ticket.id].reason, 'explicit-choice-required', 'red needs an explicit human choice')
    assert.equal(byId.dec_missing.reason, 'not-found')
    assert.equal(service.get(yellow.ticket.id).status, 'abandoned')
    assert.equal(service.get(blue.ticket.id).status, 'abandoned')
    assert.equal(service.get(red.ticket.id).status, 'pending')
    assert.equal(service.get(red.ticket.id).level, 'red')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: ask_user_choice creates a blocking red ticket and returns the selected value', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, service, root } = boot({ services: { tools } })
  try {
    const tool = registered.find((item) => item.name === 'ask_user_choice')
    assert.ok(tool, 'ask_user_choice must be registered')
    const pending = tool.execute({
      question: 'Deploy v2?',
      context: 'PM asks for a human choice',
      choices: [{ value: 'yes', label: 'Deploy' }, { value: 'no', label: 'Hold' }],
      level: 'yellow', // 即使调用方给黄，也必须自动转红
    }, { agent: { id: 'pm-session', role: 'pm' } })
    const [ticket] = service.list().items
    assert.equal(ticket.level, 'red', 'interactive choice defaults to red')
    assert.equal(ticket.isBlocking, true)
    assert.equal(ticket.source.agentRole, 'pm')
    assert.equal(ticket.source.roleTrusted, true)
    service.resolve(ticket.id, 'yes')
    const result = await pending
    assert.equal(result.blocking, true)
    assert.equal(result.outcome, 'resolved')
    assert.equal(result.selectedValue, 'yes')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: host role binding wins; caller sourceRole is untrusted fallback only', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, service, root } = boot({ services: { tools } })
  try {
    const tool = registered[0]
    // 1) 宿主绑定 pm；模型同时自报 worker → 宿主赢，自报只留展示标签
    await tool.execute(
      { level: 'green', title: 'host-bound', context: 'x', sourceRole: 'worker' },
      { agent: { id: 's-host', role: 'pm' } },
    )
    // 2) 宿主没有绑定角色；自报 pjm → 降级使用，标记 caller-reported / untrusted
    await tool.execute(
      { level: 'green', title: 'caller-fallback', context: 'x', sourceRole: 'pjm' },
      { agent: { id: 's-caller' } },
    )
    // 3) 模型伪造 args.source.agentRole / 非法 sourceRole → 一律忽略
    await tool.execute(
      {
        level: 'green', title: 'hostile-source', context: 'x',
        source: { agentRole: 'system' }, sourceRole: 'nope',
      },
      { agent: { id: 's-hostile', role: 'worker' } },
    )

    const items = service.list({ includeArchived: true }).items
    const find = (title) => items.find((item) => item.title === title)

    const hostBound = find('host-bound')
    assert.equal(hostBound.source.agentRole, 'pm', 'host role must win')
    assert.equal(hostBound.source.roleSource, 'host:agent.role')
    assert.equal(hostBound.source.roleTrusted, true)
    assert.equal(hostBound.source.reportedRole, 'worker', 'self-report is kept as a label, not used')

    const callerFallback = find('caller-fallback')
    assert.equal(callerFallback.source.agentRole, 'pjm')
    assert.equal(callerFallback.source.roleSource, 'caller-reported')
    assert.equal(callerFallback.source.roleTrusted, false)

    const hostile = find('hostile-source')
    assert.equal(hostile.source.agentRole, 'worker', 'args.source.agentRole must be ignored')
    assert.equal(hostile.source.roleSource, 'host:agent.role')
    assert.equal(hostile.source.reportedRole, undefined, 'invalid sourceRole must not be recorded')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: red tool blocks until resolve', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, service, root } = boot({ services: { tools } })
  try {
    const tool = registered[0]
    const promise = tool.execute(
      {
        level: 'red', title: 'choose', context: 'blocked',
        options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      },
      { agent: { id: 'session-red' } },
    )
    const [ticket] = service.list().items
    service.resolve(ticket.id, 'yes', { by: 'human' })
    const result = await promise
    assert.equal(result.selectedValue, 'yes')
    assert.equal(result.blocking, true)
    assert.equal(result.outcome, 'resolved')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: abandon wakes a blocking waiter with outcome abandoned, never selected', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'red', title: 'abandon me', context: 'x',
      options: [{ value: 'a', label: 'A' }],
    })
    const pending = service.wait(created.ticket.id)
    service.abandon(created.ticket.id, { by: 'human' })
    const result = await pending
    assert.equal(result.outcome, 'abandoned')
    assert.equal(result.status, 'abandoned')
    assert.equal(result.resolvedOption, null)
    assert.equal(result.selectedActionId, null)

    const registered = []
    const tools = { register(definition) { registered.push(definition); return () => {} } }
    const second = boot({ services: { tools } })
    try {
      const tool = registered[0]
      const blocked = tool.execute({ level: 'red', title: 'x', context: 'y', options: [{ value: 'a', label: 'A' }] }, { agent: { id: 's' } })
      const [ticket] = second.service.list().items
      second.service.abandon(ticket.id)
      await assert.rejects(blocked, /outcome=abandoned/)
    } finally {
      drop(second.ctx, second.root)
    }
  } finally {
    drop(ctx, root)
  }
})

test('decision center: every concurrent waiter is settled', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'red', title: 'two waiters', context: 'x',
      options: [{ value: 'a', label: 'A' }],
    })
    const first = service.wait(created.ticket.id)
    const second = service.wait(created.ticket.id)
    service.resolve(created.ticket.id, 'a')
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.outcome, 'resolved')
    assert.equal(b.outcome, 'resolved')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: prune never evicts a ticket with a live waiter', async () => {
  const { ctx, service, root } = boot({ config: { maxTickets: 10 } })
  try {
    const ticket = service.create({
      level: 'red', title: 'blocked', context: 'x',
      options: [{ value: 'a', label: 'A' }],
    })
    const pending = service.wait(ticket.ticket.id)
    for (let i = 0; i < 30; i += 1) {
      service.create({ level: 'green', title: `noise ${i}`, context: 'x' })
    }
    assert.ok(service.get(ticket.ticket.id), 'waited ticket must not be pruned')
    service.resolve(ticket.ticket.id, 'a')
    assert.equal((await pending).outcome, 'resolved')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: submit maps design actions/payload; only red may block', () => {
  const { ctx, service, root } = boot()
  try {
    const submitted = service.submit({
      id: 'dec-mirror',
      level: 'yellow',
      title: 'upgrade',
      description: 'new version',
      source: 'MirrorManager',
      actions: [
        { id: 'upgrade', label: 'Upgrade', type: 'primary', payload: { version: '3.1.0' } },
        { id: 'later', label: 'Later', type: 'default' },
      ],
    })
    assert.equal(submitted.ok, true)
    assert.equal(submitted.ticket.isBlocking, false, 'yellow does not block')
    const optedIn = service.submit({
      level: 'yellow', title: 'explicit blocking', description: 'x',
      isBlocking: true, actions: [{ id: 'yes', label: 'Yes', type: 'primary' }],
    })
    assert.equal(optedIn.ticket.isBlocking, false, 'non-red isBlocking is ignored: only red may block')
    assert.equal(submitted.ticket.options[0].id, 'upgrade')
    const resolved = service.resolve(submitted.ticket.id, 'upgrade', { by: 'human' })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ticket.selectedActionId, 'upgrade')
    assert.deepEqual(resolved.ticket.resolvedPayload, { version: '3.1.0' })
    assert.equal(resolved.ticket.outcome, 'resolved')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: batch resolve follows recommendations and acks green tickets', () => {
  const { ctx, service, root } = boot()
  try {
    const blue = service.create({
      level: 'blue', title: 'optimize', context: 'x',
      options: [{ value: 'yes', label: 'Yes', isRecommended: true }, { value: 'no', label: 'No' }],
    })
    const green = service.create({ level: 'green', title: 'done', context: 'x' })
    const out = service.resolveMany([blue.ticket.id, green.ticket.id], { by: 'batch' })
    assert.equal(out.ok, true)
    assert.equal(out.results.length, 2)
    assert.equal(service.get(blue.ticket.id).outcome, 'resolved')
    assert.equal(service.get(blue.ticket.id).resolvedOption, 'yes')
    assert.equal(service.get(green.ticket.id).outcome, 'acked')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: batch never auto-resolves red or blocking tickets', () => {
  const { ctx, service, root } = boot()
  try {
    const red = service.create({
      level: 'red', title: 'must choose', context: 'x',
      options: [{ value: 'ship', label: 'Ship', isRecommended: true }],
    })
    const green = service.create({ level: 'green', title: 'done', context: 'x' })
    const out = service.resolveMany([red.ticket.id, green.ticket.id], { by: 'batch' })
    assert.equal(out.ok, false)
    assert.equal(service.get(red.ticket.id).status, 'pending')
    assert.equal(service.get(red.ticket.id).isBlocking, true)
    assert.equal(service.get(green.ticket.id).outcome, 'acked')
    assert.equal(out.results.find((entry) => entry.id === red.ticket.id).reason, 'explicit-choice-required')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: aborting the last waiter abandons the ticket instead of faking a block', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'red', title: 'abort me', context: 'x',
      options: [{ value: 'a', label: 'A' }],
    })
    const controller = new AbortController()
    const pending = service.wait(created.ticket.id, controller.signal)
    controller.abort()
    await assert.rejects(pending, /aborted/)
    const item = service.get(created.ticket.id)
    assert.equal(item.status, 'abandoned')
    assert.equal(item.outcome, 'abandoned')
    assert.equal(item.isBlocking, false)
    assert.equal(item.resolutionNote, 'caller-aborted')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: prune preserves an un-waited pending red over green noise', () => {
  const { ctx, service, root } = boot({ config: { maxTickets: 10 } })
  try {
    const red = service.create({
      level: 'red', title: 'keep me', context: 'x',
      options: [{ value: 'a', label: 'A' }],
    })
    for (let i = 0; i < 30; i += 1) {
      service.create({ level: 'green', title: `noise ${i}`, context: 'x' })
    }
    assert.ok(service.get(red.ticket.id), 'pending red must not be pruned by green noise')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: a blocking red ticket always has a finite expiry', () => {
  const { ctx, service, root } = boot({ config: { defaultTimeoutMinutes: 360 } })
  try {
    const created = service.create({
      level: 'red', title: 'no expiry request', context: 'x', timeoutMinutes: 0,
      options: [{ value: 'a', label: 'A' }],
    })
    assert.equal(created.ok, true)
    assert.ok(created.ticket.expiresAt)
    assert.ok(created.ticket.expiresAt > Date.now())
    assert.equal(created.ticket.isBlocking, true)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: content alias and resolveAction(id, actionId, payload) match the design API', () => {
  const { ctx, service, root } = boot()
  try {
    const submitted = service.submit({
      id: 'dec-api',
      level: 'yellow',
      title: 'API shape',
      content: 'content used as description',
      source: 'PM Agent',
      actions: [{ id: 'confirm_restart', label: 'Restart', type: 'primary', payload: { version: '3.3.0' } }],
    })
    assert.equal(submitted.ok, true)
    assert.equal(submitted.ticket.context, 'content used as description')
    assert.equal(submitted.ticket.source.agentRole, 'pm')
    const out = service.resolveAction(submitted.ticket.id, 'confirm_restart', { version: '3.3.0' }, { by: 'human' })
    assert.equal(out.ok, true)
    assert.equal(out.ticket.selectedActionId, 'confirm_restart')
    assert.deepEqual(out.ticket.resolvedPayload, { version: '3.3.0' })
  } finally {
    drop(ctx, root)
  }
})

test('decision center: since cursor returns deltas and advances rev', () => {
  const { ctx, service, root } = boot()
  try {
    const first = service.create({ level: 'green', title: 'first', context: 'x' })
    const initial = service.list({ includeArchived: true })
    assert.ok(initial.rev >= 1)
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const delta = service.list({ includeArchived: true, since: initial.rev })
    assert.deepEqual(delta.items.map((item) => item.id), [second.ticket.id])
    assert.ok(delta.rev > initial.rev)
    service.resolve(second.ticket.id, 'a')
    const afterResolve = service.list({ includeArchived: true, since: delta.rev })
    assert.equal(afterResolve.items[0].status, 'resolved')
    assert.equal(afterResolve.rev > delta.rev, true)
    assert.ok(service.get(first.ticket.id))
  } finally {
    drop(ctx, root)
  }
})

test('decision center: no-option tickets accept only the explicit ack sentinel', () => {
  const { ctx, service, root } = boot()
  try {
    const green = service.create({ level: 'green', title: 'ack only', context: 'x' })
    assert.equal(service.resolve(green.ticket.id, 'anything').reason, 'unknown-option')
    assert.equal(service.get(green.ticket.id).status, 'pending')
    const acked = service.resolve(green.ticket.id, '__ACK__')
    assert.equal(acked.ok, true)
    assert.equal(acked.ticket.outcome, 'acked')
    assert.equal(acked.ticket.resolvedOption, null)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: corrupt store starts empty and can be rebuilt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-corrupt-'))
  fs.writeFileSync(path.join(root, 'decision-center.json'), '{not json', 'utf8')
  const ctx = makeCtx()
  try {
    const service = apply(ctx, { dataRoot: root })
    assert.deepEqual(service.list({ includeArchived: true }).items, [])
    const created = service.create({ level: 'green', title: 'after corrupt', context: 'x' })
    assert.equal(created.ok, true)
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'decision-center.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.tickets.length, 1)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('decision center: AI config stays out of status and advise enriches the ticket', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: '{"summary":"建议重启","recommendation":"restart","rationale":"版本不一致","confidence":0.8}' } }] })
      },
    }
  }
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    assert.equal(service.configureAi({ provider: 'deepseek', apiKey: 'short' }).reason, 'api-key-required')
    const configured = service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    assert.equal(configured.ok, true)
    assert.equal(configured.configured, true)
    assert.equal(configured.provider, 'deepseek')
    assert.equal(JSON.stringify(service.aiStatus()).includes('test-key-0123456789'), false, 'API key must not appear in status')
    const ticket = service.create({
      level: 'red', title: 'restart?', context: 'need restart',
      options: [{ value: 'restart', label: 'Restart' }],
    })
    const advised = await service.advise(ticket.ticket.id)
    assert.equal(advised.ok, true)
    assert.equal(advised.advice.recommendation, 'restart')
    assert.equal(service.get(ticket.ticket.id).ai.summary, '建议重启')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /chat\/completions$/)
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key-0123456789')
    assert.equal(calls[0].init.redirect, 'error', 'AI fetch must refuse redirects (no third-party exfiltration)')
    assert.equal(JSON.stringify(calls[0].init.body).includes('test-key-0123456789'), false)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: modelByLevel routes the model by ticket level', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return {
      ok: true, status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: '{"summary":"分级模型建议","recommendation":"a","rationale":"r","confidence":0.8}' } }] })
      },
    }
  }
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    const configured = service.configureAi({
      provider: 'deepseek', apiKey: 'test-key-0123456789', model: 'base-model',
      modelByLevel: { red: 'reasoner-x', yellow: 'fast-y', bogus: 'ignore-me' },
    })
    assert.equal(configured.ok, true)
    assert.deepEqual(service.aiStatus().modelByLevel, { red: 'reasoner-x', yellow: 'fast-y' })

    const red = service.create({ level: 'red', title: 'red route', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(red.ticket.id)
    assert.equal(bodies[0].model, 'reasoner-x')
    assert.equal(service.get(red.ticket.id).ai.model, 'reasoner-x')

    const blue = service.create({ level: 'blue', title: 'blue fallback', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(blue.ticket.id)
    assert.equal(bodies[1].model, 'base-model')
    assert.equal(service.get(blue.ticket.id).ai.model, 'base-model')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI private-host allowlist gates http endpoints', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false, aiPrivateHosts: ['192.168.1.10', 'ollama.lan', '*.bad', 'http://x', 'host:8080'] } })
  try {
    assert.deepEqual(service.aiStatus().privateHosts, ['192.168.1.10', 'ollama.lan'])
    const lan = service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'http://192.168.1.10:11434/v1', model: 'llama' })
    assert.equal(lan.ok, true)
    const named = service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'http://ollama.lan:11434/v1', model: 'llama' })
    assert.equal(named.ok, true)
    const publicHttp = service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'http://evil.example.com/v1', model: 'm' })
    assert.equal(publicHttp.reason, 'https-required-for-remote-endpoint')
    const publicHttps = service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'https://evil.example.com/v1', model: 'm' })
    assert.equal(publicHttps.ok, true)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: AI SSRF guard blocks metadata even when allowlisted', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false, aiPrivateHosts: ['10.0.0.5', '169.254.169.254'] } })
  try {
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'https://169.254.169.254/latest', model: 'm' }).reason, 'metadata-address-blocked')
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'https://10.0.0.5/v1', model: 'm' }).ok, true)
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'http://10.0.0.5/v1', model: 'm' }).ok, true, 'allowlisted private host may use http')
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'https://192.168.1.1/v1', model: 'm' }).reason, 'private-address-blocked')
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'key-0123456789', baseUrl: 'http://10.0.0.6/v1', model: 'm' }).reason, 'private-address-blocked')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: multi-provider profiles route by level', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"multi","recommendation":"a","rationale":"r","confidence":0.8}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    const configured = service.configureAi({
      profiles: [
        { id: 'fast', provider: 'deepseek', apiKey: 'key-fast-0123456789', model: 'fast-model' },
        { id: 'strong', provider: 'custom', apiKey: 'key-strong-0123456789', baseUrl: 'https://strong.example.com/v1', model: 'strong-model' },
      ],
      routes: { red: 'strong', yellow: 'fast' },
    })
    assert.equal(configured.ok, true)
    const status = service.aiStatus()
    assert.deepEqual(status.routes, { red: 'strong', yellow: 'fast' })
    assert.deepEqual(status.profiles.map((item) => [item.id, item.model]), [['fast', 'fast-model'], ['strong', 'strong-model']])
    assert.equal(JSON.stringify(status).includes('key-fast-0123456789'), false)
    assert.equal(JSON.stringify(status).includes('key-strong-0123456789'), false)

    const red = service.create({ level: 'red', title: 'red strong', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(red.ticket.id)
    assert.match(calls[0].url, /strong\.example\.com/)
    assert.equal(calls[0].body.model, 'strong-model')
    assert.equal(calls[0].init.headers.authorization, 'Bearer key-strong-0123456789')

    const yellow = service.create({ level: 'yellow', title: 'yellow fast', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(yellow.ticket.id)
    assert.match(calls[1].url, /api\.deepseek\.com/)
    assert.equal(calls[1].body.model, 'fast-model')
    assert.equal(calls[1].init.headers.authorization, 'Bearer key-fast-0123456789')
    assert.equal(service.get(yellow.ticket.id).ai.model, 'fast-model')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: multi-provider routing rejects bad ids and unknown routes', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    assert.equal(service.configureAi({ profiles: [{ id: 'bad id', provider: 'deepseek', apiKey: 'key-0123456789', model: 'm' }] }).reason, 'invalid-profile-id')
    assert.equal(service.configureAi({ profiles: [
      { id: 'a', provider: 'deepseek', apiKey: 'key-0123456789', model: 'm' },
      { id: 'a', provider: 'deepseek', apiKey: 'key-0123456789', model: 'm' },
    ] }).reason, 'duplicate-profile-id')
    assert.equal(service.configureAi({ profiles: [
      { id: 'a', provider: 'deepseek', apiKey: 'key-0123456789', model: 'm' },
    ], routes: { red: 'missing' } }).reason, 'unknown-profile')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: auto-advise wires new tickets when AI is configured', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"自动建议","recommendation":"restart","rationale":"版本旧","confidence":0.7}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    assert.equal(service.aiStatus().autoAdvise, true)
    const created = service.create({
      level: 'red', title: 'auto advise', context: 'x',
      options: [{ value: 'restart', label: 'Restart' }],
    })
    assert.equal(created.ok, true)
    const advised = await waitFor(() => service.get(created.ticket.id).ai)
    assert.equal(advised.summary, '自动建议')
    assert.equal(advised.recommendation, 'restart')
    assert.equal(calls.length, 1)
    // 建议不改变 ticket 状态，也不自动替人做决定
    assert.equal(service.get(created.ticket.id).status, 'pending')
    await waitFor(() => service.aiStatus().queue === 0 && service.aiStatus().active === 0)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: auto-advise backfills pending tickets after AI is configured', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"backfill","recommendation":"ack","rationale":"ok","confidence":0.6}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    const first = service.create({ level: 'yellow', title: 'before configure', context: 'x', options: [{ value: 'ack', label: 'Ack' }] })
    assert.equal(service.get(first.ticket.id).ai, null)
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const advised = await waitFor(() => service.get(first.ticket.id).ai)
    assert.equal(advised.summary, 'backfill')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: autoAdvise=false keeps advice manual', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"x","recommendation":"ack"}' } }] }) } }
  }
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const created = service.create({ level: 'yellow', title: 'manual only', context: 'x', options: [{ value: 'ack', label: 'Ack' }] })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(service.get(created.ticket.id).ai, null)
    assert.equal(calls, 0)
    assert.equal(service.aiStatus().autoAdvise, false)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI auto-wiring from env (memory only, source=env)', () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected network call') }
  const saved = {}
  for (const key of ['FANG_AI_API_KEY', 'FANG_AI_PROVIDER', 'FANG_AI_MODEL', 'FANG_AI_BASE_URL']) saved[key] = process.env[key]
  process.env.FANG_AI_API_KEY = 'env-key-0123456789abcdef'
  process.env.FANG_AI_PROVIDER = 'deepseek'
  delete process.env.FANG_AI_MODEL
  delete process.env.FANG_AI_BASE_URL
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    const status = service.aiStatus()
    assert.equal(status.configured, true)
    assert.equal(status.provider, 'deepseek')
    assert.equal(status.source, 'env')
    assert.equal(JSON.stringify(status).includes('env-key-0123456789abcdef'), false, 'env key must not leak into status')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI response body cap rejects oversize Content-Length before reading', async () => {
  const originalFetch = globalThis.fetch
  let readCalled = false
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-length' ? '999999' : null },
    get body() { return { getReader() { readCalled = true; throw new Error('body must not be read') } } },
    async text() { readCalled = true; throw new Error('text must not be read') },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    const out = await service.testAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ai-response-too-large')
    assert.equal(readCalled, false, 'oversize declared body must be rejected without reading')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI response body cap cancels the stream at 64KB', async () => {
  const originalFetch = globalThis.fetch
  let canceled = false
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        let done = false
        return {
          async read() {
            if (done) return { done: true, value: undefined }
            done = true
            return { done: false, value: new Uint8Array(100 * 1024).fill(65) } // 100KB > 64KB cap
          },
          async cancel() { canceled = true },
        }
      },
    },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    const out = await service.testAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    // HTTP 200 + 截断文本：连接测试仍算成功，但 reader 必须在 64KB 处被 cancel。
    assert.equal(out.ok, true)
    assert.equal(canceled, true)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI endpoint validation rejects insecure/custom unsafe URLs', () => {
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'test-key-0123456789', baseUrl: 'http://evil.example.com', model: 'm' }).reason, 'https-required-for-remote-endpoint')
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'test-key-0123456789', baseUrl: 'https://user:pass@example.com', model: 'm' }).reason, 'base-url-userinfo-forbidden')
    assert.equal(service.configureAi({ provider: 'custom', apiKey: 'test-key-0123456789', baseUrl: 'http://127.0.0.1:9999', model: 'm' }).ok, true)
    const status = service.aiStatus()
    assert.equal(status.endpointHost, '127.0.0.1')
    assert.equal(status.source, 'memory')
    assert.equal(JSON.stringify(status).includes('test-key-0123456789'), false)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: AI advisor does not advise system tickets and rejects unknown recommendations', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"x","recommendation":"not-an-option","rationale":"y","confidence":0.5}' } }] }) },
  })
  const { ctx, service, root } = boot({ config: { autoAdvise: false, persistAiKey: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const systemTicket = service.create({ level: 'yellow', title: 'system', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's', agentRole: 'system' } })
    assert.equal((await service.advise(systemTicket.ticket.id)).reason, 'system-ticket-not-advised')
    const ticket = service.create({ level: 'red', title: 'choose', context: 'x', options: [{ value: 'restart', label: 'Restart' }] })
    const out = await service.advise(ticket.ticket.id)
    assert.equal(out.ok, true)
    assert.equal(out.advice.recommendation, null)
    assert.equal(out.advice.invalidRecommendation, true)
    assert.equal(out.advice.trust, 'unverified')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI test connection validates without saving and reports latency', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false } })
  try {
    const out = await service.testAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    assert.equal(out.ok, true)
    assert.equal(out.provider, 'deepseek')
    assert.ok(Number.isFinite(out.latencyMs) && out.latencyMs >= 0)
    assert.equal(calls, 1)
    assert.equal(service.aiStatus().configured, false, 'test connection must not save/enable the config')

    const bad = await service.testAi({
      provider: 'custom', apiKey: 'test-key-0123456789', baseUrl: 'http://evil.example.com', model: 'm',
    })
    assert.equal(bad.reason, 'https-required-for-remote-endpoint')
    assert.equal(calls, 1, 'invalid candidate must not hit the network')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: daily AI quota stops further calls before network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"ok","recommendation":"a"}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, aiDailyQuota: 1, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const ok = await service.advise(first.ticket.id)
    assert.equal(ok.ok, true)
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const blocked = await service.advise(second.ticket.id)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'ai-daily-quota-exceeded')
    assert.equal(calls, 1, 'quota check must run before fetch')
    assert.deepEqual(service.aiStatus().quota, { day: service.aiStatus().quota.day, limit: 1, used: 1, remaining: 0 })
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: 429 honors Retry-After and opens circuit', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: false, status: 429,
      headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? '2' : null },
      async text() { return '' },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const limited = await service.advise(first.ticket.id)
    assert.equal(limited.ok, false)
    assert.equal(limited.reason, 'ai-rate-limited')
    assert.equal(limited.retryAfterMs, 2000)
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const blocked = await service.advise(second.ticket.id)
    assert.equal(blocked.reason, 'ai-circuit-open')
    assert.ok(blocked.retryAfterMs > 0)
    assert.equal(calls, 1, 'open circuit must not hit the network')
    assert.equal(service.aiStatus().circuit.state, 'open')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: consecutive failures open the circuit after the threshold', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('network down') }
  const { ctx, service, root } = boot({
    config: { persistAiKey: false, autoAdvise: false, aiFailureThreshold: 2, aiCircuitCooldownMs: 60000 },
  })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal((await service.advise(first.ticket.id)).reason, 'ai-failed')
    assert.equal((await service.advise(second.ticket.id)).reason, 'ai-failed')
    const third = service.create({ level: 'yellow', title: 'third', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const blocked = await service.advise(third.ticket.id)
    assert.equal(blocked.reason, 'ai-circuit-open')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI advice schema v2 records option risk, missing info, token usage and cost', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: '建议先备份再重启',
          recommendation: 'restart',
          rationale: '版本不一致',
          confidence: 0.81,
          optionRisks: [
            { value: 'restart', risk: 'high', reason: '会中断会话' },
            { value: 'skip', risk: 'low', reason: '暂时可用' },
            { value: 'not-an-option', risk: 'high', reason: '应被丢弃' },
            { value: 'restart', risk: 'unknown', reason: '无效风险级别' },
          ],
          missingInfo: ['当前在线人数', '备份是否完成'],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
    },
  })
  const { ctx, service, root } = boot({
    config: {
      persistAiKey: false, autoAdvise: false,
      aiCostInputPerMillion: 1, aiCostOutputPerMillion: 2,
    },
  })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({
      level: 'red', title: 'restart?', context: 'x',
      options: [{ value: 'restart', label: 'Restart' }, { value: 'skip', label: 'Skip' }],
    })
    const out = await service.advise(ticket.ticket.id)
    assert.equal(out.ok, true)
    const advice = out.advice
    assert.equal(advice.schemaVersion, 2)
    assert.deepEqual(advice.optionRisks, [
      { value: 'restart', risk: 'high', reason: '会中断会话' },
      { value: 'skip', risk: 'low', reason: '暂时可用' },
    ])
    assert.deepEqual(advice.missingInfo, ['当前在线人数', '备份是否完成'])
    assert.deepEqual(advice.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 })
    assert.equal(advice.costMicros, 200, '100*$1 + 50*$2 per 1M => 200 microUSD')
    assert.deepEqual(service.aiStatus().usage, { promptTokens: 100, completionTokens: 50, costMicros: 200 })
    assert.deepEqual(service.get(ticket.ticket.id).ai.optionRisks, advice.optionRisks)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI prompt redacts sk-*/Bearer/AKIA before sending', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"x","recommendation":"a"}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({
      level: 'yellow',
      title: 'sk-ABCDEFGH12345678 leaked in title',
      context: 'Authorization: Bearer abcdefgh12345678 and AKIAABCDEFGHIJKLMNOP',
      options: [{ value: 'a', label: 'A' }],
      source: { sessionId: 'sk-SESSIONSECRET99', agentRole: 'worker', taskName: 'worker' },
    })
    assert.equal((await service.advise(ticket.ticket.id)).ok, true)
    const sent = String(calls[0].init.body)
    for (const raw of ['sk-ABCDEFGH12345678', 'abcdefgh12345678', 'AKIAABCDEFGHIJKLMNOP', 'sk-SESSIONSECRET99']) {
      assert.equal(sent.includes(raw), false, `prompt must not contain raw secret: ${raw}`)
    }
    assert.match(sent, /sk-\*\*\*/)
    assert.match(sent, /Bearer \*\*\*/)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI HTTP error body is never echoed back', async () => {
  const originalFetch = globalThis.fetch
  const leaked = 'sk-LEAKEDBODY12345678'
  globalThis.fetch = async () => ({
    ok: false, status: 500, headers: { get: () => null },
    async text() { return JSON.stringify({ error: `upstream says ${leaked}` }) },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({ level: 'yellow', title: 'x', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const out = await service.advise(ticket.ticket.id)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ai-http-500')
    assert.equal(JSON.stringify(out).includes(leaked), false, 'error response body must not be echoed')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: umbrella security tickets are refused by the AI advisor', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not call AI') }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({
      level: 'red', title: 'umbrella security', context: 'x', options: [{ value: 'a', label: 'A' }],
      source: { sessionId: 's1', agentRole: 'worker', taskName: 'umbrella-ask' },
    })
    const out = await service.advise(ticket.ticket.id)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'system-ticket-not-advised')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: concurrent advise on the same ticket merges into one request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let release = null
  globalThis.fetch = async () => {
    calls++
    await new Promise((resolve) => { release = resolve })
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"merged","recommendation":"a"}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({ level: 'yellow', title: 'x', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const first = service.advise(ticket.ticket.id)
    const second = service.advise(ticket.ticket.id)
    await waitFor(() => release !== null)
    release()
    const [one, two] = await Promise.all([first, second])
    assert.equal(calls, 1, 'same ticket must not double-charge')
    assert.equal(one.ok, true)
    assert.equal(one.advice.summary, 'merged')
    assert.equal(two.ok, true)
    assert.equal(two.advice.summary, 'merged')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI advice on a ticket that changed mid-flight is rejected', async () => {
  const originalFetch = globalThis.fetch
  let release = null
  globalThis.fetch = async () => {
    await new Promise((resolve) => { release = resolve })
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"late","recommendation":"a"}' } }] }) },
    }
  }
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({ level: 'yellow', title: 'x', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const pending = service.advise(ticket.ticket.id)
    // 建议在途时把票处理掉：返回后必须复核 status/rev，拒绝写入。
    await waitFor(() => release !== null)
    service.resolve(ticket.ticket.id, 'a')
    release()
    const out = await pending
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ticket-changed')
    assert.equal(service.get(ticket.ticket.id).ai, null)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI advice never resolves, never writes isRecommended, never auto-allows by confidence', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '高置信建议选 b', recommendation: 'b', rationale: 'r', confidence: 0.99,
        optionRisks: [{ value: 'b', risk: 'low', reason: 'r' }], missingInfo: [],
      }) } }] })
    },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const created = service.create({
      level: 'red', title: 'pick', context: 'x',
      options: [
        { value: 'a', label: 'A', isRecommended: true },
        { value: 'b', label: 'B' },
      ],
    })
    const before = service.get(created.ticket.id)
    const out = await service.advise(created.ticket.id)
    assert.equal(out.ok, true)
    assert.equal(out.advice.confidence, 0.99)
    const after = service.get(created.ticket.id)
    // 1) 状态/选项完全不变
    assert.equal(after.status, 'pending')
    assert.equal(after.resolvedOption, null)
    assert.equal(after.isBlocking, true)
    assert.deepEqual(after.options, before.options, 'AI must not write options[].isRecommended')
    // 2) 建议只在 ticket.ai，不改变任何决策字段
    assert.equal(after.ai.recommendation, 'b')
    assert.equal(after.ai.trust, 'unverified')
    // 3) 批量 resolveMany 仍拒绝红色代选（无论 AI 置信度多高）
    const batch = service.resolveMany([after.id])
    assert.equal(batch.ok, false)
    assert.deepEqual(batch.results, [{ id: after.id, ok: false, reason: 'explicit-choice-required' }])
    // 4) 没有任何投票/仲裁入口
    assert.equal(service.vote, undefined)
    assert.equal(service.arbitrate, undefined)
    assert.equal(service.autoResolve, undefined)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI advice schema is strictly validated before writing', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        recommendation: 'a', confidence: 1.5,
      }) } }] })
    },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({ level: 'yellow', title: 'x', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const out = await service.advise(ticket.ticket.id)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ai-schema-invalid')
    assert.ok(out.schemaErrors.includes('summary-required'))
    assert.ok(out.schemaErrors.includes('confidence-out-of-range'))
    assert.equal(service.get(ticket.ticket.id).ai, null, 'invalid schema must not write advice')
    assert.equal(service.get(ticket.ticket.id).status, 'pending')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI adoption is audited when a ticket is resolved or abandoned', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '推荐 a', recommendation: 'a', rationale: 'r', confidence: 0.8,
      }) } }] })
    },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const adopted = service.create({ level: 'yellow', title: 'adopt', context: 'x', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
    await service.advise(adopted.ticket.id)
    const resolved = service.resolve(adopted.ticket.id, 'a')
    assert.equal(resolved.ticket.aiOutcome.adopted, true)
    assert.equal(resolved.ticket.aiOutcome.recommendation, 'a')
    assert.equal(resolved.ticket.aiOutcome.resolvedOption, 'a')

    const rejected = service.create({ level: 'yellow', title: 'reject', context: 'x', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
    await service.advise(rejected.ticket.id)
    const notAdopted = service.resolve(rejected.ticket.id, 'b')
    assert.equal(notAdopted.ticket.aiOutcome.adopted, false)

    const abandoned = service.create({ level: 'yellow', title: 'abandon', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(abandoned.ticket.id)
    const dropped = service.abandon(abandoned.ticket.id)
    assert.equal(dropped.ticket.aiOutcome.adopted, false)
    assert.equal(dropped.ticket.aiOutcome.outcome, 'abandoned')
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: pending red over the hard cap is demoted to yellow and marked', () => {
  const { ctx, service, root } = boot({ config: { maxPendingRed: 1 } })
  try {
    const first = service.create({ level: 'red', title: 'first red', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const second = service.create({ level: 'red', title: 'second red', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(first.ticket.level, 'red')
    assert.equal(first.ticket.budgetDemoted, false)
    assert.equal(second.ok, true)
    assert.equal(second.ticket.level, 'yellow')
    assert.equal(second.ticket.originalLevel, 'red')
    assert.equal(second.ticket.budgetDemoted, true)
    assert.equal(second.ticket.isBlocking, false)
    assert.equal(service.policy().maxPendingRed, 1)
    service.resolve(first.ticket.id, 'a')
    const third = service.create({ level: 'red', title: 'third red', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(third.ticket.level, 'red')
    assert.equal(third.ticket.budgetDemoted, false)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: global attention budget demotes new tickets instead of dropping them', () => {
  const { ctx, service, root } = boot({
    config: { attentionBudget: 4, attentionSourceBudget: 0, autoAdvise: false },
  })
  try {
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's1' } })
    assert.equal(first.ticket.level, 'yellow')
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's2' } })
    assert.equal(second.ticket.level, 'blue', '3 + 3 > 4 => demote one level')
    assert.equal(second.ticket.attentionDemoted, true)
    assert.equal(second.ticket.originalLevel, 'yellow')
    assert.deepEqual(second.ticket.attentionQuota, { scope: 'global', used: 3, limit: 4, points: 1 })
    const third = service.create({ level: 'blue', title: 'third', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's3' } })
    assert.equal(third.ticket.level, 'green', 'yellow(3)+blue(1) = 4, next blue 1 > 4')
    assert.equal(third.ticket.attentionDemoted, true)
    assert.equal(service.policy().attentionBudget, 4)
    assert.deepEqual(service.policy().attentionWeights, { red: 5, yellow: 3, blue: 1, green: 0, gray: 0 })
  } finally {
    drop(ctx, root)
  }
})

test('decision center: per-source attention budget stops one agent from flooding the inbox', () => {
  const { ctx, service, root } = boot({
    config: { attentionBudget: 0, attentionSourceBudget: 4, autoAdvise: false },
  })
  try {
    const a1 = service.create({ level: 'yellow', title: 'a1', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'agent-a' } })
    assert.equal(a1.ticket.level, 'yellow')
    const a2 = service.create({ level: 'yellow', title: 'a2', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'agent-a' } })
    assert.equal(a2.ticket.level, 'blue')
    assert.equal(a2.ticket.attentionQuota.scope, 'source')
    assert.equal(a2.ticket.attentionQuota.used, 3)
    const b1 = service.create({ level: 'yellow', title: 'b1', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'agent-b' } })
    assert.equal(b1.ticket.level, 'yellow', 'another source has its own budget')
    assert.equal(b1.ticket.attentionDemoted, false)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: attention budgets 0 disable demotion', () => {
  const { ctx, service, root } = boot({
    config: { attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false },
  })
  try {
    for (let i = 0; i < 5; i += 1) {
      const ticket = service.create({ level: 'yellow', title: `y${i}`, context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'same' } })
      assert.equal(ticket.ticket.level, 'yellow')
      assert.equal(ticket.ticket.attentionDemoted, false)
    }
  } finally {
    drop(ctx, root)
  }
})

test('decision center: per-session daily ticket quota rejects flooding and is persisted across restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-session-quota-'))
  const ctx1 = makeCtx()
  try {
    const svc1 = apply(ctx1, { dataRoot: root, tickMs: 1000, maxTicketsPerSessionPerDay: 2, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false })
    const a1 = svc1.create({ level: 'yellow', title: 'a1', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-a' } })
    const a2 = svc1.create({ level: 'green', title: 'a2', context: 'x', source: { sessionId: 'session-a' } })
    assert.equal(a1.ok, true)
    assert.equal(a2.ok, true)
    const a3 = svc1.create({ level: 'yellow', title: 'a3', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-a' } })
    assert.equal(a3.ok, false)
    assert.equal(a3.reason, 'session-daily-quota-exceeded')
    assert.equal(a3.used, 2)
    assert.equal(a3.limit, 2)
    const other = svc1.create({ level: 'yellow', title: 'b1', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-b' } })
    assert.equal(other.ok, true, 'another session has its own daily quota')
    // 幂等重试不计数
    const retried = svc1.create({ level: 'yellow', title: 'dup', context: 'x', options: [{ value: 'a', label: 'A' }], dedupeKey: 'dup-1', source: { sessionId: 'session-b' } })
    assert.equal(retried.ok, true)
    const retriedAgain = svc1.create({ level: 'yellow', title: 'dup', context: 'x', options: [{ value: 'a', label: 'A' }], dedupeKey: 'dup-1', source: { sessionId: 'session-b' } })
    assert.equal(retriedAgain.deduped, true)
    ctx1.dispose()
    // 重启后仍计数：session-a 已经用完 2 次，第三个仍拒绝。
    const ctx2 = makeCtx()
    try {
      const svc2 = apply(ctx2, { dataRoot: root, tickMs: 1000, maxTicketsPerSessionPerDay: 2, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false })
      const a4 = svc2.create({ level: 'yellow', title: 'a4', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-a' } })
      assert.equal(a4.ok, false)
      assert.equal(a4.reason, 'session-daily-quota-exceeded')
    } finally {
      ctx2.dispose()
    }
  } finally {
    try { ctx1.dispose() } catch { /* already disposed */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('decision center: session usage day rollover resets the quota', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-session-day-'))
  const ctx = makeCtx()
  try {
    fs.writeFileSync(path.join(root, 'decision-session-usage.json'), JSON.stringify({
      day: '2000-01-01', counts: { 'session-a': 99 },
    }), 'utf8')
    const svc = apply(ctx, { dataRoot: root, tickMs: 1000, maxTicketsPerSessionPerDay: 1, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false })
    const first = svc.create({ level: 'yellow', title: 'new day', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-a' } })
    assert.equal(first.ok, true, 'yesterday usage must not leak into today')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('decision center: session quota policy=demote demotes and tags instead of rejecting', () => {
  const { ctx, service, root } = boot({
    config: {
      maxTicketsPerSessionPerDay: 1, sessionQuotaPolicy: 'demote',
      attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false,
    },
  })
  try {
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's' } })
    assert.equal(first.ok, true)
    const second = service.create({ level: 'yellow', title: 'second', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's' } })
    assert.equal(second.ok, true)
    assert.equal(second.ticket.level, 'blue')
    assert.equal(second.ticket.sessionQuotaDemoted, true)
    assert.deepEqual(second.ticket.sessionQuota, { scope: 'session-daily', used: 1, limit: 1, policy: 'demote' })
    const third = service.create({ level: 'blue', title: 'third', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's' } })
    assert.equal(third.ticket.level, 'green')
    assert.equal(third.ticket.sessionQuotaDemoted, true)
    const fourth = service.create({ level: 'green', title: 'fourth', context: 'x', source: { sessionId: 's' } })
    assert.equal(fourth.ok, false)
    assert.equal(fourth.reason, 'session-daily-quota-exceeded', 'green cannot be demoted further')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: session quota policy=merge folds the ticket into the latest pending one', () => {
  const { ctx, service, root } = boot({
    config: {
      maxTicketsPerSessionPerDay: 1, sessionQuotaPolicy: 'merge',
      attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false,
    },
  })
  try {
    const first = service.create({ level: 'yellow', title: 'first', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's' } })
    const merged = service.create({ level: 'yellow', title: 'duplicate', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's' } })
    assert.equal(merged.ok, true)
    assert.equal(merged.merged, true)
    assert.equal(merged.reason, 'session-daily-quota-merged')
    assert.equal(merged.ticket.id, first.ticket.id)
    assert.equal(service.list().items.length, 1, 'merge must not create a second ticket')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: quotaStatus reports per-session and per-role daily counts plus pending/red totals', () => {
  const { ctx, service, root } = boot({
    config: { maxTicketsPerSessionPerDay: 10, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false },
  })
  try {
    service.create({ level: 'yellow', title: 'a1', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's-a', agentRole: 'pm' } })
    service.create({ level: 'red', title: 'a2', context: 'x', options: [{ value: 'a', label: 'A' }], source: { sessionId: 's-a', agentRole: 'pm' } })
    service.create({ level: 'green', title: 'b1', context: 'x', source: { sessionId: 's-b', agentRole: 'worker' } })
    const stats = service.quotaStatus()
    assert.equal(stats.ok, true)
    assert.deepEqual(stats.sessions, [{ sessionId: 's-a', count: 2 }, { sessionId: 's-b', count: 1 }])
    assert.deepEqual(stats.roles, [{ role: 'pm', count: 2 }, { role: 'worker', count: 1 }])
    assert.equal(stats.total, 3)
    assert.equal(stats.pending.total, 3)
    assert.equal(stats.pending.red, 1)
    assert.equal(stats.pending.attentionPoints, 3 + 5 + 0)
    assert.equal(stats.limits.maxPendingRed, 30)
    assert.equal(stats.limits.sessionQuotaPolicy, 'reject')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: specialised action hooks execute after resolve and record ticket.execution', async () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    const seen = []
    const unregister = service.registerActionHandler('confirm_restart', async ({ ticket, payload }) => {
      seen.push({ id: ticket.id, payload })
      return { ok: true, restarted: false }
    })
    assert.deepEqual(service.listActionHandlers(), ['confirm_restart'])
    const submitted = service.submit({
      level: 'yellow', title: 'restart now?', context: 'x',
      actions: [{ id: 'confirm_restart', label: 'Restart', type: 'primary', payload: { version: '3.3.0' } }],
    })
    assert.equal(submitted.ok, true)
    const resolved = service.resolveAction(submitted.ticket.id, 'confirm_restart', { version: '3.3.0' })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ticket.execution.status, 'running')
    const done = await waitFor(() => {
      const ticket = service.get(submitted.ticket.id)
      return ticket.execution?.status === 'done' ? ticket : null
    })
    assert.equal(done.execution.actionId, 'confirm_restart')
    assert.deepEqual(done.execution.result, { ok: true, restarted: false })
    assert.deepEqual(seen, [{ id: submitted.ticket.id, payload: { version: '3.3.0' } }])
    unregister()
    assert.deepEqual(service.listActionHandlers(), [])
  } finally {
    drop(ctx, root)
  }
})

test('decision center: failed action hook records execution=failed without breaking resolve', async () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    service.registerActionHandler('confirm_restart', async () => { throw new Error('restart-guard offline') })
    const submitted = service.submit({
      level: 'yellow', title: 'restart now?', context: 'x',
      actions: [{ id: 'confirm_restart', label: 'Restart', type: 'primary' }],
    })
    assert.equal(service.resolveAction(submitted.ticket.id, 'confirm_restart').ok, true)
    const failed = await waitFor(() => {
      const ticket = service.get(submitted.ticket.id)
      return ticket.execution?.status === 'failed' ? ticket : null
    })
    assert.match(failed.execution.error, /restart-guard offline/)
    assert.equal(failed.status, 'resolved')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: maxTickets eviction is counted and audited in status', () => {
  const { ctx, service, root } = boot({ config: { maxTickets: 10, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false } })
  try {
    const ids = []
    for (let i = 0; i < 12; i += 1) {
      const created = service.create({ level: 'green', title: `green ${i}`, context: 'x' })
      if (created.ok) ids.push(created.ticket.id)
    }
    const stats = service.status()
    assert.ok(stats.evictions.count >= 2, `expected evictions, got ${JSON.stringify(stats.evictions)}`)
    assert.equal(stats.evictions.last.length <= 10, true)
    assert.ok(stats.evictions.last.every((item) => item.reason === 'max-tickets'))
    assert.equal(stats.items.length, 10)
    assert.equal(ids.filter((id) => stats.items.some((item) => item.id === id)).length, 10)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: store write failure fails closed on create and reports degraded health', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-degraded-'))
  fs.mkdirSync(path.join(root, 'decision-center.json')) // 占位成目录，写入必失败
  const ctx = makeCtx()
  try {
    const service = apply(ctx, { dataRoot: root, tickMs: 1000, autoAdvise: false })
    const out = service.create({ level: 'yellow', title: 'cannot persist', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'store-unavailable')
    assert.equal(service.list().items.length, 0, 'ticket must not stay in memory if it could not be persisted')
    const status = service.status()
    assert.equal(status.health.store.ok, false)
    assert.ok(status.health.store.failures >= 1)
    assert.ok(status.health.store.lastError)
  } finally {
    ctx.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('decision center: mixed batch resolves successes and reports the failed red item', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    const yellow = service.create({ level: 'yellow', title: 'y', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const red = service.create({ level: 'red', title: 'r', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const blue = service.create({ level: 'blue', title: 'b', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const out = service.resolveMany([yellow.ticket.id, red.ticket.id, blue.ticket.id])
    assert.equal(out.ok, false)
    assert.equal(out.results.length, 3)
    const byId = Object.fromEntries(out.results.map((item) => [item.id, item]))
    assert.equal(byId[yellow.ticket.id].ok, true)
    assert.equal(byId[blue.ticket.id].ok, true)
    assert.equal(byId[red.ticket.id].ok, false)
    assert.equal(byId[red.ticket.id].reason, 'explicit-choice-required')
    assert.equal(service.get(yellow.ticket.id).status, 'resolved')
    assert.equal(service.get(blue.ticket.id).status, 'resolved')
    assert.equal(service.get(red.ticket.id).status, 'pending')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: external producer kinds map to attention defaults; PJM timeout auto-grays', async () => {
  const { ctx, service, root } = boot({ config: { tickMs: 500, autoAdvise: false } })
  try {
    const base = { producer: 'external', title: 'x', context: 'x', options: [{ value: 'a', label: 'A' }] }
    assert.equal(service.ingest({ ...base, kind: 'harnessmm-suggestion' }).ticket.level, 'blue')
    assert.equal(service.ingest({ ...base, title: 'p', kind: 'plugin-updater-backup' }).ticket.level, 'green')
    assert.equal(service.ingest({ ...base, title: 's', kind: 'superagent-completion' }).ticket.level, 'green')
    assert.equal(service.ingest({ ...base, title: 'w', kind: 'worker-deviation' }).ticket.level, 'yellow')
    const pjm = service.ingest({ ...base, title: 'pjm timeout', kind: 'pjm-timeout', timeoutMinutes: 0.01 })
    assert.equal(pjm.ticket.level, 'yellow')
    assert.ok(pjm.ticket.expiresAt > Date.now(), 'PJM timeout ticket must have a deadline')
    const expired = await waitFor(() => {
      const ticket = service.get(pjm.ticket.id)
      return ticket.status === 'expired' ? ticket : null
    }, { timeout: 3000, interval: 100 })
    assert.equal(expired.level, 'gray', 'PJM timeout auto-grays')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: built-in confirm_restart executes restart-guard by default', async () => {
  const calls = []
  const { ctx, service, root } = boot({
    services: { [SERVICE.restart]: { request: async (input) => { calls.push(input); return { ok: true, requested: true } } } },
    config: { autoAdvise: false },
  })
  try {
    assert.ok(service.listActionHandlers().includes('confirm_restart'), 'built-in confirm_restart must be registered')
    const submitted = service.submit({
      level: 'yellow', title: 'restart?', context: 'x',
      actions: [{ id: 'confirm_restart', label: '立即重启', type: 'primary', payload: { reason: 'builtin-unit' } }],
    })
    assert.equal(service.resolveAction(submitted.ticket.id, 'confirm_restart').ok, true)
    const done = await waitFor(() => {
      const ticket = service.get(submitted.ticket.id)
      return ticket.execution?.status === 'done' ? ticket : null
    })
    assert.deepEqual(done.execution.result, { ok: true, requested: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].origin, 'decision-center')
    assert.equal(calls[0].reason, 'builtin-unit')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: non-red isBlocking is ignored; blocking red is not evicted by pruning', () => {
  const { ctx, service, root } = boot({ config: { maxTickets: 10, attentionBudget: 0, attentionSourceBudget: 0, autoAdvise: false } })
  try {
    const yellow = service.create({
      level: 'yellow', title: 'yellow', context: 'x',
      options: [{ value: 'a', label: 'A' }], isBlocking: true,
    })
    assert.equal(yellow.ticket.isBlocking, false, 'only red may block')
    const blocking = service.create({
      level: 'red', title: 'red blocking', context: 'x',
      options: [{ value: 'a', label: 'A' }], isBlocking: true,
    })
    assert.equal(blocking.ticket.isBlocking, true)
    for (let i = 0; i < 12; i += 1) {
      service.create({ level: 'green', title: `noise ${i}`, context: 'x' })
    }
    assert.ok(service.get(blocking.ticket.id), 'blocking red must survive prune')
    const stats = service.status()
    assert.ok(stats.evictions.count >= 2)
    assert.equal(stats.items.some((item) => item.id === blocking.ticket.id), true)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: timeoutMinutes=0 is only "no expiry" for non-red tickets', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    const green = service.create({ level: 'green', title: 'no expiry', context: 'x', timeoutMinutes: 0 })
    assert.equal(green.ticket.expiresAt, null)
    const red = service.create({ level: 'red', title: 'red finite', context: 'x', options: [{ value: 'a', label: 'A' }], timeoutMinutes: 0 })
    assert.ok(red.ticket.expiresAt > Date.now(), 'blocking red must always have finite expiry')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: request_human_decision throws when a red ticket is abandoned', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, service, root } = boot({ services: { tools }, config: { autoAdvise: false } })
  try {
    const tool = registered.find((item) => item.name === 'request_human_decision')
    const pending = tool.execute({
      level: 'red', title: 'blocking', context: 'x', options: [{ value: 'a', label: 'A' }],
    }, { agent: { id: 's-abandon' } })
    const ticket = await waitFor(() => service.list().items[0])
    service.abandon(ticket.id)
    await assert.rejects(pending, /outcome=abandoned/)
  } finally {
    drop(ctx, root)
  }
})

test('decision center: resolve(id, actionId, payload) overload preserves payload and triggers action hook', async () => {
  const calls = []
  const { ctx, service, root } = boot({
    services: { [SERVICE.restart]: { request: async (input) => { calls.push(input); return { ok: true } } } },
    config: { autoAdvise: false },
  })
  try {
    const submitted = service.submit({
      level: 'yellow', title: 'upgrade', description: 'x', source: 'MirrorManager',
      actions: [{ id: 'confirm_restart', label: '立即重启', type: 'primary', payload: { version: '3.2.0' } }],
    })
    assert.equal(submitted.ok, true)
    assert.equal(submitted.ticket.source.rawSource, 'MirrorManager', 'raw source string is preserved for display')
    const resolved = service.resolve(submitted.ticket.id, 'confirm_restart', { version: '3.2.0' })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ticket.selectedActionId, 'confirm_restart')
    assert.deepEqual(resolved.ticket.resolvedPayload, { version: '3.2.0' })
    const done = await waitFor(() => {
      const ticket = service.get(submitted.ticket.id)
      return ticket.execution?.status === 'done' ? ticket : null
    })
    assert.deepEqual(done.execution.result, { ok: true })
    assert.equal(calls.length, 1, 'confirm_restart hook must execute from resolve() overload')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: __ACK__ is a reserved control sentinel, not a real option value', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    const direct = service.create({ level: 'yellow', title: 'x', context: 'x', options: [{ value: '__ACK__', label: 'Ack' }] })
    assert.equal(direct.ok, false)
    assert.equal(direct.reason, 'reserved-option-value')
    const viaSubmit = service.submit({
      level: 'yellow', title: 'y', description: 'x',
      actions: [{ id: '__ACK__', label: 'Ack', type: 'primary' }],
    })
    assert.equal(viaSubmit.ok, false)
    assert.equal(viaSubmit.reason, 'reserved-option-value')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: expired/abandoned overwrite level to gray but keep original severity', async () => {
  const { ctx, service, root } = boot({ config: { tickMs: 500, autoAdvise: false } })
  try {
    const abandoned = service.create({ level: 'yellow', title: 'abandon me', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const dropped = service.abandon(abandoned.ticket.id)
    assert.equal(dropped.ticket.level, 'gray')
    assert.equal(dropped.ticket.originalLevel, 'yellow')
    const expiring = service.create({ level: 'red', title: 'expire me', context: 'x', options: [{ value: 'a', label: 'A' }], timeoutMinutes: 0.01 })
    const expired = await waitFor(() => {
      const ticket = service.get(expiring.ticket.id)
      return ticket.status === 'expired' ? ticket : null
    }, { timeout: 3000, interval: 100 })
    assert.equal(expired.level, 'gray')
    assert.equal(expired.originalLevel, 'red')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: restart recovery persists pending tickets as expired/gray', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-recovery-'))
  const ctx1 = makeCtx()
  try {
    const first = apply(ctx1, { dataRoot: root, tickMs: 1000, autoAdvise: false })
    const created = first.create({ level: 'red', title: 'crash while pending', context: 'x', options: [{ value: 'a', label: 'A' }] })
    assert.equal(created.ok, true)
    ctx1.dispose()
    const ctx2 = makeCtx()
    try {
      const second = apply(ctx2, { dataRoot: root, tickMs: 1000, autoAdvise: false })
      const restored = second.get(created.ticket.id)
      assert.equal(restored.status, 'expired')
      assert.equal(restored.level, 'gray')
      assert.equal(restored.originalLevel, 'red')
      const persisted = JSON.parse(fs.readFileSync(path.join(root, 'decision-center.json'), 'utf8'))
      const row = persisted.tickets.find((item) => item.id === created.ticket.id)
      assert.equal(row.status, 'expired', 'recovery must be written back to disk')
      assert.equal(row.level, 'gray')
    } finally {
      ctx2.dispose()
    }
  } finally {
    try { ctx1.dispose() } catch { /* already */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('decision center: forkAggregation groups tickets by originForkId', () => {
  const { ctx, service, root } = boot({ config: { autoAdvise: false } })
  try {
    const opts = [{ value: 'a', label: 'A' }]
    const a1 = service.ingest({ producer: 'fork', kind: 'worker-deviation', originForkId: 'fork-a', taskId: 't1', title: 'a1', context: 'x', options: opts })
    const a2 = service.ingest({ producer: 'fork', kind: 'worker-deviation', originForkId: 'fork-a', taskId: 't1', title: 'a2', context: 'x', options: opts })
    service.ingest({ producer: 'fork', kind: 'pjm-timeout', originForkId: 'fork-b', taskId: 't2', title: 'b1', context: 'x', options: opts })
    service.ingest({ producer: 'MirrorUpgrade', kind: 'mirror-upgrade', title: 'mother', context: 'x', options: opts })
    service.resolve(a1.ticket.id, 'a')
    // AI 建议聚合：母体给 ingest 的 fork ticket 写建议后，按 fork 统计 advised/adopted。
    const advisedTicket = service.get(a2.ticket.id)
    assert.equal(advisedTicket.external.originForkId, 'fork-a')
    const agg = service.forkAggregation()
    assert.equal(agg.ok, true)
    assert.equal(agg.mother.total, 1)
    const forkA = agg.forks.find((group) => group.forkId === 'fork-a')
    const forkB = agg.forks.find((group) => group.forkId === 'fork-b')
    assert.equal(forkA.total, 2)
    assert.equal(forkA.pending, 1)
    assert.equal(forkA.resolved, 1)
    assert.equal(typeof forkA.advised, 'number')
    assert.equal(typeof forkA.aiAdopted, 'number')
    assert.equal(forkB.total, 1)
    assert.equal(forkB.pending, 1)
    assert.equal(a2.ticket.external.originForkId, 'fork-a')
  } finally {
    drop(ctx, root)
  }
})

test('decision center: forkAggregation counts AI advice and adoption per fork', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    async text() { return JSON.stringify({ choices: [{ message: { content: '{"summary":"推荐 a","recommendation":"a","rationale":"r","confidence":0.8}' } }] }) },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const first = service.ingest({ producer: 'fork', kind: 'worker-deviation', originForkId: 'fork-ai', title: 'ai1', context: 'x', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
    await service.advise(first.ticket.id)
    service.resolve(first.ticket.id, 'a')
    const second = service.ingest({ producer: 'fork', kind: 'worker-deviation', originForkId: 'fork-ai', title: 'ai2', context: 'x', options: [{ value: 'a', label: 'A' }] })
    await service.advise(second.ticket.id)
    service.abandon(second.ticket.id)
    const fork = service.forkAggregation().forks.find((group) => group.forkId === 'fork-ai')
    assert.equal(fork.advised, 2)
    assert.equal(fork.aiAdopted, 1)
    assert.equal(fork.aiRejected, 1)
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: AI streaming advice emits deltas and writes the same validated advice', async () => {
  const originalFetch = globalThis.fetch
  const content = '{"summary":"streamed advice","recommendation":"a","rationale":"r","confidence":0.9}'
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(0, 20) } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(20) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n',
    'data: [DONE]\n\n',
  ]
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[index++]) }
            return { done: true, value: undefined }
          },
          async cancel() {},
        }
      },
    },
  })
  const { ctx, service, root } = boot({ config: { persistAiKey: false, autoAdvise: false } })
  try {
    service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
    const ticket = service.create({ level: 'yellow', title: 'stream me', context: 'x', options: [{ value: 'a', label: 'A' }] })
    const deltas = []
    const result = await service.adviseStream(ticket.ticket.id, (delta) => deltas.push(delta))
    assert.equal(result.ok, true)
    assert.equal(deltas.join(''), content)
    assert.equal(result.advice.summary, 'streamed advice')
    assert.equal(service.get(ticket.ticket.id).ai.summary, 'streamed advice')
    assert.deepEqual(result.advice.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  } finally {
    globalThis.fetch = originalFetch
    drop(ctx, root)
  }
})

test('decision center: HTTP surface is registered by orchestrator', () => {
  // The orchestrator route test lives in orchestrator.test.mjs; this test only
  // proves the service key exists and is importable by that plugin.
  assert.equal(typeof SERVICE.decisionCenter, 'string')
})

test('decision center: session relay custom input resolves without a preset option', () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'yellow', title: 'choose a path', context: 'relay custom input',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    })
    const custom = service.resolve(created.ticket.id, '', { by: 'fang-relay', custom: '按 B 方案处理，先灰度 10%' })
    assert.equal(custom.ok, true)
    const ticket = service.get(created.ticket.id)
    assert.equal(ticket.status, 'resolved')
    assert.equal(ticket.resolvedOption, '按 B 方案处理，先灰度 10%')
    assert.equal(ticket.customInput, true)
    assert.equal(ticket.resolutionNote, '按 B 方案处理，先灰度 10%')
    // A malformed unknown option without custom must still be rejected (fail-closed).
    const second = service.create({ level: 'blue', title: 'pick', options: [{ value: 'x', label: 'X' }] })
    const rejected = service.resolve(second.ticket.id, 'not-an-option', { by: 'fang-relay' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, 'unknown-option')
  } finally {
    drop(ctx, root)
  }
})
