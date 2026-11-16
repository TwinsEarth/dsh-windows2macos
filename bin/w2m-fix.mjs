#!/usr/bin/env node
/** `w2m-fix`: the offline half of the self-repair subplugin. Everything lives in `src/fix/cli.mjs`. */

import { main } from '../src/fix/cli.mjs';

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
