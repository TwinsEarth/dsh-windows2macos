#!/usr/bin/env node
/**
 * P2P 握手可验证脚本（信号面 + 失败面）。
 *
 * 能做（无副作用）：
 *   1. relay 信令：/v1/devices + 每个 peer 的 /v1/peer/<id> → 候选、static key、NAT；
 *   2. 输出明确的阶段判定：signal=ok / no-candidates / key-missing；
 *   3. 提醒：UDP 打洞与 AEAD 握手结果在 w2m_status.p2p（punches/dial_failures/handshakes/
 *      last_error）里，那里是显式状态，不会静默回退。
 *
 * 用法：node scripts/p2p-handshake-check.mjs [--relay http://...] [--device <.../device.json>] [--json]
 *
 * `--device` 的默认值是**按本机状态目录算出来的**，不是某个人的固定路径：v3.7.3 里它硬编码成一个
 * Windows 用户目录下的 `device.json`，于是 macOS/Linux 上不带参数直调必 ENOENT，把"没配对"报成了
 * "脚本坏了"。默认值现在与 `bin/w2m-rabbit.mjs` 等入口共用 `resolveStateDir`，`DSH_HOME` 指向一次性
 * profile 时也跟随。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, resolveStateDir } from '../src/util/cli.mjs';

/** The device.json this machine would use when `--device` is not given. */
export function resolveDevicePath(argumentsList = process.argv.slice(2), env = process.env) {
  const index = argumentsList.indexOf('--device');
  if (index >= 0) {
    const explicit = argumentsList[index + 1];
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit;
  }
  return join(resolveStateDir(null, '', env), 'device.json');
}

function parseArguments(argumentsList) {
  const args = { relay: null, device: resolveDevicePath(argumentsList), json: false };
  for (let i = 0; i < argumentsList.length; i += 1) {
    const arg = argumentsList[i];
    if (arg === '--relay') { args.relay = argumentsList[i + 1] ?? null; i += 1; } else if (arg === '--device') { i += 1; } else if (arg === '--json') args.json = true;
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const dev = JSON.parse(readFileSync(args.device, 'utf8'));
  const relay = (args.relay ?? dev.rabbit_url).replace(/\/+$/, '');
  const token = dev.device_token;
  if (typeof token !== 'string' || token === '') {
    console.error('device.json has no device_token; pair this machine first');
    process.exit(2);
  }
  const headers = { authorization: 'Bearer ' + token, accept: 'application/json' };

  const listResponse = await fetch(relay + '/v1/devices', { headers });
  const listed = await listResponse.json().catch(() => null);
  if (listResponse.ok !== true) {
    console.error('relay /v1/devices refused: HTTP ' + listResponse.status);
    process.exit(3);
  }
  const devices = Array.isArray(listed?.devices) ? listed.devices : [];
  const rows = [];
  for (const device of devices) {
    if (device.machine_id === dev.machine_id) continue;
    let peer = null;
    try {
      const response = await fetch(relay + '/v1/peer/' + encodeURIComponent(device.machine_id), { headers });
      peer = response.ok ? await response.json() : null;
    } catch { peer = null; }
    const p = peer?.peer ?? null;
    const candidates = Array.isArray(p?.candidates) ? p.candidates.length : 0;
    rows.push({
      machine: device.name ?? device.machine_id,
      machine_id: device.machine_id,
      signal: candidates > 0 && typeof p?.static_key === 'string' && p.static_key !== '' ? 'signal-ok' : candidates > 0 ? 'key-missing' : 'no-candidates',
      candidates,
      nat: p?.nat?.mapping ?? p?.nat ?? null,
      expires_at: p?.expires_at ?? null,
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ relay, self: dev.machine_id, peers: rows }, null, 2));
  } else {
    console.log('relay ' + relay + ' self ' + dev.machine_id);
    for (const row of rows) console.log([row.signal, row.machine, 'candidates=' + row.candidates, 'nat=' + String(row.nat)].join('  '));
    console.log('\nnext: read w2m_status.p2p for punch/handshake outcome (punches_in/out, dial_failures, handshakes, last_error).');
  }
  process.exit(rows.length > 0 && rows.every((row) => row.signal === 'signal-ok') ? 0 : 1);
}

if (isMainModule(import.meta.url)) await main();
