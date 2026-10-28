/**
 * ToFuture identity report (S2): collect every NIC, HMAC it, send only HMACs.
 *
 * Raw MAC/IP values exist only inside this function's local scope. The request body carries
 * `{v, machine_id, ts_ms, nonce, entries:[{kind, salt_id, hmac}]}` and nothing else.
 */
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

import { identityHmac } from '../../util/tofuture-hmac.mjs';

export function collectIdentityEntries(machineId, fleetKey) {
  const entries = [];
  for (const rows of Object.values(networkInterfaces())) {
    for (const row of rows ?? []) {
      const mac = typeof row?.mac === 'string' ? row.mac.trim() : '';
      if (mac !== '' && mac !== '00:00:00:00:00:00') entries.push(identityHmac(fleetKey, machineId, 'mac', mac.toLowerCase()));
      const family = row?.family === 4 || row?.family === 'IPv4' ? 'ipv4' : (row?.family === 6 || row?.family === 'IPv6' ? 'ipv6' : null);
      if (family !== null && typeof row?.address === 'string' && row.address !== '') entries.push(identityHmac(fleetKey, machineId, family, row.address));
    }
  }
  return entries;
}

export function buildIdentifyBody({ machineId, fleetKey, now = Date.now() }) {
  return { v: 1, machine_id: machineId, ts_ms: now, nonce: randomBytes(12).toString('hex'), entries: collectIdentityEntries(machineId, fleetKey) };
}

/**
 * @param {{request: Function, rabbitUrl: string, token: string, machineId: string, fleetKey: string, signal?: AbortSignal}} input
 * @returns {Promise<{ok: boolean, matched?: boolean, code?: string}>} — never carries identifiers
 */
export async function reportIdentity(input) {
  if (typeof input?.fleetKey !== 'string' || input.fleetKey === '') return { ok: false, code: 'HIDDEN_STATE_NO_KEY' };
  const body = buildIdentifyBody({ machineId: input.machineId, fleetKey: input.fleetKey });
  try {
    const result = await input.request({ rabbitUrl: input.rabbitUrl, token: input.token, method: 'POST', pathname: '/v1/tofuture/identify', body, signal: input.signal });
    // The relay answers 204 for both outcomes; a non-2xx is a transport/shape failure, not membership.
    if (result?.ok === true) return { ok: true };
    return { ok: false, code: result?.error?.code ?? 'TOFUTURE_REPORT_REFUSED' };
  } catch {
    return { ok: false, code: 'TOFUTURE_REPORT_FAILED' };
  }
}
