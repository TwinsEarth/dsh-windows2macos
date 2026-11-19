// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 决策中心 UX（v3.6.1）：
//   * 本轮待选显示会话名，裸 Session ID 只留在 tooltip / 调试属性里；
//   * 决策选项先过同步规则 pass，再按配置走一次严格的智能改写，失败只回落规则。
//
// 这一组是宿主侧的证据：规则矩阵、AI 校验矩阵、缓存、配置、标题解析（含真实 zstd
// 会话日志的只读读取）。客户端渲染契约在 `test/client-bundle.test.mjs` 里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { apply, Config } from '../src/decision-center/index.mjs'
import { SERVICE } from '../src/decision-center/kernel.mjs'
import {
  buildOptionHumanizePrompt,
  createOptionHumanizeCache,
  humanizeLabelByRules,
  humanizeOptionsByRules,
  labelDisplayWidth,
  parseOptionHumanizeResponse,
  truncateOptionLabel,
} from '../src/decision-center/lib/option-humanizer.mjs'
import { createSessionTitleResolver, readTitleFromSessionLog } from '../src/decision-center/lib/session-titles.mjs'
import { makeCtx } from './helpers/fang-ctx.mjs'

const originalDshHome = process.env.DSH_HOME

function boot({ config = {}, services = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ux-'))
  process.env.DSH_HOME = path.join(root, 'home')
  const ctx = makeCtx({ services })
  const service = apply(ctx, {
    dataRoot: path.join(root, 'data'),
    tickMs: 600000,
    persistAiKey: false,
    autoAdvise: false,
    ...config,
  })
  return { ctx, service, root }
}

function drop(ctx, root) {
  try { ctx.dispose() } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
}

async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

/** A chat-completions answer carrying `content` as the assistant message. */
function chatResponse(content, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    },
  }
}

function withFetch(fake, work) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  return Promise.resolve()
    .then(work)
    .finally(() => { globalThis.fetch = original })
}

// ---------------------------------------------------------------------------
// Rule pass
// ---------------------------------------------------------------------------

test('option humanizer: the rule pass strips decoration, keeps values, and never mutates input', () => {
  const options = [
    { value: 'a', label: '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？' },
    { value: 'b', label: '```\nhttps://example.com/plan\n```\n先看计划' },
    { value: 'a', label: 'duplicate value is dropped' },
    { value: 'c', label: '' },
  ]
  const before = JSON.parse(JSON.stringify(options))
  const out = humanizeOptionsByRules(options, { maxChars: 28 })
  assert.deepEqual(options, before, 'the rule pass returns new objects instead of rewriting caller input')
  assert.deepEqual(out.options.map((option) => option.value), ['a', 'b', 'c'], 'option values are unchanged and only a duplicate value is dropped')
  assert.equal(out.dropped, 1)
  assert.equal(out.changed, true)
  const first = out.options[0]
  assert.equal(first.value, 'a')
  assert.equal(first.rawLabel, '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？', 'the original text survives for the tooltip')
  assert.match(first.label, /^继续修复队列里的并发问题/u, 'markdown, numbering, the leading question and the trailing particle are gone')
  assert.equal(first.label.includes('*'), false)
  assert.ok(first.label.endsWith('…'), 'an over-long label is shortened with …')
  assert.ok(labelDisplayWidth(first.label) <= 28, `label width ${labelDisplayWidth(first.label)} <= 28`)
  const second = out.options[1]
  assert.equal(second.label, '先看计划', 'code fence and URL are removed; the action phrase remains')
  assert.equal(second.rawLabel.includes('http'), true)
  assert.equal(out.options[2].label, 'c', 'an empty label falls back to the value rather than rendering nothing')
})

test('option humanizer: a question sentence becomes the action it asks about', () => {
  assert.equal(humanizeLabelByRules('是否继续？'), '继续')
  assert.equal(humanizeLabelByRules('要不要先回滚呢'), '先回滚')
  assert.equal(humanizeLabelByRules('我们应该重启服务吗'), '重启服务')
  assert.equal(humanizeLabelByRules('请选择 A 方案'), 'A 方案')
  assert.equal(humanizeLabelByRules('先回滚。重启会丢队列。'), '先回滚', 'the first sentence is the action; the rest is the paragraph')
  assert.equal(humanizeLabelByRules('酒吧'), '酒吧', 'a noun ending in 吧 is not a question particle')
  assert.equal(humanizeLabelByRules(''), '')
  assert.equal(humanizeLabelByRules('   '), '')
})

test('option humanizer: truncation counts CJK as two columns and never splits a code point', () => {
  const long = '把队列日志槽位化和真实页面回归一起做完再发布'
  const short = truncateOptionLabel(long, 20)
  assert.ok(labelDisplayWidth(short) <= 20, `width ${labelDisplayWidth(short)}`)
  assert.ok(short.endsWith('…'))
  assert.equal(Array.from(short).every((character) => !/[\uD800-\uDBFF]/u.test(character)), true, 'no lone surrogate survives')
  assert.equal(truncateOptionLabel('😀'.repeat(12), 8), `${'😀'.repeat(6)}…`)
  assert.equal(Array.from(truncateOptionLabel('😀'.repeat(12), 8)).some((character) => /[\uD800-\uDBFF]/u.test(character)), false)
  assert.equal(truncateOptionLabel('继续', 28), '继续', 'a label inside the budget is untouched')
  assert.ok(labelDisplayWidth(truncateOptionLabel(long, 4)) <= 4)
})

test('option humanizer: a second rule pass is a no-op (no rev churn, no pointless AI call)', () => {
  const first = humanizeOptionsByRules([{ value: 'a', label: '1. 是否继续修复并补测试呢？' }], { maxChars: 28 })
  assert.equal(first.changed, true)
  const second = humanizeOptionsByRules(first.options, { maxChars: 28 })
  assert.equal(second.changed, false)
  assert.equal(second.options[0].label, first.options[0].label)
  assert.equal(second.options[0].rawLabel, first.options[0].rawLabel, 'rawLabel is kept, not replaced by the humanized text')
})

// ---------------------------------------------------------------------------
// Intelligence-pass contract
// ---------------------------------------------------------------------------

test('option humanizer: the prompt states the invariants the parser enforces', () => {
  const messages = buildOptionHumanizePrompt({
    title: 't',
    context: 'c',
    options: [{ value: 'a', label: '是否继续？' }, { value: 'b', label: '先回滚' }],
    maxChars: 28,
  })
  assert.equal(messages.length, 2)
  const prompt = messages.map((message) => message.content).join('\n')
  assert.match(prompt, /value 与选项数量、顺序必须完全不变/u)
  assert.match(prompt, /不超过 28 个显示列/u)
  assert.match(prompt, /不要合并、不要新增、不要删除选项/u)
  assert.match(prompt, /\[\{"value":"原 value"/u)
  assert.match(prompt, /"value":"a"/u)
})

test('option humanizer: the parser refuses anything that would change the choice', () => {
  const expected = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
  const ok = parseOptionHumanizeResponse('[{"value":"a","label":"继续修复"},{"value":"b","label":"先回滚"}]', expected)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.options, [{ value: 'a', label: '继续修复' }, { value: 'b', label: '先回滚' }])
  const tolerated = parseOptionHumanizeResponse('好的：\n[{"value":"a","label":"继续"},{"value":"b","label":"回滚"}]\n完成', expected)
  assert.equal(tolerated.ok, true, 'a code-fenced/commentary wrapper is tolerated; only the array is read')
  for (const [name, content, reason] of [
    ['malformed', 'not json', 'option-humanize-json'],
    ['not-array', '{"value":"a"}', 'option-humanize-json'],
    ['wrong-count', '[{"value":"a","label":"x"}]', 'option-humanize-count'],
    ['extra-option', '[{"value":"a","label":"x"},{"value":"b","label":"y"},{"value":"c","label":"z"}]', 'option-humanize-count'],
    ['changed-value', '[{"value":"a","label":"x"},{"value":"zzz","label":"y"}]', 'option-humanize-value'],
    ['duplicate-label', '[{"value":"a","label":"同样"},{"value":"b","label":"同样"}]', 'option-humanize-duplicate'],
    ['empty-label', '[{"value":"a","label":""},{"value":"b","label":"y"}]', 'option-humanize-label'],
  ]) {
    const parsed = parseOptionHumanizeResponse(content, expected)
    assert.equal(parsed.ok, false, name)
    assert.equal(parsed.reason, reason, name)
  }
  assert.equal(parseOptionHumanizeResponse('[]', []).ok, false, 'no options means nothing to humanize')
})

test('option humanizer: the cache is LRU-bounded and keyed by value|label|model', () => {
  const cache = createOptionHumanizeCache({ limit: 2 })
  const keyA = cache.keyFor('a', 'raw', 'model-1')
  const keyB = cache.keyFor('a', 'raw', 'model-2')
  assert.notEqual(keyA, keyB, 'the model is part of the key')
  assert.equal(cache.keyFor('a', 'raw', 'model-1'), keyA, 'the key is deterministic')
  cache.set(keyA, '继续')
  assert.equal(cache.get(keyA), '继续')
  cache.set(keyB, '继续（另一个模型）')
  assert.equal(cache.stats().size, 2)
  cache.set(cache.keyFor('b', 'raw', 'model-1'), '回滚')
  assert.equal(cache.stats().size, 2, 'the least-recently used entry is evicted')
  assert.equal(cache.get(keyA), undefined, 'the evicted key is gone')
  assert.equal(cache.get(keyB), '继续（另一个模型）', 'the more recently used key survived')
  const stats = cache.stats()
  assert.equal(stats.limit, 2)
  assert.ok(stats.hits >= 2)
  assert.ok(stats.misses >= 1)
})

// ---------------------------------------------------------------------------
// Intelligence pass through the real service (injected fake fetch)
// ---------------------------------------------------------------------------

test('decision center: rules land synchronously, the AI pass runs in the background and only rewrites labels', async () => {
  const bodies = []
  const auditor = []
  await withFetch(
    async (url, init) => {
      bodies.push(JSON.parse(init.body))
      await new Promise((resolve) => setTimeout(resolve, 40))
      return chatResponse(JSON.stringify([{ value: 'a', label: '继续修复并补测试' }, { value: 'b', label: '先回滚' }]))
    },
    async () => {
      const { ctx, service, root } = boot({ services: { [SERVICE.auditor]: { append: (kind, data) => auditor.push({ kind, data }) } } })
      try {
        assert.equal(service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' }).ok, true)
        const startedAt = Date.now()
        const created = service.create({
          level: 'yellow',
          title: '本轮待选：继续修复还是回滚？',
          context: 'x',
          options: [
            { value: 'a', label: '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？' },
            { value: 'b', label: '要不要先回滚到上一个版本，避免更多会话受影响呢' },
          ],
        })
        const elapsed = Date.now() - startedAt
        assert.equal(created.ok, true)
        assert.equal(created.ticket.optionsHumanized.mode, 'rules', 'the button is usable before create() returns')
        assert.ok(elapsed < 250, `create() did not wait for the AI pass (${elapsed}ms)`)
        assert.equal(bodies.length, 0, 'the AI call is queued, not awaited')
        assert.ok(created.ticket.options[0].label.endsWith('…'))

        const humanized = await waitFor(() => {
          const ticket = service.get(created.ticket.id)
          return ticket.optionsHumanized.mode === 'ai' ? ticket : null
        })
        assert.equal(bodies.length, 1, 'one call per ticket, never a second provider stack')
        assert.deepEqual(humanized.options.map((option) => option.value), ['a', 'b'], 'values are untouched')
        assert.deepEqual(humanized.options.map((option) => option.label), ['继续修复并补测试', '先回滚'])
        assert.equal(humanized.options[0].rawLabel, '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？')
        assert.equal(humanized.optionsHumanized.model, 'deepseek-flash')
        assert.equal(typeof humanized.optionsHumanized.at, 'number')

        const prompt = bodies[0].messages.map((message) => message.content).join('\n')
        assert.match(prompt, /value 与选项数量、顺序必须完全不变/u)
        assert.match(prompt, /不超过 28 个显示列/u)
        assert.match(prompt, /"value":"a"/u)
        assert.equal(bodies[0].temperature, 0.2)
        assert.equal(bodies[0].max_tokens, 400)
        assert.equal(JSON.stringify(auditor).includes('是否继续'), false, 'audit events never carry raw option text')
        const success = auditor.filter((entry) => entry.kind === 'decision-option-humanize')
        assert.equal(success.length, 1)
        assert.equal(success[0].data.mode, 'ai')
        assert.equal(success[0].data.cached, false)
        assert.ok(service.aiStatus().optionHumanize.cache.size >= 2)
      } finally {
        drop(ctx, root)
      }
    },
  )
})

test('decision center: every AI failure mode falls back to the rule labels, never to raw paragraphs', async () => {
  const cases = [
    ['malformed-json', () => chatResponse('抱歉，我不能只输出 JSON。'), 'option-humanize-json'],
    ['wrong-count', () => chatResponse(JSON.stringify([{ value: 'a', label: '继续' }])), 'option-humanize-count'],
    ['extra-options', () => chatResponse(JSON.stringify([
      { value: 'a', label: '继续' }, { value: 'b', label: '回滚' }, { value: 'c', label: '新增' },
    ])), 'option-humanize-count'],
    ['foreign-value', () => chatResponse(JSON.stringify([
      { value: 'a', label: '继续' }, { value: 'zzz', label: '回滚' },
    ])), 'option-humanize-value'],
    ['duplicate-label', () => chatResponse(JSON.stringify([
      { value: 'a', label: '继续' }, { value: 'b', label: '继续' },
    ])), 'option-humanize-duplicate'],
    ['timeout', () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error }, 'ai-timeout'],
  ]
  for (const [name, responder, reason] of cases) {
    const failures = []
    await withFetch(responder, async () => {
      const { ctx, service, root } = boot({ services: { [SERVICE.auditor]: { append: (kind, data) => failures.push({ kind, data }) } } })
      try {
        assert.equal(service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' }).ok, true)
        const created = service.create({
          level: 'yellow',
          title: `failure case ${name}`,
          context: 'x',
          options: [
            { value: 'a', label: '1. 是否继续修复队列里的并发问题，并且把测试补齐呢？' },
            { value: 'b', label: '要不要先回滚到上一个版本，避免更多会话受影响呢' },
          ],
        })
        const failed = await waitFor(() => failures.find((entry) => entry.kind === 'decision-option-humanize-failed'))
        assert.equal(failed.data.reason, reason, name)
        const ticket = service.get(created.ticket.id)
        assert.equal(ticket.optionsHumanized.mode, 'rules', `${name} falls back to rules`)
        assert.ok(ticket.options.every((option) => option.label.endsWith('…')), `${name}: the visible labels are the short rules result`)
        assert.deepEqual(ticket.options.map((option) => option.value), ['a', 'b'], `${name}: values are untouched`)
      } finally {
        drop(ctx, root)
      }
    })
  }
})

test('decision center: optionHumanize=off and rules-only never call the model, and the manual route says why', async () => {
  await withFetch(async () => { throw new Error('the model must not be called') }, async () => {
    for (const mode of ['off', 'rules-only']) {
      const { ctx, service, root } = boot({ config: { optionHumanize: mode } })
      try {
        assert.equal(service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' }).ok, true)
        const created = service.create({
          level: 'yellow',
          title: `mode ${mode}`,
          context: 'x',
          options: [{ value: 'a', label: '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？' }],
        })
        await new Promise((resolve) => setTimeout(resolve, 60))
        assert.equal(created.ticket.optionsHumanized.mode, mode === 'off' ? 'off' : 'rules')
        if (mode === 'off') {
          assert.equal(created.ticket.options[0].label, '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？', 'off keeps the original text')
          assert.equal(created.ticket.options[0].rawLabel, undefined)
        } else {
          assert.ok(created.ticket.options[0].label.endsWith('…'))
          assert.notEqual(created.ticket.options[0].rawLabel, undefined)
        }
        const manual = await service.humanizeOptions(created.ticket.id)
        if (mode === 'off') {
          assert.equal(manual.ok, false)
          assert.equal(manual.reason, 'option-humanize-disabled')
        } else {
          assert.equal(manual.ok, true)
          assert.equal(manual.mode, 'rules')
        }
      } finally {
        drop(ctx, root)
      }
    }
  })
})

test('decision center: a cached AI label makes the manual re-run free, and manual runs are single-flight', async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return chatResponse(JSON.stringify([{ value: 'a', label: '继续修复' }, { value: 'b', label: '先回滚' }]))
    },
    async () => {
      const { ctx, service, root } = boot()
      try {
        service.configureAi({ provider: 'deepseek', apiKey: 'test-key-0123456789' })
        const created = service.create({
          level: 'yellow',
          title: 'cache',
          context: 'x',
          options: [
            { value: 'a', label: '是否继续修复队列里的并发问题并把测试补齐呢？' },
            { value: 'b', label: '要不要先回滚到上一个版本，避免更多会话受影响呢' },
          ],
        })
        await waitFor(() => service.get(created.ticket.id).optionsHumanized.mode === 'ai')
        assert.equal(calls, 1)
        const first = await service.humanizeOptions(created.ticket.id)
        assert.equal(first.ok, true)
        assert.equal(first.cached, true)
        assert.equal(calls, 1, 'a full cache hit is answered without a second request')
        const second = await service.humanizeOptions(created.ticket.id)
        assert.equal(second.ok, true)
        assert.equal(calls, 1, 'the cache survives repeated manual runs')
        assert.equal(service.get(created.ticket.id).optionsHumanized.mode, 'ai')
      } finally {
        drop(ctx, root)
      }
    },
  )
})

test('decision center: manual AI humanization without a provider reports ai-not-configured and keeps the rules result', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({
      level: 'yellow',
      title: 'no ai',
      context: 'x',
      options: [{ value: 'a', label: '是否继续修复队列里的并发问题并把测试补齐呢？' }],
    })
    const out = await service.humanizeOptions(created.ticket.id)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ai-not-configured')
    assert.equal(out.mode, 'rules')
    assert.equal(out.ticket.optionsHumanized.mode, 'rules')
    assert.ok(out.ticket.options[0].label.endsWith('…'))
    assert.deepEqual(await service.humanizeOptions('dec_missing'), { ok: false, reason: 'not-found' })
  } finally {
    drop(ctx, root)
  }
})

// ---------------------------------------------------------------------------
// Session titles
// ---------------------------------------------------------------------------

test('session titles: services first, log fallback, then null — cached and bounded', async () => {
  const reads = []
  const ctx = makeCtx({ services: { sessions: { list: () => [{ id: 'session-aaa', title: '服务标题' }] } } })
  const resolver = createSessionTitleResolver({
    ctx,
    env: { DSH_HOME: 'unused' },
    readLogTitle: (id) => { reads.push(id); return id === 'session-bbb' ? '日志标题' : null },
  })
  const found = await resolver.lookupMany(['session-aaa', 'session-bbb', 'session-ccc'])
  assert.equal(found.get('session-aaa'), '服务标题')
  assert.equal(found.get('session-bbb'), '日志标题', 'a title the service does not know is read from the session log')
  assert.equal(found.get('session-ccc'), null, 'an unknown id is null, never the id')
  const readsAfterFirst = reads.length
  assert.equal(resolver.resolve('session-bbb'), '日志标题')
  assert.equal(reads.length, readsAfterFirst, 'the title is cached: no second log read')
  assert.equal(resolver.resolve('unknown'), null)
  assert.equal(resolver.resolve(''), null)
  assert.equal(reads.includes('unknown'), false, 'placeholder ids never hit the filesystem')

  const boundedReads = []
  const bounded = createSessionTitleResolver({
    env: { DSH_HOME: 'unused' },
    maxLogReadsPerCall: 3,
    readLogTitle: (id) => { boundedReads.push(id); return null },
  })
  const misses = ['session-miss-1', 'session-miss-2', 'session-miss-3']
  await bounded.lookupMany(misses)
  assert.equal(boundedReads.length, 3, 'one list call spends at most maxLogReadsPerCall log reads')
  await bounded.lookupMany(misses)
  assert.equal(boundedReads.length, 3, 'the negative entries are cached, so a poll does not re-read the same logs')
  await bounded.lookupMany(Array.from({ length: 10 }, (_, index) => `session-new-${index}`))
  assert.equal(boundedReads.length, 6, 'a new batch gets its own bounded budget, never an unbounded scan')
})

test('session titles: a service whose list() is async is awaited by the route helper', async () => {
  const ctx = makeCtx({ services: { sessions: { list: async () => [{ id: 'session-ddd', title: '异步标题' }] } } })
  const resolver = createSessionTitleResolver({ ctx, readLogTitle: () => null })
  const titles = await resolver.lookupMany(['session-ddd'])
  assert.equal(titles.get('session-ddd'), '异步标题')
})

test('session titles: an absent service is a missing source, not an error', async () => {
  const resolver = createSessionTitleResolver({ ctx: makeCtx(), readLogTitle: () => null })
  assert.equal(resolver.resolve('session-nope'), null)
  assert.equal(await resolver.lookupMany(['session-nope']).then((titles) => titles.get('session-nope')), null)
  assert.equal(typeof resolver.stats().cache, 'number')
})

test('session titles: the real log reader returns the session/title event without writing the log', (t) => {
  if (typeof zlib.zstdCompressSync !== 'function') return t.skip('this Node has no zstd compressor')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-title-'))
  try {
    const root = path.join(home, 'sessions')
    const dir = path.join(root, 'ws1', 'session-abc')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'hello' } },
      { type: 'session/title', data: { title: '真实标题' } },
    ]
    fs.writeFileSync(file, Buffer.concat(events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))))
    const before = fs.statSync(file)
    const beforeBytes = fs.readFileSync(file)
    assert.equal(readTitleFromSessionLog('abc', { root }), '真实标题')
    assert.equal(readTitleFromSessionLog('session-abc', { root }), '真实标题', 'both the bare and the session- prefixed id resolve')
    assert.equal(readTitleFromSessionLog('missing', { root }), null)
    const after = fs.statSync(file)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs, 'the reader never writes to the session log')
    assert.deepEqual(fs.readFileSync(file), beforeBytes, 'the log bytes are unchanged')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('decision center: a title hint wins; an unresolved session is null on the ticket, never its id', async () => {
  const { ctx, service, root } = boot({ services: { sessions: { list: () => [{ id: 'sess-1', title: '宿主标题' }] } } })
  try {
    const hinted = service.create({
      level: 'green',
      title: 'hinted',
      context: 'x',
      options: [{ value: 'a', label: 'A' }],
      source: { sessionId: 'sess-1', agentRole: 'worker', sessionTitle: '调用方标题' },
    })
    assert.equal(hinted.ticket.source.sessionTitle, '调用方标题', 'the caller-provided hint is used before any lookup')
    const resolved = service.create({
      level: 'green',
      title: 'resolved',
      context: 'x',
      options: [{ value: 'a', label: 'A' }],
      source: { sessionId: 'sess-1', agentRole: 'worker' },
    })
    assert.equal(resolved.ticket.source.sessionTitle, '宿主标题', 'the host session service resolves it when no hint exists')
    const missing = service.create({
      level: 'green',
      title: 'missing',
      context: 'x',
      options: [{ value: 'a', label: 'A' }],
      source: { sessionId: 'sess-nope', agentRole: 'worker' },
    })
    assert.equal(missing.ticket.source.sessionTitle, null)
    const listed = service.list().items.find((item) => item.id === missing.ticket.id)
    assert.equal(listed.source.sessionTitle, null, 'the list view carries the honest null')
    assert.equal(listed.source.sessionId, 'sess-nope', 'the raw id stays in the payload for the tooltip, not as the title')
    const ingested = service.ingest({
      producer: 'probe',
      level: 'blue',
      title: 'ingest hint',
      options: [{ value: 'ok', label: 'OK' }],
      sessionId: 'sess-1',
      metadata: { sessionTitle: '生产者标题' },
    })
    assert.equal(ingested.ticket.source.sessionTitle, '生产者标题')
    const titles = await service.sessionTitles(['sess-1', 'sess-nope'])
    assert.deepEqual(titles, { ok: true, titles: { 'sess-1': '宿主标题', 'sess-nope': null } })
  } finally {
    drop(ctx, root)
  }
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('decision center: humanizer config has safe defaults, a validated enum and clamped numbers', () => {
  assert.throws(() => Config({ optionHumanize: 'sometimes' }))
  const first = boot()
  try {
    const policy = first.service.policy()
    assert.equal(policy.optionHumanize, 'auto')
    assert.equal(policy.optionLabelMaxChars, 28)
    assert.equal(policy.optionHumanizeTimeoutMs, 10000)
    assert.equal(first.service.aiStatus().optionHumanize.mode, 'auto')
  } finally {
    drop(first.ctx, first.root)
  }
  const second = boot({ config: { optionHumanize: 'rules-only', optionLabelMaxChars: 2, optionHumanizeTimeoutMs: 10 } })
  try {
    assert.equal(second.service.policy().optionLabelMaxChars, 4, 'below-minimum widths are clamped, not accepted')
    assert.equal(second.service.policy().optionHumanizeTimeoutMs, 1000)
  } finally {
    drop(second.ctx, second.root)
  }
})
