/**
 * w2m-rabbit — start the W2M relay (Rabbit).
 *
 * The relay is a plain `node:http` server with no third-party dependencies, so
 * it can run on any machine that has Node: a laptop, a small VPS, or whichever
 * of your machines happens to be on all the time.
 *
 * Design notes that matter at this layer:
 *
 * * The pairing code is the only credential that grants admission, it is shown
 *   once, and it is consumed on first successful use. A relay that started
 *   silently accepting unknown devices would be a relay anyone on the LAN could
 *   join.
 * * State lives in `--state`, and `state.json` records the pairing code so that
 *   restarting the relay does not silently invalidate every paired machine.
 * * Nothing about a project is read here. The relay never holds a working copy
 *   and never holds a model credential.
 */

import { parseArgs } from 'node:util';
import { createRelayServer } from '../src/relay/server.mjs';
import { resolveStateDir, formatError } from '../src/util/cli.mjs';

const USAGE = `w2m-rabbit — W2M relay (Rabbit)

Usage:
  w2m-rabbit [options]

Options:
  --host <addr>        Bind address. Default 127.0.0.1. Use 0.0.0.0 to accept
                       other machines on your LAN (see README, "Security").
  --port <n>           Port. Default 8787. 0 asks the OS for a free port.
  --state <dir>        State directory. Default <DSH_HOME>/xclient/rabbit.
  --pairing-code <c>   Use a fixed pairing code instead of a generated one.
  --heartbeat-ms <n>   Expected heartbeat interval. Default 10000.
  --grace-ms <n>       Extra grace before a silent lease is expired. Default 30000.
  --json               Print machine-readable status lines instead of prose.
  -h, --help           Show this help.

Exit codes:
  0  stopped normally (SIGINT/SIGTERM)
  2  bad usage
  3  failed to bind or to start
`;

function fail(message, code = 2) {
  process.stderr.write(`w2m-rabbit: ${message}\n`);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      state: { type: 'string' },
      'pairing-code': { type: 'string' },
      'heartbeat-ms': { type: 'string' },
      'grace-ms': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
} catch (error) {
  fail(`${error.message}\n\n${USAGE}`);
}

const { values } = parsed;
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const port = values.port === undefined ? 8787 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`--port must be an integer in 0..65535, got ${JSON.stringify(values.port)}`);
}

const heartbeatMs = values['heartbeat-ms'] === undefined ? undefined : Number(values['heartbeat-ms']);
if (heartbeatMs !== undefined && (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0)) {
  fail(`--heartbeat-ms must be a positive number, got ${JSON.stringify(values['heartbeat-ms'])}`);
}

const graceMs = values['grace-ms'] === undefined ? undefined : Number(values['grace-ms']);
if (graceMs !== undefined && (!Number.isFinite(graceMs) || graceMs < 0)) {
  fail(`--grace-ms must be a non-negative number, got ${JSON.stringify(values['grace-ms'])}`);
}

const stateDir = resolveStateDir(values.state, 'rabbit');
const log = (line) => process.stdout.write(`${line}\n`);

let relay;
let listenInfo;
let pairingCode;
try {
  relay = createRelayServer({
    stateDir,
    pairingCode: values['pairing-code'],
    heartbeatIntervalMs: heartbeatMs,
    leaseGraceMs: graceMs,
  });
  // The pairing code rotates on every successful pairing, so the CLI has to
  // follow it rather than print it once: an operator pairing a second machine
  // needs the *current* code, not the one that was already consumed.
  //
  // Listeners receive the buffered *entry* (`{seq, event, target}`), not the
  // event itself -- `entry.event` is the frame that goes on the wire.
  relay.state.onEvent((entry) => {
    const event = entry?.event ?? entry;
    if (event?.type === 'notice' && event.code === 'PAIRING_CODE_ROTATED' && event.pairing_code) {
      pairingCode = event.pairing_code;
      log('');
      log('  Pairing code rotated after a successful pairing.');
      log(`  新的配对码 / NEW PAIRING CODE:  ${pairingCode}`);
      log('');
    }
  });
  listenInfo = await relay.listen({
    host: values.host ?? '127.0.0.1',
    port,
  });
  pairingCode = listenInfo.pairingCode;
} catch (error) {
  fail(formatError(error), 3);
}

const boundPort = listenInfo.port;
const boundHost = listenInfo.host;

if (values.json) {
  log(JSON.stringify({
    event: 'listening',
    url: listenInfo.url,
    host: boundHost,
    port: boundPort,
    stateDir,
    pairingCode,
    protocolVersion: 1,
  }));
} else {
  log('');
  log('  W2M relay (Rabbit) is listening.');
  log('');
  log(`  URL          ${listenInfo.url}`);
  log(`  State        ${stateDir}`);
  log(`  Protocol     v1`);
  log('');
  if (pairingCode) {
    log('  ┌──────────────────────────────────────────────┐');
    log(`  │  配对码 / PAIRING CODE:  ${String(pairingCode).padEnd(19)}│`);
    log('  └──────────────────────────────────────────────┘');
    log('');
    log('  Run this on every machine you want in the group:');
    log('');
    log(`    w2m-localside --rabbit ${listenInfo.url} --pair ${pairingCode} \\`);
    log('                  --project <path-to-project> --name <machine-name>');
    log('');
    log('  The code rotates after each successful pairing; the new one is');
    log('  printed here, so you can pair the next machine without restarting.');
  }
  if (boundHost === '0.0.0.0') {
    log('  NOTE: bound to 0.0.0.0 -- other machines on your network can reach this');
    log('        relay. It carries no TLS and no authentication beyond device tokens.');
    log('');
  }
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (!values.json) log(`\n  ${signal} received, shutting down...`);
  try {
    await relay.close();
  } catch (error) {
    process.stderr.write(`w2m-rabbit: error while closing: ${formatError(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
