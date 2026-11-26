/**
 * Entry guards: deciding "is this file the process entry?" by comparing `import.meta.url` with a URL built by
 * hand from `process.argv[1]`.
 *
 * That compares two encodings of one path. A hand-built `file://${...}` template leaves `~` and `#` as they
 * are; the loader percent-encodes them (`ADMINI%7E1`, `%23`). On such a path the comparison is false, `main()`
 * never runs, and the process exits 0 having done nothing -- the worst failure a command can have, because
 * every caller that trusts the exit status reads "done".
 *
 * Found on a real machine, not by review. A Windows profile whose `%TEMP%` is the 8.3 short name
 * `C:\Users\ADMINI~1\...` failed `passes scripts/layer-check.mjs against the real tree` twice, each time with an
 * EMPTY stdout and exit 0, and passed the moment the same tree was reached through the long path. Three shipped
 * commands (`w2m-bootstrap`, `w2m-hidden-task`, `w2m-secondary-link`) carried the identical guard.
 *
 * `pathToFileURL` fixes the encoding, and does not fix the other half: `argv[1]` keeps the spelling the caller used
 * while `import.meta.url` has already been resolved. On macOS `/tmp` and `/var` are symlinks and `os.tmpdir()`
 * lives behind `/var`, so an entry started from a temporary path -- which is exactly how this suite starts them --
 * took the silent branch even with the URL built correctly. A pnpm install has the same shape: the package under
 * `node_modules/@twinsearth/` is a link into the store, so the shipped commands were silent in production too.
 *
 * So the rule is asserted four times: no file under `bin/` and `scripts/` builds the entry URL by hand; anything
 * that decides the question goes through the shared `isMainModule`; and the shipped entry points still run when
 * reached through a path that carries `~` and `#`, through a symlink, and (on Windows) through the 8.3 short name.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The hand-built form this suite forbids: a template literal that starts with `file://${`. */
const HAND_BUILT_ENTRY_URL = /import\.meta\.url\s*[!=]==\s*(?:new URL\(\s*)?`file:\/\/\$\{/u;
const COMPARES_AGAINST_ENTRY = /import\.meta\.url\s*[!=]==/u;

/** Every `.mjs` under `directory`, recursively, as paths relative to the repository root. */
function mjsFilesUnder(directory) {
  const out = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.mjs')) out.push(child);
    }
  };
  walk(directory);
  return out.sort();
}

/**
 * One shipped entry point, invoked the one way that touches nothing: `--help`, or no arguments for the checker.
 *
 * @type {Array<{script: string, args: string[], exit: number, stdout?: RegExp, stderr?: RegExp}>}
 */
const ENTRY_POINTS = [
  {
    script: 'scripts/layer-check.mjs',
    args: [],
    exit: 0,
    stdout: /clean: every cross-layer edge is declared/u,
  },
  {
    script: 'bin/w2m-bootstrap.mjs',
    args: ['--help'],
    exit: 0,
    stdout: /^usage: w2m-bootstrap\.mjs --bootstrap <json\|url>/mu,
  },
  {
    // The help flag is honoured only next to the required ones: the parser checks those before `main()` gets to
    // look at `--help`. With the flags present nothing is scheduled and no file is written.
    script: 'bin/w2m-hidden-task.mjs',
    args: ['--help', '--name', 'entry-guard-probe', '--command', 'entry-guard-probe', '--every-minutes', '60'],
    exit: 0,
    stdout: /^usage: w2m-hidden-task\.mjs --name <task>/mu,
  },
  {
    script: 'bin/w2m-secondary-link.mjs',
    args: ['--help'],
    exit: 2,
    stderr: /^w2m-secondary-link: usage: w2m-secondary-link\.mjs --relay <url>/mu,
  },
];

describe('entry guards', () => {
  it('a hand-built template and the loader disagree on ~ and #', () => {
    // The fact the rest of this file rests on, stated directly so a reader never has to take it on faith.
    const file = join(ROOT, 'a~b #c.mjs');
    const handBuilt = new URL(`file://${file.replace(/\\/g, '/')}`).href;
    assert.equal(handBuilt, pathToFileURL(file).href.replace(/%7E/gu, '~').replace(/%23/gu, '#'),
      'the template leaves `~` and `#` alone; only those two characters differ');
    assert.notEqual(handBuilt, pathToFileURL(file).href, 'the two must therefore encode the same path differently');
  });

  it('builds no entry URL by hand under bin/ and scripts/', () => {
    const offenders = [];
    for (const file of [...mjsFilesUnder('bin'), ...mjsFilesUnder('scripts')]) {
      if (HAND_BUILT_ENTRY_URL.test(readFileSync(join(ROOT, file), 'utf8'))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'these files compare import.meta.url with a hand-built file:// URL');
  });

  it('decides the entry through the shared guard wherever it decides at all', () => {
    const offenders = [];
    for (const file of [...mjsFilesUnder('bin'), ...mjsFilesUnder('scripts')]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (COMPARES_AGAINST_ENTRY.test(text) && !text.includes('isMainModule(')) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'these files decide the entry without the shared isMainModule helper');
  });

  describe('from a path that carries ~ and #', () => {
    // A copy, not a link: the loader resolves a symlinked or junction-mounted entry to its real path, which
    // would remove the very characters this suite is about. `bin/`, `scripts/` and `src/` are enough for every
    // entry point below to load; nothing else in the tree is read on these invocations.
    const odd = mkdtempSync(join(tmpdir(), 'w2m entry~guard #'));
    before(() => {
      for (const directory of ['bin', 'scripts', 'src']) {
        cpSync(join(ROOT, directory), join(odd, directory), { recursive: true });
      }
    });
    after(() => {
      rmSync(odd, { recursive: true, force: true });
    });

    for (const entry of ENTRY_POINTS) {
      it(`${entry.script} runs and answers`, () => {
        assert.ok(/[~#]/u.test(odd), 'the scratch path must carry the characters under test');
        const run = spawnSync(process.execPath, [join(odd, ...entry.script.split('/')), ...entry.args], {
          cwd: odd,
          encoding: 'utf8',
          timeout: 120_000,
        });
        assert.equal(run.error, undefined, `node itself failed to start: ${String(run.error)}`);
        const seen = `exit ${String(run.status)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))}, `
          + `stderr ${JSON.stringify(run.stderr.slice(0, 200))}`;
        assert.equal(run.status, entry.exit, `${entry.script} from ${odd}: ${seen}`);
        if (entry.stdout !== undefined) {
          assert.match(run.stdout, entry.stdout, `${entry.script} printed nothing to stdout: ${seen}`);
        }
        if (entry.stderr !== undefined) {
          assert.match(run.stderr, entry.stderr, `${entry.script} printed nothing to stderr: ${seen}`);
        }
      });
    }
  });

  describe('from a path reached through a symlink', () => {
    // The other half of the problem: the entry exists once and has two spellings. `argv[1]` keeps the spelling the
    // caller typed, `import.meta.url` is the resolved one, and the caller is who decides.
    const scratch = mkdtempSync(join(tmpdir(), 'w2m-entry-guard-link-'));
    const real = join(scratch, 'real');
    const link = join(scratch, 'link');
    let usable = true;
    before(() => {
      for (const directory of ['bin', 'scripts', 'src']) {
        cpSync(join(ROOT, directory), join(real, directory), { recursive: true });
      }
      try {
        // Windows lets an unprivileged process create a junction but not a symlink; both are resolved the same way.
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        // Windows only lets an elevated or developer-mode process create one; that is not a failure of the guard.
        usable = false;
        process.stderr.write(`[entry-guard] symlink not available here: ${String(error)}\n`);
      }
    });
    after(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    for (const entry of ENTRY_POINTS) {
      it(`${entry.script} runs and answers`, (t) => {
        if (!usable) return t.skip('this machine cannot create a directory symlink');
        assert.notEqual(realpathSync(link), link, 'the link must actually be a link, or the test proves nothing');
        const run = spawnSync(process.execPath, [join(link, ...entry.script.split('/')), ...entry.args], {
          cwd: link,
          encoding: 'utf8',
          timeout: 120_000,
        });
        const seen = `exit ${String(run.status)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))}, `
          + `stderr ${JSON.stringify(run.stderr.slice(0, 200))}`;
        assert.equal(run.status, entry.exit, `${entry.script} from ${link}: ${seen}`);
        if (entry.stdout !== undefined) assert.match(run.stdout, entry.stdout, `${entry.script}: ${seen}`);
        if (entry.stderr !== undefined) assert.match(run.stderr, entry.stderr, `${entry.script}: ${seen}`);
      });
    }
  });

  it('runs from the 8.3 short name on Windows', (t) => {
    // The case the bug was first seen on. `%TEMP%` on that machine is `C:\Users\ADMINI~1\...`, and the guard
    // has to survive the spelling the OS hands out, not the one a test would prefer.
    if (process.platform !== 'win32') return t.skip('8.3 short names exist on Windows only');
    const dir = mkdtempSync(join(tmpdir(), 'w2m-entry-guard-83-'));
    for (const directory of ['bin', 'scripts', 'src']) {
      cpSync(join(ROOT, directory), join(dir, directory), { recursive: true });
    }
    // `ShortPath` from the shell's own file-system object: no quoting games, and it is the same spelling that
    // `%TEMP%` hands out on the machine the bug was found on.
    const quoted = dir.replace(/'/gu, "''");
    const queried = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${quoted}').ShortPath`], { encoding: 'utf8' });
    const short = (queried.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean).pop();
    try {
      assert.equal(queried.status, 0, `could not ask for the short name: ${String(queried.stderr)}`);
      assert.ok(short && /~\d/u.test(short), `no short name was produced for ${dir}: ${JSON.stringify(short)}`);
      const entry = ENTRY_POINTS[1];
      const run = spawnSync(process.execPath, [join(short, ...entry.script.split('/')), ...entry.args], {
        cwd: short,
        encoding: 'utf8',
        timeout: 120_000,
      });
      const seen = `exit ${String(run.status)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))}, `
        + `stderr ${JSON.stringify(run.stderr.slice(0, 200))}`;
      assert.equal(run.status, entry.exit, `${entry.script} from ${short}: ${seen}`);
      assert.match(run.stdout, entry.stdout, `${entry.script} from its short name printed nothing: ${seen}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
