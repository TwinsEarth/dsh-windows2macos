/**
 * The Streamable HTTP binding for the MCP server (v0.55.0).
 *
 * ## Why this is a separate file from the stdio binding
 *
 * The MCP overview says it directly: **"Protocol semantics are identical on every transport. A transport is a
 * binding"** -- it defines framing and delivery, never meaning. So this file contains no protocol decisions: it
 * decodes a request, hands the body to `handleMessage`, and encodes the reply. **`bin/w2m-mcp.mjs` holds the
 * semantics and neither binding imports the other.**
 *
 * ## What revision 2026-07-28 removed, which simplifies this by a lot
 *
 * * **The GET stream endpoint is gone.** A GET is refused rather than half-supported.
 * * **Protocol-level sessions are gone.** No `Mcp-Session-Id`, no session table, no state between requests --
 *   which is what the overview means by "stateless, self-contained requests".
 *
 * ## The security requirement that is easy to skip
 *
 * **"Servers MUST validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks."**
 * A local MCP server bound to a loopback port is reachable by any page the user's browser loads, and a
 * rebinding attack makes that page same-origin. So an invalid `Origin` gets **403**, and the default bind is
 * **127.0.0.1** rather than every interface.
 *
 * ## Two response shapes, and why JSON is chosen
 *
 * The specification allows a plain JSON object or a request-scoped SSE stream. **SSE exists to interleave
 * request-related notifications with the final response**, and this server emits no notifications during a call
 * -- its only outbound messages are responses. So the JSON shape carries everything, and SSE would be a stream
 * with one frame. `?stream=1` is honoured for a client that insists, because a client written against the
 * stream form is entitled to it.
 */
import { createServer } from 'node:http';
import { handleMessage, TOOL_NAMES, SUPPORTED_VERSIONS, SERVER_NAME, SERVER_VERSION } from '../../bin/w2m-mcp.mjs';

/** The path the MCP endpoint is mounted at. A single endpoint, per the specification. */
export const MCP_PATH = '/mcp';

/**
 * Origins that may call this server.
 *
 * **Loopback only, and by exact match.** A rebinding attack arrives with an `Origin` the attacker chose, so the
 * rule has to be an allow-list rather than a check for something suspicious -- and `null` (a `file://` page, a
 * sandboxed iframe) is refused for the same reason.
 */
export const ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1',
  'http://localhost',
  'https://127.0.0.1',
  'https://localhost',
]);

/**
 * Is this `Origin` acceptable?
 *
 * A missing `Origin` is allowed: a non-browser client (curl, an SDK) sends none, and the header exists to
 * constrain *browsers*. **Refusing an absent header would break every command-line client while stopping no
 * attack**, because an attacker's browser always sends one.
 *
 * @param {string|undefined} origin
 */
export function originAllowed(origin) {
  if (origin === undefined || origin === '') return true;
  // Compare origin+port only, so any port on loopback is acceptable.
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const bare = `${parsed.protocol}//${parsed.hostname}`;
  return ALLOWED_ORIGINS.includes(bare);
}

/** Read a request body, bounded so a hostile client cannot exhaust memory. */
const readBody = (req, limit = 4 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      reject(new Error(`body exceeds ${limit} bytes`));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/**
 * Build the request handler.
 *
 * Exported separately from `createMcpHttpServer` so a test can call it with fake request and response objects --
 * **the same reason `handleMessage` is exported**: a socket is not needed to prove framing.
 *
 * @param {{deps: object}} options
 */
export function createRequestHandler({ deps }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    // 1. Origin, before anything else -- the specification makes this a MUST, and it must precede parsing.
    if (!originAllowed(req.headers.origin)) {
      sendJson(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Origin ${JSON.stringify(req.headers.origin)} is not allowed`, data: { allowed: [...ALLOWED_ORIGINS] } } });
      return;
    }

    /**
     * 2. A discovery GET, so an operator can see what is here without speaking the protocol.
     *
     * **Gated on an explicit `?discover=1`, and that is not decoration.** A bare `GET /mcp` is what a client
     * written against the removed stream endpoint sends, and it must be told the endpoint is gone rather than
     * handed a document it will fail to parse as a stream. **Two different requests with two different answers,
     * decided by a parameter rather than by guessing at the caller's intent.**
     */
    if (req.method === 'GET' && url.pathname === MCP_PATH && url.searchParams.has('discover')) {
      sendJson(res, 200, {
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        transport: 'streamable-http',
        endpoint: MCP_PATH,
        method: 'POST',
        protocolVersions: [...SUPPORTED_VERSIONS],
        tools: [...TOOL_NAMES],
      });
      return;
    }

    // 3. The GET *stream* endpoint was removed in 2026-07-28. Refused explicitly rather than 404, because a
    //    client written against the older revision should learn why rather than guess.
    if (req.method === 'GET') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `the GET stream endpoint was removed in protocol revision 2026-07-28; POST to the MCP endpoint instead, or GET ${MCP_PATH}?discover for a description`, data: { endpoint: MCP_PATH } } });
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, GET' });
      res.end();
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: `no endpoint at ${url.pathname}; the MCP endpoint is ${MCP_PATH}` } });
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } });
      return;
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      // A parse failure is a JSON-RPC error response, not an HTTP 400: the transport delivered the bytes, and
      // the protocol layer is what rejects them.
      sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `invalid JSON: ${error.message}` } });
      return;
    }

    const reply = await handleMessage(message, deps);
    if (reply === null) {
      // A notification: JSON-RPC forbids a response, and the HTTP binding says so with 202 Accepted.
      res.writeHead(202);
      res.end();
      return;
    }

    if (url.searchParams.get('stream') === '1') {
      // Request-scoped SSE, for a client written against the stream form. One frame: this server emits no
      // notifications during a call, so there is nothing to interleave.
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      res.end();
      return;
    }

    sendJson(res, 200, reply);
  };
}

/**
 * Start the server.
 *
 * **Binds 127.0.0.1 by default.** The specification says a local server SHOULD bind only to loopback, and a
 * fleet-control endpoint reachable from the network is a different threat than one reachable from this machine.
 *
 * @param {{host?: string, port?: number, deps: object}} options
 * @returns {Promise<{server: object, url: string, close: () => Promise<void>}>}
 */
export function createMcpHttpServer({ host = '127.0.0.1', port = 8766, deps }) {
  const server = createServer(createRequestHandler({ deps }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        url: `http://${host}:${address.port}${MCP_PATH}`,
        // A block body, not a concise arrow: `() => done()` returns `done()`'s value into a Promise executor,
        // which nothing reads.
        close: () => new Promise((done) => { server.close(() => { done(); }); }),
      });
    });
  });
}
