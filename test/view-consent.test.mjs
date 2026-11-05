import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { viewAllowed } from '../src/agent/view/consent.mjs';

describe('remote-view target consent', () => {
  it('denies when the machine has not enabled remote view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-view-consent-'));
    assert.equal(viewAllowed(dir, {}), false);
  });

  it('allows when the local settings file enables remote view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-view-consent-'));
    writeFileSync(join(dir, 'remote-view.json'), JSON.stringify({ enabled: true }));
    assert.equal(viewAllowed(dir, {}), true);
  });

  it('reads the plugin root when the agent state directory is localside/', () => {
    const root = mkdtempSync(join(tmpdir(), 'w2m-view-consent-'));
    const agentDir = join(root, 'localside');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(root, 'remote-view.json'), JSON.stringify({ enabled: true }));
    assert.equal(viewAllowed(agentDir, {}), true);
  });

  it('lets W2M_VIEW_ALLOW override the file in both directions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-view-consent-'));
    writeFileSync(join(dir, 'remote-view.json'), JSON.stringify({ enabled: false }));
    assert.equal(viewAllowed(dir, { W2M_VIEW_ALLOW: '1' }), true);
    writeFileSync(join(dir, 'remote-view.json'), JSON.stringify({ enabled: true }));
    assert.equal(viewAllowed(dir, { W2M_VIEW_ALLOW: '0' }), false);
  });
});
