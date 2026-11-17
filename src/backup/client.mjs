/**
 * Is the DSH client running? G2 asks the restore path to either pause the client or verify again after it saves;
 * this module answers the first half of that question, cheaply and with an injectable runner.
 *
 * ## Why "pause the client" is a refusal, not an action
 *
 * A plugin cannot pause the application it runs inside, and silently stopping it would be worse than the problem.
 * What it *can* do is refuse to write a home whose client is running (the offline CLI path), and, on the panel path
 * where the client is by definition running, rely on the other two halves of G2: read-back verification and a
 * post-save re-check (`registry-watch.mjs`).
 *
 * ## Detection is best effort, and says so
 *
 * `tasklist`/`pgrep` may be unavailable (a sandbox, a minimal image). The result distinguishes "not running" from
 * "could not tell": `running: false` is a measurement, `running: null` is an absence of one. A caller that refuses
 * on `running === true` therefore fails open only when the platform provides no way to look.
 */

import { spawnSync } from 'node:child_process';

/** Named client-gate codes (also used by the restore refusal). */
export const CLIENT_CODES = Object.freeze({
  RUNNING: 'BACKUP_CLIENT_RUNNING',
  UNKNOWN: 'BACKUP_CLIENT_UNKNOWN',
});

/** Process names the desktop client can have, per platform. */
const CLIENT_IMAGES = {
  win32: ['DeepSeek Harness.exe', 'deepseek-harness.exe'],
  darwin: ['DeepSeek Harness', 'deepseek-harness'],
  linux: ['DeepSeek Harness', 'deepseek-harness'],
};

/**
 * Detect whether a DSH client process is running.
 *
 * @param {{platform?: string, runner?: Function, env?: Record<string, string|undefined>}} [input]
 *   `runner` is `spawnSync`-shaped and exists so tests (and hosts without a process list) can answer directly.
 * @returns {{running: boolean|null, detail: string, method: string, source: string|null}}
 */
export function detectClientRunning(input = {}) {
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? spawnSync;
  const images = CLIENT_IMAGES[platform] ?? null;
  if (images === null) {
    return { running: null, detail: `${platform} is not a platform this build inspects processes on`, method: 'none', source: null };
  }
  let result;
  try {
    if (platform === 'win32') {
      result = runner('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    } else {
      result = runner('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 15_000 });
    }
  } catch (error) {
    return { running: null, detail: `process inspection failed: ${error instanceof Error ? error.message : String(error)}`, method: 'process-list', source: null };
  }
  if (result?.error !== undefined || result?.status !== 0) {
    return { running: null, detail: `process inspection failed: ${result?.error?.message ?? `exit ${result?.status ?? '?'}`}`, method: 'process-list', source: null };
  }
  const stdout = String(result.stdout ?? '');
  for (const image of images) {
    const needle = platform === 'win32' ? `"${image}"` : image;
    if (stdout.includes(needle)) return { running: true, detail: `${image} is running`, method: 'process-list', source: image };
  }
  return { running: false, detail: 'no DSH client process was found', method: 'process-list', source: null };
}

/**
 * The restore gate's pause half: refuse when the client is running and the caller has not accepted a live home.
 *
 * @param {{allowLiveHome?: boolean, platform?: string, runner?: Function, check?: Function}} input
 * @returns {{ok: true, detail: string} | {ok: false, reason_code: string, detail: string, detection: object}}
 */
export function clientGate(input = {}) {
  if (input.allowLiveHome === true) {
    return { ok: true, detail: 'the caller accepts a live home (the panel path) and relies on read-back + post-save re-check' };
  }
  const detection = (input.check ?? (() => detectClientRunning({ platform: input.platform, runner: input.runner })))();
  if (detection.running !== true) {
    return { ok: true, detail: detection.running === false ? 'no DSH client process is running' : `could not confirm the client is stopped: ${detection.detail}` };
  }
  return {
    ok: false,
    reason_code: CLIENT_CODES.RUNNING,
    detail:
      `the DSH client is running (${detection.detail}); writing a session it may keep open can tear the log. ` +
      'Quit the client and retry, or pass --allow-live-home to accept the read-back + post-save re-check protocol instead.',
    detection,
  };
}
