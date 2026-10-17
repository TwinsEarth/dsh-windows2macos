/**
 * The three channels, and the four facts a UI needs from them.
 *
 * Every decision here comes from \`decideUpdate\` -- these tests assert the CHANNEL SELECTION, and one of them asserts
 * that the selection does not disagree with the rule that does the deciding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannels } from '../src/plugin/update-channels.mjs';

const rel = (v, prerelease = false) => ({ ok: true, tag: 'v' + v, version: v, prerelease });

describe('channel resolution', () => {
  it('reports a missing beta as null instead of substituting the stable one', () => {
    const out = resolveChannels({ stable: rel('1.1.18'), beta: null, currentVersion: '1.1.17' });
    assert.equal(out.channels.beta.available, null, 'a beta button must be disable-able');
    assert.equal(out.channels.stable.available, '1.1.18');
    assert.equal(out.channels.stable.decision.action, 'install');
    assert.deepEqual(out.latest, { version: '1.1.18', channel: 'stable' });
  });

  it('picks beta as latest only when it really is the newer SemVer version', () => {
    const betaNewer = resolveChannels({ stable: rel('1.1.17'), beta: rel('1.1.18-beta.1', true), currentVersion: '1.1.16' });
    assert.equal(betaNewer.channels.beta.available, '1.1.18-beta.1');
    assert.equal(betaNewer.latest.channel, 'beta');

    const stableNewer = resolveChannels({ stable: rel('1.1.20'), beta: rel('1.1.18-beta.1', true), currentVersion: '1.1.16' });
    assert.deepEqual(stableNewer.latest, { version: '1.1.20', channel: 'stable' });
  });

  it('a stable channel never installs a prerelease, even if one is newer', () => {
    const out = resolveChannels({ stable: rel('1.1.18-beta.1', true), beta: null, currentVersion: '1.1.17' });
    assert.equal(out.channels.stable.decision.action, 'skip');
    assert.match(out.channels.stable.decision.reason, /prerelease/);
  });

  it('agrees with decideUpdate about the current version being newest', () => {
    const out = resolveChannels({ stable: rel('1.1.17'), beta: rel('1.1.18-beta.1', true), currentVersion: '1.1.18' });
    assert.equal(out.channels.stable.decision.action, 'skip');
    assert.equal(out.channels.beta.decision.action, 'skip', '1.1.18 outranks 1.1.18-beta.1');
    assert.equal(out.current_version, '1.1.18');
  });
});
