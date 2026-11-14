// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// ai-secret-store — AI advisor 的 API Key 持久化：只走 OS 钥匙串 / DPAPI，绝不落明文。
//
// 支持的 backend：
//   * win32  : DPAPI（用户级）——PowerShell 调 ProtectedData.Protect/Unprotect，secret 走 stdin
//   * linux  : secret-tool（Secret Service / libsecret）——secret 走 stdin
//   * darwin : 暂未实现（明确返回 unavailable，不假装成功）
//   * 其它   : unavailable
//
// 磁盘上只存：
//   <dataDir>/decision-ai-secret.json   { version, backend, provider, model, baseUrl, updatedAt }
//   <dataDir>/decision-ai-secret.enc    backend 加密后的 blob（DPAPI 是 base64 密文；secret-tool 不落盘）
// 若 backend 不可用 => available=false，调用方必须退回「仅内存」，绝不写明文。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { ensureDir, writeJsonAtomic } from '../kernel.mjs'

export const SECRET_META_FILE = 'decision-ai-secret.json'
export const SECRET_BLOB_FILE = 'decision-ai-secret.enc'
export const DEFAULT_SERVICE = 'w2m-decision-ai'

const PS_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64=[Console]::In.ReadToEnd()',
  '$bytes=[Convert]::FromBase64String($b64)',
  '$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($enc))',
].join('; ')

const PS_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64=[Console]::In.ReadToEnd()',
  '$bytes=[Convert]::FromBase64String($b64)',
  '$raw=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($raw))',
].join('; ')

/** 默认 runner：同步执行，stdin 传 secret，stdout 回结果；不把 secret 放进 argv。 */
export function defaultRunner(command, args, input = '') {
  const result = spawnSync(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ? String(result.error?.message ?? result.error) : '',
  }
}

export function detectSecretBackend({ platform = process.platform, runner = defaultRunner } = {}) {
  if (platform === 'win32') {
    const probe = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; "ok"'])
    return probe.ok ? { backend: 'dpapi', available: true } : { backend: 'unavailable', available: false, reason: 'dpapi-probe-failed' }
  }
  if (platform === 'linux') {
    const probe = runner('secret-tool', ['--version'])
    return probe.ok ? { backend: 'secret-service', available: true } : { backend: 'unavailable', available: false, reason: 'secret-tool-missing' }
  }
  return { backend: 'unavailable', available: false, reason: platform === 'darwin' ? 'keychain-not-implemented' : 'platform-unsupported' }
}

/**
 * @param {{dataDir:string, platform?:string, runner?:Function, service?:string, logger?:object}} options
 */
export function createAiSecretStore(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  if (!dataDir) throw new Error('createAiSecretStore: dataDir required')
  const platform = options.platform ?? process.platform
  const runner = typeof options.runner === 'function' ? options.runner : defaultRunner
  const service = String(options.service ?? DEFAULT_SERVICE)
  const log = (level, message) => { try { options.logger?.[level]?.(`[ai-secret-store] ${message}`) } catch { /* ignore */ } }
  const metaFile = path.join(dataDir, SECRET_META_FILE)
  const blobFile = path.join(dataDir, SECRET_BLOB_FILE)
  // 懒探测：只有真正需要持久化/读取能力时才执行后端探测（测试/未配置 AI 时零开销）。
  let detection = null
  const ensureBackend = () => {
    if (detection === null) detection = detectSecretBackend({ platform, runner })
    return detection
  }

  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const removeIfExists = (file) => { try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* ignore */ } }

  function encrypt(secretJson) {
    const detection = ensureBackend()
    const plain = Buffer.from(secretJson, 'utf8').toString('base64')
    if (detection.backend === 'dpapi') {
      const out = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], plain)
      if (!out.ok || !out.stdout) return { ok: false, reason: 'dpapi-protect-failed', detail: out.stderr || out.error }
      return { ok: true, payload: out.stdout }
    }
    if (detection.backend === 'secret-service') {
      const out = runner('secret-tool', ['store', '--label', 'dsh-fang decision AI key', 'service', service, 'slot', 'api-key'], secretJson)
      if (!out.ok) return { ok: false, reason: 'secret-tool-store-failed', detail: out.stderr || out.error }
      return { ok: true, payload: '' }
    }
    return { ok: false, reason: 'secret-backend-unavailable' }
  }

  function decrypt(payload) {
    const detection = ensureBackend()
    if (detection.backend === 'dpapi') {
      const out = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], String(payload ?? ''))
      if (!out.ok || !out.stdout) return { ok: false, reason: 'dpapi-unprotect-failed', detail: out.stderr || out.error }
      try { return { ok: true, secretJson: Buffer.from(out.stdout, 'base64').toString('utf8') } } catch { return { ok: false, reason: 'dpapi-decode-failed' } }
    }
    if (detection.backend === 'secret-service') {
      const out = runner('secret-tool', ['lookup', 'service', service, 'slot', 'api-key'])
      if (!out.ok || !out.stdout) return { ok: false, reason: 'secret-tool-lookup-failed', detail: out.stderr || out.error }
      return { ok: true, secretJson: out.stdout }
    }
    return { ok: false, reason: 'secret-backend-unavailable' }
  }

  return {
    get backend() { return ensureBackend().backend },
    get available() { return ensureBackend().available === true },
    get reason() { return ensureBackend().reason ?? null },
    service,
    capabilities() {
      const detection = ensureBackend()
      return { backend: detection.backend, available: detection.available === true, reason: detection.reason ?? null, encryptedAtRest: detection.backend === 'dpapi' ? 'dpapi-user' : detection.backend === 'secret-service' ? 'os-secret-service' : 'none' }
    },
    /** 保存 { provider, model, baseUrl, apiKey }；失败返回 ok:false，调用方保持仅内存。 */
    save(config = {}) {
      const detection = ensureBackend()
      if (!detection.available) return { ok: false, reason: detection.reason ?? 'secret-backend-unavailable' }
      const apiKey = String(config.apiKey ?? '').trim()
      if (!apiKey) return { ok: false, reason: 'api-key-required' }
      const meta = {
        version: 1,
        backend: detection.backend,
        provider: String(config.provider ?? '').slice(0, 40),
        model: String(config.model ?? '').slice(0, 120),
        baseUrl: String(config.baseUrl ?? '').slice(0, 500),
        updatedAt: Date.now(),
      }
      const encrypted = encrypt(JSON.stringify({
        apiKey,
        ...(Array.isArray(config.profiles) ? { profiles: config.profiles } : {}),
        ...(config.routes && typeof config.routes === 'object' ? { routes: config.routes } : {}),
        ...(config.modelByLevel && typeof config.modelByLevel === 'object' ? { modelByLevel: config.modelByLevel } : {}),
      }))
      if (!encrypted.ok) return encrypted
      try {
        ensureDir(dataDir)
        if (encrypted.payload) {
          fs.writeFileSync(blobFile, encrypted.payload, { encoding: 'utf8', mode: 0o600 })
          try { fs.chmodSync(blobFile, 0o600) } catch { /* windows */ }
        }
        writeJsonAtomic(metaFile, meta)
        return { ok: true, backend: detection.backend, meta }
      } catch (error) {
        log('warn', `save failed: ${String(error?.message ?? error)}`)
        return { ok: false, reason: 'persist-failed', detail: String(error?.message ?? error) }
      }
    },
    /** 读取已持久化配置；不存在/backend 不匹配/解密失败 => null（不抛）。 */
    load() {
      // 没有落盘元数据时不要探测 backend（避免无 AI 配置的宿主每次启动都拉起 PowerShell）。
      if (!fs.existsSync(metaFile)) return null
      const detection = ensureBackend()
      if (!detection.available) return null
      const meta = readJson(metaFile)
      if (!meta || meta.backend !== detection.backend) return null
      let payload = ''
      try { payload = fs.existsSync(blobFile) ? fs.readFileSync(blobFile, 'utf8') : '' } catch { payload = '' }
      if (detection.backend === 'dpapi' && !payload) return null
      const decrypted = decrypt(payload)
      if (!decrypted.ok) { log('warn', `load failed: ${decrypted.reason}`); return null }
      let secret = null
      try { secret = JSON.parse(decrypted.secretJson) } catch { return null }
      const apiKey = String(secret?.apiKey ?? '').trim()
      if (!apiKey) return null
      return {
        provider: String(meta.provider ?? 'custom'),
        model: String(meta.model ?? ''),
        baseUrl: String(meta.baseUrl ?? ''),
        apiKey,
        ...(Array.isArray(secret.profiles) ? { profiles: secret.profiles } : {}),
        ...(secret.routes && typeof secret.routes === 'object' ? { routes: secret.routes } : {}),
        ...(secret.modelByLevel && typeof secret.modelByLevel === 'object' ? { modelByLevel: secret.modelByLevel } : {}),
        source: `os:${detection.backend}`,
        backend: detection.backend,
      }
    },
    clear() {
      removeIfExists(metaFile)
      removeIfExists(blobFile)
      if (ensureBackend().backend === 'secret-service') {
        try { runner('secret-tool', ['clear', 'service', service, 'slot', 'api-key']) } catch { /* ignore */ }
      }
      return { ok: true }
    },
  }
}
