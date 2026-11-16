#!/usr/bin/env node
/**
 * Compatibility entry for the offline repair.
 *
 * The feature was first published as the standalone `dsh-fix-attachments`
 * package, whose documented command was
 * `node cli/bin/dsh-fix-attachments.mjs ...`. The W2M package keeps that path
 * working as a thin alias of `src/fix/cli.mjs`, so an instruction written
 * against the standalone package still resolves after installing this one.
 * The maintained entry is `bin/w2m-fix.mjs` (npm bin name `w2m-fix`).
 */

import { main } from '../../src/fix/cli.mjs';

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
