/**
 * The vendored contract SDK must stay byte-identical to what PROVENANCE.md records.
 *
 * The port ships in w2m but the SDK is not w2m code: it is a published, independently versioned
 * contract package. A local edit to this copy would silently change the interop wire contract
 * without changing the version that peers negotiate, which is exactly the failure mode the
 * contract package exists to prevent. So the check re-hashes every vendored file and compares it
 * with the recorded table; a mismatch is RED until the copy is refreshed from npm and the table
 * regenerated.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'src', 'interop', 'contract');
const provenance = readFileSync(join(vendorDir, 'PROVENANCE.md'), 'utf8');

const recorded = new Map();
for (const line of provenance.split('\n')) {
  const match = /^\| ([A-Za-z0-9_.-]+) \| (\d+) \| ([0-9a-f]{64}) \|$/.exec(line);
  if (match !== null) recorded.set(match[1], { bytes: Number(match[2]), sha256: match[3] });
}

const problems = [];
for (const name of readdirSync(vendorDir)
  .filter((entry) => entry !== 'PROVENANCE.md')
  .sort()) {
  const entry = recorded.get(name);
  if (entry === undefined) {
    problems.push(`${name}: present but not recorded in PROVENANCE.md`);
    continue;
  }
  const bytes = readFileSync(join(vendorDir, name));
  if (bytes.length !== entry.bytes) problems.push(`${name}: ${bytes.length} bytes, recorded ${entry.bytes}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) problems.push(`${name}: sha256 ${digest}, recorded ${entry.sha256}`);
}
for (const name of recorded.keys()) {
  if (!readdirSync(vendorDir).includes(name)) problems.push(`${name}: recorded but missing`);
}

if (problems.length > 0) {
  process.stderr.write(`contract vendor check: ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`contract vendor check: ${recorded.size} file(s) match PROVENANCE.md\n`);
