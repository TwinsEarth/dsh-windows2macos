/**
 * The fleet identity reader must go through the DSH_HOME fallback.
 *
 * Two outages came from this one call. `readDevice({ stateDir })` returns an empty device whenever `stateDir` is unset --
 * which is the documented default layout, because the agent writes its identity to `<DSH_HOME>/xclient/device.json`. Every
 * consumer of `localIdentity()` then answered "no identity" on a perfectly paired machine: the fleet-chat panel refused
 * every request with "this machine has no fleet-chat identity yet", and w2m_status printed machine_id null next to a
 * working P2P identity.
 *
 * A behaviour test would need a whole host context to reach this callback, so this guards the call site itself. It is
 * deliberately scoped to the callback body: a whole-file `includes()` check is what let the first "fix" pass while the
 * old call was still there.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the local identity reader', () => {
  it('resolves through readLocalIdentity, not the stateDir-only reader', () => {
    const source = readFileSync(join(ROOT, 'src/plugin/tools.mjs'), 'utf8');
    const lines = source.split('\n');
    const start = lines.findIndex((line) => line.includes('const localIdentity = createLocalIdentity'));
    assert.notEqual(start, -1, 'the local identity helper must exist under its documented name');
    const body = lines.slice(start, start + 8).join('\n');
    assert.ok(
      body.includes('readLocalIdentity(cfg)'),
      'the callback must use readLocalIdentity(cfg): it knows the <DSH_HOME>/xclient fallback',
    );
    assert.ok(
      !body.includes('readDevice({ stateDir: cfg.stateDir })'),
      'readDevice({ stateDir }) returns empty when stateDir is unset, which is the default layout',
    );
  });
});