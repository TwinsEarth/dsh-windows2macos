/**
 * Per-test-file temp cleanup for the zero-residue requirement.
 *
 * Installed at the top of a test file, `withTempCleanup()` records the residue-looking directories that already exist,
 * and returns a remover that deletes only the ones created after this point. It is deliberately baseline-based rather than
 * age-based: `node --test` runs test files concurrently, and deleting a sibling file's live fixture would turn a hygiene
 * fix into a flaky suite.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESIDUE = /^(w2m|gpw)-/;

function list() {
  const out = [];
  for (const name of readdirSync(tmpdir())) {
    if (!RESIDUE.test(name)) continue;
    const full = join(tmpdir(), name);
    try {
      if (statSync(full).isDirectory()) out.push({ name, full });
    } catch {
      /* vanished */
    }
  }
  return out;
}

/** @returns {{ remove: () => string[], registerAfterHook: (after: Function) => void }} */
export function withTempCleanup() {
  const before = new Set(list().map((entry) => entry.name));
  const remove = () => {
    const removed = [];
    for (const entry of list()) {
      if (before.has(entry.name)) continue;
      try {
        rmSync(entry.full, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        /* a Windows handle may still be open: the residue report catches it */
      }
    }
    return removed;
  };
  return { remove, registerAfterHook: (after) => after(remove) };
}
