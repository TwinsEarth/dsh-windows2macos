#!/usr/bin/env node
/**
 * w2m-maintenance — the root/SYSTEM side of the maintenance channel (v1.3.2-beta, M1).
 *
 * Installed as a systemd path unit (Linux) or a scheduled task (Windows). It reads signed request files from a queue
 * directory the unprivileged agent may write to, verifies the operator signature, executes one of the three fixed
 * actions, and writes a result file back. It never interprets a shell string and never accepts an action outside
 * update/restart/diag.
 */
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { runOnce } from '../src/maintenance/runner.mjs';
import { executeAction } from '../src/maintenance/actions.mjs';
import { createPinStore, registrationPayload } from '../src/maintenance/operator-key.mjs';

function parseArgs(argv) {
  const args = { once: false, watch: false, allowNonRoot: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--queue-dir') args.queueDir = next();
    else if (token === '--done-dir') args.doneDir = next();
    else if (token === '--claimed-dir') args.claimedDir = next();
    else if (token === '--state-file') args.stateFile = next();
    else if (token === '--pin-file') args.pinFile = next();
    else if (token === '--machine-id') args.machineId = next();
    else if (token === '--operator-key') args.operatorKey = next();
    else if (token === '--operator-key-id') args.operatorKeyId = next();
    else if (token === '--once') args.once = true;
    else if (token === '--watch') args.watch = true;
    else if (token === '--allow-nonroot') args.allowNonRoot = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error('unknown argument: ' + token);
  }
  return args;
}

const USAGE = `usage: w2m-maintenance [options]

  --queue-dir <dir>        directory the agent writes requests to (required)
  --done-dir <dir>         directory results are written to (required)
  --claimed-dir <dir>      default: <queue-dir>/../claimed
  --state-file <file>      replay state, default: <queue-dir>/../state.json
  --pin-file <file>        operator key pins, default: <queue-dir>/../operator-pins.json
  --machine-id <id>        this machine's id (required; or W2M_MACHINE_ID)
  --operator-key <pem>     bootstrap: pin this operator public key (PEM file) on first start
  --operator-key-id <id>   optional expected key id for the bootstrap key
  --once                   process the queue once and exit
  --watch                  poll the queue until interrupted
  --allow-nonroot          run without root (development/testing only)
`;

function requireRoot(args) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return; // Windows: the scheduled task decides the account, and there is no uid to check
  if (uid === 0 || args.allowNonRoot) return;
  throw new Error('the maintenance runner must run as root (pass --allow-nonroot only for development)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return 0; }
  if (!args.queueDir || !args.doneDir) { process.stderr.write(USAGE); return 2; }
  requireRoot(args);
  const machineId = args.machineId ?? process.env.W2M_MACHINE_ID;
  if (typeof machineId !== 'string' || machineId === '') throw new Error('--machine-id (or W2M_MACHINE_ID) is required');
  const claimedDir = args.claimedDir ?? join(args.queueDir, '..', 'claimed');
  const stateFile = args.stateFile ?? join(args.queueDir, '..', 'state.json');
  const pinFile = args.pinFile ?? join(args.queueDir, '..', 'operator-pins.json');
  mkdirSync(args.queueDir, { recursive: true });
  mkdirSync(args.doneDir, { recursive: true });
  const store = createPinStore(pinFile);
  if (args.operatorKey) {
    const pin = store.pinFromRegistration(registrationPayload({
      keyId: args.operatorKeyId ?? '',
      publicKeyPem: readFileSync(args.operatorKey, 'utf8'),
    }));
    process.stdout.write('pinned operator key ' + pin.pinned.key_id + (pin.firstContact ? ' (first contact)' : '') + '\n');
  }
  const options = {
    queueDir: args.queueDir,
    doneDir: args.doneDir,
    claimedDir,
    stateFile,
    machineId,
    pinStore: { load: () => store.load(), isRevoked: (keyId) => store.isRevoked(keyId) },
    executeAction,
    log: (level, message, detail) => process.stdout.write('[' + level + '] ' + message + (detail ? ' ' + JSON.stringify(detail) : '') + '\n'),
  };
  const run = async () => {
    const result = await runOnce(options);
    for (const entry of result.processed) process.stdout.write(JSON.stringify(entry) + '\n');
    return result;
  };
  if (args.once) { await run(); return 0; }
  await run();
  if (args.watch) {
    const tick = Number.parseInt(process.env.W2M_MAINTENANCE_INTERVAL_MS ?? '2000', 10);
    watch(args.queueDir, () => { run().catch((error) => process.stderr.write('watch run failed: ' + error.message + '\n')); });
    setInterval(() => { run().catch((error) => process.stderr.write('poll run failed: ' + error.message + '\n')); }, Number.isFinite(tick) && tick >= 500 ? tick : 2000);
    process.stdout.write('watching ' + args.queueDir + '\n');
    return new Promise(() => {});
  }
  return 0;
}

main().then((code) => { process.exitCode = typeof code === 'number' ? code : 0; }).catch((error) => {
  process.stderr.write('w2m-maintenance: ' + (error?.message ?? String(error)) + '\n');
  process.exitCode = 1;
});