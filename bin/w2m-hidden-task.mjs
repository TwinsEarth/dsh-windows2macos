#!/usr/bin/env node
/**
 * w2m-hidden-task — schedule a command on Windows **without any console window**.
 *
 * Why this tool exists: `schtasks /TR "node.exe ..."` produces a visible console window every time
 * the task fires. On a 2-minute keeper that is a window every two minutes; on a long-running watcher
 * it also accumulates processes. This tool writes a VBScript wrapper and registers
 * `wscript.exe //B wrapper.vbs`, which starts the command hidden and does not wait.
 *
 * Usage:
 *   node bin/w2m-hidden-task.mjs --name w2m-keeper --every-minutes 2 \
 *     --command "C:\...\node.exe" --arg "C:\...\script.mjs" \
 *     [--workdir "C:\..."] [--delete]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

import { buildHiddenWrapper, hiddenTaskArgs } from '../src/util/windows-hidden-task.mjs';

/** Parse `--flag value` pairs plus repeatable `--arg`; unknown flags are refused by name. */
export function parseHiddenTaskArgs(argv) {
  const out = { name: null, everyMinutes: null, command: null, args: [], workdir: null, delete: false, vbsPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--name': out.name = next(); break;
      case '--every-minutes': out.everyMinutes = Number(next()); break;
      case '--command': out.command = next(); break;
      case '--arg': out.args.push(next()); break;
      case '--workdir': out.workdir = next(); break;
      case '--vbs': out.vbsPath = next(); break;
      case '--delete': out.delete = true; break;
      case '--help':
      case '-h': out.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (out.delete === true) {
    if (typeof out.name !== 'string' || out.name.trim() === '') throw new Error('--delete needs --name');
    return out;
  }
  if (out.name === null || out.command === null || out.everyMinutes === null) {
    throw new Error('--name, --command and --every-minutes are required');
  }
  if (out.vbsPath === null) {
    const safe = String(out.name).replace(/[^A-Za-z0-9._-]/g, '_');
    out.vbsPath = join(os.homedir(), '.dsh', 'xclient', `${safe}-hidden.vbs`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseHiddenTaskArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`w2m-hidden-task: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help === true) {
    process.stdout.write('usage: w2m-hidden-task.mjs --name <task> --every-minutes <n> --command <exe> [--arg <a>]... [--workdir <dir>] [--vbs <path>]\n'
      + '       w2m-hidden-task.mjs --delete --name <task>\n');
    return;
  }
  if (args.delete === true) {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', args.name, '/F'], { stdio: 'ignore' });
      process.stdout.write(`deleted ${args.name}\n`);
    } catch {
      process.stdout.write(`no task named ${args.name}\n`);
    }
    return;
  }
  if (process.platform !== 'win32') throw new Error('hidden scheduled tasks are a Windows feature');
  mkdirSync(dirname(args.vbsPath), { recursive: true });
  writeFileSync(args.vbsPath, buildHiddenWrapper({ command: args.command, args: args.args, workingDirectory: args.workdir }), 'utf8');
  const taskArgs = hiddenTaskArgs({ taskName: args.name, everyMinutes: args.everyMinutes, vbsPath: args.vbsPath });
  execFileSync('schtasks', taskArgs, { stdio: 'ignore' });
  process.stdout.write(`scheduled ${args.name} every ${args.everyMinutes} min (hidden wrapper ${args.vbsPath})\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`w2m-hidden-task: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
