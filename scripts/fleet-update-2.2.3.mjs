#!/usr/bin/env node
/**
 * Fleet-side, no-shell installer for @twinsearth/w2m-dsh-plugin 2.2.3.
 *
 * Why this exists: some fleet agents reject `node -e` as a reparse argument.
 * This file can be fetched with curl and run as `node <file>`, with no shell
 * and no inline code. It verifies the published tarball, backs up every profile
 * that contains the plugin, and atomically replaces the installed package.
 *
 * It deliberately does not restart DSH: loading the new version is the
 * operator's decision. Exit 0 means at least one profile was updated and every
 * profile that had the plugin now contains 2.2.3.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '2.2.3';
const EXPECTED_SHA256 = '3b9e5dc0662508b1a15e727ffa67abe7f3846a5e13cd3de1a30791b5c829f51f';
const URL = `https://registry.npmjs.org/@twinsearth/w2m-dsh-plugin/-/w2m-dsh-plugin-${VERSION}.tgz`;

function roots() {
  return [...new Set([
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
  ].filter((value) => typeof value === 'string' && value !== ''))];
}

function profiles() {
  const found = [];
  for (const root of roots()) {
    let names = [];
    try { names = readdirSync(join(root, 'profiles')); } catch { continue; }
    for (const name of names) {
      const dir = join(root, 'profiles', name);
      const packageJson = join(dir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'package.json');
      if (existsSync(packageJson)) found.push({ root, name, dir, packageJson });
    }
  }
  return found;
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), `w2m-${VERSION}-`));
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) return 2;
    const tarball = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(tarball).digest('hex') !== EXPECTED_SHA256) return 3;
    const file = join(temp, 'plugin.tgz');
    writeFileSync(file, tarball);
    execFileSync('tar', ['-xzf', file, '-C', temp], { stdio: 'ignore' });
    const source = join(temp, 'package');
    if (!existsSync(join(source, 'package.json'))) return 5;

    let updated = 0;
    let failed = 0;
    for (const profile of profiles()) {
      const destination = join(profile.dir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin');
      const updates = join(profile.dir, '.w2m-update');
      const backup = join(updates, `plugin-backup-${VERSION}-${Date.now()}`);
      try {
        mkdirSync(updates, { recursive: true });
        cpSync(destination, backup, { recursive: true });
        const staging = `${destination}.new-${process.pid}`;
        rmSync(staging, { recursive: true, force: true });
        cpSync(source, staging, { recursive: true });
        rmSync(destination, { recursive: true, force: true });
        renameSync(staging, destination);
        copyFileSync(file, join(updates, `twinsearth-w2m-dsh-plugin-${VERSION}.tgz`));
        const installed = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).version;
        if (installed !== VERSION) failed += 1;
        else updated += 1;
        writeFileSync(join(updates, `status-${VERSION}.json`), JSON.stringify({
          ok: installed === VERSION, profile: profile.name, version: installed,
          backup, updated_at: new Date().toISOString(),
        }, null, 2));
      } catch {
        try {
          rmSync(destination, { recursive: true, force: true });
          cpSync(backup, destination, { recursive: true });
        } catch { /* report the failure through the exit code */ }
        failed += 1;
      }
    }
    return updated > 0 && failed === 0 ? 0 : 6;
  } catch {
    return 5;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

process.exit(await main());
