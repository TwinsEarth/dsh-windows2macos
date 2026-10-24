/**
 * `/api/w2m/plugin-update` — the host half of the plugin panel's "更新" button (v1.6.8).
 *
 * Wire:
 *   GET  /api/w2m/plugin-update[?check=1] -> { ok, current, latest, update_available, error? }
 *   POST /api/w2m/plugin-update           { action: 'apply' }
 *        -> { ok, outcome, from, to, installed, restart_required, error? }
 *
 * The GET half asks npm for `latest` (src/plugin/npm-update.mjs). The POST half delegates the write
 * to the already-verified updater: `auto-update.mjs` downloads the release tarball, verifies its
 * SHA-256 against SHA256SUMS, installs it over the profile package with a backup, and records the
 * outcome. This module never writes the profile itself — that division is what keeps a button click
 * from inventing a second install path with weaker checks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkNpmUpdate } from './npm-update.mjs';

export const PLUGIN_UPDATE_ROUTE_PATH = '/api/w2m/plugin-update';
const NO_STORE = { 'cache-control': 'no-store' };

/** Read the version installed in the profile's node_modules; null when it cannot be read. */
export function readInstalledVersion(profileDir) {
  try {
    const text = readFileSync(join(profileDir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'package.json'), 'utf8');
    const parsed = JSON.parse(text);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Mount the route on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context
 * @param {{profileDir: () => string|null, createUpdater?: (options: object) => object}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerPluginUpdateRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    registry.register({
      path: PLUGIN_UPDATE_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
          return Response.json({ ok: false, error: request.method + ' is not a method this route answers', reason_code: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: NO_STORE });
        }
        const profileDir = typeof deps?.profileDir === 'function' ? deps.profileDir() : null;
        if (typeof profileDir !== 'string' || profileDir === '') {
          return Response.json({ ok: false, error: 'no DSH profile directory was found, so there is nothing to update', reason_code: 'NO_PROFILE' }, { status: 400, headers: NO_STORE });
        }
        const current = readInstalledVersion(profileDir);
        if (request.method === 'GET') {
          const checked = await checkNpmUpdate({ currentVersion: current });
          return Response.json({ ...checked, profile_dir: profileDir }, { headers: NO_STORE });
        }
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body !== 'object' || body.action !== 'apply') {
          return Response.json({ ok: false, error: 'a JSON body with {"action":"apply"} is required', reason_code: 'UPDATE_BODY_INVALID' }, { status: 400, headers: NO_STORE });
        }
        // Refuse before installing when npm says there is nothing newer.
        const checked = await checkNpmUpdate({ currentVersion: current });
        if (checked.ok !== true) {
          return Response.json({ ok: false, outcome: 'check-failed', error: checked.error, current, restart_required: false }, { status: 502, headers: NO_STORE });
        }
        if (checked.update_available !== true) {
          return Response.json({ ok: true, outcome: 'up-to-date', current, latest: checked.latest, installed: false, restart_required: false }, { headers: NO_STORE });
        }
        let updater;
        try {
          updater = deps?.createUpdater !== undefined ? deps.createUpdater({ profileDir, currentVersion: current }) : await defaultUpdater({ profileDir, currentVersion: current });
        } catch (error) {
          return Response.json({ ok: false, outcome: 'error', error: error instanceof Error ? error.message : String(error), current, restart_required: false }, { status: 500, headers: NO_STORE });
        }
        const result = await updater.check('manual');
        const installedTo = typeof result?.to === 'string' && result.to !== '' ? result.to : null;
        const installed = result?.outcome === 'installed' || installedTo !== null && installedTo !== current;
        return Response.json({
          ok: result?.ok === true && installed === true,
          outcome: result?.outcome ?? 'unknown',
          from: result?.from ?? current,
          to: installedTo,
          installed,
          reason: result?.reason ?? null,
          error: result?.error ?? null,
          restart_required: installed === true,
        }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}

/** Build the verified updater for a manual install (lazy import keeps this route cheap to load). */
async function defaultUpdater({ profileDir, currentVersion }) {
  const { createAutoUpdater } = await import('./auto-update.mjs');
  return createAutoUpdater({
    profileDir,
    currentVersion,
    enabled: true,
    // A button click is an explicit request: no daily minimum interval may swallow it.
    intervalDays: 0,
    log: () => {},
  });
}
