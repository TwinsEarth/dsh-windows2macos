/**
 * The three fixed maintenance actions (v1.3.2-beta, M1).
 *
 * Everything here is executed by the root runner, so the action set is closed by construction: update/restart/diag are
 * functions with fixed argv, and no value from a request is ever interpolated into a command line. Parameters name
 * versions, hashes, URLs and unit selections; they do not become shell text.
 */
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const UNITS = Object.freeze({
  rabbit: 'w2m-rabbit.service',
  agent: 'w2m-localside.service',
  stun: 'w2m-stun.service',
});

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_SECTION_BYTES = 32 * 1024;
const MAX_TOTAL_DIAG_BYTES = 256 * 1024;

export function defaultDeps(overrides = {}) {
  return {
    platform: process.platform,
    appDir: process.platform === 'win32' ? 'C:\\w2m\\app' : '/opt/w2m/app',
    stagingRoot: process.platform === 'win32' ? 'C:\\w2m\\staging' : '/tmp',
    backupDir: process.platform === 'win32' ? 'C:\\w2m\\app.old' : '/opt/w2m/app.old',
    healthzUrl: 'http://127.0.0.1:8787/healthz',
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    fetch: (...args) => globalThis.fetch(...args),
    execFile: (command, argv, options = {}) => new Promise((resolve, reject) => {
      execFileCb(command, argv, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    }),
    ...overrides,
  };
}

async function run(deps, command, argv) {
  try {
    const result = await deps.execFile(command, argv);
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error?.message ?? error) };
  }
}

function clip(text) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= MAX_SECTION_BYTES) return value;
  let cut = value;
  while (Buffer.byteLength(cut, 'utf8') > MAX_SECTION_BYTES) cut = cut.slice(0, -1024);
  return cut + '\n[truncated]';
}

async function diag(deps, _params) {
  const sections = {};
  const commands = {
    version: ['sh', ['-c', `cat ${deps.appDir}/package.json`]],
    disk: ['df', ['-h', '/opt', '/var/lib/w2m']],
    ports: ['ss', ['-ltn']],
  };
  for (const key of Object.keys(commands)) {
    const result = await run(deps, commands[key][0], commands[key][1]);
    sections[key] = clip(result.ok ? result.stdout : `ERROR: ${result.stderr}`);
  }
  for (const unit of Object.values(UNITS)) {
    const active = await run(deps, 'systemctl', ['is-active', unit]);
    sections[`service:${unit}`] = clip(active.ok ? active.stdout : `inactive (${active.stderr.trim()})`);
    const logs = await run(deps, 'journalctl', ['-u', unit, '-n', '100', '--no-pager']);
    sections[`journal:${unit}`] = clip(logs.ok ? logs.stdout : `ERROR: ${logs.stderr}`);
  }
  let total = 0;
  for (const key of Object.keys(sections)) total += Buffer.byteLength(sections[key], 'utf8');
  return { status: 'ok', detail: { sections, bytes: total, truncated: total > MAX_TOTAL_DIAG_BYTES } };
}

async function waitFor(deps, probe, timeoutMs, intervalMs = 2000) {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (await probe()) return true;
    await deps.sleep(intervalMs);
  }
  return false;
}

async function healthy(deps) {
  try {
    const response = await deps.fetch(deps.healthzUrl);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function restart(deps, params) {
  const targets = params.targets === 'all' ? ['rabbit', 'stun', 'agent'] : [params.targets];
  const states = {};
  for (const target of targets) {
    const unit = UNITS[target];
    const result = await run(deps, 'systemctl', ['restart', unit]);
    if (!result.ok) return { status: 'failed', code: 'RESTART_FAILED', detail: { unit, stderr: result.stderr } };
    const active = await run(deps, 'systemctl', ['is-active', unit]);
    states[target] = active.ok ? active.stdout.trim() : 'inactive';
  }
  if (params.wait_healthy === false) return { status: 'ok', detail: { states } };
  if (targets.includes('rabbit')) {
    const ok = await waitFor(deps, () => healthy(deps), 60_000);
    if (!ok) return { status: 'failed', code: 'HEALTH_TIMEOUT', detail: { states, probe: deps.healthzUrl } };
  }
  return { status: 'ok', detail: { states, waited: true } };
}

async function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadTo(deps, urls, sha256) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await deps.fetch(url);
      if (response.status !== 200) { errors.push(`${url}: HTTP ${response.status}`); continue; }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) { errors.push(`${url}: too large (${buffer.byteLength})`); continue; }
      const digest = await sha256Of(buffer);
      if (digest !== sha256) { errors.push(`${url}: sha256 ${digest} != expected`); continue; }
      const file = join(tmpdir(), 'w2m-maintenance-' + Date.now() + '.tgz');
      writeFileSync(file, buffer);
      return { ok: true, file, bytes: buffer.byteLength };
    } catch (error) {
      errors.push(`${url}: ${error?.message ?? String(error)}`);
    }
  }
  return { ok: false, errors };
}

async function update(deps, params, request) {
  const downloaded = await downloadTo(deps, params.artifact_urls, params.artifact_sha256);
  if (!downloaded.ok) return { status: 'failed', code: 'UPDATE_DOWNLOAD_FAILED', detail: { errors: downloaded.errors } };

  const staging = join(deps.stagingRoot, 'w2m-maintenance-' + request.request_id);
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* staging may not exist */ }
  mkdirSync(staging, { recursive: true });
  const extracted = await run(deps, 'tar', ['-xzf', downloaded.file, '-C', staging]);
  if (!extracted.ok) return { status: 'failed', code: 'UPDATE_EXTRACT_FAILED', detail: { stderr: extracted.stderr } };

  const stagedPkg = join(staging, 'package', 'package.json');
  if (!existsSync(stagedPkg)) return { status: 'failed', code: 'UPDATE_BAD_ARTIFACT', detail: { message: 'package/package.json missing' } };
  const stagedVersion = JSON.parse(readFileSync(stagedPkg, 'utf8')).version;
  if (stagedVersion !== params.version) return { status: 'failed', code: 'UPDATE_VERSION_MISMATCH', detail: { expected: params.version, artifact: stagedVersion } };

  let rolledBack = false;
  const hadPrevious = existsSync(deps.appDir);
  if (hadPrevious) {
    try { rmSync(deps.backupDir, { recursive: true, force: true }); } catch { /* old backup is replaceable */ }
    try { renameSync(deps.appDir, deps.backupDir); } catch (error) { return { status: 'failed', code: 'UPDATE_BACKUP_FAILED', detail: { message: error?.message } }; }
  }
  try {
    renameSync(join(staging, 'package'), deps.appDir);
  } catch (error) {
    if (hadPrevious) { try { renameSync(deps.backupDir, deps.appDir); } catch { /* rollback attempted */ } }
    return { status: 'failed', code: 'UPDATE_SWAP_FAILED', detail: { message: error?.message } };
  }

  const restarted = params.restart_after_update !== false;
  if (restarted) {
    const units = params.target === 'relay' ? ['rabbit', 'stun', 'agent'] : ['agent'];
    for (const target of units) {
      const result = await run(deps, 'systemctl', ['restart', UNITS[target]]);
      if (!result.ok) { rolledBack = true; break; }
    }
    if (!rolledBack) {
      const healthOk = units.includes('rabbit') ? await waitFor(deps, () => healthy(deps), 60_000) : true;
      if (!healthOk) rolledBack = true;
    }
  }
  if (rolledBack) {
    try {
      rmSync(deps.appDir, { recursive: true, force: true });
      renameSync(deps.backupDir, deps.appDir);
      await run(deps, 'systemctl', ['restart', UNITS.agent]);
    } catch { /* rollback best effort, reported below */ }
    return { status: 'failed', code: 'UPDATE_ROLLED_BACK', detail: { version: params.version, rolled_back: true } };
  }
  return { status: 'ok', detail: { version: stagedVersion, sha256: params.artifact_sha256, bytes: downloaded.bytes, restarted, backup: hadPrevious ? deps.backupDir : null } };
}

/** Execute one verified request. Returns a result the runner writes to the done directory. */
export async function executeAction(action, params, request, deps = defaultDeps()) {
  if (action === 'diag') return diag(deps, params);
  if (action === 'restart') return restart(deps, params);
  if (action === 'update') return update(deps, params, request);
  return { status: 'failed', code: 'MAINTENANCE_BAD_ACTION', detail: { action } };
}
