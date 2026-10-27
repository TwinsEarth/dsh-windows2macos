#!/usr/bin/env node
/**
 * Remote-triggerable, verified self-update for the W2M plugin.
 *
 * Fleet policy (operator): a machine is upgraded by dispatching this script as a task
 * (`node <profile>/node_modules/@twinsearth/w2m-dsh-plugin/bin/w2m-self-update.mjs`), and only
 * when that fails is a Node remote-execution fallback used. This file is therefore headless:
 * it checks the configured GitHub release, verifies the published sha256, installs through the
 * same updater the plugin UI uses, and prints one JSON line. It never restarts DSH.
 *
 * Usage:
 *   node bin/w2m-self-update.mjs [--profile <dir|name>] [--dry-run] [--allow-prerelease] [--json]
 *
 * Exit codes: 0 installed or already current; 1 check/install failed; 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAutoUpdater, findProfileDir } from '../src/plugin/auto-update.mjs';

const DEFAULT_REPO = 'TwinsEarth/dsh-windows2macos';
const PACKAGE_NAME = '@twinsearth/w2m-dsh-plugin';

function parseArgs(argv) {
  const args = { profile: null, dryRun: false, allowPrerelease: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') { args.profile = argv[i + 1] ?? null; i += 1; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--allow-prerelease') { args.allowPrerelease = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--json') { args.json = true; continue; }
    args.unknown = arg;
  }
  return args;
}

function readInstalledVersion(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function resolveProfile(input) {
  if (input !== null) {
    if (existsSync(input)) return input;
    // A bare profile name resolves under the DSH home directory.
    const named = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', input);
    if (existsSync(named)) return named;
    return null;
  }
  if (typeof process.env.W2M_PROFILE_DIR === 'string' && existsSync(process.env.W2M_PROFILE_DIR)) return process.env.W2M_PROFILE_DIR;
  return findProfileDir() ?? null;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  process.stdout.write(
    'Usage: w2m-self-update [--profile <dir|name>] [--dry-run] [--allow-prerelease]\n' +
    'Checks GitHub releases, verifies sha256, installs the newer plugin build for the next start.\n',
  );
  process.exit(0);
}
if (args.unknown !== undefined) {
  process.stderr.write(`unknown argument: ${args.unknown}\n`);
  process.exit(2);
}

const profileDir = resolveProfile(args.profile);
if (profileDir === null) {
  process.stdout.write(JSON.stringify({ ok: false, outcome: 'error', error: 'no DSH profile directory found; pass --profile <dir>' }) + '\n');
  process.exit(2);
}

const currentVersion = readInstalledVersion(profileDir);
const updater = createAutoUpdater({
  profileDir,
  currentVersion,
  repo: process.env.W2M_UPDATE_REPO ?? DEFAULT_REPO,
  dryRun: args.dryRun,
  allowPrerelease: args.allowPrerelease,
  enabled: false,
});

let result;
try {
  result = await updater.check('manual');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, outcome: 'error', error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exit(1);
}

const outcome = result?.outcome ?? 'unknown';
const ok = result?.ok === true && (outcome === 'installed' || outcome === 'up-to-date' || outcome === 'current' || outcome === 'skipped');
process.stdout.write(JSON.stringify({
  ok,
  outcome,
  current: currentVersion,
  latest: result?.tag ?? result?.to ?? null,
  reason: result?.reason ?? null,
  error: result?.error ?? null,
  restart_required: outcome === 'installed',
}) + '\n');
process.exit(ok ? 0 : 1);
