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
 * 用法：node scripts/p2p-handshake-check.mjs [--relay http://...] [--device C:\...\device.json] [--json]
 */
import { readFileSync } from 'node:fs';

const args = { relay: null, device: 'C:/Users/fangw/.dsh/xclient/device.json', json: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--relay') { args.relay = process.argv[i + 1] ?? null; i += 1; } else if (arg === '--device') { args.device = process.argv[i + 1] ?? args.device; i += 1; } else if (arg === '--json') args.json = true;
}

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
