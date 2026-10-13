/**
 * Reading a file out of the project, and telling the truth about sending it (v0.7.0).
 *
 * Two properties, both of which `dsh-chatops` 0.1.0 got wrong in ways that are invisible
 * from the outside.
 *
 * **The fence has to survive symlinks.** 0.1.0 resolved the requested path and compared
 * prefixes, which normalises `..` and nothing else — `statSync` and `readFile` both
 * follow links, so a symlink *inside* the project pointing at `~/.dsh/.credentials.yaml`
 * passed the check and its contents went to a chat platform. The tests below therefore
 * drive a fake filesystem rather than the real one: a symlink escape can be constructed
 * exactly, including one whose *parent directory* is the link, without needing the host
 * running the suite to support symlinks at all (Windows does not, without privileges —
 * which is also why 0.1.0's own workspace fence was never caught by its author).
 *
 * **A failed send is not a sent file.** Only one of that plugin's four channels re-threw;
 * the rest logged, told the user it failed, and returned normally, so the caller counted
 * the file as delivered and the model was told `已发送到 N 个 IM 窗口`. The tests here
 * assert on the *count*, because the count is what the model reads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as posix from 'node:path/posix';

import {
  createFileReader,
  createFileSender,
  fanOutFile,
  FILE_REFUSAL,
  REFUSED_EXTENSIONS,
  DEFAULT_MAX_BYTES,
} from '../src/chatops/file-safety.mjs';

const ROOT = '/proj';
const OUTSIDE = '/home/fang/.dsh';

/**
 * A filesystem described as real paths plus a link table.
 *
 * `links` maps a lexically-resolvable path to the path it really is. `realpath` follows
 * links repeatedly, as the real one does, so a chain of two links behaves like a chain
 * of two links.
 */
function fakeFs({ files = {}, links = {}, dirs = [], root = ROOT } = {}) {
  const reads = [];
  const isDir = new Set(dirs);
  // Every parent of every file and link is a directory, as it would be on a real
  // filesystem, and so is the project root itself. Stating that by hand in each test is
  // how a suite ends up failing on a missing `/proj` rather than on the property it is
  // checking.
  const noteParents = (p) => {
    let current = p;
    for (;;) {
      const cut = current.lastIndexOf('/');
      // `cut === 0` means the only separator is the leading one, so `current` is a
      // top-level path and there is nothing above it — stopping here also avoids
      // inserting the empty string, which would make `realpath('/proj')` miss.
      if (cut <= 0) break;
      current = current.slice(0, cut);
      isDir.add(current);
    }
  };
  // The root needs stating outright: `noteParents` walks upward and stops before the
  // first segment, and `/proj` has its only separator at index 0.
  isDir.add(root);
  for (const p of [...Object.keys(files), ...Object.keys(links), ...Object.values(links)]) noteParents(p);
  /**
   * Resolve a path the way `realpath` does: **segment by segment**, following a link
   * wherever it appears — including a directory in the middle of the path.
   *
   * Resolving only the whole string would make the fixture agree with a fence that
   * checks only the leaf, which is precisely the bug under test.
   */
  const resolveLinks = (p) => {
    const parts = posix.resolve(p).split('/').filter(Boolean);
    let built = '';
    for (const part of parts) {
      built += `/${part}`;
      for (let hop = 0; hop < 16; hop += 1) {
        if (!(built in links)) break;
        built = links[built];
        if (hop === 15) throw new Error('too many levels of symbolic links');
      }
    }
    return built === '' ? '/' : built;
  };
  return {
    reads,
    lstat: async (p) => {
      const real = resolveLinks(p);
      if (real in files) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: files[real].length,
          isSymbolicLink: () => p in links,
        };
      }
      if (isDir.has(real) || isDir.has(p)) {
        return { isFile: () => false, isDirectory: () => true, size: 0, isSymbolicLink: () => p in links };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    realpath: async (p) => {
      const real = resolveLinks(p);
      if (real in files || isDir.has(real)) return real;
      // A link pointing at something that does not exist still resolves its own path.
      if (p in links) return real;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readFile: async (p) => {
      const real = resolveLinks(p);
      if (!(real in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      reads.push(real);
      return Buffer.from(files[real]);
    },
  };
}

function reader(fs, over = {}) {
  const events = [];
  const r = createFileReader({ projectRoot: ROOT, audit: (e, d) => events.push({ e, ...d }), ...fs, ...over });
  return { reader: r, events };
}
describe('the fence survives symlinks', () => {
  it('reads an ordinary file inside the project', async () => {
    const fs = fakeFs({ files: { '/proj/notes/todo.md': 'hello' } });
    const { reader: r } = reader(fs);
    const result = await r.read('notes/todo.md');
    assert.equal(result.ok, true);
    assert.equal(result.name, 'todo.md');
    assert.equal(result.bytes, 5);
    assert.equal(result.data.toString(), 'hello');
  });

  it('refuses a link inside the project that points outside it', async () => {
    // The exact escape 0.1.0 allowed: the lexical path is inside, the real path is not.
    const fs = fakeFs({
      files: { [`${OUTSIDE}/.credentials.yaml`]: 'deepseek: sk-live-abcdef' },
      links: { '/proj/creds': `${OUTSIDE}/.credentials.yaml` },
    });
    const { reader: r, events } = reader(fs);
    const result = await r.read('creds');
    assert.equal(result.ok, false);
    assert.equal(result.reason, FILE_REFUSAL.ESCAPED);
    assert.deepEqual(fs.reads, [], 'a refused path must never reach readFile');
    assert.equal(events.at(-1).reason, FILE_REFUSAL.ESCAPED);
  });

  it('refuses when a parent directory is the link', async () => {
    // The leaf is an ordinary file; it is the directory above it that leaves.
    const fs = fakeFs({
      files: { [`${OUTSIDE}/keys/id_rsa`]: 'PRIVATE KEY' },
      dirs: [`${OUTSIDE}/keys`],
      links: { '/proj/linked': `${OUTSIDE}/keys` },
    });
    const { reader: r } = reader(fs);
    const result = await r.read('linked/id_rsa');
    assert.equal(result.ok, false);
    assert.equal(result.reason, FILE_REFUSAL.ESCAPED);
  });

  it('follows a link that stays inside the project', async () => {
    const fs = fakeFs({
      files: { '/proj/real/report.txt': 'ok' },
      dirs: ['/proj/real'],
      links: { '/proj/alias': '/proj/real/report.txt' },
    });
    const { reader: r } = reader(fs);
    const result = await r.read('alias');
    assert.equal(result.ok, true);
    assert.equal(result.name, 'report.txt');
  });

  it('refuses a relative traversal before touching the filesystem', async () => {
    const fs = fakeFs({ files: {} });
    const { reader: r } = reader(fs);
    const result = await r.read('../../etc/passwd');
    assert.equal(result.reason, FILE_REFUSAL.ESCAPED);
    assert.match(result.detail, /^lexical:/, 'a lexical escape is refused without a stat');
  });

  it('refuses an absolute path rather than treating it as project-relative', async () => {
    const fs = fakeFs({ files: { [`${OUTSIDE}/.credentials.yaml`]: 'x' } });
    const { reader: r } = reader(fs);
    const result = await r.read(`${OUTSIDE}/.credentials.yaml`);
    assert.equal(result.reason, FILE_REFUSAL.NOT_RELATIVE);
  });

  it('refuses a NUL in the path instead of letting a syscall truncate it', async () => {
    const fs = fakeFs({ files: { '/proj/ok.txt': 'x' } });
    const { reader: r } = reader(fs);
    assert.equal((await r.read('ok.txt\u0000.png')).reason, FILE_REFUSAL.MALFORMED);
  });

  it('allows the project root itself to be a symlink', async () => {
    // A workspace reached through a link is normal, and resolving it must not make every
    // path inside look like an escape.
    const fs = fakeFs({
      files: { '/real/proj/a.txt': 'x' },
      links: { [`${ROOT}`]: '/real/proj' },
    });
    const { reader: r } = reader(fs);
    const result = await r.read('a.txt');
    assert.equal(result.ok, true, 'a linked project root must still contain its own files');
  });
});

describe('what is not sent, whatever was asked for', () => {
  it('refuses credential-shaped extensions', async () => {
    const fs = fakeFs({
      files: {
        '/proj/server.pem': 'KEY',
        '/proj/app.key': 'KEY',
        '/proj/cert.p12': 'x',
        '/proj/.env': 'SECRET=1',
      },
    });
    const { reader: r } = reader(fs);
    for (const p of ['server.pem', 'app.key', 'cert.p12', '.env']) {
      assert.equal((await r.read(p)).reason, FILE_REFUSAL.TYPE_REFUSED, `${p} should be refused`);
    }
  });

  it('refuses credential-shaped names behind an innocent extension', async () => {
    const fs = fakeFs({ files: { '/proj/id_rsa.bak': 'KEY', '/proj/db-password.txt': 'x' } });
    const { reader: r } = reader(fs);
    assert.equal((await r.read('id_rsa.bak')).reason, FILE_REFUSAL.TYPE_REFUSED);
    assert.equal((await r.read('db-password.txt')).reason, FILE_REFUSAL.TYPE_REFUSED);
  });

  it('refuses executables and scripts', async () => {
    const fs = fakeFs({ files: { '/proj/tool.exe': 'MZ', '/proj/run.sh': '#!/bin/sh', '/proj/s.ps1': 'x' } });
    const { reader: r } = reader(fs);
    for (const p of ['tool.exe', 'run.sh', 's.ps1']) {
      assert.equal((await r.read(p)).reason, FILE_REFUSAL.TYPE_REFUSED, `${p} should be refused`);
    }
  });

  it('allows ordinary files a person would actually want on their phone', async () => {
    const fs = fakeFs({
      files: {
        '/proj/build.log': 'log',
        '/proj/shot.png': 'png',
        '/proj/report.pdf': 'pdf',
        '/proj/data.csv': 'a,b',
        '/proj/notes.md': '# hi',
      },
    });
    const { reader: r } = reader(fs);
    for (const p of ['build.log', 'shot.png', 'report.pdf', 'data.csv', 'notes.md']) {
      assert.equal((await r.read(p)).ok, true, `${p} should be allowed`);
    }
  });

  it('can be overridden per install, because a refusal must be answerable', async () => {
    // A deny-list an operator cannot get past is a deny-list they work around by
    // copying files somewhere worse. The escape hatch is explicit and narrow.
    const fs = fakeFs({ files: { '/proj/deploy.sh': '#!/bin/sh' } });
    const { reader: r } = reader(fs, { allowExtensions: ['.sh'] });
    assert.equal((await r.read('deploy.sh')).ok, true);
  });

  it('refuses a directory and a missing path with different names', async () => {
    const fs = fakeFs({ files: {}, dirs: ['/proj/sub'] });
    const { reader: r } = reader(fs);
    assert.equal((await r.read('sub')).reason, FILE_REFUSAL.NOT_A_FILE);
    assert.equal((await r.read('nope.txt')).reason, FILE_REFUSAL.MISSING);
  });

  it('refuses an oversized file before reading a byte of it', async () => {
    const fs = fakeFs({ files: { '/proj/big.bin': 'x'.repeat(2048) } });
    const { reader: r } = reader(fs, { maxBytes: 1024 });
    const result = await r.read('big.bin');
    assert.equal(result.reason, FILE_REFUSAL.TOO_LARGE);
    assert.deepEqual(fs.reads, [], 'the size gate must come before the read, not after');
  });

  it('publishes the ceiling it enforces', () => {
    assert.equal(DEFAULT_MAX_BYTES, 100 * 1024 * 1024);
    assert.ok(REFUSED_EXTENSIONS.includes('.pem') && REFUSED_EXTENSIONS.includes('.env'));
  });
});

describe('a failed send is not a sent file', () => {
  it('reports a rejecting channel send as a failure', async () => {
    const events = [];
    const sender = createFileSender({
      send: async () => {
        throw new Error('platform refused the upload');
      },
      audit: (e, d) => events.push({ e, ...d }),
    });
    const result = await sender.deliver({ name: 'a.log', bytes: 3, data: Buffer.from('abc') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'send_failed');
    assert.equal(result.detail, 'platform refused the upload');
    assert.equal(events.at(-1).e, 'file/send-failed');
  });

  it('reports a resolving channel send as a success', async () => {
    const sender = createFileSender({ send: async () => {} });
    assert.deepEqual(await sender.deliver({ name: 'a.log', bytes: 3, data: Buffer.from('abc') }), { ok: true });
  });

  it('counts what was delivered, not what was attempted', async () => {
    // The failure this replaces: three of four channels logged the error and returned
    // normally, so the count was four and the model was told four.
    const file = { name: 'build.log', bytes: 4, data: Buffer.from('logs') };
    const targets = [
      { window: 'user:a', deliver: async () => ({ ok: true }) },
      { window: 'user:b', deliver: async () => ({ ok: false, reason: 'send_failed', detail: 'boom' }) },
      { window: 'fsu:c', deliver: async () => ({ ok: false, reason: 'send_failed', detail: 'boom' }) },
      { window: 'user:d', deliver: async () => ({ ok: true }) },
    ];
    const outcome = await fanOutFile({ targets, file });
    assert.equal(outcome.attempted, 4);
    assert.equal(outcome.sent, 2);
    assert.equal(outcome.allSent, false);
    assert.deepEqual(
      outcome.failed.map((f) => f.window),
      ['user:b', 'fsu:c'],
    );
  });

  it('says allSent only when every window really took it', async () => {
    const file = { name: 'a.log', bytes: 1, data: Buffer.from('a') };
    const targets = [
      { window: 'user:a', deliver: async () => ({ ok: true }) },
      { window: 'user:b', deliver: async () => ({ ok: true }) },
    ];
    const outcome = await fanOutFile({ targets, file });
    assert.equal(outcome.allSent, true);
    assert.equal(outcome.sent, 2);
  });

  it('says allSent is false for zero windows rather than vacuously true', async () => {
    // "Sent to all of nobody" must not read as success; the caller has to notice that
    // there was nowhere to send it.
    const outcome = await fanOutFile({ targets: [], file: { name: 'a', bytes: 0, data: Buffer.alloc(0) } });
    assert.equal(outcome.attempted, 0);
    assert.equal(outcome.allSent, false);
  });

  it('refuses to be built without a send function', () => {
    assert.throws(() => createFileSender({}), /requires a send\(\)/);
  });
});
