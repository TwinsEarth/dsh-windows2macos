// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang test helpers — a minimal Cordis-like context.
// Mirrors exactly the API surface the installed plugins rely on:
//   ctx.effect(() => disposer) | ctx.provide(key, value) | ctx.get(key)
//   ctx.inject([...names], cb) | ctx.plugin(module, config) | ctx.logger
// Events go through the kernel module-level bus, so they behave like the host process.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { bus } from '../../src/decision-center/kernel.mjs'

export function makeCtx({ services = {} } = {}) {
  const provided = new Map()
  const disposers = []
  const children = []

  const ctx = {
    logger: {
      debug() {}, info() {}, warn() {}, error() {}, child() { return ctx.logger },
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    provide(key, value) {
      if (provided.has(key)) throw new Error(`service "${key}" has been registered`)
      provided.set(key, value)
      return () => provided.delete(key)
    },
    get(key) {
      if (provided.has(key)) return provided.get(key)
      if (key in services) return services[key]
      return undefined
    },
    has(key) {
      return provided.has(key) || key in services
    },
    inject(names, callback) {
      const child = makeCtx({ services: { ...services } })
      for (const [k, v] of provided) child.provide(k, v)
      child.__parent = ctx
      children.push(child)
      return callback(child)
    },
    plugin(pluginModule, config) {
      if (!pluginModule || typeof pluginModule.apply !== 'function') {
        throw new Error('not a plugin: missing apply()')
      }
      return pluginModule.apply(ctx, config ?? {})
    },
    on(topic, fn) { return bus.on(topic, fn) },
    emit(topic, payload) { return bus.emit(topic, payload) },
    disposed: false,
  }

  ctx.dispose = () => {
    ctx.disposed = true
    for (const d of disposers.reverse()) {
      try { d() } catch { /* ignore */ }
    }
    for (const c of children) c.dispose()
    provided.clear()
    bus.clear()
  }

  return ctx
}

/** Build just enough of a `webServer` to assert route registration without a socket. */
export function makeWebServerStub() {
  const routes = []
  return {
    routes,
    register(spec) {
      const entry = { kind: spec?.kind, path: spec?.path, method: spec?.method ?? '', handler: spec?.handler }
      routes.push(entry)
      return () => {
        const i = routes.indexOf(entry)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    find(method, path) {
      return routes.find((r) => {
        if (r.path !== path) return false
        const methods = String(r.method ?? '').split(',').filter(Boolean)
        return methods.length === 0 || methods.includes(method)
      }) ?? null
    },
    paths() {
      return routes.map(r => r.path)
    },
  }
}

/** A fake http response recorder for handler tests. */
export function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers ?? {}) },
    setHeader(name, value) { res.headers[String(name).toLowerCase()] = value },
    end(chunk) { res.body += chunk ?? '' },
    json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

/** A fake http request with an optional JSON body. */
export const TEST_AUTH_TOKEN = 'test-auth-token-0123456789abcdef0123456789abcdef'

export function makeReq(body = undefined, method = 'GET') {
  const req = new EventEmitter()
  req.method = method
  req.headers = {
    host: '127.0.0.1:1',
    'x-fang-auth': TEST_AUTH_TOKEN,
    'content-type': 'application/json',
  }
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined && method !== 'GET') req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

export function tmpDir(prefix = 'fang-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeTempFile(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

export { fs, os, path }
