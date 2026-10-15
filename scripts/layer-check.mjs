/**
 * Derive the actual module graph from the source tree, then check it against the declared layer model.
 *
 * Run it after adding an import that crosses a layer, and it says so. Run it from CI and the tree cannot
 * drift while nobody is looking -- which is the whole reason the model is data in `layer-model.mjs` rather
 * than a paragraph in a document.
 *
 * Exit codes: 1 clean, 2 model violations, 3 unexplained (a dependency involving something that is not a
 * declared layer), 4 the source tree could not be read. Distinguishable, because "the layering broke" and
 * "the checker could not run" must not look alike.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_EDGES, LAYERS, checkEdges } from './layer-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

/** Every `.mjs` under `src`, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * The layer a file belongs to, relative to `srcDir`.
 *
 * A file under a directory takes that directory's name. A file sitting **directly** in the source root is not
 * a layer of its own — it takes the declared `shared` layer, because the alternative is that each such file
 * becomes a layer named after itself, and then any new root-level file silently passes the check as a layer
 * nobody declared. The first version did exactly that and reported two genuine edges as unexplained.
 */
function layerOf(file, srcDir) {
  const rel = relative(srcDir, file).split(/[\\/]/);
  return rel.length === 1 ? 'shared' : rel[0];
}

/** True when `target` is inside `srcDir`, by resolved path rather than by string prefix. */
function insideSrc(target, srcDir) {
  const normalized = resolve(target);
  const root = resolve(srcDir);
  return normalized === root || normalized.startsWith(root + (process.platform === 'win32' ? '\\' : '/'));
}

export function buildGraph(srcDir = SRC) {
  const files = walk(srcDir);
  const byKey = new Map();
  for (const file of files) {
    const from = layerOf(file, srcDir);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!insideSrc(target, srcDir)) continue;
      const to = layerOf(target, srcDir);
      if (from === to) continue; // intra-layer coupling is reported separately, not checked here
      const key = `${from} -> ${to}`;
      const existing = byKey.get(key);
      if (existing) existing.count += 1;
      else byKey.set(key, { from, to, count: 1, example: relative(srcDir, file).split(/[\\/]/).join('/') });
    }
  }
  return {
    files: files.length,
    edges: [...byKey.values()].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
  };
}

/** Count intra-layer edges, which the checker does not judge but a report should show. */
export function buildIntraLayer(srcDir = SRC) {
  const counts = new Map();
  for (const file of walk(srcDir)) {
    const from = layerOf(file, srcDir);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+(?:'|")(\.[^'"]+)(?:'|")/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!insideSrc(target, srcDir)) continue;
      if (layerOf(target, srcDir) !== from) continue;
      counts.set(from, (counts.get(from) ?? 0) + 1);
    }
  }
  return counts;
}

function main() {
  let graph;
  let intra;
  try {
    graph = buildGraph();
    intra = buildIntraLayer();
  } catch (e) {
    process.stdout.write(`could not read the source tree: ${e.message}\n`);
    process.exit(4);
  }

  const result = checkEdges(graph.edges);

  process.stdout.write(`layer check over ${graph.files} file(s) in ${LAYERS.length} declared layer(s)\n\n`);
  process.stdout.write('declared layers (rank, kind):\n');
  for (const l of LAYERS) process.stdout.write(`  ${String(l.rank).padStart(2)}  ${l.name.padEnd(10)} ${l.kind.padEnd(11)} ${l.note}\n`);

  process.stdout.write(`\nallowed cross-layer edges (${ALLOWED_EDGES.length} declared, ${result.allowed.length} present):\n`);
  for (const [a, b] of ALLOWED_EDGES) {
    const found = graph.edges.find((e) => e.from === a && e.to === b);
    process.stdout.write(`  ${found ? 'used  ' : 'unused'} ${a} -> ${b}${found ? `  (${found.count})` : ''}\n`);
  }

  process.stdout.write('\nintra-layer edges:\n');
  for (const [name, count] of [...intra].sort()) process.stdout.write(`  ${name.padEnd(10)} ${count}\n`);

  if (result.violations.length > 0) {
    process.stdout.write('\nVIOLATIONS:\n');
    for (const v of result.violations) process.stdout.write(`  ${v.from} -> ${v.to} (${v.count}, first in ${v.example})\n    ${v.reason}\n`);
  }
  if (result.unexplained.length > 0) {
    process.stdout.write('\nUNEXPLAINED (not a declared layer):\n');
    for (const u of result.unexplained) process.stdout.write(`  ${u.from} -> ${u.to} (${u.count}, first in ${u.example})\n    ${u.reason}\n`);
  }

  if (result.ok) {
    process.stdout.write('\nclean: every cross-layer edge is declared\n');
    // ZERO, not one. This said `process.exit(1)` and printed "clean" in the same breath, so **every reader
    // that trusts the exit code -- a shell, CI, a script -- read a passing check as a failing one.** The
    // pre-flight never noticed because its own step reads the PRINTED TEXT rather than the status, which is
    // how a script can be wrong for a hundred versions while the gate over it stays green.
    //
    // Found while gathering numbers for the README: the check printed `clean:` and returned 1 in the same
    // command, and the contradiction was only visible because both were printed side by side.
    process.exit(0);
  }
  process.exit(result.violations.length > 0 ? 2 : 3);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) main();
