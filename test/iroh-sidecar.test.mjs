import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createIrohSidecarTransport, IROH_TRANSPORT } from '../src/agent/iroh-sidecar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fake-iroh-sidecar.mjs');

describe('W1: iroh sidecar contract (fake binary)', () => {
  it('starts, sends and receives a payload, then stops', async () => {
    const created = createIrohSidecarTransport({ command: process.execPath, args: [fixture], timeoutMs: 2000 });
    assert.equal(created.ok, true);
    const transport = created.transport;
    assert.equal(transport.name, IROH_TRANSPORT);
    const started = await transport.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const received = [];
    transport.onMessage((message) => received.push(message));
    const sent = await transport.send('peer-a', Buffer.from('spike-payload'));
    assert.equal(sent.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].peer, 'peer-a');
    assert.equal(received[0].payload.toString(), 'spike-payload');
    assert.equal(transport.diagnostics().name, IROH_TRANSPORT);
    await transport.stop();
    assert.equal(transport.diagnostics().closed, true);
  });

  it('refuses to start a command that does not exist', async () => {
    const created = createIrohSidecarTransport({ command: 'definitely-not-a-real-iroh-binary', timeoutMs: 500 });
    assert.equal(created.ok, true);
    const started = await created.transport.start();
    assert.equal(started.ok, false);
    assert.equal(started.code, 'IROH_SIDECAR_START_FAILED');
  });

  it('reports a start timeout instead of hanging when the sidecar never says ready', async () => {
    const created = createIrohSidecarTransport({ command: process.execPath, args: [fixture], env: { FAKE_IROH_SILENT: '1' }, timeoutMs: 200 });
    assert.equal(created.ok, true);
    const started = await created.transport.start();
    assert.equal(started.ok, false);
    assert.equal(started.code, 'IROH_SIDECAR_START_FAILED');
  });

  it('names a crashed sidecar on send', async () => {
    const created = createIrohSidecarTransport({ command: process.execPath, args: [fixture], env: { FAKE_IROH_CRASH: '1' }, timeoutMs: 500 });
    assert.equal(created.ok, true);
    const started = await created.transport.start();
    assert.equal(started.ok, false);
    assert.equal(started.code, 'IROH_SIDECAR_START_FAILED');
  });
});
