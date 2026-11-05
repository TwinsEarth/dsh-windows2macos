/**
 * Target-side remote-view consent.
 *
 * Turning on "远程桌面" on a machine is an explicit statement that the machine may be viewed by
 * the fleet; `W2M_VIEW_ALLOW=0` remains an operator override that denies even an enabled file.
 * The file is written by the host settings route under the same state directory the agent uses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The per-machine settings file shared with `src/plugin/remote-view-route.mjs`. */
export const REMOTE_VIEW_CONFIG_FILE = 'remote-view.json';

/**
 * Whether this machine may serve view frames.
 *
 * @param {string} stateDir - agent state directory.
 * @param {NodeJS.ProcessEnv} [env] - process environment for the operator override.
 * @returns {boolean}
 */
export function viewAllowed(stateDir, env = process.env) {
  if (env.W2M_VIEW_ALLOW === '0') return false;
  if (env.W2M_VIEW_ALLOW === '1') return true;
  // The agent's `--state` is the `localside/` child of the plugin's state directory, while the
  // settings route writes beside `device.json` one level up. Check the agent directory first (an
  // explicit deployment may keep the file there), then the plugin root.
  for (const file of [join(stateDir, REMOTE_VIEW_CONFIG_FILE), join(dirname(stateDir), REMOTE_VIEW_CONFIG_FILE)]) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (value?.enabled === true || value?.allow === true) return true;
    } catch {
      // Try the next location.
    }
  }
  return false;
}
