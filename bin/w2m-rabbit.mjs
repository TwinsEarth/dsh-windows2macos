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

Deployment:
  --host <addr>          Bind address. Default 127.0.0.1. Use 0.0.0.0 to accept
                         other machines (see README, "Security").
  --port <n>             Port. Default 8787. 0 asks the OS for a free port.
  --base-path <p>        Prefix the relay is mounted under, e.g. /w2m, for a
                         reverse proxy or tunnel that forwards the prefix
                         through unchanged. Default /.  [env W2M_BASE_PATH]
  --trust-proxy          Believe X-Forwarded-Proto / X-Forwarded-For. Enable ONLY
                         behind a proxy you control: otherwise a client can forge
                         its address and bypass the pairing rate limit.
  --tls-cert <file>      Terminate TLS here. Requires --tls-key.
  --tls-key <file>       Private key for --tls-cert.
  --pair-rate-limit <n>  Pairing attempts per IP per minute. Default 5. 0 = off.

Credentials and state:
  --operator-token <t>   Token that authorises SENDING work. Generated and
                         written to <state>/operator-token.txt if omitted.
                         Pass an empty string to remove the requirement.
                         [env W2M_OPERATOR_TOKEN]
  --state <dir>          State directory. Default <DSH_HOME>/xclient/rabbit.
  --no-persist           Keep everything in memory; forget devices and tasks on
                         restart.
  --pairing-code <c>     Use a fixed pairing code instead of a generated one.

Tuning:
  --heartbeat-ms <n>     Expected heartbeat interval. Default 10000.
  --grace-ms <n>         Extra grace before a silent lease is expired. Default 30000.
  --json                 Print machine-readable status lines instead of prose.
  -h, --help             Show this help.

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
      'base-path': { type: 'string' },
      'trust-proxy': { type: 'boolean', default: false },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'pair-rate-limit': { type: 'string' },
      'operator-token': { type: 'string' },
      'no-persist': { type: 'boolean', default: false },
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

/* ---------- v0.1.2 deployment options ---------- */

// A base path is normalised to either '/' or '/prefix' with no trailing slash,
// so the router can compare one canonical form instead of guessing.
const rawBasePath = values['base-path'] ?? process.env.W2M_BASE_PATH ?? '/';
let basePath = String(rawBasePath).trim();
if (basePath === '' || basePath === '/') {
  basePath = '/';
} else {
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  basePath = basePath.replace(/\/+$/, '');
}

const tlsCert = values['tls-cert'];
const tlsKey = values['tls-key'];
if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
  fail('--tls-cert and --tls-key must be given together');
}

const pairRateLimit = values['pair-rate-limit'] === undefined
  ? undefined
  : Number(values['pair-rate-limit']);
if (pairRateLimit !== undefined && (!Number.isInteger(pairRateLimit) || pairRateLimit < 0)) {
  fail(`--pair-rate-limit must be a non-negative integer, got ${JSON.stringify(values['pair-rate-limit'])}`);
}

// Distinguish "not supplied" (generate one) from "supplied empty" (explicitly
// turn the requirement off). `parseArgs` gives the same value for both, so the
// presence of the flag is checked separately -- silently treating `''` as
// "generate one" would leave a user who asked for no operator token with one
// they do not know.
const operatorTokenFlag = process.argv.some((a) => a === '--operator-token' || a.startsWith('--operator-token='));
const operatorTokenValue = values['operator-token'] ?? process.env.W2M_OPERATOR_TOKEN;
const operatorToken = operatorTokenValue === undefined
  ? undefined
  : (String(operatorTokenValue) === '' ? null : String(operatorTokenValue));
const operatorTokenRequired = !(operatorTokenFlag && operatorToken === null);

const stateDir = resolveStateDir(values.state, 'rabbit');
// Diagnostics go to stderr, data goes to stdout. `--json` promises one machine
// readable line on stdout, so the pairing-code rotation notice must not land
// there and break `| jq` / `| ConvertFrom-Json`.
const log = (line) => process.stdout.write(`${line}\n`);
const diag = (line) => process.stderr.write(`${line}\n`);

let relay;
let listenInfo;
let pairingCode;
try {
  relay = createRelayServer({
    stateDir,
    pairingCode: values['pairing-code'],
    heartbeatIntervalMs: heartbeatMs,
    leaseGraceMs: graceMs,
    // v0.1.2 deployment options
    basePath,
    trustProxy: Boolean(values['trust-proxy']),
    tlsCert: tlsCert ?? null,
    tlsKey: tlsKey ?? null,
    operatorToken,
    operatorTokenRequired,
    pairRateLimitPerMinute: pairRateLimit,
    persist: !values['no-persist'],
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
      // In --json mode this must not touch stdout: a rotation would otherwise
      // corrupt the very output the flag exists to produce.
      const out = values.json ? diag : log;
      out('');
      out('  Pairing code rotated after a successful pairing.');
      out(`  新的配对码 / NEW PAIRING CODE:  ${pairingCode}`);
      out('');
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
const scheme = listenInfo.scheme ?? (tlsCert ? 'https' : 'http');
// Prefer what the relay reports (it knows whether TLS is active); fall back to
// the bound address so a 0.0.0.0 bind is not advertised as a usable URL.
const publicUrl = listenInfo.publicUrl ?? `${scheme}://${boundHost === '0.0.0.0' ? '<this-host>' : boundHost}:${boundPort}${basePath === '/' ? '' : basePath}`;
const resolvedOperatorToken = listenInfo.operatorToken ?? operatorToken ?? null;

if (values.json) {
  log(JSON.stringify({
    event: 'listening',
    url: listenInfo.url,
    publicUrl,
    host: boundHost,
    port: boundPort,
    scheme,
    basePath,
    stateDir,
    persist: !values['no-persist'],
    trustProxy: Boolean(values['trust-proxy']),
    pairRateLimit: pairRateLimit ?? 5,
    operatorTokenRequired,
    // The token itself is deliberately absent. This line is the one people pipe
    // into a log or a file, and a credential written there is a credential
    // leaked; it is printed to stderr and stored at
    // <stateDir>/operator-token.txt (0600), which is where a secret belongs.
    operatorTokenPresent: Boolean(operatorTokenRequired && resolvedOperatorToken),
    pairingCode,
    relayId: listenInfo.relayId ?? null,
    protocolVersion: 1,
  }));
} else {
  log('');
  log('  W2M relay (Rabbit) is listening.');
  log('');
  log(`  URL          ${publicUrl}`);
  log(`  Bind         ${boundHost}:${boundPort}${scheme === 'https' ? ' (TLS)' : ''}`);
  if (basePath !== '/') log(`  Base path    ${basePath}`);
  log(`  State        ${stateDir}${values['no-persist'] ? '  (persistence DISABLED)' : ''}`);
  log(`  Protocol     v1   relay id ${listenInfo.relayId ?? '(none)'}`);

  if (values['trust-proxy']) {
    log('');
    log('  NOTE: --trust-proxy is ON. The relay believes X-Forwarded-For and');
    log('        X-Forwarded-Proto. Only safe behind a proxy you control.');
  }
  if (boundHost === '0.0.0.0' && scheme === 'http') {
    log('');
    log('  NOTE: bound to 0.0.0.0 over plain HTTP. Fine on a Tailscale/WireGuard');
    log('        address (already encrypted); NOT fine on a public interface --');
    log('        use --tls-cert/--tls-key or a TLS-terminating proxy there.');
  }

  log('');
  if (operatorTokenRequired && resolvedOperatorToken) {
    log('  ┌────────────────────────────────────────────────────────────┐');
    log('  │  OPERATOR TOKEN (needed to SEND instructions, keep secret)  │');
    log(`  │  ${String(resolvedOperatorToken).padEnd(56)}│`);
    log('  └────────────────────────────────────────────────────────────┘');
    log(`  Also written to ${stateDir}/operator-token.txt`);
    log('  Device tokens cannot send work; this is what authorises it.');
  } else if (!operatorTokenRequired) {
    log('  ⚠  OPERATOR TOKEN REQUIREMENT IS OFF (--operator-token "").');
    log('     Any paired device can send work to any other. Trusted LAN only.');
  }

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
