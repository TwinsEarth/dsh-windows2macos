#!/usr/bin/env node
/**
 * `w2m-localside` — the Windows/macOS side of a W2M pair.
 *
 *     node bin/w2m-localside.mjs \
 *       --rabbit http://127.0.0.1:8787 \
 *       --pair PAIR-7K2M9QX4 \
 *       --project E:/DS/w2m \
 *       --name win-desktop \
 *       --allowed-commands '["node --test","git status"]' \
 *       --state ~/.dsh/xclient/localside \
 *       --once
 *
 * The allow-list is **default-deny**: with no `--allowed-commands`, every offer
 * is refused with `COMMAND_NOT_ALLOWED`.  That is deliberate -- an agent that
 * runs whatever it is told is not a thing this project ships.
 *
 * State (identity file excluded) lives under `--state`, never in the project,
 * so `write: false` offers cannot dirty the worktree they are measuring.
 */

import { parseArgs as parseNodeArgs } from 'node:util';
import process from 'node:process';

import { formatError, resolveStateDir } from '../src/util/cli.mjs';
import { createAgent, parseAllowedCommands } from '../src/agent/agent.mjs';
import { probeCapsDetailed, detectPlatform } from '../src/agent/caps.mjs';
import { loadOrCreateIdentity, saveDeviceToken } from '../src/agent/identity.mjs';
import { normalizeP2PMode, normalizeP2PPort, stunServersWithShared } from '../src/agent/p2p-node.mjs';
import { resolveBaseUrl } from '../src/agent/url.mjs';

const USAGE = `w2m-localside — W2M Localside agent (protocol v1)

Usage:
  w2m-localside --rabbit <url> [--pair <CODE>] [--project <dir>]
                [--name <name>] [--allowed-commands <json>]
                [--state <dir>] [--p2p-mode <mode>] [--p2p-port <n>]
                [--stun-servers <list>]
                [--once] [--once-idle-ms <ms>]

Options:
  --rabbit <url>            Rabbit base address (default: $W2M_RABBIT_URL).
                            A sub-path is supported: https://host/w2m
                            Query strings and fragments are rejected.
  --pair <CODE>             One-time pairing code, e.g. PAIR-7K2M9QX4
  --project <dir>           Project root to run in (default: current directory)
  --name <name>             machine_name (default: <os>-<hostname>)
  --allowed-commands <json> Default-deny allow-list, JSON array of prefixes.
                            Example: '["node --test","git status"]'
                            Nothing is allowed when omitted.
  --state <dir>             State directory for spool/state
                            (default: <DSH_HOME>/xclient/localside)
  --p2p-mode <mode>         auto (default) | direct | relay
                            (default: $W2M_P2P_MODE)
                            auto:   accept an offer over either path
                            direct: refuse an offer that did not arrive
                                    directly (P2P_UNAVAILABLE)
                            relay:  v0.3.9 - no UDP socket is bound at all
  --p2p-port <n>            Local UDP port for the punch socket, 1..65535
                            (default: $W2M_P2P_PORT, or an ephemeral port)
                            Pin this on a machine that must *accept* a punch:
                            an ephemeral port changes on every restart, so the
                            firewall rule has to be re-pointed each time and
                            every dispatch falls back to the relay until it is.
  --stun-servers <list>     Comma-separated STUN servers, queried in order,
                            after the shared server (default: $W2M_STUN_SERVERS)
                            Example: stun.internal:3478,stun.l.google.com:19302
  --operator-token <t>      Operator token (or $W2M_OPERATOR_TOKEN). Only needed
                            when this host also submits tasks; the Localside
                            agent itself never sends it.
  --once                    Handle one offer, then exit
  --once-idle-ms <ms>       With --once: give up if no offer arrives in <ms>
  --heartbeat-ms <ms>       Lease heartbeat interval (default: 10000)
  --help                    Show this message

Exit codes: 0 stopped cleanly, 1 runtime error, 2 usage error.`;

/**
 * Parse argv, tolerating `--flag=value` and `--flag value`.
 *
 * @param {string[]} argv
 */
function parseCli(argv) {
  const { values, positionals } = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      rabbit: { type: 'string' },
      pair: { type: 'string' },
      project: { type: 'string' },
      name: { type: 'string' },
      'allowed-commands': { type: 'string' },
      'operator-token': { type: 'string' },
      state: { type: 'string' },
      'p2p-mode': { type: 'string' },
      'p2p-port': { type: 'string' },
      'stun-servers': { type: 'string' },
      once: { type: 'boolean', default: false },
      'once-idle-ms': { type: 'string' },
      'heartbeat-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  void positionals;
  return values;
}

async function main() {
  let flags;
  try {
    flags = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n\n${USAGE}\n`);
    return 2;
  }

  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const rabbitUrl = flags.rabbit ?? process.env.W2M_RABBIT_URL ?? '';
  if (rabbitUrl.trim() === '') {
    process.stderr.write('error: --rabbit <url> is required (or set W2M_RABBIT_URL)\n\n' + `${USAGE}\n`);
    return 2;
  }
  // Validate the base address before doing anything else: a sub-path is fine,
  // a query string / fragment / non-http scheme is a usage error (v0.1.2 §2).
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(rabbitUrl);
  } catch (error) {
    process.stderr.write(`error: ${formatError(error)}\n`);
    return 2;
  }

  const operatorToken = flags['operator-token'] ?? process.env.W2M_OPERATOR_TOKEN ?? null;

  let allowedCommands;
  try {
    allowedCommands = parseAllowedCommands(flags['allowed-commands'] ?? '[]');
  } catch (error) {
    process.stderr.write(`error: ${formatError(error)}\n`);
    return 2;
  }

  const project = flags.project ?? process.cwd();
  const stateDir = resolveStateDir(flags.state, 'localside');
  const onceIdleMs = flags['once-idle-ms'] ? Number.parseInt(flags['once-idle-ms'], 10) : 0;
  const heartbeatMs = flags['heartbeat-ms']
    ? Number.parseInt(flags['heartbeat-ms'], 10)
    : undefined;

  if (Number.isNaN(onceIdleMs) || onceIdleMs < 0) {
    process.stderr.write('error: --once-idle-ms must be a non-negative integer\n');
    return 2;
  }
  if (heartbeatMs !== undefined && (Number.isNaN(heartbeatMs) || heartbeatMs <= 0)) {
    process.stderr.write('error: --heartbeat-ms must be a positive integer\n');
    return 2;
  }

  // v0.4.0. The flag wins over the environment, and both go through the same loud validator the
  // node and the agent use: a typo is a usage error (exit 2) naming the setting, exactly like
  // `--rabbit` or `--once-idle-ms`, and never a silent fallback to the default. A mode that
  // silently became `auto` would turn `direct` into a promise the operator only discovers was
  // broken when a punch failed.
  const p2pModeInput = flags['p2p-mode'] ?? process.env.W2M_P2P_MODE ?? undefined;
  const p2pModeResult = normalizeP2PMode(p2pModeInput === undefined ? 'auto' : p2pModeInput);
  if (!p2pModeResult.ok) {
    const source = flags['p2p-mode'] !== undefined ? '--p2p-mode' : 'W2M_P2P_MODE';
    process.stderr.write(`error: ${source}: ${p2pModeResult.reason}\n`);
    return 2;
  }
  const p2pMode = p2pModeResult.mode;

  // Same precedence rule, same reason, and the same loud validator the node and the agent use.
  // Omitting the setting keeps the ephemeral port, which is the right default for a machine that
  // only dials. A value that *is* written must be a real port: `0` is refused by name rather than
  // read as "let the OS choose", because an operator who writes `0` is asking for a stable port and
  // would silently get a random one -- see `normalizeP2PPort`.
  const p2pPortInput = flags['p2p-port'] ?? process.env.W2M_P2P_PORT ?? undefined;
  const p2pPortResult = normalizeP2PPort(p2pPortInput);
  if (!p2pPortResult.ok) {
    const source = flags['p2p-port'] !== undefined ? '--p2p-port' : 'W2M_P2P_PORT';
    process.stderr.write(`error: ${source}: ${p2pPortResult.reason}\n`);
    return 2;
  }
  const p2pPort = p2pPortResult.port;

  // Same precedence rule, same reason. An empty list means "the shared server and the public
  // fallbacks", i.e. the default -- `stunServersWithShared()` accepts '' and drops it -- so an
  // accidentally blank variable is harmless rather than a node that cannot discover anything.
  const stunInput = flags['stun-servers'] ?? process.env.W2M_STUN_SERVERS ?? '';
  let stunServers;
  try {
    stunServers = stunServersWithShared(stunInput);
  } catch (error) {
    const source = flags['stun-servers'] !== undefined ? '--stun-servers' : 'W2M_STUN_SERVERS';
    process.stderr.write(`error: ${source}: ${formatError(error)}\n`);
    return 2;
  }

  const log = (level, message, extra) => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
    process.stdout.write(`${new Date().toISOString()} ${level.padEnd(7)} ${message}${suffix}\n`);
  };

  /** One-shot guard for the resolved-P2P startup line (see `onP2PStatus` below). */
  let p2pLogged = false;

  try {
    const { identity, path: identityPath, created } = loadOrCreateIdentity({
      name: flags.name,
      rabbitUrl: baseUrl,
    });
    log('info', `${created ? 'created' : 'loaded'} identity ${identity.machine_id} (${identityPath})`);

    const [{ caps, detail }, platform] = await Promise.all([
      probeCapsDetailed({}),
      detectPlatform({}),
    ]);
    log('info', `platform ${platform.os} ${platform.os_version} ${platform.arch} shell=${platform.shell}`, {});
    log('info', 'caps', caps);
    if (detail.notes.length > 0) log('warn', 'capability probe notes', { notes: detail.notes });

    const agent = createAgent({
      rabbitUrl: baseUrl,
      project,
      stateDir,
      identity,
      caps,
      platform,
      allowedCommands,
      once: flags.once === true,
      onceIdleMs,
      heartbeatIntervalMs: heartbeatMs,
      operatorToken,
      p2pMode,
      p2pPort,
      stunServers,
      log,
      // The startup line has to name the *resolved* mode, the STUN list and whether the node
      // actually started. `p2p_mode` is what was asked for; `started` is what happened, and a
      // machine that cannot punch reports `started: false` with the reason right there -- which is
      // the whole point of "a failure to start the node is never fatal".
      onP2PStatus: (status) => {
        // One line, for every mode including `relay`. It is emitted when the fact is final --
        // the node started, the node failed to start, or there is no node to start -- so the line
        // never says "starting" and never repeats as the status is refreshed on each heartbeat.
        const final = status.running || !status.enabled || status.start_error !== null;
        if (p2pLogged || !final) return;
        p2pLogged = true;
        log(status.start_error === null ? 'info' : 'warn', `p2p mode=${status.mode} node ${status.running ? 'started' : 'not started'}`, {
          stun_servers: stunServers,
          ...(status.start_error === null ? {} : { error: status.start_error }),
        });
      },
    });
    if (operatorToken) {
      log('info', 'operator token configured (submit-capable host); the agent itself never sends it', {
        length: operatorToken.length,
      });
    }

    if (flags.pair) {
      const paired = await agent.pair(flags.pair);
      saveDeviceToken(paired.device_token, {});
      log('info', 'device_token stored');
    } else if (!identity.device_token) {
      log('warn', 'no device_token and no --pair: offers cannot be fetched until paired');
    }

    let stopping = false;
    const onSignal = (signal) => {
      if (stopping) return;
      stopping = true;
      log('warn', `received ${signal}, stopping`);
      // Awaited so the node's socket is really gone before the process leaves; an unawaited
      // `stop()` would let the event loop drain with a dgram handle still open.
      void agent.stop();
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    await agent.start();
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${formatError(error)}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fatal: ${formatError(error)}\n`);
    process.exitCode = 1;
  },
);
