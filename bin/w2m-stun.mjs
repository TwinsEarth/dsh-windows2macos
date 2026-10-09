/**
 * w2m-stun — run the W2M STUN responder (RFC 5389 Binding server).
 *
 * This is the other half of `src/agent/stun.mjs`. Every machine that wants a
 * direct path must learn the *public* address a peer can reach it on, and the
 * port a NAT hands out cannot be guessed from the inside: a host sees its own
 * `192.168.x.y`, the peer must be told the translated address. That translation is
 * the one fact only an outside observer can supply, which is what this process is.
 *
 * Design notes that matter at this layer:
 *
 * * **UDP only, and stateless.** Each datagram is answered from the address it
 *   arrived on and from nothing else. Nothing is stored, so there is no state for
 *   an attacker to exhaust and no session to hijack.
 * * **Not a reflector.** A Binding request is answered to its *source*, never to
 *   an address carried in the message, so this server cannot be aimed at a third
 *   party. Binding responses arriving here are dropped, not answered — answering a
 *   response is how a loop starts.
 * * **The single bug that matters is a crash on malformed input.** A malformed
 *   datagram is counted and dropped; nothing in the responder throws out of the
 *   socket handler, because an uncaught exception here would take down the whole
 *   relay host with it.
 * * **A taken port must be loud.** The default port is 3478 and it is a
 *   well-known one: the most likely failure is another STUN server already
 *   holding it, and that has to be a clear line and a non-zero exit, not a
 *   half-started process.
 */

import { parseArgs } from 'node:util';
import { createStunServer, DEFAULT_SOFTWARE } from '../src/relay/stun-server.mjs';
import { formatError } from '../src/util/cli.mjs';

const USAGE = `w2m-stun — W2M STUN responder (RFC 5389 Binding server)

Usage:
  w2m-stun [options]

What it is for:
  A machine behind NAT cannot see the public address and port its packets come
  from — only the far side can. This server reports that translation back to the
  caller, which is what lets two machines exchange reachable addresses and punch
  a direct path instead of routing every task through the relay.

Deployment:
  --host <addr>          Bind address. Default 0.0.0.0, because a STUN server
                         bound to loopback answers nobody. It must be reachable
                         on UDP from the machines that will use it, and the port
                         must be forwarded if this host is itself behind NAT.
  --port <n>             UDP port. Default 3478 (the IANA STUN port). 0 asks the
                         OS for a free port.
  --software <name>      Value of the SOFTWARE attribute. Default ${DEFAULT_SOFTWARE}.
                         Printed to clients; keep secrets out of it.

Observability:
  --log-level <level>    info | debug. Default info. "debug" prints one line per
                         request, including every datagram that was dropped and
                         why — the only way to tell "the NAT is blocking UDP"
                         apart from "something is answering but not with STUN".

  -h, --help             Show this help.

Protocol:
  0x0001 Binding request   -> 0x0101 Binding success, with XOR-MAPPED-ADDRESS
                              (0x0020), MAPPED-ADDRESS (0x0001) and SOFTWARE
                              (0x8022). The 96-bit transaction id is echoed.
  0x0001 with an unknown comprehension-required attribute
                           -> 0x0111 Binding error, ERROR-CODE 400.
  Anything else            -> dropped silently: UDP has no error channel worth
                              using here, and a wrong magic cookie is not STUN.

Notes:
  * IPv4 only (the socket is udp4), no authentication, no TLS: the answer is the
    source address of the request, which any STUN client can ask for.
  * This server reports the mapping a NAT applied. It does not test filtering
    behaviour (RFC 5780 CHANGE-REQUEST), so a client's "endpoint-independent"
    verdict here is a statement about mapping only.

Exit codes:
  0  stopped normally (SIGINT/SIGTERM)
  2  bad usage
  3  failed to bind (port already in use?)
`;

function fail(message, code = 2) {
  process.stderr.write(`w2m-stun: ${message}\n`);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      software: { type: 'string' },
      'log-level': { type: 'string' },
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

const host = values.host ?? '0.0.0.0';

const port = values.port === undefined ? 3478 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`--port must be an integer in 0..65535, got ${JSON.stringify(values.port)}`);
}

// An empty --software is a configuration error rather than "use the default":
// the attribute is what a client sees when it asks who answered, and silently
// substituting a name the operator did not choose makes a deployment
// indistinguishable from the library default.
const software = values.software ?? DEFAULT_SOFTWARE;
if (String(software).trim() === '') {
  fail('--software must not be empty; omit it to use the default');
}

const logLevel = values['log-level'] ?? 'info';
if (logLevel !== 'info' && logLevel !== 'debug') {
  fail(`--log-level must be "info" or "debug", got ${JSON.stringify(logLevel)}`);
}
const debug = logLevel === 'debug';

// Data goes to stdout, diagnostics to stderr, as everywhere else in this project.
const log = (line) => process.stdout.write(`${line}\n`);

/**
 * One line per request, in `--log-level debug` only.
 *
 * The disposition is the interesting field: "binding_success" is a working
 * client, and every other value names the exact reason a datagram went
 * unanswered, which is what an operator needs to tell a blocked port from a
 * non-STUN client.
 *
 * @param {object} entry
 */
function logRequest(entry) {
  if (!debug) return;
  const unknown = entry.unknown?.length
    ? ` unknown=${entry.unknown.map((t) => `0x${t.toString(16)}`).join(',')}`
    : '';
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  log(
    `  ${at}  ${entry.from.padEnd(21)} ${String(entry.type ?? '-').padEnd(6)} ${entry.disposition}${unknown}`,
  );
}

let server;
let listen;
const startedAt = Date.now();
try {
  server = createStunServer({ host, port, software, log: logRequest });
  listen = await server.start();
} catch (error) {
  fail(formatError(error), 3);
}

if (!listen.ok) {
  // EADDRINUSE deserves its own sentence: it is the one failure an operator will
  // actually hit, and the fix (find the other listener, or pick another port) is
  // not obvious from "EADDRINUSE".
  if (listen.error === 'EADDRINUSE') {
    fail(
      `UDP port ${port} is already in use on ${host} — another STUN server or another ` +
        `w2m-stun is holding it. Stop it, or choose a different --port.`,
      3,
    );
  }
  fail(`failed to bind ${host}:${port} — ${listen.error}`, 3);
}

const bound = server.address() ?? { address: listen.host, port: listen.port };
log('');
log('  W2M STUN responder is listening.');
log('');
log(`  Bind          udp4 ${bound.address}:${bound.port}`);
log(`  Software      ${software}`);
log('  Answers       Binding requests (0x0001) -> 0x0101 with XOR-MAPPED-ADDRESS,');
log('                MAPPED-ADDRESS and SOFTWARE. Anything else is dropped.');
log('');
log('  NAT translation:');
log('    A machine behind NAT cannot see the public address and port its packets');
log(
  `    leave from. Point clients at ${bound.address === '0.0.0.0' ? '<this-host>' : bound.address}:${bound.port} (UDP) and`,
);
log('    this server reports the translated address back, which is what lets two');
log('    machines punch a direct path instead of relaying every task.');
if (bound.address === '0.0.0.0') {
  log('');
  log('  NOTE: bound to 0.0.0.0 — reachable from anywhere that can route UDP to this');
  log('        host. There is no authentication and no state: every request is');
  log('        answered on the address it came from, and nothing else is possible.');
}
log('');
log(`  Log level     ${logLevel}${debug ? '' : '   (--log-level debug prints one line per request)'}`);
log('');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  const stats = server.stats();
  log(
    `\n  ${signal} received, shutting down. ` +
      `requests=${stats.requests} responses=${stats.responses} errors=${stats.errors} ` +
      `uptime=${Math.round((Date.now() - startedAt) / 100) / 10}s`,
  );
  try {
    await server.stop();
  } catch (error) {
    process.stderr.write(`w2m-stun: error while closing: ${formatError(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
