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
import { resolveBaseUrl } from '../src/agent/url.mjs';

const USAGE = `w2m-localside — W2M Localside agent (protocol v1)

Usage:
  w2m-localside --rabbit <url> [--pair <CODE>] [--project <dir>]
                [--name <name>] [--allowed-commands <json>]
                [--state <dir>] [--once] [--once-idle-ms <ms>]

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

  const log = (level, message, extra) => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
    process.stdout.write(`${new Date().toISOString()} ${level.padEnd(7)} ${message}${suffix}\n`);
  };

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
      log,
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
      agent.stop();
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
