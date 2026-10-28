#!/usr/bin/env node
/**
 * Drive the G0-3 relay upgrade across hosts over SSH (v2).
 *
 *   W2M_RELAY_HOSTS=106.53.197.47,202.182.123.154 W2M_SSH_USER=root \
 *     node scripts/relay-upgrade-driver.mjs
 *
 *   node scripts/relay-upgrade-driver.mjs --dry-run     # show per-host commands, run nothing
 *
 * Env:
 *   W2M_RELAY_HOSTS  comma-separated hosts (required for a real run)
 *   W2M_SSH_USER     ssh user (default root)
 *   W2M_SSH_KEY      optional identity file
 *   W2M_SSH_PORT     default 22
 *   W2M_VERSION      package version to install (default 2.0.0-beta.1)
 *   W2M_SCRUB_BIN    absolute path to w2m-scrub.mjs ON THE RELAY HOST
 *   W2M_STATE_DIR    relay state dir (script default /var/lib/w2m/rabbit)
 *
 * Nothing is executed without W2M_RELAY_HOSTS: a host list is the operator's statement that these
 * machines may be touched in this window.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'relay-upgrade.sh');
const script = readFileSync(scriptPath, 'utf8');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const hosts = String(process.env.W2M_RELAY_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const user = process.env.W2M_SSH_USER ?? 'root';
const port = process.env.W2M_SSH_PORT ?? '22';
const key = process.env.W2M_SSH_KEY ?? '';
const version = process.env.W2M_VERSION ?? '2.0.0-beta.1';
const scrub = process.env.W2M_SCRUB_BIN ?? '';
const stateDir = process.env.W2M_STATE_DIR ?? '/var/lib/w2m/rabbit';

const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

if (hosts.length === 0) {
  print({
    ok: true,
    dry_run: true,
    reason: 'W2M_RELAY_HOSTS is not set; nothing was executed',
    known_old_relays: ['106.53.197.47', '202.182.123.154'],
    how_to_run: 'W2M_RELAY_HOSTS=host1,host2 W2M_SSH_USER=root W2M_SCRUB_BIN=/opt/w2m-src/bin/w2m-scrub.mjs W2M_VERSION=' + version + ' node scripts/relay-upgrade-driver.mjs',
    per_host_steps: ['backup state+unit+old version', 'stop service', 'npm i -g @twinsearth/w2m-dsh-plugin@' + version, 'scrub ' + stateDir + ' with external backup', 'start service', 'assert healthz relay_version/features/blobs=0', 'rollback on failure'],
  });
  process.exit(0);
}

const sharedEnv = { W2M_VERSION: version, W2M_STATE_DIR: stateDir, ...(scrub === '' ? {} : { W2M_SCRUB_BIN: scrub }), ...(dryRun ? { W2M_DRY_RUN: '1' } : {}) };
const sshBase = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', port, ...(key === '' ? [] : ['-i', key])];

const results = [];
for (const host of hosts) {
  const envPrefix = Object.entries(sharedEnv).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join(' ');
  const command = `${envPrefix} bash -s`;
  if (dryRun) {
    results.push({ host, user, command, script_bytes: Buffer.byteLength(script) });
    continue;
  }
  const result = spawnSync('ssh', [...sshBase, `${user}@${host}`, command], { input: script, encoding: 'utf8', timeout: 30 * 60 * 1000 });
  results.push({ host, status: result.status, stdout: (result.stdout ?? '').trim().slice(-4000), stderr: (result.stderr ?? '').trim().slice(-4000) });
}
print({ ok: results.every((r) => dryRun || r.status === 0), dry_run: dryRun, version, results });
process.exit(results.every((r) => dryRun || r.status === 0) ? 0 : 1);
