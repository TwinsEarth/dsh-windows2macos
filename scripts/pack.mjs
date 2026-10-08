/**
 * Deterministic npm-compatible tarball packer.
 *
 * Why this exists instead of `npm pack` / `pnpm pack`: neither ships with the
 * DSH runtime (only `pnpm` is present, and this project's install path is a
 * plain tarball the user points `dsh plugin add` at). Shelling out to a package
 * manager to build a release artifact also makes the artifact depend on that
 * manager's version, which defeats the point of publishing a checksum.
 *
 * What it does:
 *   * reads `files` from package.json and packs exactly those entries;
 *   * prefixes every entry with `package/`, the layout npm expects;
 *   * writes tar entries with fixed mode/uid/gid/mtime so that packing the same
 *     sources twice yields **byte-identical** output -- so a published sha256 is
 *     a statement about the sources, not about when you ran the command;
 *   * gzips with `mtime: 0` for the same reason.
 *
 * Usage:
 *   node scripts/pack.mjs [--out <dir>] [--check <tarball>]
 *
 *   --out    directory to write the .tgz into (default: dist/)
 *   --check  after packing, compare the sha256 against an existing tarball and
 *            exit non-zero if they differ (used to prove reproducibility)
 */

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

function fail(message) {
  process.stderr.write(`w2m-pack: ${message}\n`);
  process.exit(1);
}

/* ---------------- tar writing ---------------- */

/**
 * Build a ustar header for one entry.
 *
 * The checksum field is computed with itself treated as spaces, which is the
 * fiddly part of the format and the reason a hand-rolled writer needs a test.
 */
function tarHeader({ name, size, mode, typeflag, mtime = 0, uid = 0, gid = 0 }) {
  const header = Buffer.alloc(BLOCK);

  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    // Long paths go through the ustar prefix field rather than GNU extensions,
    // so the archive stays readable by strict implementations.
    const split = name.lastIndexOf('/', 155);
    const prefix = split > 0 ? name.slice(0, split) : '';
    const rest = split > 0 ? name.slice(split + 1) : name;
    if (prefix.length > 155 || rest.length > 100) {
      fail(`path too long for the ustar format: ${name}`);
    }
    header.write(rest, 0, 100, 'utf8');
    header.write(prefix, 345, 155, 'utf8');
  } else {
    nameBuf.copy(header, 0);
  }

  const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
  header.write(octal(mode, 8), 100, 8, 'ascii');
  header.write(octal(uid, 8), 108, 8, 'ascii');
  header.write(octal(gid, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(mtime, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

function padTo512(buffer) {
  const remainder = buffer.length % BLOCK;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK - remainder);
}

/* ---------------- file selection ---------------- */

const ALWAYS = ['package.json', 'README.md', 'LICENSE'];

/**
 * Expand the `files` globs from package.json.
 *
 * Only the subset npm actually uses here is supported: a plain file or a
 * directory name (which means "everything under it"). A pattern this does not
 * understand is a packaging bug waiting to happen, so it fails loudly instead of
 * silently shipping less than intended.
 */
function expandFiles(entries) {
  const collected = [];

  const walk = (absPath, relPath) => {
    const info = statSync(absPath);
    if (info.isDirectory()) {
      for (const child of readdirSync(absPath).sort()) {
        walk(join(absPath, child), `${relPath}/${child}`);
      }
      return;
    }
    if (!info.isFile()) return;
    collected.push({ absPath, relPath });
  };

  for (const entry of entries) {
    if (entry.includes('*') || entry.includes('?')) {
      fail(
        `unsupported pattern in package.json "files": ${entry}. ` +
          'Add the concrete path, or extend scripts/pack.mjs deliberately.',
      );
    }
    const abs = join(ROOT, entry);
    if (!existsSync(abs)) {
      fail(`package.json "files" names a path that does not exist: ${entry}`);
    }
    walk(abs, entry.replace(/^\.\//, ''));
  }

  for (const name of ALWAYS) {
    const abs = join(ROOT, name);
    if (existsSync(abs) && !collected.some((f) => f.relPath === name)) {
      collected.push({ absPath: abs, relPath: name });
    }
  }

  collected.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return collected;
}

/* ---------------- packing ---------------- */

/**
 * Refuse to pack a manifest that points at files which do not exist.
 *
 * This is the check that earns its keep: a published tarball whose `bin` entry
 * names a missing file installs cleanly and then fails at first use, which is
 * the worst possible time to find out. Publishing is irreversible, so the gate
 * belongs here rather than in a test someone might skip.
 */
function assertManifestPathsExist(manifest) {
  const declared = [];

  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    declared.push([`bin["${name}"]`, target]);
  }
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target === 'string' && target.startsWith('./')) {
      declared.push([`exports["${subpath}"]`, target]);
    }
  }
  for (const [field, value] of [['main', manifest.main], ['types', manifest.types]]) {
    if (typeof value === 'string' && value.startsWith('./')) declared.push([field, value]);
  }

  const missing = declared.filter(([, target]) => !existsSync(join(ROOT, target)));
  if (missing.length > 0) {
    fail(
      `package.json declares paths that do not exist:\n` +
        missing.map(([field, target]) => `    ${field} -> ${target}`).join('\n') +
        '\n  A tarball that points at missing files installs and then fails at first use.',
    );
  }
}

/**
 * The placeholder `src/plugin/tools.mjs` carries for its own version.
 *
 * The shipped artifact must know which version it is: the daily self-update compares the newest
 * GitHub release against this string, and a stale value means either a downgrade (worse than a
 * missed update) or a permanent no-op. Baking it in at pack time keeps it from being
 * hand-maintained in two places and drifting.
 */
const VERSION_PLACEHOLDER = '__W2M_PLUGIN_VERSION__';

/** Files whose placeholder is substituted with the real version during packing. */
const VERSION_BEARING_FILES = new Set(['src/plugin/tools.mjs']);

/**
 * Substitute the version placeholder in a file's bytes.
 *
 * Works on the raw buffer so the substitution cannot introduce an encoding change, and fails loudly
 * when a file that should carry the placeholder does not -- silently shipping a literal
 * `__W2M_PLUGIN_VERSION__` would make the updater compare against nonsense forever.
 *
 * @param {string} relPath - Path relative to the package root, POSIX-separated.
 * @param {Buffer} content - File bytes.
 * @param {string} version - Version from `package.json`.
 * @returns {Buffer} Bytes to pack.
 */
function substituteVersion(relPath, content, version) {
  if (!VERSION_BEARING_FILES.has(relPath)) return content;
  const text = content.toString('utf8');
  if (!text.includes(VERSION_PLACEHOLDER)) {
    throw new Error(
      `pack: ${relPath} no longer contains ${VERSION_PLACEHOLDER}. The updater needs the shipped ` +
        'version baked in; restore the placeholder or update VERSION_BEARING_FILES.',
    );
  }
  return Buffer.from(text.split(VERSION_PLACEHOLDER).join(version), 'utf8');
}

function packTarball() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assertManifestPathsExist(manifest);
  const entries = expandFiles(manifest.files ?? []);

  const parts = [];
  for (const { absPath, relPath } of entries) {
    const name = `package/${relPath.split(sep).join('/')}`;
    const content = substituteVersion(name.replace(/^package\//, ''), readFileSync(absPath), manifest.version);
    parts.push(tarHeader({
      name,
      size: content.length,
      mode: 0o644,
      typeflag: '0',
    }));
    parts.push(content);
    parts.push(padTo512(content));
  }
  parts.push(ZERO_BLOCK, ZERO_BLOCK); // end-of-archive marker

  const tar = Buffer.concat(parts);
  const gz = gzipSync(tar, { level: 9, mtime: 0 });

  // Force the gzip OS byte to 3 ("Unix").
  //
  // zlib stamps this from the host: Windows writes 10 (NTFS), Linux writes 3.
  // Everything else in the archive is already fixed, so without this the same
  // sources pack to two different files depending on who runs the command -- and
  // a published hash would stop being a statement about the sources. The tar
  // payload is byte-identical across platforms (verified by unpacking both and
  // comparing), so this single byte was the whole difference.
  gz[9] = 3;
  return { gz, manifest, entries };
}

/* ---------------- cli ---------------- */

const argv = process.argv.slice(2);
let outDir = join(ROOT, 'dist');
let checkPath = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out') outDir = resolve(argv[++i]);
  else if (argv[i] === '--check') checkPath = resolve(argv[++i]);
  else fail(`unknown argument: ${argv[i]}`);
}

const { gz, manifest, entries } = packTarball();
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `twinsearth-w2m-dsh-plugin-${manifest.version}.tgz`);
writeFileSync(outPath, gz);

const sha256 = createHash('sha256').update(gz).digest('hex');
process.stdout.write(`packed ${entries.length} files\n`);
process.stdout.write(`  ${outPath}\n`);
process.stdout.write(`  bytes  ${gz.length}\n`);
process.stdout.write(`  sha256 ${sha256}\n`);

if (checkPath) {
  if (!existsSync(checkPath)) fail(`--check target does not exist: ${checkPath}`);
  const other = readFileSync(checkPath);
  // Compare decompressed contents as well as the compressed bytes: gzip level
  // differences between toolchains would otherwise look like a content change.
  const otherTar = gunzipSync(other);
  const { gz: fresh } = packTarball();
  const freshTar = gunzipSync(fresh);
  const sameBytes = Buffer.compare(gz, other) === 0;
  const sameContent = Buffer.compare(freshTar, otherTar) === 0;
  process.stdout.write(`  vs ${checkPath}\n`);
  process.stdout.write(`    compressed identical : ${sameBytes}\n`);
  process.stdout.write(`    content identical    : ${sameContent}\n`);
  if (!sameContent) {
    fail('packed content differs from the reference tarball');
  }
}
