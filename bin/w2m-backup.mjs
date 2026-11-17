#!/usr/bin/env node
/** `w2m-backup`: the read-only backup substrate CLI (status / scan / selftest). Everything lives in `src/backup/cli.mjs`. */

import { main } from '../src/backup/cli.mjs';

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
