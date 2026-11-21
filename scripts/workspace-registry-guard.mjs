#!/usr/bin/env node
/**
 * `workspace-registry-guard` — inspect (default) or repair the DSH workspace registry.
 *
 * Usage:
 *   node scripts/workspace-registry-guard.mjs [--dsh-home <dir>] [--fix] [--json]
 *
 * Exit codes: 0 consistent (or repaired), 1 inconsistent (check mode), 2 unreadable/missing.
 *
 * The DSH client owns `storages/workspace.json`; a repair while the app is running can be overwritten by
 * the client's in-memory copy. Quit the app first (the PowerShell wrapper at `tools/dsh-workspace-guard.ps1`
 * offers `-Fix`, which stops the app before calling this script).
 */

import os from 'node:os';
import path from 'node:path';

import { inspectWorkspaceRegistry, repairWorkspaceRegistry } from '../src/backup/workspace-registry-guard.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const fix = args.includes('--fix');
const homeIndex = args.indexOf('--dsh-home');
const dshHome = homeIndex >= 0 && args[homeIndex + 1] ? args[homeIndex + 1] : (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));

const report = fix ? repairWorkspaceRegistry(dshHome) : inspectWorkspaceRegistry(dshHome);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`file: ${report.file}`);
  const shown = report.after ?? report;
  console.log(`workspaceIds=${shown.ids?.length ?? 0}  rows=${shown.rows?.length ?? 0}  defaultOk=${shown.defaultOk}`);
  if (shown.danglingIds?.length) console.log(`dangling ids (fatal): ${shown.danglingIds.join(', ')}`);
  if (shown.unlistedRows?.length) console.log(`unlisted rows (invisible): ${shown.unlistedRows.join(', ')}`);
  for (const problem of shown.problems ?? []) console.log(`  ${problem.code}: ${problem.detail}`);
  if (fix) {
    console.log(report.changed ? `repaired; backup: ${report.backup}` : 'nothing to repair');
    console.log(`after: workspaceIds=${report.after?.ids?.length ?? 0} rows=${report.after?.rows?.length ?? 0} defaultOk=${report.after?.defaultOk}`);
    console.log('restart DeepSeek Harness to reload the registry.');
  } else {
    console.log(report.ok ? 'consistent' : 'inconsistent — run with --fix (quit DSH first)');
  }
}

const exit = fix ? (report.ok ? 0 : 1) : (report.ok ? 0 : (report.error === 'registry file is missing' ? 2 : 1));
process.exit(exit);
