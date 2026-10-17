/**
 * The beta channel's source, with an injected fetch.
 *
 * The two behaviours that matter are both about what it REFUSES to do: it must not pick a stable release when only
 * stables exist (a beta button that silently means "stable" is a lie in the UI), and it must not pick a draft.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrereleaseRelease } from '../src/plugin/update-source.mjs';

const respond = (list, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => list,
  text: async () => JSON.stringify(list),
});

describe('the beta channel source', () => {
  it('picks the highest prerelease by SemVer and ignores drafts and stables', async () => {
    const out = await fetchPrereleaseRelease({
      repo: 'o/r',
      fetchImpl: respond([
        { tag_name: 'v1.1.18-beta.1', prerelease: true, draft: false, html_url: 'x' },
        { tag_name: 'v1.1.19-beta.2', prerelease: true, draft: false, html_url: 'y' },
        { tag_name: 'v1.2.0', prerelease: false, draft: false },
        { tag_name: 'v1.3.0-beta.9', prerelease: true, draft: true },
      ]),
    });
    assert.equal(out.ok, true);
    assert.equal(out.tag, 'v1.1.19-beta.2', 'the highest real prerelease wins');
    assert.equal(out.prerelease, true);
    assert.ok(out.version, 'the version must be parsed, not left as a raw tag');
  });

  it('reports an empty beta channel instead of falling back to stable, and names HTTP failures', async () => {
    const empty = await fetchPrereleaseRelease({ repo: 'o/r', fetchImpl: respond([{ tag_name: 'v1.2.0', prerelease: false }]) });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'NO_PRERELEASE');

    const limited = await fetchPrereleaseRelease({ repo: 'o/r', fetchImpl: respond([], 403) });
    assert.equal(limited.ok, false);
    assert.equal(limited.code, 'RATE_LIMITED');
  });
});
