/**
 * Runtime session validation: the gate in the retrospective's G5.
 *
 * ## Why a static validator is not enough
 *
 * The 2026-11-17 recovery drill failed four times with logs that *looked right* and were refused by the app, and
 * the fix was to stop trusting a hand-written parser as evidence: the only accepted proof is the code the running
 * application uses (`sessionFormatCatalog.createRestore(...)` with `validation: 'current'`, which validates the
 * header, event envelopes, messages, surface operations and seed cut through the *installed* `dsh-session`
 * package). That code lives inside `resources/app.asar`, which a plain `node` cannot read -- so this module spawns
 * the Harness runtime itself (Electron in Node mode) with a small driver.
 *
 * ## What is evidence and what is a pre-filter
 *
 * `src/util/session-validate.mjs` (the doctor) is a **pre-filter**: cheap, dependency-free, and the thing that can
 * run anywhere. It is good at catching the four measured failure classes, but its verdict is not the gate. When a
 * Harness installation is present, the runtime verdict is the gate and restore refuses without it. When none is
 * present the caller must opt in explicitly (`requireRuntime: false` / `--allow-static-validation`), and every
 * report says so instead of pretending the evidence is equivalent.
 *
 * ## How the bytes reach the driver
 *
 * The driver needs the decoded artifact (header + event rows), not the zstd file, because frame splitting is
 * already implemented and tested in `src/fix/zstd.mjs`. So the node side decodes once, writes the artifact JSON to
 * a temp file, and the driver reads it. Keep the interface small: one artifact in, one verdict line out.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decompressFrame, scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';

/** Prefix of the driver's single stdout line. Keep it in sync with `runtime-driver.mjs`. */
export const DRIVER_REPORT_PREFIX = 'W2M-RUNTIME-VALIDATE:';

/** Default time budget for one validation process. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 60_000;

/** The driver file, resolved beside this module (it ships inside `src/`). */
export function driverPath() {
  return fileURLToPath(new URL('./runtime-driver.mjs', import.meta.url));
}

/**
 * Locate a Harness installation whose ASAR this process can hand to the runtime.
 *
 * Checks, in order: explicit env overrides, the environment the desktop app exports, and the common Windows
 * install locations. A candidate counts only when `resources/app.asar` exists under it.
 *
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {{root: string, runtime: string, asar: string, source: string} | null}
 */
export function findHarnessInstallation(options = {}) {
  const env = options.env ?? process.env;
  const candidates = [];
  const add = (root, source, runtime = null) => {
    if (typeof root === 'string' && root.trim() !== '') candidates.push({ root: path.resolve(root.trim()), source, runtime });
  };
  add(env.W2M_DSH_ROOT, 'W2M_DSH_ROOT');
  if (typeof env.W2M_DSH_RUNTIME === 'string' && env.W2M_DSH_RUNTIME.trim() !== '') {
    add(path.dirname(env.W2M_DSH_RUNTIME.trim()), 'W2M_DSH_RUNTIME', env.W2M_DSH_RUNTIME.trim());
  }
  if (typeof env.DSH_NODE_EXECUTABLE === 'string' && env.DSH_NODE_EXECUTABLE.trim() !== '') {
    add(path.dirname(env.DSH_NODE_EXECUTABLE.trim()), 'DSH_NODE_EXECUTABLE', env.DSH_NODE_EXECUTABLE.trim());
  }
  if (typeof env.DSH_INSTALL_DIR === 'string' && env.DSH_INSTALL_DIR.trim() !== '') {
    // `<root>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh` -- walk up until the asar is a sibling.
    let dir = path.resolve(env.DSH_INSTALL_DIR.trim());
    for (let depth = 0; depth < 8; depth += 1) {
      const asar = path.join(dir, 'resources', 'app.asar');
      if (fs.existsSync(asar)) {
        add(dir, 'DSH_INSTALL_DIR');
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const local = env.LOCALAPPDATA;
  if (typeof local === 'string' && local !== '') add(path.join(local, 'Programs', 'DeepSeek Harness'), 'LOCALAPPDATA');
  if (typeof env.ProgramFiles === 'string' && env.ProgramFiles !== '') add(path.join(env.ProgramFiles, 'DeepSeek Harness'), 'ProgramFiles');

  for (const candidate of candidates) {
    const asar = path.join(candidate.root, 'resources', 'app.asar');
    if (!fs.existsSync(asar)) continue;
    const runtime = candidate.runtime ?? defaultRuntimeFor(candidate.root);
    if (runtime === null || !fs.existsSync(runtime)) continue;
    return { root: candidate.root, runtime, asar, source: candidate.source };
  }
  return null;
}

/** The executable inside an installation root, if one of the known names is present. */
function defaultRuntimeFor(root) {
  for (const name of ['DeepSeek Harness.exe', 'deepseek-harness.exe', 'DeepSeek Harness']) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Decode a session log into the artifact the runtime restore expects.
 *
 * @param {Buffer} buffer
 * @returns {{header: object, events: object[], inheritedEventCount: number, frames: number}}
 * @throws {Error} when the container has no decodable frame or no header
 */
export function buildArtifactFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('the log is empty');
  const { frames } = scanFrames(buffer);
  if (frames.length === 0) throw new Error('the log contains no complete zstd frame');
  const rows = [];
  for (const frame of frames) {
    const text = decompressFrame(buffer.subarray(frame.start, frame.end));
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      rows.push(JSON.parse(line));
    }
  }
  if (rows.length === 0) throw new Error('the log decoded to no rows');
  const [header, ...events] = rows;
  if (header?.type !== 'session') throw new Error('the first row is not a session header');
  let inheritedEventCount = 0;
  for (const [index, event] of events.entries()) {
    if (event?.type === 'session/end-seed' && event.data?.inherited === true) inheritedEventCount = index + 1;
  }
  return { header, events, inheritedEventCount, frames: frames.length };
}

/**
 * Run the installed Harness's own session validator on one artifact.
 *
 * @param {{
 *   buffer?: Buffer,
 *   artifact?: object,
 *   harness?: ReturnType<typeof findHarnessInstallation>,
 *   timeoutMs?: number,
 *   env?: Record<string, string|undefined>,
 * }} input
 * @returns {{available: boolean, ok: boolean, detail: string, events: number, runtime: string|null, source: string|null, duration_ms: number}}
 */
export function runtimeValidate(input = {}) {
  const started = Date.now();
  const harness = input.harness === undefined ? findHarnessInstallation({ env: input.env }) : input.harness;
  if (harness === null) {
    return {
      available: false,
      ok: false,
      detail: 'no DeepSeek Harness installation was found, so the runtime validator cannot run',
      events: 0,
      runtime: null,
      source: null,
      duration_ms: Date.now() - started,
    };
  }
  let artifact = input.artifact;
  if (artifact === undefined) {
    try {
      artifact = buildArtifactFromBuffer(input.buffer ?? Buffer.alloc(0));
    } catch (error) {
      return {
        available: true,
        ok: false,
        detail: `could not decode the log for validation: ${error instanceof Error ? error.message : String(error)}`,
        events: 0,
        runtime: harness.runtime,
        source: harness.source,
        duration_ms: Date.now() - started,
      };
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-runtime-validate-'));
  const artifactFile = path.join(scratch, 'artifact.json');
  try {
    fs.writeFileSync(artifactFile, JSON.stringify(artifact), 'utf8');
    const result = spawnSync(harness.runtime, [driverPath(), artifactFile], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: input.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS,
      env: { ...process.env, ...(input.env ?? {}), ELECTRON_RUN_AS_NODE: '1' },
    });
    const stdout = String(result.stdout ?? '');
    const line = stdout.split('\n').find((candidate) => candidate.startsWith(DRIVER_REPORT_PREFIX));
    if (line === undefined) {
      const stderr = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
      return {
        available: true,
        ok: false,
        detail: `the runtime validator produced no verdict (exit ${result.status ?? '?'})${stderr === '' ? '' : `: ${stderr}`}`,
        events: 0,
        runtime: harness.runtime,
        source: harness.source,
        duration_ms: Date.now() - started,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(line.slice(DRIVER_REPORT_PREFIX.length));
    } catch (error) {
      return {
        available: true,
        ok: false,
        detail: `the runtime validator's verdict was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        events: 0,
        runtime: harness.runtime,
        source: harness.source,
        duration_ms: Date.now() - started,
      };
    }
    return {
      available: true,
      ok: parsed.ok === true,
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      events: Number.isSafeInteger(parsed.events) ? parsed.events : 0,
      runtime: harness.runtime,
      source: harness.source,
      duration_ms: Date.now() - started,
    };
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* the verdict is what matters; a leaked temp dir is reported by gc-like checks elsewhere */
    }
  }
}

/**
 * The restore gate: static pre-filter, then the runtime verdict when one is required.
 *
 * @param {{
 *   buffer: Buffer,
 *   expectedSessionId?: string|null,
 *   harness?: ReturnType<typeof findHarnessInstallation>,
 *   requireRuntime?: boolean,
 *   env?: Record<string, string|undefined>,
 * }} input
 * @returns {{
 *   ok: boolean, reason_code: string|null, detail: string,
 *   static: {ok: boolean, codes: string[], detail: object},
 *   runtime: ReturnType<typeof runtimeValidate>|null,
 *   runtime_verified: boolean,
 * }}
 */
export function validateCandidate(input) {
  const staticResult = diagnoseSessionBuffer(input.buffer, { expectedSessionId: input.expectedSessionId ?? null });
  const requireRuntime = input.requireRuntime !== false;
  // A log the pre-filter already refuses never reaches the runtime: it is cheaper, and it keeps the refusal
  // attributable to the static rule rather than to a slower second opinion.
  if (staticResult.ok !== true) {
    return {
      ok: false,
      reason_code: 'BACKUP_CANDIDATE_INVALID',
      detail: `the static validator refused the log: ${staticResult.codes.join(', ')}`,
      static: { ok: false, codes: staticResult.codes, detail: staticResult.detail },
      runtime: null,
      runtime_verified: false,
    };
  }
  const runtime = requireRuntime || input.harness !== undefined ? runtimeValidate({ buffer: input.buffer, harness: input.harness, env: input.env }) : null;
  if (runtime === null) {
    return {
      ok: true,
      reason_code: null,
      detail: 'static validation passed; runtime validation was not requested',
      static: { ok: true, codes: [], detail: staticResult.detail },
      runtime: null,
      runtime_verified: false,
    };
  }
  if (runtime.available !== true) {
    if (requireRuntime) {
      return {
        ok: false,
        reason_code: 'BACKUP_RUNTIME_UNAVAILABLE',
        detail: `${runtime.detail}; install the Harness on this machine, or pass --allow-static-validation to accept static-only evidence`,
        static: { ok: true, codes: [], detail: staticResult.detail },
        runtime,
        runtime_verified: false,
      };
    }
    return {
      ok: true,
      reason_code: null,
      detail: 'static validation passed; the runtime validator is unavailable (static-only evidence accepted)',
      static: { ok: true, codes: [], detail: staticResult.detail },
      runtime,
      runtime_verified: false,
    };
  }
  if (runtime.ok !== true) {
    return {
      ok: false,
      reason_code: 'BACKUP_RUNTIME_REJECTED',
      detail: `the installed Harness refused the log: ${runtime.detail}`,
      static: { ok: true, codes: [], detail: staticResult.detail },
      runtime,
      runtime_verified: false,
    };
  }
  return {
    ok: true,
    reason_code: null,
    detail: `static and runtime validation both passed (${runtime.events} events)`,
    static: { ok: true, codes: [], detail: staticResult.detail },
    runtime,
    runtime_verified: true,
  };
}
