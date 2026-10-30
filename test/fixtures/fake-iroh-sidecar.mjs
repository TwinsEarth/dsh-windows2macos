#!/usr/bin/env node
/** Fake iroh sidecar for W1 tests: same framing, no Rust, no network. */
const silent = process.env.FAKE_IROH_SILENT === '1';
const crash = process.env.FAKE_IROH_CRASH === '1';
if (crash) process.exit(7);

let buffer = Buffer.alloc(0);
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) return;
    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    let message = null;
    try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
    if (message.method === 'send') {
      send({ type: 'message', peer: message.params.peer, data: message.params.data });
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === 'status') {
      send({ id: message.id, result: { paths: [{ kind: 'iroh-direct', rttMs: 12 }] } });
    } else if (message.method === 'close') {
      send({ id: message.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 10);
    } else {
      send({ id: message.id, error: { code: 'FAKE_UNKNOWN', message: 'unknown method' } });
    }
  }
});

if (!silent) send({ type: 'ready' });
