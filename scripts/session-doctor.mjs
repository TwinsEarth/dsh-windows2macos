#!/usr/bin/env node
/**
 * Session doctor — read-only diagnostics for DSH v4 session logs and the workspace index.
 *
 * The rules themselves live in `src/util/session-validate.mjs` (shared with the restore gate in v3.4.8); this
 * file is the command line: argument parsing, the human/JSON report and the exit codes.
 *
 * Usage:
 *   node scripts/session-doctor.mjs [--root "$DSH_HOME"]        # default: $DSH_HOME
 *   node scripts/session-doctor.mjs --root "$DSH_HOME" --json
 *   node scripts/session-doctor.mjs --file <session.v4.jsonl.zstd> [--session-id <id>]
 *
 * Exit codes: 0 all checked artifacts pass; 1 at least one finding; 2 usage error.
 */
import path from 'node:path';
import process from 'node:process';

import { diagnoseRoot, diagnoseSessionFile, formatReport } from '../src/util/session-validate.mjs';
import { isMainModule } from '../src/util/cli.mjs';

export {
  CODES,
  diagnoseBuffer,
  diagnoseRoot,
  diagnoseSessionBuffer,
  diagnoseSessionFile,
  formatReport,
  listSessionLogs,
  splitFrames,
} from '../src/util/session-validate.mjs';

export function usage() {
  return [
    'usage: node scripts/session-doctor.mjs [--root <DSH_HOME>] [--json]',
    '       node scripts/session-doctor.mjs --file <session.v4.jsonl.zstd> [--session-id <id>] [--json]',
    '',
    'Without --root or --file, --root defaults to $DSH_HOME (so `npm run doctor` works as-is;',
    'an explicit path is still supported). --file examines one log and ignores the registry.',
    '',
    'read-only: nothing is created, rewritten, or deleted.',
  ].join('\n');
}

/**
 * Resolve the working mode from argv.
 *
 * `--file` wins over `--root`; a bare invocation falls back to `$DSH_HOME` so the npm script does not depend on
 * the caller's shell expanding a variable (cmd.exe would pass the literal text).
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function resolveCli(argv, env) {
  const read = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1] ?? null;
  };
  const file = read('--file');
  const sessionId = read('--session-id');
  const explicitRoot = read('--root');
  const root = file === null ? explicitRoot ?? env.DSH_HOME ?? null : null;
  return { json: argv.includes('--json'), file, sessionId, root };
}

function main() {
  const { json, file, sessionId, root } = resolveCli(process.argv.slice(2), process.env);

  if (root !== null) {
    const report = diagnoseRoot({ root });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatReport(report)}\n`);
    return report.findings.length === 0 && report.sessions.every((session) => session.ok) ? 0 : 1;
  }
  if (file !== null) {
    const result = diagnoseSessionFile(path.resolve(file), { expectedSessionId: sessionId });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.ok ? 'OK' : 'FAIL'} ${result.file}\n${result.codes.join('\n')}\n${JSON.stringify(result.detail, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (isMainModule(import.meta.url) || process.argv[1]?.endsWith('session-doctor.mjs') === true) {
  process.exit(main());
}
