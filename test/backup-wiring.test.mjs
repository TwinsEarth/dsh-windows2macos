/**
 * Backup wiring: a module that nothing mounts is a module that ships broken.
 *
 * The project has shipped that defect three times (see `scripts/accepted-orphans.mjs`), so the wiring is asserted
 * rather than assumed: the bin is declared, the suites are named in `package.json`, the plugin mounts the routes,
 * the layer model knows the new layer, and the CLI actually runs through the real entry point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_EDGES, LAYERS } from '../scripts/layer-model.mjs';
import {
  BACKUP_SCAN_ROUTE_PATH,
  BACKUP_STATUS_ROUTE_PATH,
  buildScan,
  buildStatus,
  registerBackupRoutes,
} from '../src/backup/routes.mjs';
import { formatScan, formatStatus, main } from '../src/backup/cli.mjs';
import { makeHome, registryDocument } from './helpers/backup-fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** A fake Cordis context whose connection registry records what the plugin registers. */
function fakeCtx() {
  const registrations = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection']);
      callback({ connection: { fetch: { register: (definition) => registrations.push(definition) } } });
    },
  };
  return { ctx, registrations };
}

describe('backup wiring: package and entry points', () => {
  it('declares the CLI in package.json#bin and ships it', () => {
    assert.equal(pkg.bin['w2m-backup'], 'bin/w2m-backup.mjs');
    assert.ok(pkg.files.includes('bin'), 'the bin directory must be in the published file list');
    assert.ok(pkg.files.includes('src'), 'the implementation lives in src and must be published');
    assert.ok(pkg.files.includes('docs'), 'the design document ships with the package');
  });

  it('ships a bin that starts with a shebang and delegates to src/backup/cli.mjs', () => {
    const text = readFileSync(join(ROOT, 'bin', 'w2m-backup.mjs'), 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env node/u);
    assert.match(text, /\.\.\/src\/backup\/cli\.mjs/u);
  });

  it('runs through the real entry point: --help exits 0 and prints usage', () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'bin', 'w2m-backup.mjs'), '--help'], { encoding: 'utf8' });
    assert.match(output, /usage: w2m-backup/u);
    assert.match(output, /read-only/u);
  });

  it('names every backup suite in scripts.test, test:all and its own script', () => {
    const suites = ['backup-layout', 'backup-scan', 'backup-crypto', 'backup-protocol', 'backup-wiring'];
    for (const suite of suites) {
      assert.equal(pkg.scripts[`test:${suite}`], `node --test --test-force-exit test/${suite}.test.mjs`, `test:${suite} missing`);
      assert.ok(pkg.scripts.test.includes(`test/${suite}.test.mjs`), `${suite} missing from scripts.test`);
      assert.ok(pkg.scripts['test:all'].includes(`test/${suite}.test.mjs`), `${suite} missing from test:all`);
      assert.ok(existsSync(join(ROOT, 'test', `${suite}.test.mjs`)), `${suite}.test.mjs missing`);
    }
  });

  it('documents the protocol in docs/BACKUP-DESIGN.md', () => {
    const file = join(ROOT, 'docs', 'BACKUP-DESIGN.md');
    assert.ok(existsSync(file), 'docs/BACKUP-DESIGN.md must exist');
    const text = readFileSync(file, 'utf8');
    for (const frozen of ['w2m-session-backup/manifest', 'w2m-session-backup/keys', 'BACKUP_NO_PERMISSION']) {
      assert.ok(text.includes(frozen), `the design document must name ${frozen}`);
    }
  });
});

describe('backup wiring: the layer model', () => {
  it('declares a backup capability layer and its three downward edges', () => {
    const layer = LAYERS.find((entry) => entry.name === 'backup');
    assert.ok(layer, 'the backup layer must be declared in scripts/layer-model.mjs');
    assert.equal(layer.rank, 1);
    const edges = ALLOWED_EDGES.map(([from, to]) => `${from} -> ${to}`);
    for (const edge of ['plugin -> backup', 'backup -> fix', 'backup -> util']) {
      assert.ok(edges.includes(edge), `${edge} must be declared`);
    }
  });

  it('passes scripts/layer-check.mjs against the real tree', () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'layer-check.mjs')], { encoding: 'utf8' });
    assert.match(output, /clean: every cross-layer edge is declared/u);
    assert.match(output, /backup/u, 'the checker must have seen the layer');
  });

  it('parses the workspace registry through ONE module, shared with the doctor', () => {
    const doctor = readFileSync(join(ROOT, 'scripts', 'session-doctor.mjs'), 'utf8');
    const scan = readFileSync(join(ROOT, 'src', 'backup', 'scan.mjs'), 'utf8');
    assert.match(doctor, /util\/dsh-workspace\.mjs/u, 'the doctor must reuse the shared parser');
    assert.match(scan, /util\/dsh-workspace\.mjs/u, 'the scanner must reuse the shared parser');
  });
});

describe('backup wiring: routes', () => {
  it('registers nothing without a Connection service, and says why', () => {
    const status = registerBackupRoutes({});
    assert.equal(status.mounted, false);
    assert.match(status.reason, /Connection/u);
    assert.deepEqual(status.paths, [BACKUP_STATUS_ROUTE_PATH, BACKUP_SCAN_ROUTE_PATH]);
  });

  it('registers two GET routes on the host registry', () => {
    const { ctx, registrations } = fakeCtx();
    const status = registerBackupRoutes(ctx);
    assert.equal(status.mounted, true);
    assert.equal(status.reason, null);
    assert.deepEqual(registrations.map((entry) => entry.path), [BACKUP_STATUS_ROUTE_PATH, BACKUP_SCAN_ROUTE_PATH]);
    for (const entry of registrations) assert.deepEqual(entry.methods, ['GET']);
  });

  it('answers GET status from a read-only inspection, and refuses other methods', async () => {
    const { ctx, registrations } = fakeCtx();
    const { home, cleanup } = makeHome();
    try {
      registerBackupRoutes(ctx, { dshHome: () => home, backupDir: () => join(home, '..', 'repo-not-created'), env: {} });
      const [status, scan] = registrations;

      const response = await status.fetch(new Request(`http://local.invalid${BACKUP_STATUS_ROUTE_PATH}`, { method: 'GET' }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.read_only, true);
      assert.equal(body.dsh_home, home);
      assert.equal(body.repository.exists, false);
      assert.equal(body.schedule.times[0], '22:00');

      const refused = await status.fetch(new Request(`http://local.invalid${BACKUP_STATUS_ROUTE_PATH}`, { method: 'POST' }));
      assert.equal(refused.status, 405);
      assert.equal((await refused.json()).reason_code, 'METHOD_NOT_ALLOWED');

      const scanned = await scan.fetch(new Request(`http://local.invalid${BACKUP_SCAN_ROUTE_PATH}`, { method: 'GET' }));
      const scanBody = await scanned.json();
      assert.equal(scanBody.ok, true);
      assert.equal(scanBody.read_only, true);
      assert.equal(typeof scanBody.totals.sessions, 'number');
      assert.equal(scanBody.sessions, undefined, 'the default payload is a summary, not the file list');
    } finally {
      cleanup();
    }
  });

  it('includes rows only when the caller asks for detail, and refuses a failing scan with a code', async () => {
    const { ctx, registrations } = fakeCtx();
    const { home, cleanup } = makeHome({ registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }) });
    try {
      registerBackupRoutes(ctx, { dshHome: () => home, env: {} });
      const scan = registrations[1];
      const detailed = await scan.fetch(new Request(`http://local.invalid${BACKUP_SCAN_ROUTE_PATH}?detail=1`, { method: 'GET' }));
      const body = await detailed.json();
      assert.ok(Array.isArray(body.sessions));
      assert.equal(body.sessions.length, 1);
      assert.equal(body.sessions[0].session_id, 'session-aaaaaaaa-0001');
      assert.equal(body.sessions[0].flags.registered, true);
    } finally {
      cleanup();
    }

    const failing = fakeCtx();
    registerBackupRoutes(failing.ctx, {
      dshHome: () => 'C:\\nonexistent',
      scan: () => {
        const error = new Error('boom');
        error.code = 'BACKUP_SCAN_FAILED';
        throw error;
      },
    });
    const response = await failing.registrations[1].fetch(new Request(`http://local.invalid${BACKUP_SCAN_ROUTE_PATH}`, { method: 'GET' }));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).reason_code, 'BACKUP_SCAN_FAILED');
  });

  it('buildStatus and buildScan are pure functions a test can call without a host', () => {
    const { home, cleanup } = makeHome();
    try {
      const status = buildStatus({ dshHome: home, backupDir: join(home, '..', 'repo'), env: {} });
      assert.equal(status.read_only, true);
      assert.equal(status.repository.root.endsWith('repo'), true);
      const scan = buildScan({ dshHome: home, detail: true, env: {} });
      assert.equal(scan.ok, true);
      assert.equal(scan.totals.sessions, 1);
      assert.equal(scan.sessions.length, 1);
    } finally {
      cleanup();
    }
  });
});

describe('backup wiring: the CLI', () => {
  const capture = () => {
    const lines = [];
    return { lines, io: { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text), env: {} } };
  };

  it('prints usage for help, and exits 2 for an unknown command', () => {
    const help = capture();
    assert.equal(main(['help'], help.io), 0);
    assert.match(help.lines.join('\n'), /usage: w2m-backup/u);

    const bad = capture();
    assert.equal(main(['nonsense'], bad.io), 2);
    assert.match(bad.lines.join('\n'), /unknown command/u);

    const unknownFlag = capture();
    assert.equal(main(['status', '--wat'], unknownFlag.io), 2);
  });

  it('status is read-only and reports an absent repository as a state', () => {
    const { home, cleanup } = makeHome();
    try {
      const captured = capture();
      const code = main(['status', '--dsh-home', home, '--backup-dir', join(home, '..', 'not-created'), '--json'], captured.io);
      assert.equal(code, 0);
      const payload = JSON.parse(captured.lines.join('\n'));
      assert.equal(payload.read_only, true);
      assert.equal(payload.repository.exists, false);
      assert.equal(payload.repository.writable, null);
      assert.equal(existsSync(join(home, '..', 'not-created')), false);
    } finally {
      cleanup();
    }
  });

  it('scan reports the fixture and builds an in-memory manifest only when asked', () => {
    const { home, cleanup } = makeHome();
    try {
      const captured = capture();
      assert.equal(main(['scan', '--dsh-home', home, '--json'], captured.io), 0);
      const payload = JSON.parse(captured.lines.join('\n'));
      assert.equal(payload.totals.sessions, 1);
      assert.equal(payload.manifest, undefined);

      const withManifest = capture();
      assert.equal(main(['scan', '--dsh-home', home, '--manifest', '--json'], withManifest.io), 0);
      const built = JSON.parse(withManifest.lines.join('\n'));
      assert.equal(built.manifest.sessions, 1);
      assert.match(built.manifest_digest, /^[0-9a-f]{64}$/u);
    } finally {
      cleanup();
    }
  });

  it('selftest exits 0 when the cryptography round-trips', () => {
    const captured = capture();
    assert.equal(main(['selftest'], captured.io), 0);
    assert.match(captured.lines.join('\n'), /result: OK/u);
  });

  it('formats human output without leaking a machine path into the summary lines', () => {
    const status = formatStatus({
      ok: true,
      dsh_home: 'C:\\Users\\x\\.dsh',
      repository: { root: 'D:\\BackUP', exists: true, is_file: false, initialized: false, writable: true, free_bytes: 1024, counts: { objects: 0, snapshots: 0, old: 0 } },
      schedule: { times: ['22:00'], time_zone: 'Asia/Shanghai', implemented: false },
    });
    assert.match(status, /22:00/u);
    const scan = formatScan({ dsh_home: 'C:\\x', exists: true, totals: { sessions: 1, session_bytes: 10 }, registry: { ok: true, workspaces: 1, registered: 1 }, exclusions: [] });
    assert.match(scan, /sessions\s+: 1/u);
  });
});
