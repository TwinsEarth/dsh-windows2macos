/**
 * Runtime session validation: the gate in the retrospective's G5.
 *
 * ## Why a static validator is not enough
 *
 * The 2026-11-17 recovery drill failed four times with logs that *looked right* and were refused by the app, and
 * the fix was to stop trusting a hand-written parser as evidence: the only accepted proof is the code the running
 * application uses (`sessionFormatCatalog.createRestore(...)` with `validation: 'current'`). That code lives inside
 * `resources/app.asar`, which a plain `node` cannot read -- so this module spawns the Harness runtime itself
 * (Electron in Node mode) with a small driver.
 *
 * ## What is evidence and what is a pre-filter
 *
 * `src/util/session-validate.mjs` (the doctor) is a **pre-filter**: cheap, dependency-free, and the thing that can
 * run anywhere. It is good at catching the measured failure classes, but its verdict is not the gate. When a
 * Harness installation is present, the runtime verdict is the gate and restore refuses without it. When none is
 * present the caller must opt in explicitly (`requireRuntime: false` / `--allow-static-validation`), and every
 * report says so instead of pretending the evidence is equivalent.
 *
 * ## Batches, because plans validate many sessions
 *
 * One runtime process validates an array of artifacts: `runtimeValidateBatch`. Planning a 15-session restore used to
 * spawn 15 processes (~1.4 min) and now spawns one. Verdicts are cached per artifact content digest, so the plan and
 * the apply in the same process do not validate the same bytes twice.
 *
 * ## The future append is validated too (G3)
 *
 * "It opens today" is not "it keeps opening". `appendLegalEvent` builds the bytes of the log plus one legal
 * `permission/preset` event; `validateCandidates` asks the runtime about both the original and the appended artifact
 * in the same batch, so a log that would break on the next real append is refused *before* it is published.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decompressFrame, scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';
import { appendLegalEvent as generateAppend } from './future-append.mjs';

/** Prefix of the driver's single stdout line. Keep it in sync with `runtime-driver.mjs`. */
export const DRIVER_REPORT_PREFIX = 'W2M-RUNTIME-VALIDATE:';

/** Default time budget for one validation process. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 120_000;

/** Cache of verdicts by artifact digest, for the lifetime of the process. */
const verdictCache = new Map();
const VERDICT_CACHE_LIMIT = 128;

/** The driver file, resolved beside this module (it ships inside `src/`). */
export function driverPath() {
  return fileURLToPath(new URL('./runtime-driver.mjs', import.meta.url));
}

/** Clear the per-process verdict cache (tests, or after the installation changes). */
export function clearVerdictCache() {
  verdictCache.clear();
}

/**
 * Locate a Harness installation whose ASAR this process can hand to the runtime.
 *
 * Checks, in order: explicit env overrides, the environment the desktop app exports, and the common install
 * locations. A candidate counts only when `resources/app.asar` exists under it.
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
    let dir = path.resolve(env.DSH_INSTALL_DIR.trim());
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(dir, 'resources', 'app.asar'))) {
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
 * Append one legal event to a session log, in memory (gate G3's "future append").
 *
 * `permission/preset` is the weakest legal append found empirically: it is session-level (no turn state, no
 * surface, no references), and the installed Harness accepts it after both a completed turn and a seed end
 * (`turn/start` needs the *next* turn number, which depends on state that a validator should not have to predict).
 * If the appended bytes fail, the log's own invariants are wrong in a way the client's next append would hit.
 *
 * @param {Buffer} buffer
 * @returns {Buffer} the original bytes followed by one compressed event frame
 */
export function appendLegalEvent(buffer) {
  // One implementation, in future-append.mjs: the engine, verify and restore all simulate the same append.
  return generateAppend(buffer);
}

/** Stable digest of one artifact, used as the verdict-cache key. */
function artifactDigest(artifact) {
  return crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}

/**
 * Write one artifact as NDJSON without ever building one giant string.
 *
 * Line 1 is the header envelope; every following line is one event row. Written with `writeSync` in a loop so the
 * process never holds a second copy of the whole artifact (the measured failure mode for a 370 MiB artifact was
 * `JSON.parse` inside the runtime, not the write, but the write is the part we control).
 *
 * @param {string} file
 * @param {{header: object, events: object[], inheritedEventCount: number}} artifact
 */
function writeArtifactNdjson(file, artifact) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify({ header: artifact.header, inheritedEventCount: artifact.inheritedEventCount })}\n`);
    for (const event of artifact.events) {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Remember a verdict, evicting the oldest entry when the cache is full. */
function remember(key, verdict) {
  if (verdictCache.size >= VERDICT_CACHE_LIMIT) {
    const oldest = verdictCache.keys().next();
    if (!oldest.done) verdictCache.delete(oldest.value);
  }
  verdictCache.set(key, verdict);
}

/**
 * Validate a batch of artifacts in ONE runtime process (cache-aware).
 *
 * @param {{
 *   artifacts: Array<object>, harness?: ReturnType<typeof findHarnessInstallation>|null,
 *   timeoutMs?: number, env?: Record<string, string|undefined>,
 * }} input
 * @returns {{available: boolean, source: string|null, runtime: string|null,
 *   verdicts: Array<{ok: boolean, detail: string, events: number}>, duration_ms: number}}
 */
export function runtimeValidateBatch(input) {
  const started = Date.now();
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const harness = input.harness === undefined ? findHarnessInstallation({ env: input.env }) : input.harness;
  const unavailable = (detail) => ({
    available: false,
    source: null,
    runtime: null,
    verdicts: artifacts.map(() => ({ ok: false, detail, events: 0 })),
    duration_ms: Date.now() - started,
  });
  if (artifacts.length === 0) return { available: harness !== null, source: harness?.source ?? null, runtime: harness?.runtime ?? null, verdicts: [], duration_ms: 0 };
  if (harness === null) return unavailable('no DeepSeek Harness installation was found, so the runtime validator cannot run');

  // Cache key = installation identity + artifact digest: two installations may disagree.
  const cacheKeys = artifacts.map((artifact) => `${harness.runtime}|${artifactDigest(artifact)}`);
  const verdicts = new Array(artifacts.length).fill(null);
  const pendingKeys = [];
  const pendingByKey = new Map();
  for (const [index, key] of cacheKeys.entries()) {
    const cached = verdictCache.get(key);
    if (cached !== undefined) {
      verdicts[index] = { ...cached };
      continue;
    }
    let entry = pendingByKey.get(key);
    if (entry === undefined) {
      entry = { artifact: artifacts[index], indices: [] };
      pendingByKey.set(key, entry);
      pendingKeys.push(key);
    }
    entry.indices.push(index);
  }

  if (pendingKeys.length > 0) {
    // Two transports, chosen by size:
    //  * small artifacts go into one JSON array per ~96 MiB chunk (fast: one process for many sessions);
    //  * an artifact whose JSON would be huge is streamed to the driver as NDJSON, because parsing a ~370 MiB
    //    JSON value inside the Electron runtime crashed its V8 heap on a real backup (exit 134). The threshold is
    //    well below that measured failure so the decision is made before the runtime sees the file.
    const MAX_BATCH_BYTES = 96 * 1024 * 1024;
    const STREAM_THRESHOLD = 32 * 1024 * 1024;
    const batches = [];
    const streaming = [];
    let batch = [];
    let batchBytes = 0;
    for (const key of pendingKeys) {
      const entry = pendingByKey.get(key);
      let serialized;
      try {
        serialized = JSON.stringify(entry.artifact);
      } catch (error) {
        const verdict = { ok: false, detail: `the artifact could not be serialized for validation: ${error instanceof Error ? error.message : String(error)}`, events: 0 };
        remember(key, verdict);
        for (const index of entry.indices) verdicts[index] = { ...verdict };
        continue;
      }
      if (serialized.length > STREAM_THRESHOLD) {
        streaming.push({ key, artifact: entry.artifact, size: serialized.length });
        continue;
      }
      if (batch.length > 0 && batchBytes + serialized.length > MAX_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push({ key, serialized });
      batchBytes += serialized.length;
    }
    if (batch.length > 0) batches.push(batch);

    for (const current of batches) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-runtime-validate-'));
      const artifactFile = path.join(scratch, 'artifacts.json');
      try {
        fs.writeFileSync(artifactFile, `[${current.map((row) => row.serialized).join(',')}]`, 'utf8');
        const result = spawnSync(harness.runtime, [driverPath(), artifactFile], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: input.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS,
          env: { ...process.env, ...(input.env ?? {}), ELECTRON_RUN_AS_NODE: '1' },
        });
        const line = String(result.stdout ?? '')
          .split('\n')
          .find((candidate) => candidate.startsWith(DRIVER_REPORT_PREFIX));
        if (line === undefined) {
          const stderr = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
          const detail = `the runtime validator produced no verdict (exit ${result.status ?? '?'})${stderr === '' ? '' : `: ${stderr}`}`;
          for (const row of current) {
            const verdict = { ok: false, detail, events: 0 };
            remember(row.key, verdict);
            for (const index of pendingByKey.get(row.key).indices) verdicts[index] = { ...verdict };
          }
          continue;
        }
        const parsed = JSON.parse(line.slice(DRIVER_REPORT_PREFIX.length));
        const list = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
        for (const [offset, row] of current.entries()) {
          const verdict = list[offset] ?? { ok: false, detail: 'the runtime validator returned fewer verdicts than artifacts', events: 0 };
          const normalized = {
            ok: verdict.ok === true,
            detail: typeof verdict.detail === 'string' ? verdict.detail : '',
            events: Number.isSafeInteger(verdict.events) ? verdict.events : 0,
          };
          remember(row.key, normalized);
          for (const index of pendingByKey.get(row.key).indices) verdicts[index] = { ...normalized };
        }
      } finally {
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
          /* the verdict is what matters */
        }
      }
    }

    for (const item of streaming) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-runtime-stream-'));
      const artifactFile = path.join(scratch, 'artifact.ndjson');
      try {
        writeArtifactNdjson(artifactFile, item.artifact);
        const result = spawnSync(harness.runtime, [driverPath(), '-ndjson', artifactFile], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: input.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS,
          env: { ...process.env, ...(input.env ?? {}), ELECTRON_RUN_AS_NODE: '1' },
        });
        const line = String(result.stdout ?? '')
          .split('\n')
          .find((candidate) => candidate.startsWith(DRIVER_REPORT_PREFIX));
        let verdict;
        if (line === undefined) {
          const stderr = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
          verdict = { ok: false, detail: `the streaming runtime validator produced no verdict (exit ${result.status ?? '?'})${stderr === '' ? '' : `: ${stderr}`}`, events: 0 };
        } else {
          const parsed = JSON.parse(line.slice(DRIVER_REPORT_PREFIX.length));
          const first = Array.isArray(parsed?.verdicts) ? parsed.verdicts[0] : undefined;
          verdict = {
            ok: first?.ok === true,
            detail: typeof first?.detail === 'string' ? first.detail : 'the streaming validator returned no verdict',
            events: Number.isSafeInteger(first?.events) ? first.events : 0,
          };
        }
        remember(item.key, verdict);
        for (const index of pendingByKey.get(item.key).indices) verdicts[index] = { ...verdict };
      } finally {
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
          /* the verdict is what matters */
        }
      }
    }
  }

  const finalVerdicts = verdicts.map((verdict) => verdict ?? { ok: false, detail: 'no verdict for this artifact', events: 0 });
  return {
    available: true,
    source: harness.source,
    runtime: harness.runtime,
    verdicts: finalVerdicts,
    duration_ms: Date.now() - started,
  };
}

/**
 * Run the installed Harness's own session validator on one artifact.
 *
 * @param {{
 *   buffer?: Buffer, artifact?: object,
 *   harness?: ReturnType<typeof findHarnessInstallation>,
 *   timeoutMs?: number, env?: Record<string, string|undefined>,
 * }} input
 * @returns {{available: boolean, ok: boolean, detail: string, events: number, runtime: string|null,
 *   source: string|null, duration_ms: number}}
 */
export function runtimeValidate(input = {}) {
  let artifact = input.artifact;
  if (artifact === undefined) {
    try {
      artifact = buildArtifactFromBuffer(input.buffer ?? Buffer.alloc(0));
    } catch (error) {
      return {
        available: input.harness === null ? false : findHarnessInstallation({ env: input.env }) !== null,
        ok: false,
        detail: `could not decode the log for validation: ${error instanceof Error ? error.message : String(error)}`,
        events: 0,
        runtime: null,
        source: null,
        duration_ms: 0,
      };
    }
  }
  const batch = runtimeValidateBatch({ artifacts: [artifact], harness: input.harness, timeoutMs: input.timeoutMs, env: input.env });
  const verdict = batch.verdicts[0] ?? { ok: false, detail: 'no verdict', events: 0 };
  return {
    available: batch.available,
    ok: batch.available === true && verdict.ok === true,
    detail: verdict.detail,
    events: verdict.events,
    runtime: batch.runtime,
    source: batch.source,
    duration_ms: batch.duration_ms,
  };
}

/**
 * The restore gate: static pre-filter for each item, then one runtime batch for everything that passed.
 *
 * @param {{
 *   items: Array<{buffer: Buffer, expectedSessionId?: string|null, appendCheck?: boolean}>,
 *   harness?: ReturnType<typeof findHarnessInstallation>,
 *   requireRuntime?: boolean,
 *   env?: Record<string, string|undefined>,
 * }} input
 * @returns {{runtime_available: boolean, results: Array<{
 *   ok: boolean, reason_code: string|null, detail: string,
 *   static: {ok: boolean, codes: string[], detail: object},
 *   runtime: {ok: boolean, detail: string, events: number}|null,
 *   future_append: boolean|null,
 *   runtime_verified: boolean,
 * }>}}
 */
export function validateCandidates(input) {
  const requireRuntime = input.requireRuntime !== false;
  const results = (input.items ?? []).map((item) => ({
    ok: false,
    reason_code: null,
    detail: '',
    static: { ok: false, codes: [], detail: {} },
    runtime: null,
    future_append: null,
    runtime_verified: false,
    buffer: item.buffer,
    expectedSessionId: item.expectedSessionId ?? null,
  }));

  const pending = [];
  for (const [index, item] of (input.items ?? []).entries()) {
    const staticResult = diagnoseSessionBuffer(item.buffer, { expectedSessionId: item.expectedSessionId ?? null });
    results[index].static = { ok: staticResult.ok === true, codes: staticResult.codes, detail: staticResult.detail };
    if (staticResult.ok !== true) {
      results[index].reason_code = 'BACKUP_CANDIDATE_INVALID';
      results[index].detail = `the static validator refused the log: ${staticResult.codes.join(', ')}`;
      continue;
    }
    try {
      const artifact = buildArtifactFromBuffer(item.buffer);
      pending.push({ index, key: `original:${index}`, artifact });
      if (item.appendCheck !== false) {
        pending.push({ index, key: `appended:${index}`, artifact: buildArtifactFromBuffer(appendLegalEvent(item.buffer)) });
      }
    } catch (error) {
      results[index].reason_code = 'BACKUP_CANDIDATE_INVALID';
      results[index].detail = `could not decode the log: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (pending.length === 0) {
    return { runtime_available: false, results: results.map(({ buffer, expectedSessionId, ...row }) => row) };
  }
  const batch = runtimeValidateBatch({
    artifacts: pending.map((row) => row.artifact),
    harness: input.harness,
    env: input.env,
  });
  const verdictByKey = new Map(pending.map((row, offset) => [row.key, batch.verdicts[offset] ?? { ok: false, detail: 'no verdict', events: 0 }]));
  for (const [index, row] of results.entries()) {
    const original = verdictByKey.get(`original:${index}`);
    const appended = verdictByKey.get(`appended:${index}`);
    if (original === undefined) continue;
    // No installation means no verdicts at all: the placeholder "ok:false" from the batch is not a refusal of
    // this log, so the unavailable branch must come first.
    if (batch.available !== true) {
      row.runtime = null;
      row.future_append = null;
      row.reason_code = requireRuntime ? 'BACKUP_RUNTIME_UNAVAILABLE' : null;
      row.detail = requireRuntime
        ? `${original.detail}; install the Harness on this machine, or pass --allow-static-validation to accept static-only evidence`
        : 'static validation passed; the runtime validator is unavailable (static-only evidence accepted)';
      row.ok = requireRuntime !== true;
      row.runtime_verified = false;
      continue;
    }
    row.runtime = { ok: original.ok, detail: original.detail, events: original.events };
    row.future_append = appended === undefined ? null : appended.ok;
    if (original.ok !== true) {
      row.reason_code = 'BACKUP_RUNTIME_REJECTED';
      row.detail = `the installed Harness refused the log: ${original.detail}`;
    } else if (appended !== undefined && appended.ok !== true) {
      row.reason_code = 'BACKUP_RUNTIME_REJECTED';
      row.detail = `the installed Harness refuses the log after one legal append: ${appended.detail}`;
    } else {
      row.ok = true;
      row.detail = `static and runtime validation both passed (${original.events} events)`;
    }
    row.runtime_verified = batch.available === true && row.ok === true;
  }

  return { runtime_available: batch.available, results: results.map(({ buffer, expectedSessionId, ...row }) => row) };
}

/**
 * One-candidate helper over {@link validateCandidates}.
 *
 * @param {{buffer: Buffer, expectedSessionId?: string|null, appendCheck?: boolean,
 *   harness?: ReturnType<typeof findHarnessInstallation>, requireRuntime?: boolean,
 *   env?: Record<string, string|undefined>}} input
 * @returns {object}
 */
export function validateCandidate(input) {
  const { results } = validateCandidates({
    items: [{ buffer: input.buffer, expectedSessionId: input.expectedSessionId, appendCheck: input.appendCheck === true }],
    harness: input.harness,
    requireRuntime: input.requireRuntime,
    env: input.env,
  });
  return results[0];
}
