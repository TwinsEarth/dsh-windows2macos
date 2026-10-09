/**
 * Capability detection for the W2M Localside agent.
 *
 * Rules this file follows, because "guessing" here poisons every later
 * comparison:
 *
 *   * **Probe, do not assume.**  Case sensitivity, symlink support and the
 *     POSIX execute bit are detected by actually exercising the filesystem in
 *     the system temp directory, not by switching on `process.platform`.
 *   * **PATH first, bundled runtime second.**  This machine has no `python`
 *     and no `npm` on PATH, but DSH ships its own runtimes under
 *     `%DSH_HOME%\dsh-runtimes\<runtime>\dependencies\`.  A capability we can
 *     find there is real and is reported with the real version string.
 *   * **Null over fiction.**  When a tool cannot be found we report `null`
 *     instead of a plausible-looking version, and the caller refuses the task
 *     with `MISSING_<TOOL>` rather than silently degrading.
 *
 * Only the six keys the contract puts in `caps` are returned by `probeCaps()`;
 * the evidence behind them is in `probeCapsDetailed().detail` so it never
 * leaks into an envelope.
 */

import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, release as osRelease } from 'node:os';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runArgv } from './exec.mjs';
import { dshDependenciesDir, findExecutable } from './resolve.mjs';

// The executable search order is shared with the executor, so the probe and the
// run agree on what "this machine has node" means. Re-exported from here because
// this module is where callers have always imported them from.
export {
  DSH_RUNTIME_RELATIVE,
  bundledBinDirs,
  dshDependenciesDir,
  dshHome,
  findExecutable,
  resolveCommand,
} from './resolve.mjs';

/** Keys of the contract's `caps` object — nothing else may be added. */
export const CAPS_KEYS = ['case_sensitive_fs', 'symlinks', 'exec_bit', 'python', 'npm', 'node'];

/**
 * Run `<exe> <args>` and return the first regex capture of stdout+stderr.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {RegExp} pattern
 * @param {number} [timeoutMs]
 * @returns {Promise<{version: string|null, error: string|null}>}
 */
async function probeVersion(exe, args, pattern, timeoutMs = 8000) {
  const result = await runArgv([exe, ...args], { timeoutMs, maxOutputBytes: 64 * 1024 });
  if (result.spawn_error) return { version: null, error: `SPAWN_${result.spawn_error.code}` };
  if (result.timed_out) return { version: null, error: 'PROBE_TIMEOUT' };
  const text = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
  const match = text.match(pattern);
  return { version: match ? match[1] : null, error: match ? null : 'VERSION_UNPARSED' };
}

/** Node/npm/python version formats differ; keep the tool's own spelling. */
const RE_NODE = /\bv?(\d+\.\d+\.\d+)\b/;
const RE_PYTHON = /Python\s+(\d+\.\d+\.\d+)/i;
const RE_NPM = /\bv?(\d+\.\d+\.\d+)\b/;

/**
 * Locate and version one external tool.
 *
 * @param {object} spec
 * @param {string[]} spec.names Bare names to look for, in priority order.
 * @param {string[]} spec.bundled Absolute candidate paths inside the DSH tree.
 * @param {string[]} spec.versionArgs
 * @param {RegExp} spec.pattern
 * @param {string} [spec.versionPrefix]
 * @param {Record<string,string|undefined>} env
 * @returns {Promise<{version: string|null, path: string|null, source: 'path'|'bundled'|null, error: string|null}>}
 */
async function probeTool(spec, env) {
  const onPath = spec.names.map((n) => findExecutable(n, { env })).find(Boolean) ?? null;
  const bundled = spec.bundled.map((p) => (p && isFile(p) ? p : null)).find(Boolean) ?? null;
  const exe = onPath ?? bundled;
  if (!exe) return { version: null, path: null, source: null, error: 'NOT_FOUND' };

  const { version, error } = await probeVersion(exe, spec.versionArgs, spec.pattern);
  return {
    version: version && spec.versionPrefix ? spec.versionPrefix + version : version,
    path: exe,
    source: onPath ? 'path' : 'bundled',
    error,
  };
}

/** @param {string} p */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `node` as a *task* would resolve it: PATH first, DSH's bundled node second,
 * and finally the interpreter currently running this agent.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string|null} depsDir
 * @returns {Promise<{version: string|null, path: string|null, source: string|null, error: string|null}>}
 */
async function probeNode(env, depsDir) {
  const isWin = process.platform === 'win32';
  const bundled = depsDir ? [join(depsDir, 'node', 'bin', isWin ? 'node.exe' : 'node')] : [];
  const found = await probeTool(
    { names: ['node'], bundled, versionArgs: ['-v'], pattern: RE_NODE, versionPrefix: 'v' },
    env,
  );
  if (found.version) {
    return { ...found, version: `v${found.version.replace(/^v/, '')}` };
  }
  return { version: process.version, path: process.execPath, source: 'self', error: found.error };
}

/**
 * Python: PATH (`python`, `python3`) first, then the bundled interpreter.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string|null} depsDir
 */
async function probePython(env, depsDir) {
  const isWin = process.platform === 'win32';
  const bundled = depsDir
    ? [
        join(depsDir, 'python', isWin ? 'python.exe' : join('bin', 'python3')),
        join(depsDir, 'python', 'python.exe'),
      ]
    : [];
  return probeTool(
    {
      names: ['python', 'python3'],
      bundled,
      versionArgs: ['--version'],
      pattern: RE_PYTHON,
    },
    env,
  );
}

/**
 * npm.
 *
 * On Windows npm on PATH is normally `npm.cmd`, which `spawn(..., {shell:false})`
 * cannot start (and we will not build a shell command line just to ask for a
 * version).  `npm-cli.js` next to the resolved node is the honest alternative:
 * it is what `npm.cmd` would have run anyway.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string|null} depsDir
 * @param {string|null} nodePath
 */
async function probeNpm(env, depsDir, nodePath) {
  const nodeExe = nodePath ?? process.execPath;
  const cliCandidates = [];
  if (depsDir) {
    cliCandidates.push(
      join(depsDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(depsDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(depsDir, 'npm', 'bin', 'npm-cli.js'),
    );
  }
  if (nodePath) {
    const binDir = join(nodePath, '..');
    cliCandidates.push(
      join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }

  const cli = cliCandidates.find((p) => isFile(p));
  if (cli) {
    const { version, error } = await probeVersion(nodeExe, [cli, '--version'], RE_NPM);
    return { version, path: cli, source: 'npm-cli', error };
  }

  // A directly executable npm (POSIX shell script, or npm.exe on Windows).
  const direct = probeToolOnPath(['npm'], env);
  if (direct) {
    const { version, error } = await probeVersion(direct, ['--version'], RE_NPM);
    return { version, path: direct, source: 'path', error };
  }

  const shim = probeToolOnPath(['npm.cmd', 'npm.bat'], env);
  return {
    version: null,
    path: shim,
    source: shim ? 'cmd-shim' : null,
    error: shim ? 'NEEDS_SHELL' : 'NOT_FOUND',
  };
}

/** @param {string[]} names @param {Record<string,string|undefined>} env */
function probeToolOnPath(names, env) {
  for (const name of names) {
    const found = findExecutable(name, { env, extensions: [''] });
    if (found) return found;
  }
  return null;
}

/**
 * Probe the three filesystem capabilities in a scratch directory.
 *
 * @param {string} root Scratch root (usually `os.tmpdir()`).
 * @returns {{case_sensitive_fs: boolean, case_sensitive_source: string, symlinks: boolean, symlinks_source: string, exec_bit: boolean, exec_bit_source: string, notes: string[]}}
 */
export function probeFilesystemCaps(root = tmpdir()) {
  const notes = [];
  let dir = null;
  const out = {
    case_sensitive_fs: false,
    case_sensitive_source: 'fallback',
    symlinks: false,
    symlinks_source: 'fallback',
    exec_bit: false,
    exec_bit_source: 'fallback',
    notes,
  };

  try {
    dir = mkdtempSync(join(root, 'w2m-caps-'));
  } catch (error) {
    notes.push(`scratch dir unavailable: ${error?.message ?? error}`);
    out.case_sensitive_fs = process.platform !== 'win32' && process.platform !== 'darwin';
    out.symlinks = process.platform !== 'win32';
    out.exec_bit = process.platform !== 'win32';
    return out;
  }

  try {
    // --- case sensitivity -------------------------------------------------
    const token = randomBytes(6).toString('hex');
    const upper = join(dir, `W2M-Case-${token}`);
    try {
      writeFileSync(upper, 'probe');
      let insensitive = false;
      try {
        statSync(join(dir, `w2m-case-${token}`));
        insensitive = true;
      } catch {
        insensitive = false;
      }
      out.case_sensitive_fs = !insensitive;
      out.case_sensitive_source = 'probe';
    } catch (error) {
      notes.push(`case probe failed: ${error?.message ?? error}`);
    }

    // --- symlinks ---------------------------------------------------------
    const target = join(dir, 'symlink-target.txt');
    const link = join(dir, 'symlink-link.txt');
    try {
      writeFileSync(target, 'probe');
      symlinkSync(target, link, 'file');
      out.symlinks = true;
      out.symlinks_source = 'probe';
    } catch (error) {
      const code = error?.code ?? 'UNKNOWN';
      out.symlinks = false;
      out.symlinks_source = `probe:${code}`;
      notes.push(`symlink probe denied (${code})`);
    }

    // --- POSIX execute bit ------------------------------------------------
    const execFile = join(dir, 'exec-probe.sh');
    try {
      writeFileSync(execFile, '#!/bin/sh\nexit 0\n');
      chmodSync(execFile, 0o755);
      const mode = statSync(execFile).mode & 0o777;
      out.exec_bit = (mode & 0o100) !== 0;
      out.exec_bit_source = `probe:${mode.toString(8)}`;
    } catch (error) {
      notes.push(`exec-bit probe failed: ${error?.message ?? error}`);
    }
  } finally {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return out;
}

/**
 * Detect the platform object the contract wants in `platform` (§5.1) and in the
 * pair request (§2.2).
 *
 * `shell` here is the machine's *interactive* shell, reported for the record;
 * task execution never uses it (`shell_id` stays `direct-exec`).
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @returns {Promise<{os: string, os_version: string, arch: string, shell: string, shell_version: string|null, shell_path: string|null}>}
 */
export async function detectPlatform(options = {}) {
  const env = options.env ?? process.env;
  const os = osName(process.platform);
  const arch = normalizeArch(process.arch);
  let osVersion = osRelease();

  if (process.platform === 'darwin') {
    // APFS builds report the Darwin kernel (e.g. 24.6.0); humans expect 15.x.
    const swVers = isFile('/usr/bin/sw_vers') ? '/usr/bin/sw_vers' : null;
    if (swVers) {
      const { version } = await probeVersion(swVers, ['-productVersion'], /^(\d+(?:\.\d+)*)/m, 5000);
      if (version) osVersion = version;
    }
  }

  return { os, os_version: osVersion, arch, ...(await detectShell(env)) };
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {Promise<{shell: string, shell_version: string|null, shell_path: string|null}>}
 */
async function detectShell(env) {
  if (process.platform === 'win32') {
    const pwsh = findExecutable('pwsh', { env });
    if (pwsh) {
      const { version } = await probeVersion(
        pwsh,
        ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        /^(\d+(?:\.\d+){1,3})/m,
      );
      return { shell: 'pwsh', shell_version: version, shell_path: pwsh };
    }
    const powershell = findExecutable('powershell', { env });
    if (powershell) {
      const { version } = await probeVersion(
        powershell,
        ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        /^(\d+(?:\.\d+){1,3})/m,
      );
      return { shell: 'powershell', shell_version: version, shell_path: powershell };
    }
    const cmd = (env.ComSpec && env.ComSpec.trim() !== '' ? env.ComSpec : null) ??
      findExecutable('cmd', { env });
    if (cmd) {
      const { version } = await probeVersion(cmd, ['/d', '/c', 'ver'], /Version\s+(\d+(?:\.\d+)*)/i);
      return { shell: 'cmd', shell_version: version, shell_path: cmd };
    }
    return { shell: 'unknown', shell_version: null, shell_path: null };
  }

  const fromEnv = env.SHELL && env.SHELL.trim() !== '' ? env.SHELL : null;
  const exe = fromEnv ?? findExecutable('sh', { env });
  if (!exe) return { shell: 'sh', shell_version: null, shell_path: null };
  const name = basename(exe);
  if (name === 'sh') return { shell: 'sh', shell_version: null, shell_path: exe };
  const { version } = await probeVersion(exe, ['--version'], /(\d+\.\d+(?:\.\d+)?)/);
  return { shell: name, shell_version: version, shell_path: exe };
}

/** @param {string} platform @returns {string} */
export function osName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

/** @param {string} arch @returns {string} */
export function normalizeArch(arch = process.arch) {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'ia32') return 'ia32';
  return arch;
}

/**
 * Produce the contract's `caps` object plus the evidence behind every value.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.tmpRoot] Scratch directory for filesystem probes.
 * @returns {Promise<{caps: {case_sensitive_fs: boolean, symlinks: boolean, exec_bit: boolean, python: string|null, npm: string|null, node: string|null}, detail: object}>}
 */
export async function probeCapsDetailed(options = {}) {
  const env = options.env ?? process.env;
  const fsCaps = probeFilesystemCaps(options.tmpRoot ?? tmpdir());
  const depsDir = dshDependenciesDir(env);

  const node = await probeNode(env, depsDir);
  const python = await probePython(env, depsDir);
  const npm = await probeNpm(env, depsDir, node.path);

  const caps = {
    case_sensitive_fs: fsCaps.case_sensitive_fs,
    symlinks: fsCaps.symlinks,
    exec_bit: fsCaps.exec_bit,
    python: python.version,
    npm: npm.version,
    node: node.version,
  };

  return {
    caps,
    detail: {
      case_sensitive_fs: { value: caps.case_sensitive_fs, source: fsCaps.case_sensitive_source },
      symlinks: { value: caps.symlinks, source: fsCaps.symlinks_source },
      exec_bit: { value: caps.exec_bit, source: fsCaps.exec_bit_source },
      python: { value: python.version, path: python.path, source: python.source, error: python.error },
      npm: { value: npm.version, path: npm.path, source: npm.source, error: npm.error },
      node: { value: node.version, path: node.path, source: node.source, error: node.error },
      dsh_dependencies_dir: depsDir,
      notes: fsCaps.notes,
    },
  };
}

/**
 * Contract-shaped caps only (no detail keys), for pair requests and envelopes.
 *
 * @param {object} [options]
 * @returns {Promise<{case_sensitive_fs: boolean, symlinks: boolean, exec_bit: boolean, python: string|null, npm: string|null, node: string|null}>}
 */
export async function probeCaps(options = {}) {
  return (await probeCapsDetailed(options)).caps;
}

/** The bare executable name of a resolved tool, for logging. */
export function commandLabel(exe) {
  const base = basename(exe);
  return extname(base) === '' ? base : base.slice(0, -extname(base).length);
}
