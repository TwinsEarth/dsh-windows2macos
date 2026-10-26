/**
 * v1.8.1 — "recently intercepted" behaves like a decision log: rows already covered by a list are collapsed, and the
 * row an operator just added to a list disappears from the list.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { foldIsCoveredBy, folderInLists } from '../src/plugin/gpw.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('GPW recently-intercepted fold (v1.8.1)', () => {
  it('reports which list already covers a folder, including nested folders', () => {
    const lists = { whitelist: ['/work/data'], blacklist: ['/secrets'] };
    assert.equal(folderInLists('/work/data', lists), 'whitelist');
    assert.equal(folderInLists('/work/data/2026/reports', lists), 'whitelist');
    assert.equal(folderInLists('/secrets/keys', lists), 'blacklist');
    assert.equal(folderInLists('/elsewhere', lists), null);
    assert.equal(folderInLists(null, lists), null);
  });

  it('removes the acted-on row and rows inside the folder just added', () => {
    assert.equal(foldIsCoveredBy('/work/data', '/work/data'), true);
    assert.equal(foldIsCoveredBy('/work/data', '/work/data/2026'), true);
    assert.equal(foldIsCoveredBy('/work/data', '/work/database'), false);
    assert.equal(foldIsCoveredBy('', '/work/data'), false);
  });

  it('keeps the client fold in the bundle: covered rows hide behind a toggle', () => {
    const client = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
    assert.match(client, /recentInLists/);
    assert.match(client, /已在名单中/);
    assert.match(client, /showRecentInLists/);
  });

  it('annotates recent rows with folder_in on the state route', () => {
    const source = readFileSync(join(here, '..', 'src', 'plugin', 'gpw.mjs'), 'utf8');
    assert.match(source, /folder_in: folderInLists\(folder, lists\)/);
  });
});
