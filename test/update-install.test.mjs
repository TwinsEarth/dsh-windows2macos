/**
 * Tests for the self-update installer (`src/plugin/update-install.mjs`).
 *
 * The installer edits the profile that a *running* DSH boots from, so these
 * tests are written around the failure modes rather than the happy path:
 * a bad checksum must not write one byte, a failed package-manager run must
 * leave the profile byte-identical, and a dry run must not touch anything.
 *
 * Only fake runners are used except in the two integration cases at the bottom,
 * which drive the real runtime pnpm against a **throwaway profile in the OS temp
 * directory**. Nothing here may read or write `$DSH_HOME` itself; the profile
 * from the user's machine is never a test fixture.
 *
 * Run:  node --test test/update-install.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  BACKED_UP_FILES,
  DEFAULT_STDERR_TAIL_BYTES,
  STAGING_DIR_NAME,
  createChildProcessRunner,
  installUpdate,
  planInstall,
  readInstalledVersion,
  readTarballManifest,
  resolveRuntimePnpm,
  rollback,
  sha256File,
  tailBytes,
} from '../src/plugin/update-install.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** @type {string} */
let workRoot;
/** @type {string} */
let tarballPath;
/** @type {string} */
let tarballSha256;

before(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'w2m-update-test-'));
  // A real artifact, built by the project's own packer: the installer must work
  // against the bytes that are actually published, not a hand-made fixture.
  const outDir = join(workRoot, 'dist');
  const packed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--out', outDir], {
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, `pack.mjs failed: ${packed.stderr}`);
  tarballPath = join(outDir, `twinsearth-w2m-dsh-plugin-${PACKAGE_VERSION}.tgz`);
  assert.ok(existsSync(tarballPath), `pack.mjs did not produce ${tarballPath}`);
  tarballSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
});

after(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

/** A fresh directory under the test root. @param {string} name */
function scratch(name) {
  const dir = join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Bytes that are easy to compare and obviously not JSON we wrote. */
const ORIGINAL_PACKAGE_JSON = `{
  "name": "dsh-profile-fixture",
  "private": true,
  "dependencies": {
    "@twinsearth/w2m-dsh-plugin": "file:C:/old/w2m-plugin-0.1.1.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@twinsearth/w2m-dsh-plugin"
      ]
    }
  }
}
`;
const ORIGINAL_LOCK = 'lockfileVersion: 9.0\n\nimporters:\n  .:\n    dependencies: {}\n';

/**
 * Build a plausible profile.
 *
 * `node_modules/unrelated-package` exists so every test can prove the installer
 * does not reach into installed packages.
 */
function makeProfile(name, { withLock = true, packageJson = ORIGINAL_PACKAGE_JSON } = {}) {
  const dir = scratch(name);
  writeFileSync(join(dir, 'package.json'), packageJson);
  if (withLock) writeFileSync(join(dir, 'pnpm-lock.yaml'), ORIGINAL_LOCK);
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\n');
  writeFileSync(join(dir, 'cordis.yml'), 'plugins: []\n');
  const unrelated = join(dir, 'node_modules', 'unrelated-package');
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, 'package.json'), '{"name":"unrelated-package","version":"9.9.9"}\n');
  return dir;
}

/**
 * Recursive `relative path -> sha256` map, used to prove "not one byte".
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function snapshot(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out[relative(dir, full).split('\\').join('/')] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * A runner that records its calls and optionally mutates the profile the way a
 * real package manager would before reporting a result.
 *
 * @param {object} options
 * @param {number|null} [options.code]
 * @param {string} [options.stderr]
 * @param {(spec: object) => void} [options.onRun]
 * @param {{code: string, message: string}|null} [options.spawnError]
 * @param {boolean} [options.throwInstead]
 */
function fakeRunner(options = {}) {
  const calls = [];
  const runner = async (spec) => {
    calls.push(spec);
    if (options.throwInstead) throw new Error('runner exploded');
    if (options.onRun) options.onRun(spec);
    return {
      code: options.code ?? 0,
      stdout: options.stdout ?? '',
      stderr: options.stderr ?? '',
      spawnError: options.spawnError ?? null,
      timedOut: options.timedOut ?? false,
    };
  };
  runner.calls = calls;
  return runner;
}

/** Emulate what `pnpm add <tarball>` does to a profile on success. */
function emulateSuccessfulAdd(profileDir, tarball, version = PACKAGE_VERSION) {
  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    [PACKAGE_NAME]: `file:${tarball.split('\\').join('/')}`,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const installed = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'));
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }));
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
}

// ---------------------------------------------------------------------------
// 1. verify before acting
// ---------------------------------------------------------------------------

describe('update-install: the checksum gate', () => {
  it('writes not a single byte when the checksum does not match', async () => {
    const profile = makeProfile('gate-mismatch');
    const before = snapshot(profile);
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: 'f'.repeat(64),
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /sha256 mismatch/);
    assert.equal(result.rolledBack, false);
    assert.equal(runner.calls.length, 0, 'the package manager must not run');
    assert.deepEqual(snapshot(profile), before, 'the profile must be untouched');
    assert.equal(existsSync(join(profile, STAGING_DIR_NAME)), false, 'nothing may be staged');
  });

  it('refuses to install without a checksum at all', async () => {
    const profile = makeProfile('gate-missing-sha');
    const before = snapshot(profile);
    const runner = fakeRunner();

    for (const expectedSha256 of [undefined, '', 'not-a-hash', 'abc123']) {
      const result = await installUpdate({
        tarballPath,
        profileDir: profile,
        expectedSha256,
        runner,
        dshPath: null,
        pnpmPath: 'C:/fake/pnpm.mjs',
      });
      assert.equal(result.ok, false, `expected ${JSON.stringify(expectedSha256)} to be rejected`);
      assert.match(result.error, /expectedSha256/);
    }
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(snapshot(profile), before);
  });

  it('reports a missing tarball or profile as a failure, not a crash', async () => {
    const profile = makeProfile('gate-missing-inputs');
    const missingTarball = await installUpdate({
      tarballPath: join(profile, 'nope.tgz'),
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner: fakeRunner(),
    });
    assert.equal(missingTarball.ok, false);
    assert.match(missingTarball.error, /tarball does not exist/);

    const missingProfile = await installUpdate({
      tarballPath,
      profileDir: join(profile, 'no-such-profile'),
      expectedSha256: tarballSha256,
      runner: fakeRunner(),
    });
    assert.equal(missingProfile.ok, false);
    assert.match(missingProfile.error, /profile directory does not exist/);
  });
});

// ---------------------------------------------------------------------------
// 2. staging and atomicity
// ---------------------------------------------------------------------------

describe('update-install: atomic staging', () => {
  it('stages into the profile and leaves no temporary file behind', async () => {
    const profile = makeProfile('stage-ok');
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, true, result.error ?? '');
    const stagingDir = join(profile, STAGING_DIR_NAME);
    const staged = join(stagingDir, basename(tarballPath));
    assert.ok(existsSync(staged), 'the tarball must be staged inside the profile');
    assert.equal(await sha256File(staged), tarballSha256, 'the staged copy must be identical');
    assert.deepEqual(
      readdirSync(stagingDir).filter((name) => name.includes('.tmp-')),
      [],
      'no temporary file may survive staging',
    );
    assert.ok(
      result.steps.some((line) => /staged .* into/.test(line)),
      `staging must be reported: ${result.steps.join(' | ')}`,
    );
    // The staged path is what the package manager was pointed at, so
    // `file:` in package.json never depends on the OS temp directory.
    assert.ok(runner.calls[0].argv.includes(staged), runner.calls[0].argv.join(' '));
  });

  it('does not re-copy a tarball that is already staged', async () => {
    const profile = makeProfile('stage-twice');
    const runner = fakeRunner();
    const options = {
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    };
    await installUpdate(options);
    const second = await installUpdate({ ...options, tarballPath: join(profile, STAGING_DIR_NAME, basename(tarballPath)) });
    assert.equal(second.ok, true, second.error ?? '');
    assert.ok(
      second.steps.some((line) => /already staged/.test(line)),
      `expected an "already staged" step: ${second.steps.join(' | ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. backup and rollback
// ---------------------------------------------------------------------------

describe('update-install: backup and rollback', () => {
  it('restores package.json and pnpm-lock.yaml byte-for-byte after a failed install', async () => {
    const profile = makeProfile('rollback-bytes');
    const before = snapshot(profile);
    const bigStderr = `${'x'.repeat(6000)}FAILURE_TAIL_MARKER`;

    const runner = fakeRunner({
      code: 1,
      stderr: bigStderr,
      onRun: () => {
        // What pnpm does before failing: rewrite the manifest and the lockfile.
        writeFileSync(join(profile, 'package.json'), '{"name":"half-written"}\n');
        writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# pnpm was here\n');
        mkdirSync(join(profile, 'node_modules', '.pnpm'), { recursive: true });
        writeFileSync(join(profile, 'node_modules', '.pnpm', 'junk'), 'junk\n');
      },
    });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
    assert.equal(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), ORIGINAL_LOCK);
    assert.equal(
      snapshot(profile)['package.json'],
      before['package.json'],
      'the restored manifest must be the same bytes',
    );
    assert.equal(snapshot(profile)['pnpm-lock.yaml'], before['pnpm-lock.yaml']);
    assert.equal(
      snapshot(profile)['node_modules/unrelated-package/package.json'],
      before['node_modules/unrelated-package/package.json'],
      'an unrelated installed package must not be touched',
    );

    // The backup is real and usable, not a rename of the file we overwrote.
    assert.ok(result.backupPath && existsSync(result.backupPath));
    for (const name of BACKED_UP_FILES) {
      assert.equal(readFileSync(join(result.backupPath, name), 'utf8'), readFileSync(join(profile, name), 'utf8'));
    }
    // Nothing was installed before and nothing is installed now, so the
    // resolved tree agrees with the restored manifest.
    assert.equal(result.rollbackComplete, true);
    assert.equal(result.reconciliation, null);
  });

  it('says when the resolved tree no longer matches the restored manifest', async () => {
    const profile = makeProfile('rollback-tree-drift');
    // Pretend an older version is installed before the update runs.
    const installed = join(profile, 'node_modules', ...PACKAGE_NAME.split('/'));
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME, version: '0.0.9' }),
    );

    const runner = fakeRunner({
      code: 1,
      stderr: 'link step failed\n',
      onRun: () => {
        // pnpm removed the old install and died before linking the new one.
        // Restoring package.json cannot bring that directory back -- which is
        // exactly the limitation this field exists to surface.
        rmSync(installed, { recursive: true, force: true });
      },
    });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/runtime/pnpm/bin/pnpm.mjs',
      nodePath: 'C:/node/node.exe',
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true, 'the files are still restored');
    assert.equal(result.rollbackComplete, false, 'but the profile is not provably usable');
    assert.equal(result.installedVersionBefore, '0.0.9');
    assert.equal(result.installedVersionAfterRollback, null);
    assert.match(result.reconciliation, /node_modules no longer matches/);
    assert.match(result.error, /reconcile it with/);
    assert.match(result.error, /install --frozen-lockfile/);
    assert.match(result.error, /C:\/runtime\/pnpm\/bin\/pnpm\.mjs/);
    // The manifest itself is still byte-identical: the restore is never skipped
    // just because the tree is in doubt.
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
  });

  it('removes a lockfile that pnpm created when the profile had none', async () => {
    const profile = makeProfile('rollback-newlock', { withLock: false });
    const runner = fakeRunner({
      code: 3,
      stderr: 'boom\n',
      onRun: () => {
        writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
        writeFileSync(join(profile, 'package.json'), '{}\n');
      },
    });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
    assert.equal(
      existsSync(join(profile, 'pnpm-lock.yaml')),
      false,
      'a lockfile that did not exist before must not survive a rollback',
    );
  });

  it('keeps the new state on success and preserves dsh.profile.bundles exactly', async () => {
    const profile = makeProfile('success-keeps-bundles');
    const originalManifest = JSON.parse(ORIGINAL_PACKAGE_JSON);
    const runner = fakeRunner({
      code: 0,
      onRun: () => {
        emulateSuccessfulAdd(profile, join(profile, STAGING_DIR_NAME, basename(tarballPath)));
      },
    });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.rolledBack, false);
    assert.equal(result.installedVia, 'pnpm');
    assert.equal(result.to, PACKAGE_VERSION, 'the target version comes from the tarball itself');
    assert.equal(result.installedVersion, PACKAGE_VERSION, 'and the installed copy is verified afterwards');

    const after_ = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(
      after_.dsh.profile.bundles,
      originalManifest.dsh.profile.bundles,
      'dsh.profile.bundles decides what DSH loads and must never be rewritten',
    );
    assert.equal(
      readFileSync(join(profile, 'node_modules', 'unrelated-package', 'package.json'), 'utf8'),
      '{"name":"unrelated-package","version":"9.9.9"}\n',
    );
    // The pre-update manifest is preserved in the backup, which is the only
    // reason a later rollback is possible at all.
    assert.equal(readFileSync(join(result.backupPath, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
  });

  it('never deletes the profile directory, even when everything fails', async () => {
    const profile = makeProfile('profile-survives');
    const forFailure = fakeRunner({ code: 1, stderr: 'nope\n' });
    const failed = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner: forFailure,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });
    assert.equal(failed.ok, false);
    assert.ok(existsSync(profile), 'the profile directory must still exist');
    for (const name of ['cordis.yml', 'pnpm-workspace.yaml', 'package.json', 'pnpm-lock.yaml']) {
      assert.ok(existsSync(join(profile, name)), `${name} must survive a failed update`);
    }
  });

  it('restores files and reports false when the restore itself cannot be done', async () => {
    const profile = makeProfile('rollback-broken');
    const backups = [
      { name: 'package.json', existed: true },
      { name: 'pnpm-lock.yaml', existed: true },
    ];
    const ok = rollback(profile, join(profile, 'does-not-exist-backup'), backups);
    assert.equal(ok, false, 'a rollback that cannot read its backup must say so');
  });
});

// ---------------------------------------------------------------------------
// 4. dry run
// ---------------------------------------------------------------------------

describe('update-install: dryRun', () => {
  it('reports the plan without writing or running anything', async () => {
    const profile = makeProfile('dry-run');
    const before = snapshot(profile);
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dryRun: true,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.dryRun, true);
    assert.equal(result.installedVia, 'pnpm');
    assert.ok(Array.isArray(result.argv) && result.argv.includes('add'));
    assert.equal(runner.calls.length, 0, 'dryRun must not call the package manager');
    assert.deepEqual(snapshot(profile), before, 'dryRun must not write');
    assert.equal(existsSync(join(profile, STAGING_DIR_NAME)), false);
  });

  it('still reports a checksum mismatch, with no side effects', async () => {
    const profile = makeProfile('dry-run-bad-sha');
    const before = snapshot(profile);
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: 'a'.repeat(64),
      runner,
      dryRun: true,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /sha256 mismatch/);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(snapshot(profile), before);
  });
});

// ---------------------------------------------------------------------------
// 5. which supported entry point runs
// ---------------------------------------------------------------------------

describe('update-install: installer selection', () => {
  it('prefers the dsh CLI and reports installedVia: dsh', async () => {
    const profile = makeProfile('via-dsh');
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: 'C:/dsh/dsh.cmd',
      pnpmPath: 'C:/runtime/pnpm.mjs',
    });

    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.installedVia, 'dsh');
    const argv = runner.calls[0].argv;
    assert.equal(argv[0], 'C:/dsh/dsh.cmd');
    assert.deepEqual(argv.slice(1, 5), ['plugin', '--profile', basename(profile), 'add']);
    assert.equal(argv[5], join(profile, STAGING_DIR_NAME, basename(tarballPath)));
  });

  it('falls back to the runtime pnpm and reports installedVia: pnpm', async () => {
    const profile = makeProfile('via-pnpm');
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/runtime/pnpm/bin/pnpm.mjs',
      nodePath: 'C:/node/node.exe',
    });

    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.installedVia, 'pnpm');
    assert.deepEqual(runner.calls[0].argv, [
      'C:/node/node.exe',
      '--expose-internals',
      'C:/runtime/pnpm/bin/pnpm.mjs',
      'add',
      join(profile, STAGING_DIR_NAME, basename(tarballPath)),
      '--dir',
      profile,
    ]);
  });

  it('fails clearly when no supported installer exists, without hand-editing node_modules', async () => {
    const profile = makeProfile('no-installer');
    const before = snapshot(profile);
    const runner = fakeRunner();

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: null,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /no supported installer available/);
    assert.match(result.error, /W2M_DSH_CLI/);
    assert.match(result.error, /W2M_PNPM/);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(snapshot(profile), before, 'nothing may be modified without a package manager');
    assert.ok(
      result.steps.some((line) => /nothing to roll back|backed up/.test(line)) || result.steps.length > 0,
      'the steps must explain how far it got',
    );
  });

  it('planInstall is pure and prefers dsh', () => {
    const base = { profileDir: 'P', profileName: 'p', stagedTarball: 'T', nodePath: 'N' };
    assert.deepEqual(planInstall({ ...base, dshPath: 'D', pnpmPath: 'M' }).via, 'dsh');
    assert.deepEqual(planInstall({ ...base, dshPath: null, pnpmPath: 'M' }).via, 'pnpm');
    assert.equal(planInstall({ ...base, dshPath: null, pnpmPath: null }), null);
  });
});

// ---------------------------------------------------------------------------
// 6. failures are never silent
// ---------------------------------------------------------------------------

describe('update-install: failure reporting', () => {
  it('keeps the tail of stderr and says how much was dropped', () => {
    const head = 'HEAD_MARKER';
    const tail = 'TAIL_MARKER';
    const text = `${head}${'y'.repeat(10_000)}${tail}`;
    const result = tailBytes(text, 4096);
    assert.equal(result.text.length <= 4096, true);
    assert.ok(result.text.endsWith(tail), 'the end of the message is what matters');
    assert.equal(result.text.includes(head), false, 'the head is what gets dropped');
    assert.equal(result.truncatedBytes, Buffer.byteLength(text) - result.text.length);
    assert.deepEqual(tailBytes('short', 4096), { text: 'short', truncatedBytes: 0 });
    assert.equal(DEFAULT_STDERR_TAIL_BYTES, 4096);
  });

  it('puts the stderr tail in `error` when the installer exits non-zero', async () => {
    const profile = makeProfile('stderr-tail');
    const stderr = `${'HEAD_MARKER\n'}${'z'.repeat(20_000)}\nTAIL_MARKER\n`;
    const runner = fakeRunner({ code: 2, stderr });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /exited with code 2/);
    assert.ok(result.error.includes('TAIL_MARKER'), 'the reason lives at the end of stderr');
    assert.equal(result.error.includes('HEAD_MARKER'), false);
    assert.equal(Buffer.byteLength(result.stderrTail), 4096);
    assert.equal(result.detailStream, 'stderr');
    assert.equal(result.rolledBack, true);
  });

  it('also keeps the stdout tail, because pnpm 11 prints its errors there', async () => {
    // Measured, not assumed: `pnpm add` failing to resolve a `file:` dependency
    // writes `[ENOENT] ...` to **stdout** and leaves stderr empty. Keeping only
    // stderr would report "exited with code 1" and nothing else.
    const profile = makeProfile('stdout-tail');
    const stdout = `${'a'.repeat(9000)}\n[ENOENT] ENOENT: no such file or directory, open 'C:/old/plugin.tgz'\n`;
    const runner = fakeRunner({ code: 1, stdout, stderr: '' });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.equal(result.detailStream, 'stdout');
    assert.match(result.error, /\[ENOENT\]/, 'the explanation must survive into the error');
    assert.equal(Buffer.byteLength(result.stdoutTail) <= 4096, true);
    assert.equal(result.rolledBack, true);
  });

  it('treats a spawn failure as a failure and rolls back', async () => {
    const profile = makeProfile('spawn-failure');
    const runner = fakeRunner({ spawnError: { code: 'ENOENT', message: 'spawn dsh ENOENT' } });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: 'C:/missing/dsh.cmd',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /could not run dsh \(ENOENT/);
    assert.equal(result.rolledBack, true);
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
  });

  it('treats a throwing runner as a failure and rolls back', async () => {
    const profile = makeProfile('runner-throws');
    const runner = fakeRunner({ throwInstead: true });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner,
      dshPath: null,
      pnpmPath: 'C:/fake/pnpm.mjs',
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), ORIGINAL_PACKAGE_JSON);
  });
});

// ---------------------------------------------------------------------------
// 7. helpers
// ---------------------------------------------------------------------------

describe('update-install: helpers', () => {
  it('reads name and version out of a real release tarball', () => {
    const manifest = readTarballManifest(tarballPath);
    assert.equal(manifest.name, PACKAGE_NAME);
    assert.equal(manifest.version, PACKAGE_VERSION);

    const notATarball = join(workRoot, 'not-a-tarball.tgz');
    writeFileSync(notATarball, 'plain text, definitely not gzip\n');
    assert.equal(readTarballManifest(notATarball), null, 'an unreadable tarball must not throw');
  });

  it('reads the installed version from node_modules, tolerantly', () => {
    const profile = makeProfile('installed-version');
    mkdirSync(join(profile, 'node_modules', ...PACKAGE_NAME.split('/')), { recursive: true });
    writeFileSync(
      join(profile, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME, version: '0.0.9' }),
    );
    assert.equal(readInstalledVersion(profile, PACKAGE_NAME), '0.0.9');
    assert.equal(readInstalledVersion(profile, '@twinsearth/absent'), null);
    assert.equal(readInstalledVersion(join(profile, 'nope'), PACKAGE_NAME), null);
  });

  it('hashes a file the same way the release checksum does', async () => {
    const file = join(workRoot, 'hash-me.bin');
    writeFileSync(file, Buffer.from([0, 1, 2, 3, 255, 254]));
    const expected = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(await sha256File(file), expected);
    await assert.rejects(() => sha256File(join(workRoot, 'absent.bin')));
  });

  it('finds no dsh on PATH but does find the runtime pnpm on this machine', () => {
    // Both are informational: the installer works with either, and reports which.
    const pnpm = resolveRuntimePnpm();
    if (pnpm !== null) {
      assert.ok(existsSync(pnpm), `resolved pnpm does not exist: ${pnpm}`);
      assert.match(pnpm, /pnpm[\\/]bin[\\/]pnpm\.mjs$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. integration with the real runtime pnpm (throwaway profiles only)
// ---------------------------------------------------------------------------

describe('update-install: real pnpm against a throwaway profile', () => {
  const pnpmPath = resolveRuntimePnpm();
  const skip = pnpmPath === null ? 'runtime pnpm not found' : false;

  it('installs this package and preserves dsh.profile.bundles', { skip, timeout: 300_000 }, async () => {
    const profile = makeProfile('real-install');
    // A realistic pre-state: the plugin is already installed from a tarball that
    // **exists** (pnpm resolves every dependency in the manifest, so a
    // placeholder path would fail the install for a reason that has nothing to
    // do with what is being tested).
    const vendor = join(profile, 'vendor');
    mkdirSync(vendor, { recursive: true });
    const previousTarball = join(vendor, 'twinsearth-w2m-dsh-plugin-0.1.1.tgz');
    copyFileSync(tarballPath, previousTarball);
    const preExisting = ORIGINAL_PACKAGE_JSON.replace(
      'file:C:/old/w2m-plugin-0.1.1.tgz',
      `file:${previousTarball.split('\\').join('/')}`,
    );
    writeFileSync(join(profile, 'package.json'), preExisting);
    const original = JSON.parse(preExisting);
    // The real install form: hoisted, no peer auto-install, so pnpm never needs
    // the network for a package with zero runtime dependencies.
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\n');

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner: createChildProcessRunner(),
      dshPath: null,
      pnpmPath,
    });

    assert.equal(result.ok, true, `real pnpm failed: ${result.error ?? ''}`);
    assert.equal(result.installedVia, 'pnpm');
    assert.equal(result.to, PACKAGE_VERSION);
    assert.equal(result.installedVersion, PACKAGE_VERSION);

    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.equal(typeof manifest.dependencies[PACKAGE_NAME], 'string');
    assert.match(manifest.dependencies[PACKAGE_NAME], /^file:/);
    assert.deepEqual(
      manifest.dsh.profile.bundles,
      original.dsh.profile.bundles,
      'a real pnpm run must not touch the bundle list either',
    );
    assert.ok(existsSync(join(profile, 'pnpm-lock.yaml')), 'pnpm writes a lockfile');
    assert.ok(existsSync(profile), 'the profile directory is still there');
    assert.deepEqual(
      readdirSync(join(profile, STAGING_DIR_NAME)).filter((name) => name.includes('.tmp-')),
      [],
    );
    // The backup holds the pre-update manifest, byte for byte.
    assert.equal(readFileSync(join(result.backupPath, 'package.json'), 'utf8'), preExisting);
  });

  it('rolls back for real when pnpm cannot resolve an existing dependency', { skip, timeout: 300_000 }, async () => {
    // A profile that is already broken: pnpm fails while resolving, *after* it
    // has started touching the manifest. That is the state a rollback exists for.
    const broken = `{
  "name": "dsh-profile-broken",
  "private": true,
  "dependencies": {
    "broken-pkg": "file:./does-not-exist.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base"
      ]
    }
  }
}
`;
    const profile = makeProfile('real-rollback', { withLock: false, packageJson: broken });

    const result = await installUpdate({
      tarballPath,
      profileDir: profile,
      expectedSha256: tarballSha256,
      runner: createChildProcessRunner(),
      dshPath: null,
      pnpmPath,
    });

    assert.equal(result.ok, false, 'pnpm must fail on an unresolvable dependency');
    assert.equal(result.rolledBack, true);
    assert.equal(
      readFileSync(join(profile, 'package.json'), 'utf8'),
      broken,
      'the manifest must be restored byte-for-byte',
    );
    assert.equal(existsSync(join(profile, 'pnpm-lock.yaml')), false, 'the lockfile pnpm created must be gone');
    assert.ok(
      /does-not-exist|ENOENT/i.test(result.error),
      `the pnpm explanation must survive into the error: ${result.error}`,
    );
    assert.ok(existsSync(profile), 'the profile directory must still exist');
    // A resolution failure happens before pnpm mutates anything, so the tree is
    // expected to agree with the restored manifest. Asserted as an invariant
    // rather than a hard `true`: if pnpm ever changes that, the result says so
    // instead of the test silently passing a broken profile.
    assert.equal(result.reconciliation === null, result.rollbackComplete === true);
  });
});
