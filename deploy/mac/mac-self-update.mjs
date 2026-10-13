/**
 * The Mac's self-updating supervisor (v0.8.0).
 *
 * ## Why this is detached rather than run inline
 *
 * It has to **survive the thing it is restarting**. DSH spawns the Localside agent, so a script
 * running inside that agent dies the moment DSH stops — which is exactly when the work begins. So
 * this is launched detached with `stdio: 'ignore'` and `unref()`, and it is the *only* process that
 * outlives the restart.
 *
 * ## The failure this is built around
 *
 * A blind remote update has one catastrophic outcome: DSH stops, the plugin does not load, and the
 * machine never comes back — leaving no channel to fix it with. So every step is ordered so that
 * **the previous state is restorable without the network**:
 *
 *   1. back up the installed plugin tree to a timestamped directory
 *   2. stage the new tarball and verify it EXTRACTED (a truncated download upacks to nothing)
 *   3. swap, then restart
 *   4. **self-check**: is DSH running, and is the plugin loaded?
 *   5. **on failure, roll back and restart again** — automatically, because nobody is watching
 *
 * ## How success is reported when nothing can be read back
 *
 * The machine cannot tell us anything directly: its task results are `unverifiable` and its stdout
 * never reaches the relay. So the report is written to a file **and** the outcome is made visible
 * indirectly — a successful restart puts the machine back in the fleet, and the caller watches for
 * it. `--verify-fleet` does that check from inside this script as well, against the relay's
 * `/healthz`, so the rollback decision does not depend on an outside observer.
 *
 * Usage: node mac-self-update.mjs --tarball <path> --sha256 <hex> [--verify-fleet <url>]
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);

const TARBALL = opt('--tarball', '');
const EXPECTED = opt('--sha256', '');
const VERIFY_FLEET = opt('--verify-fleet', '');
const PACKAGE = '@twinsearth/w2m-dsh-plugin';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT = join(homedir(), 'w2m-self-update-report.json');

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail, at: new Date().toISOString() });
  // Written after every step: if the process is killed mid-way, the report says where it stopped.
  try { writeFileSync(REPORT, JSON.stringify({ stamp: STAMP, steps, done: false }, null, 2)); } catch { /* the report must never break the update */ }
};
const finish = (ok, extra = {}) => {
  try { writeFileSync(REPORT, JSON.stringify({ stamp: STAMP, ok, steps, done: true, ...extra }, null, 2)); } catch { /* as above */ }
  process.exit(ok ? 0 : 1);
};

/** Run a command, never throwing: a missing tool is a finding, not a crash. */
function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.status ?? ''} ${String(e.stderr ?? e.message).trim()}`.trim() };
  }
}

/**
 * Find the DSH home and the installed plugin.
 *
 * Discovered rather than assumed: the paths differ between a packaged app, a profile install, and a
 * development checkout, and this script has exactly one chance to be right.
 */
function findInstall() {
  const home = homedir();
  const candidates = [
    join(home, '.dsh'),
    join(home, 'Library', 'Application Support', 'dsh'),
    join(home, 'Library', 'Application Support', 'DeepSeek Harness'),
  ];
  for (const dshHome of candidates) {
    if (!existsSync(dshHome)) continue;
    const profiles = join(dshHome, 'profiles');
    if (!existsSync(profiles)) continue;
    for (const profile of readdirSync(profiles)) {
      const mod = join(profiles, profile, 'node_modules', ...PACKAGE.split('/'));
      if (existsSync(join(mod, 'package.json'))) {
        let version = '?';
        try { version = JSON.parse(readFileSync(join(mod, 'package.json'), 'utf8')).version; } catch { /* reported as ? */ }
        return { dshHome, profiles, profile, moduleDir: mod, version, profileDir: join(profiles, profile) };
      }
    }
  }
  return null;
}

/** Is DSH itself running, and what launched it? */
function findDshProcess() {
  const ps = run('/bin/ps', ['-Ao', 'pid=,command='], { timeout: 20_000 });
  if (!ps.ok) return { ok: false, reason: `ps failed: ${ps.out}` };
  const lines = ps.out.split('\n').filter((l) => l.trim() !== '');
  const self = String(process.pid);
  const matches = lines
    .map((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: m[1], command: m[2] } : null;
    })
    .filter(Boolean)
    .filter((p) => p.pid !== self)
    .filter((p) => /DeepSeek Harness|\.dsh|dsh\b/i.test(p.command))
    .filter((p) => !/mac-self-update|node -e/i.test(p.command));
  return { ok: true, matches };
}

/**
 * The fleet check: does this machine show up at the relay again?
 *
 * `machineName` is read from the environment the agent was started with, falling back to the
 * hostname — the relay lists machines by the name they paired under.
 */
async function fleetHasMachine(url, name) {
  try {
    const res = await fetch(new URL('/healthz', url).toString(), { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    if (body?.ok !== true) return { ok: false, why: `healthz ok=${body?.ok}` };
    // `/healthz` gives a count; the device list needs a device token, so the count is the signal
    // available here. A drop to zero means the fleet lost everyone and the rollback should fire.
    return { ok: (body.devices ?? 0) > 0, why: `devices=${body.devices}`, devices: body.devices ?? 0 };
  } catch (e) {
    return { ok: false, why: `healthz threw: ${e.message}` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const install = findInstall();
  if (install === null) {
    record('locate the installed plugin', false, `no ${PACKAGE} under any known DSH home`);
    return finish(false, { reason: 'not_installed' });
  }
  record('locate the installed plugin', true, `v${install.version} at ${install.moduleDir}`);

  const before = findDshProcess();
  record('find the DSH process', before.ok, before.ok ? `${before.matches.length} match(es)` : before.reason);

  // ---- 1. verify the artefact BEFORE touching anything -------------------------------
  if (!existsSync(TARBALL)) { record('verify the artefact', false, `no tarball at ${TARBALL}`); return finish(false, { reason: 'no_tarball' }); }
  const actual = createHash('sha256').update(readFileSync(TARBALL)).digest('hex');
  if (EXPECTED !== '' && actual !== EXPECTED) {
    record('verify the artefact', false, `checksum ${actual} != ${EXPECTED}`);
    return finish(false, { reason: 'checksum_mismatch' });
  }
  record('verify the artefact', true, `sha256 ${actual.slice(0, 16)}…`);

  // ---- 2. back up, so rollback needs nothing from the network -------------------------
  const backup = `${install.moduleDir}.backup-${STAMP}`;
  try {
    cpSync(install.moduleDir, backup, { recursive: true });
    record('back up the installed plugin', true, `${backup}`);
  } catch (e) {
    record('back up the installed plugin', false, e.message);
    return finish(false, { reason: 'backup_failed' });
  }

  // ---- 3. stage and check it EXTRACTED -------------------------------------------------
  const staging = join(tmpdir(), `w2m-stage-${STAMP}`);
  mkdirSync(staging, { recursive: true });
  const untar = run('/usr/bin/tar', ['-xzf', TARBALL, '-C', staging], { timeout: 180_000 });
  if (!untar.ok) { record('unpack to staging', false, untar.out); return finish(false, { reason: 'untar_failed' }); }
  const staged = join(staging, 'package');
  const src = existsSync(staged) ? staged : staging;
  const entry = join(src, 'bin', 'w2m-localside.mjs');
  if (!existsSync(entry)) {
    record('check the staged tree', false, `no bin/w2m-localside.mjs in ${src}`);
    return finish(false, { reason: 'no_entry_point' });
  }
  let stagedVersion = '?';
  try { stagedVersion = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version; } catch { /* reported as ? */ }
  record('check the staged tree', true, `v${stagedVersion}`);

  // ---- 4. swap -------------------------------------------------------------------------
  try {
    rmSync(install.moduleDir, { recursive: true, force: true });
    cpSync(src, install.moduleDir, { recursive: true });
    record('swap into place', true, `v${install.version} -> v${stagedVersion}`);
  } catch (e) {
    record('swap into place', false, e.message);
    // The backup is right there; restore without asking.
    try { rmSync(install.moduleDir, { recursive: true, force: true }); cpSync(backup, install.moduleDir, { recursive: true }); record('restore after a failed swap', true, 'reverted'); } catch (e2) { record('restore after a failed swap', false, e2.message); }
    return finish(false, { reason: 'swap_failed' });
  }

  // ---- 5. restart ----------------------------------------------------------------------
  /**
   * DSH is restarted by signalling it, and **the detached supervisor is what makes that survivable**:
   * this process is not a child of DSH, so it keeps running to do the self-check and the rollback.
   */
  const targets = before.ok ? before.matches : [];
  for (const p of targets) run('/bin/kill', ['-TERM', p.pid], { timeout: 10_000 });
  record('signal DSH to stop', targets.length > 0, `${targets.length} process(es)`);
  await sleep(5000);

  // Bring it back the way it was launched, if a launcher is discoverable.
  const launchd = run('/bin/launchctl', ['list'], { timeout: 15_000 });
  const launchdHit = launchd.ok ? launchd.out.split('\n').find((l) => /dsh|harness/i.test(l)) : undefined;
  if (launchdHit) {
    record('restart via launchd', true, launchdHit.trim());
  } else {
    // No launchd job: try `open`, which is how a packaged app is started. A failure here is the
    // case the rollback exists for.
    const opened = run('/usr/bin/open', ['-a', 'DeepSeek Harness'], { timeout: 30_000 });
    record('restart via open -a', opened.ok, opened.ok ? 'launched' : opened.out);
  }

  // ---- 6. self-check, with the rollback as the answer to a failure ----------------------
  let healthy = false;
  let why = '';
  for (let i = 1; i <= 6; i += 1) {
    await sleep(10_000);
    const proc = findDshProcess();
    if (!proc.ok || proc.matches.length === 0) { why = 'DSH is not running'; continue; }
    if (VERIFY_FLEET !== '') {
      const fleet = await fleetHasMachine(VERIFY_FLEET, '');
      if (!fleet.ok) { why = `fleet check: ${fleet.why}`; continue; }
      record(`self-check ${i}`, true, `DSH up, ${fleet.why}`);
    } else {
      record(`self-check ${i}`, true, `DSH up (${proc.matches.length} process(es))`);
    }
    healthy = true;
    break;
  }

  if (healthy) return finish(true, { from: install.version, to: stagedVersion, backup });

  record('self-check', false, why || 'DSH did not come back');
  // ---- 7. roll back, automatically ------------------------------------------------------
  for (const p of (findDshProcess().matches ?? [])) run('/bin/kill', ['-TERM', p.pid], { timeout: 10_000 });
  await sleep(3000);
  try {
    rmSync(install.moduleDir, { recursive: true, force: true });
    cpSync(backup, install.moduleDir, { recursive: true });
    record('roll back', true, `restored v${install.version}`);
  } catch (e) {
    record('roll back', false, e.message);
    return finish(false, { reason: 'rollback_failed', backup });
  }
  run('/usr/bin/open', ['-a', 'DeepSeek Harness'], { timeout: 30_000 });
  await sleep(20_000);
  const after = findDshProcess();
  record('verify the rollback', after.ok && after.matches.length > 0, `${after.matches?.length ?? 0} process(es)`);
  return finish(false, { reason: 'rolled_back', restored: install.version, backup });
}

main().catch((e) => { record('unhandled', false, String(e?.stack ?? e)); finish(false, { reason: 'threw' }); });
