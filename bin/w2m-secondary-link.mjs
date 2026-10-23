#!/usr/bin/env node
/**
 * w2m-secondary-link — keep a second relay link alive beside the plugin's primary link.
 *
 * ## Why this exists (v1.5.0)
 *
 * The plugin mounts against exactly one relay (`rabbitUrl`). A second relay link makes the
 * machine visible on both relays at once, so a dispatcher can fail over to the other relay
 * without waiting for the machine to reconnect. The two links are independent processes:
 *
 *   primary   the plugin's own agent, configured by `rabbitUrl`           (always on)
 *   secondary this supervisor + a `w2m-localside` child, configured here   (standby)
 *
 * Active-passive is a *routing* rule, not a second execution engine: both links are connected,
 * but work is dispatched through the primary relay; only when the primary relay is down or
 * severely degraded does the operator route work to the secondary relay, where this link is
 * already online. That keeps one executor per machine in the normal case (no two relays racing
 * to run the same project) while making failover a routing decision instead of a reconnection.
 *
 * ## The supervisor, not the child
 *
 * A localside child dies for ordinary reasons (relay restart, laptop sleep, a rotated token).
 * If the link were launched once, the machine would silently stop being visible on the standby
 * relay — the exact "looks connected, is not" failure this project keeps recording. This process
 * therefore supervises the child: restart on exit with backoff, and log every transition, so a
 * scheduled task / launchd / systemd unit only has to keep *this* process alive.
 *
 * ## Usage
 *
 *   node bin/w2m-secondary-link.mjs \
 *     --relay http://202.182.123.154:8787 \
 *     --fleet-key <account fleet key> \
 *     --name <machine-name>-standby \
 *     --state ~/.dsh/xclient/secondary-link \
 *     --log ~/.dsh/xclient/secondary-link.log \
 *     [--project <dir>] [--operator-token <token>] [--allowed-commands '[]']
 *
 * The child is `bin/w2m-localside.mjs` from this same package, so the two links share the same
 * protocol implementation and there is no second network client to keep in step.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({
  project: process.cwd(),
  stateDir: null,
  identityHome: null,
  logFile: null,
  allowedCommands: '[]',
  restartDelayMs: 3000,
  maxRestartDelayMs: 60000,
});

/**
 * Parse the flags this supervisor forwards. Deliberately small and explicit: every value has
 * exactly one spelling, and an unknown flag is an error rather than a silently ignored one --
 * a standby link that is quietly pointed at the wrong relay is worse than one that refuses.
 *
 * @param {string[]} argv
 * @returns {{relay:string, fleetKey:string|null, name:string|null, stateDir:string, logFile:string,
 *   project:string, operatorToken:string|null, allowedCommands:string}}
 */
export function parseSecondaryArgs(argv) {
  const out = {
    relay: null,
    fleetKey: null,
    name: null,
    stateDir: null,
    identityHome: null,
    logFile: null,
    project: DEFAULTS.project,
    operatorToken: null,
    allowedCommands: DEFAULTS.allowedCommands,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--relay': out.relay = value().replace(/\/+$/, ''); break;
      case '--fleet-key': out.fleetKey = value(); break;
      case '--name': out.name = value(); break;
      case '--state': out.stateDir = value(); break;
      case '--identity-home': out.identityHome = value(); break;
      case '--log': out.logFile = value(); break;
      case '--project': out.project = value(); break;
      case '--operator-token': out.operatorToken = value(); break;
      case '--allowed-commands': out.allowedCommands = value(); break;
      case '--help':
      case '-h':
        throw new Error('usage: w2m-secondary-link.mjs --relay <url> [--fleet-key <key>] [--name <name>] [--state <dir>] [--log <file>] [--project <dir>] [--operator-token <t>] [--allowed-commands <json>]');
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (typeof out.relay !== 'string' || out.relay === '') throw new Error('--relay <url> is required');
  if (!/^https?:\/\//.test(out.relay)) throw new Error('--relay must be an http(s) base URL');
  if (out.fleetKey === null && out.operatorToken === null) {
    throw new Error('at least one of --fleet-key or --operator-token is required');
  }
  const suffix = out.name ?? 'standby';
  out.stateDir = out.stateDir ?? join(process.cwd(), '.w2m-secondary', suffix);
  /**
   * v1.5.1: **the standby gets its own identity home.**
   *
   * Measured in the field: the first v1.5.0 standby overwrote `~/.dsh/xclient/device.json` -- the
   * primary link's identity -- because `w2m-localside` derives that path from `DSH_HOME`. The
   * machine kept working (the running agent holds its token in memory) until its next restart, at
   * which point it would have come up as the *standby* identity on the wrong relay. A link that is
   * only correct until the next restart is a trap, so isolation is the default rather than an
   * option: the child runs with `DSH_HOME` (and the platforms' home variables) pointed at this
   * directory, and `--identity-home` exists for operators who need a specific path.
   */
  out.identityHome = out.identityHome ?? join(out.stateDir, 'dsh-home');
  out.logFile = out.logFile ?? join(out.stateDir, 'link.log');
  return out;
}

/**
 * Build the child argv for `w2m-localside.mjs`. `--pair` is deliberately absent: v1.5.0 links
 * join with the account's fleet key, which is re-proven on every start rather than being a
 * one-shot code that can expire before the standby is first used.
 *
 * @param {ReturnType<typeof parseSecondaryArgs>} options
 * @returns {string[]}
 */
export function buildLocalsideArgs(options) {
  const args = [
    join(HERE, 'w2m-localside.mjs'),
    '--rabbit', options.relay,
    '--project', options.project,
    '--state', options.stateDir,
    '--allowed-commands', options.allowedCommands,
  ];
  if (options.name !== null) args.push('--name', options.name);
  if (options.fleetKey !== null) args.push('--fleet-key', options.fleetKey);
  if (options.operatorToken !== null) args.push('--operator-token', options.operatorToken);
  return args;
}

/** Append one timestamped line to the link log (and best-effort to stdout). */
export function makeLinkLogger(file) {
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, entry, 'utf8');
    } catch {
      /* logging must never take the link down */
    }
    process.stdout.write(entry);
  };
}

/**
 * Run the supervisor loop. Exported so a test can drive one cycle against a fake spawn.
 *
 * @param {ReturnType<typeof parseSecondaryArgs>} options
 * @param {{log: (line: string) => void, spawnFn?: Function, sleep?: Function,
 *   stopSignal?: {stopped: boolean}}} deps
 */
export async function runSupervisor(options, deps) {
  const log = deps.log;
  const spawnFn = deps.spawnFn ?? spawn;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const stopSignal = deps.stopSignal ?? { stopped: false };
  const args = buildLocalsideArgs(options);
  let delay = DEFAULTS.restartDelayMs;
  // v1.5.1: the child must not see the primary link's identity. Both spellings are set because
  // Windows resolves the home directory from USERPROFILE while POSIX uses HOME, and `DSH_HOME` is
  // what `src/agent/identity.mjs` actually reads for `<DSH_HOME>/xclient/device.json`.
  const childEnv = {
    ...process.env,
    DSH_HOME: options.identityHome,
    USERPROFILE: options.identityHome,
    HOME: options.identityHome,
  };
  try {
    mkdirSync(options.identityHome, { recursive: true, mode: 0o700 });
  } catch (error) {
    log(`cannot create identity home ${options.identityHome}: ${error?.message ?? error}`);
    throw error;
  }
  log(`supervising secondary link relay=${options.relay} state=${options.stateDir} identityHome=${options.identityHome}`);
  while (!stopSignal.stopped) {
    const startedAt = Date.now();
    const child = spawnFn(process.execPath, args, { stdio: 'ignore', windowsHide: true, env: childEnv });
    log(`child started pid=${child.pid ?? '?'}`);
    const exit = await new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) => resolve({ code: 'spawn-error', signal: String(error?.message ?? error) }));
    });
    if (stopSignal.stopped) {
      try { child.kill?.(); } catch { /* already gone */ }
      break;
    }
    const livedMs = Date.now() - startedAt;
    // A long-lived child that exits gets the fast restart; a child that dies immediately is
    // backed off so a broken configuration cannot turn into a spawn storm.
    delay = livedMs > 60_000 ? DEFAULTS.restartDelayMs
      : Math.min(Math.round(delay * 1.5), DEFAULTS.maxRestartDelayMs);
    log(`child exited code=${String(exit.code)} signal=${String(exit.signal)} lived=${livedMs}ms restart_in=${delay}ms`);
    await sleep(delay);
  }
  log('supervisor stopped');
}

async function main() {
  let options;
  try {
    options = parseSecondaryArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`w2m-secondary-link: ${error.message}\n`);
    process.exit(2);
  }
  const log = makeLinkLogger(options.logFile);
  const stopSignal = { stopped: false };
  const onStop = () => { stopSignal.stopped = true; };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  await runSupervisor(options, { log, stopSignal });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`w2m-secondary-link: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
