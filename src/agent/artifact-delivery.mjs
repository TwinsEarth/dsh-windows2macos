/**
 * S4 data-plane delivery (A3): artifacts leave the agent through a USER sink, never through relay.
 *
 * Order of events:
 *   1. no sink configured -> keep the bytes locally (0600) and report
 *      ARTIFACT_NOT_DELIVERED / DATA_PLANE_SINK_REQUIRED; the relay is not contacted;
 *   2. sink configured -> write the sealed bytes to the sink (dir/git/ssh), then build an ArtifactRef
 *      (metadata only, <= 4 KiB) that a reader can resolve against the same sink.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createArtifactRef } from '../util/artifact-ref.mjs';
import { createDirSink } from './sinks/dir-sink.mjs';
import { createGitSink } from './sinks/git-sink.mjs';
import { createSshSink } from './sinks/ssh-sink.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SAFE_TASK = /^[A-Za-z0-9._-]{1,80}$/;

/** Read `<stateDir>/dataplane/sink.json` and build the configured sink, or null (fail closed). */
export function loadArtifactSink(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return null;
  const file = join(stateDir, 'dataplane', 'sink.json');
  if (!existsSync(file)) return null;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config?.kind === 'dir' && typeof config.root === 'string') return createDirSink({ root: config.root });
    if (config?.kind === 'lan-git' && typeof config.root === 'string') return createGitSink({ root: config.root, remote: config.remote ?? null, branch: config.branch ?? null });
    if (config?.kind === 'ssh' && typeof config.host === 'string' && typeof config.user === 'string' && typeof config.dir === 'string') {
      return createSshSink({ host: config.host, user: config.user, dir: config.dir, port: Number.isInteger(config.port) ? config.port : null, keyPath: typeof config.keyPath === 'string' ? config.keyPath : null });
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deliver one artifact.
 *
 * @param {{stateDir: string, kind?: 'stdout'|'stderr'|'patch'|'commit'|'reduce-input', bytes: Buffer|string,
 *          taskId: string, machineId: string, stepId?: string|null, sink?: object|null}} input
 * @returns {Promise<{ok: true, ref: object, sha256: string, bytes: number}
 *                 | {ok: false, code: 'ARTIFACT_NOT_DELIVERED', reason: string, local: object}>}
 */
export async function deliverArtifact(input) {
  const bytes = Buffer.isBuffer(input?.bytes) ? input.bytes : Buffer.from(String(input?.bytes ?? ''), 'utf8');
  const digest = sha256(bytes);
  const taskId = typeof input?.taskId === 'string' && input.taskId !== '' ? input.taskId : 'unknown-task';
  const machineId = typeof input?.machineId === 'string' && input.machineId !== '' ? input.machineId : 'unknown-machine';
  const taskDir = SAFE_TASK.test(taskId) ? taskId : 'unknown-task';
  const kind = typeof input?.kind === 'string' ? input.kind : 'stdout';
  const stateDir = typeof input?.stateDir === 'string' ? input.stateDir : '';
  const localPath = join(stateDir, 'artifacts', taskDir, kind + '-' + digest + '.bin');
  const keepLocal = () => {
    try {
      mkdirSync(join(stateDir, 'artifacts', taskDir), { recursive: true, mode: 0o700 });
      writeFileSync(localPath, bytes, { encoding: 'utf8', mode: 0o600 });
      return { sha256: digest, bytes: bytes.length, path: localPath };
    } catch {
      return { sha256: digest, bytes: bytes.length, path: null };
    }
  };
  const sink = input?.sink === undefined ? loadArtifactSink(stateDir) : input.sink;
  if (sink === null || sink === undefined) {
    return { ok: false, code: 'ARTIFACT_NOT_DELIVERED', reason: 'DATA_PLANE_SINK_REQUIRED', local: keepLocal() };
  }
  const objectId = randomBytes(16).toString('hex');
  const written = await sink.writeObject({ objectId, body: bytes, expectSha256: digest });
  if (written.ok !== true) {
    return { ok: false, code: 'ARTIFACT_NOT_DELIVERED', reason: written.code ?? 'SINK_WRITE_FAILED', local: keepLocal() };
  }
  const ref = createArtifactRef({
    objectId,
    taskId: taskId,
    stepId: typeof input?.stepId === 'string' ? input.stepId : null,
    machineId,
    kind,
    sinkKind: sink.kind === 'lan-git' ? 'lan-git' : sink.kind,
    relPath: written.rel_path ?? objectId + '.json',
    cipherSha256: digest,
    cipherBytes: bytes.length,
    plainBytes: bytes.length,
  });
  if (ref.ok !== true) return { ok: false, code: 'ARTIFACT_NOT_DELIVERED', reason: ref.code ?? 'REF_INVALID', local: keepLocal() };
  return { ok: true, ref: ref.ref, sha256: digest, bytes: bytes.length };
}
