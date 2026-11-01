/**
 * `/api/w2m/fleet-config` (v2.2.1): the settings-page half of the fleet pin.
 *
 *   GET  /api/w2m/fleet-config
 *        → {ok, configured, policy, fleet_id, fingerprint, path}
 *   POST /api/w2m/fleet-config {action:'preview', fleet_key, expected_fleet_id?}
 *        → {ok, fleet_id, fleet_key_fingerprint, matches_expected}   (writes nothing)
 *   POST /api/w2m/fleet-config {action:'save', fleet_key, expected_fleet_id?}
 *        → {ok, configured, policy, fleet_id, fingerprint, path, backup, restart_required}
 *
 * The raw key is never returned. `preview` is the confirmation step: the page shows the derived
 * fleet id, the operator compares it with the expected id, and only then does `save` replace the
 * file (with a timestamped backup and rollback).
 */

import { fingerprintOf } from './operator-token.mjs';
import { readFleetConfig, writeFleetConfig } from './fleet-config.mjs';

export const FLEET_CONFIG_ROUTE_PATH = '/api/w2m/fleet-config';
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * @param {object} ctx Cordis context.
 * @param {{file?: string|(() => string|null)}} [deps]
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerFleetConfigRoute(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const fileOf = () => (typeof deps.file === 'function' ? deps.file() : deps.file ?? null);

    registry.register({
      path: FLEET_CONFIG_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const file = fileOf();
        if (typeof file !== 'string' || file === '') {
          return Response.json({ ok: false, code: 'FLEET_CONFIG_NO_STATE', error: 'no state directory is known' }, { status: 503, headers: NO_STORE });
        }

        if (request.method === 'GET') {
          const read = readFleetConfig(file);
          if (read.ok !== true) {
            return Response.json({ ok: false, code: read.code, error: read.error, path: read.path }, { status: 500, headers: NO_STORE });
          }
          const config = read.config;
          return Response.json({
            ok: true,
            configured: config !== null,
            policy: config?.policy ?? null,
            fleet_id: config?.fleetId ?? null,
            fingerprint: config === null ? null : fingerprintOf(config.fleetKey),
            updated_at: config?.updatedAt ?? null,
            path: file,
            source: config === null ? 'none' : 'file',
          }, { headers: NO_STORE });
        }

        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ ok: false, code: 'FLEET_CONFIG_BAD_BODY', error: 'send a JSON object' }, { status: 400, headers: NO_STORE });
        }
        const action = body.action;
        if (action !== 'preview' && action !== 'save') {
          return Response.json({ ok: false, code: 'FLEET_CONFIG_BAD_ACTION', error: 'action must be preview or save' }, { status: 400, headers: NO_STORE });
        }
        const fleetKey = typeof body.fleet_key === 'string' ? body.fleet_key.trim() : '';
        if (fleetKey === '') {
          return Response.json({ ok: false, code: 'FLEET_CONFIG_KEY_REQUIRED', error: 'fleet_key is required' }, { status: 400, headers: NO_STORE });
        }
        const { planJoin } = await import('../chatops/fleet-join.mjs');
        const plan = planJoin({ fleetKeyEncoded: fleetKey });
        if (plan.ok !== true) {
          return Response.json({ ok: false, code: plan.reason, error: plan.text }, { status: 400, headers: NO_STORE });
        }
        const expected = typeof body.expected_fleet_id === 'string' ? body.expected_fleet_id.trim().toLowerCase() : '';
        const matchesExpected = expected === '' ? null : expected === plan.fleetId;
        if (action === 'preview') {
          return Response.json({
            ok: true,
            action: 'preview',
            fleet_id: plan.fleetId,
            fleet_key_fingerprint: fingerprintOf(fleetKey),
            matches_expected: matchesExpected,
          }, { headers: NO_STORE });
        }
        if (matchesExpected === false) {
          return Response.json({
            ok: false,
            code: 'FLEET_CONFIG_FLEET_ID_MISMATCH',
            error: 'the key derives a different fleet_id than the expected one',
            fleet_id: plan.fleetId,
            expected_fleet_id: expected,
          }, { status: 409, headers: NO_STORE });
        }

        const written = writeFleetConfig(file, {
          fleetKey,
          fleetId: plan.fleetId,
          policy: 'config',
        });
        if (written.ok !== true) {
          return Response.json({ ok: false, code: written.code, error: written.error, path: written.path }, { status: 500, headers: NO_STORE });
        }
        return Response.json({
          ok: true,
          action: 'save',
          configured: true,
          policy: 'config',
          fleet_id: plan.fleetId,
          fingerprint: fingerprintOf(fleetKey),
          path: written.path,
          backup: written.backup,
          restart_required: true,
        }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
