/**
 * The project-root containment guard, and the escape that had to be named.
 *
 * ## What this suite is actually about
 *
 * `resolveProjectCwd` exists so a caller cannot point a machine at a directory the operator never
 * designated as the project. That guarantee is worth keeping, and the tests below pin it.
 *
 * **But it was measured to make the agent unusable for the one thing a fleet is for.** A `localside`
 * started without `--project` takes *its own* working directory as the root (`bin/w2m-localside.mjs`:
 * `flags.project ?? process.cwd()`), and the packaged DSH starts it from the state directory. Such a
 * machine can then run **only inside that directory** — and a dispatch asking for anywhere else fails as
 * `PATH_INVALID`, which is a warning about a missing executable and says nothing about a missing
 * directory. **Eight dispatches went into establishing that.**
 *
 * So the escape is `allowOutside`: off unless asked for, carried on the offer, and reported in the
 * result. The tests are organised around the three things that must all hold:
 *
 *   1. containment still refuses by default;
 *   2. the escape works when asked for;
 *   3. **the escape is visible** — `outside_project` is reported, so a reader is never left guessing
 *      where the command ran.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';

import { normalizeRelPath, resolveProjectCwd } from '../src/agent/git.mjs';

const ROOT = resolve('/home/u/state');
/** Where `n` levels of `..` actually lead, so an expectation cannot be off by a level. */
const upFromRoot = (n) => resolve(ROOT, ...Array(n).fill('..'));

describe('containment: the default still refuses, because the guard is the point', () => {
  it('resolves a path inside the project root', () => {
    const r = resolveProjectCwd(ROOT, 'local/test');
    assert.equal(r.ok, true);
    assert.equal(r.outside_project, false);
    assert.equal(r.cwd, resolve(ROOT, 'local', 'test'));
  });

  it('treats the root itself as inside', () => {
    for (const rel of ['.', '', undefined, null]) {
      const r = resolveProjectCwd(ROOT, rel);
      assert.equal(r.ok, true, String(rel));
      assert.equal(r.cwd, ROOT);
      assert.equal(r.outside_project, false);
    }
  });

  it('refuses an escape when the caller did not ask for one', () => {
    for (const rel of ['..', '../..', '../../repo', 'a/../../../etc']) {
      const r = resolveProjectCwd(ROOT, rel);
      assert.equal(r.ok, false, rel);
      assert.equal(r.reason, 'CWD_OUTSIDE_PROJECT');
    }
  });

  it('refuses an absolute path, which is an escape however it is spelled', () => {
    for (const rel of ['/etc', '/home/u/repo']) {
      const r = resolveProjectCwd(ROOT, rel);
      assert.equal(r.ok, false, rel);
      assert.equal(r.reason, 'CWD_OUTSIDE_PROJECT');
    }
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    // The reason containment uses `path.relative` rather than a string prefix test: `/home/u/state-other`
    // starts with `/home/u/state` and is NOT inside it.
    const r = resolveProjectCwd(ROOT, '../state-other');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'CWD_OUTSIDE_PROJECT');
  });
});

describe('the escape: reachable, opt-in, and never the default', () => {
  it('lets a caller reach outside when it asks', () => {
    const r = resolveProjectCwd(ROOT, '../../repo', { allowOutside: true });
    assert.equal(r.ok, true);
    assert.equal(r.cwd, resolve(upFromRoot(2), 'repo'));
  });

  it('reports that it went outside, so the result says where it ran', () => {
    // The failure this prevents: a command that quietly ran somewhere other than where the reader assumed.
    const outside = resolveProjectCwd(ROOT, '../../repo', { allowOutside: true });
    assert.equal(outside.outside_project, true);
    const inside = resolveProjectCwd(ROOT, 'local', { allowOutside: true });
    assert.equal(inside.ok, true);
    assert.equal(inside.outside_project, false, 'asking does not make everything "outside"');
  });

  it('is off for every value that is not exactly true', () => {
    // `allowOutside` comes off the wire, so anything truthy-but-not-boolean must not open it.
    for (const v of [undefined, null, false, 0, '', 'true', 1, {}]) {
      const r = resolveProjectCwd(ROOT, '../../repo', { allowOutside: v });
      assert.equal(r.ok, false, JSON.stringify(v));
      assert.equal(r.reason, 'CWD_OUTSIDE_PROJECT');
    }
  });

  it('keeps `cwd_rel` relative and forward-slashed in both outcomes', () => {
    // `cwd_rel` is hashed into `command_hash`; changing its form for one mode would make the same logical
    // command hash differently depending on whether it escaped.
    const inside = resolveProjectCwd(ROOT, 'a/b');
    assert.equal(inside.cwd_rel.includes('\\'), false);
    assert.equal(isAbsolute(inside.cwd_rel), false);
    const outside = resolveProjectCwd(ROOT, '../../repo', { allowOutside: true });
    assert.equal(outside.cwd_rel.includes('\\'), false);
    assert.equal(isAbsolute(outside.cwd_rel), false);
  });
});

describe('normalizeRelPath: what it does and does not do to a path', () => {
  it('leaves `..` alone, which is why the escape works at all', () => {
    // Worth pinning: the escape depends on `..` surviving normalization and being resolved later by
    // `path.resolve`. A future "tidy-up" that collapsed `..` here would break the mechanism silently.
    assert.equal(normalizeRelPath('../../repo'), '../../repo');
  });

  it('strips a leading ./ and collapses redundant separators', () => {
    assert.equal(normalizeRelPath('./a'), 'a');
    assert.equal(normalizeRelPath('a//b'), 'a/b');
    assert.equal(normalizeRelPath('a/b/'), 'a/b');
    assert.equal(normalizeRelPath('a\\b'), 'a/b');
  });

  it('answers `.` for the empty cases', () => {
    for (const v of ['', null, undefined, '/', './']) {
      assert.equal(normalizeRelPath(v), '.', JSON.stringify(v));
    }
  });
});
