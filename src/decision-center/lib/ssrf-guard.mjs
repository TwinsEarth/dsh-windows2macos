// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// ssrf-guard — AI / 出站端点的最小 SSRF 防护：
//   * 字面量私网 IP：默认拒绝，除非显式 allowlist
//   * 云元数据地址/主机名：永远拒绝（allowlist 也不能放行）
//   * hostname：配置时只做语法检查；请求前做一次 DNS 解析，
//     解析到私网/元数据则拒绝（防“公网域名解析到内网”的常见 SSRF）
//
// 诚实边界：DNS 预检与 fetch 的真实解析之间仍有 TOCTOU 窗口（DNS rebinding），
// Node fetch 没有 pinned-lookup 接口；因此这里只做“高置信拦截”，不宣称完备。
import net from 'node:net'
import dns from 'node:dns/promises'

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS / GCP / Azure IMDS
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IPv6 IMDS
])

export function normalizeHost(value) {
  let host = String(value ?? '').trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return host.replace(/\.$/, '')
}

export function isMetadataAddress(value) {
  return METADATA_ADDRESSES.has(normalizeHost(value))
}

export function isMetadataHost(value) {
  return METADATA_HOSTS.has(normalizeHost(value))
}

const inV4Range = (parts, base, bits) => {
  if (!Array.isArray(parts) || parts.length !== 4) return false
  let value = 0
  for (const part of parts) value = (value << 8) | part
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (value & mask) === (base & mask)
}

function ipv4Parts(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts
}

function ipv4ToInt(parts) {
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

export function isPrivateIpv4(ip) {
  const parts = ipv4Parts(ip)
  if (!parts) return false
  const value = ipv4ToInt(parts)
  // RFC1918
  if (inV4Range(parts, ipv4ToInt([10, 0, 0, 0]), 8)) return true
  if (inV4Range(parts, ipv4ToInt([172, 16, 0, 0]), 12)) return true
  if (inV4Range(parts, ipv4ToInt([192, 168, 0, 0]), 16)) return true
  // loopback / link-local / unspecified
  if (inV4Range(parts, ipv4ToInt([127, 0, 0, 0]), 8)) return true
  if (inV4Range(parts, ipv4ToInt([169, 254, 0, 0]), 16)) return true
  if (inV4Range(parts, ipv4ToInt([0, 0, 0, 0]), 8)) return true
  // CGNAT / benchmark / multicast / reserved
  if (inV4Range(parts, ipv4ToInt([100, 64, 0, 0]), 10)) return true
  if (inV4Range(parts, ipv4ToInt([198, 18, 0, 0]), 15)) return true
  if (inV4Range(parts, ipv4ToInt([198, 51, 100, 0]), 24)) return true
  if (inV4Range(parts, ipv4ToInt([203, 0, 113, 0]), 24)) return true
  if (((value & 0xF0000000) >>> 0) === 0xE0000000) return true // multicast
  if (((value & 0xF0000000) >>> 0) === 0xF0000000) return true // reserved
  return false
}

function ipv6Groups(ip) {
  const raw = normalizeHost(ip)
  if (!raw.includes(':')) return null
  const [head, tail] = raw.split('::')
  const parse = (segment) => segment.length === 0 ? [] : segment.split(':')
  let groups = []
  if (raw.includes('::')) groups = [...parse(head), ...Array(8 - parse(head).length - parse(tail ?? '').length).fill('0'), ...parse(tail ?? '')]
  else groups = raw.split(':')
  if (groups.length !== 8) return null
  return groups.map((group) => parseInt(group || '0', 16)).filter((part) => Number.isInteger(part))
}

export function isPrivateIpv6(ip) {
  const raw = normalizeHost(ip)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  if (mapped) return isPrivateIpv4(mapped[1])
  const groups = ipv6Groups(raw)
  if (!groups) return false
  if (groups.every((group, index) => (index < 7 ? group === 0 : group === 1))) return true // ::1
  if (groups.every((group) => group === 0)) return true // ::
  if ((groups[0] & 0xFE00) === 0xFC00) return true // fc00::/7
  if ((groups[0] & 0xFFC0) === 0xFE80) return true // fe80::/10
  if ((groups[0] & 0xFF00) === 0xFF00) return true // multicast
  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xFFFF) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xFF}.${groups[7] >> 8}.${groups[7] & 0xFF}`
    return isPrivateIpv4(v4)
  }
  return false
}

export function isPrivateAddress(ip) {
  const host = normalizeHost(ip)
  const family = net.isIP(host)
  if (family === 4) return isPrivateIpv4(host)
  if (family === 6) return isPrivateIpv6(host)
  return false
}

/** 同步分类：仅处理字面量 IP 与元数据主机名；DNS 主机名留给请求前预检。 */
export function classifyEndpointHost(hostname, { allowHosts = [] } = {}) {
  const host = normalizeHost(hostname)
  const allowed = new Set((Array.isArray(allowHosts) ? allowHosts : []).map(normalizeHost))
  if (isMetadataHost(host)) return { ok: false, reason: 'metadata-address-blocked', kind: 'metadata' }
  const family = net.isIP(host)
  if (family === 0) {
    if (host === 'localhost') return { ok: true, kind: 'loopback' }
    return { ok: true, kind: 'hostname' }
  }
  if (isMetadataAddress(host)) return { ok: false, reason: 'metadata-address-blocked', kind: 'metadata' }
  if (family === 4 && inV4Range(ipv4Parts(host) ?? [], ipv4ToInt([127, 0, 0, 0]), 8)) return { ok: true, kind: 'loopback' }
  if (family === 6) {
    const groups = ipv6Groups(host)
    if (groups && groups.every((group, index) => (index < 7 ? group === 0 : group === 1))) return { ok: true, kind: 'loopback' }
  }
  if ((family === 4 && isPrivateIpv4(host)) || (family === 6 && isPrivateIpv6(host))) {
    if (allowed.has(host)) return { ok: true, kind: 'private-allowlisted' }
    return { ok: false, reason: 'private-address-blocked', kind: 'private' }
  }
  return { ok: true, kind: family === 4 ? 'public-ipv4' : 'public-ipv6' }
}

/** 请求前 DNS 预检；解析失败视为 NXDOMAIN（交给 fetch 失败，不视为 SSRF）。 */
export async function assertEndpointSafe(hostname, { allowHosts = [], resolve = dns.lookup, timeoutMs = 1500 } = {}) {
  const sync = classifyEndpointHost(hostname, { allowHosts })
  if (!sync.ok) return sync
  if (sync.kind !== 'hostname') return sync
  const host = normalizeHost(hostname)
  const allowed = new Set((Array.isArray(allowHosts) ? allowHosts : []).map(normalizeHost))
  // 明确的 metadata 主机名已在 sync 拦截；其余做一次解析。
  let addresses = []
  try {
    const result = await Promise.race([
      resolve(host, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), timeoutMs).unref?.()),
    ])
    addresses = Array.isArray(result) ? result : (result?.address ? [result] : [])
  } catch (error) {
    return { ok: true, kind: 'hostname-unresolved', detail: String(error?.message ?? error) }
  }
  for (const entry of addresses) {
    const address = normalizeHost(entry?.address ?? entry)
    if (isMetadataAddress(address)) return { ok: false, reason: 'metadata-address-blocked', kind: 'metadata', address }
    if (isPrivateAddress(address) && !allowed.has(host)) {
      return { ok: false, reason: 'private-address-blocked', kind: 'private', address }
    }
  }
  return { ok: true, kind: 'hostname-public', addresses: addresses.map((entry) => normalizeHost(entry?.address ?? entry)) }
}
