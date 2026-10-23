/**
 * v1.5.2 — `w2m-bootstrap` (the one-command relay assignment writer).
 *
 * These cases cover the four things that make the tool safe to run on a fresh machine:
 *   * it refuses unusable input instead of writing a config that cannot join;
 *   * the document shape it accepts is exactly `{"relays": [...]}` (or a bare array);
 *   * the profile patch edit touches only the keys the tool owns and keeps everything else;
 *   * a fallback list is written with `relayTemporary: true`, the marker the panel renders red.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultPatchPath,
  parseBootstrapCliArgs,
  relaysFromDocument,
  resolveBootstrapSource,
  writeBootstrapPatch,
} from '../bin/w2m-bootstrap.mjs';

const FLEET_KEY = Buffer.alloc(32, 7).toString('base64url');
const RELAYS = ['http://106.53.197.47:8787/', 'https://relay.example:8787'];

describe('w2m-bootstrap CLI (v1.5.2)', () => {
  it('parses the documented flags and refuses anything it cannot honour', () => {
    const parsed = parseBootstrapCliArgs([
      '--bootstrap', 'https://relays.example/bootstrap',
      '--fleet-key', FLEET_KEY,
      '--profile', 'desktop',
      '--name', 'box-1',
      '--temporary',
    ]);
    assert.equal(parsed.bootstrap, 'https://relays.example/bootstrap');
    assert.equal(parsed.fleetKey, FLEET_KEY);
    assert.equal(parsed.name, 'box-1');
    assert.equal(parsed.temporary, true);
    assert.equal(parsed.profile, 'desktop');
    assert.throws(() => parseBootstrapCliArgs(['--fleet-key', FLEET_KEY]), /--bootstrap/);
    assert.throws(() => parseBootstrapCliArgs(['--bootstrap', 'x', '--fleet-key', 'short']), /fleet key/);
    assert.throws(() => parseBootstrapCliArgs(['--bootstrap', 'x', '--fleet-key', FLEET_KEY, '--nope']), /unknown flag/);
  });

  it('accepts {"relays": [...]} and a bare array, normalizing and deduplicating', () => {
    assert.deepEqual(relaysFromDocument({ relays: RELAYS }).relays, ['http://106.53.197.47:8787', 'https://relay.example:8787']);
    assert.deepEqual(relaysFromDocument(['http://a:1', 'http://a:1']).relays, ['http://a:1']);
    assert.equal(relaysFromDocument({ relays: [] }).ok, false);
    assert.equal(relaysFromDocument({ relays: ['ftp://x'] }).ok, false);
    assert.equal(relaysFromDocument({ nope: true }).ok, false);
  });

  it('resolves a JSON document and a file path the same way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-bootstrap-json-'));
    try {
      const file = join(dir, 'relays.json');
      writeFileSync(file, JSON.stringify({ relays: RELAYS }), 'utf8');
      const fromFile = await resolveBootstrapSource({ bootstrap: file, fleetKey: FLEET_KEY, operatorKeyPath: null });
      assert.equal(fromFile.ok, true);
      assert.equal(fromFile.relays.length, 2);
      const inline = await resolveBootstrapSource({ bootstrap: JSON.stringify(['http://only:8787']), fleetKey: FLEET_KEY, operatorKeyPath: null });
      assert.equal(inline.ok, true);
      assert.deepEqual(inline.relays, ['http://only:8787']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes relayUrls/fleetKey/autoStartAgent and keeps unmanaged keys in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-bootstrap-patch-'));
    try {
      const patch = join(dir, 'cordis.patch.yml');
      writeFileSync(patch, [
        '- id: other',
        '  config:',
        '    keep: me',
        '- id: w2m',
        '  config:',
        '    autoStartAgent: false',
        '    rabbitUrl: http://old:8787',
        '    operatorToken: keep-this',
        '- id: ui-theme',
        '  config:',
        '    x: 1',
      ].join('\n') + '\n', 'utf8');
      const written = writeBootstrapPatch(patch, {
        relays: RELAYS,
        fleetKey: FLEET_KEY,
        relayUrl: RELAYS[0],
        temporary: true,
        machineName: 'box-1',
      });
      assert.equal(written.ok, true);
      const text = readFileSync(patch, 'utf8');
      assert.match(text, /rabbitUrl: http:\/\/106\.53\.197\.47:8787/);
      assert.match(text, /relayUrls:\n\s+- http:\/\/106\.53\.197\.47:8787\n\s+- https:\/\/relay\.example:8787/);
      assert.match(text, new RegExp(`fleetKey: '${FLEET_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
      assert.match(text, /autoStartAgent: true/);
      assert.match(text, /relayTemporary: true/);
      assert.match(text, /operatorToken: keep-this/, 'unmanaged keys are not dropped');
      assert.match(text, /- id: other[\s\S]*keep: me[\s\S]*- id: w2m/, 'other rows are untouched');
      assert.match(text, /- id: ui-theme[\s\S]*x: 1/, 'following rows are untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a patch without the w2m row or without a config block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-bootstrap-badpatch-'));
    try {
      const noRow = join(dir, 'a.yml');
      writeFileSync(noRow, '- id: other\n  config:\n    x: 1\n', 'utf8');
      assert.equal(writeBootstrapPatch(noRow, { relays: RELAYS, fleetKey: FLEET_KEY, relayUrl: RELAYS[0], temporary: false, machineName: null }).ok, false);
      const noConfig = join(dir, 'b.yml');
      writeFileSync(noConfig, '- id: w2m\n  disabled: false\n', 'utf8');
      assert.equal(writeBootstrapPatch(noConfig, { relays: RELAYS, fleetKey: FLEET_KEY, relayUrl: RELAYS[0], temporary: false, machineName: null }).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the profile patch under DSH_HOME when that is set', () => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = join('C:\\', 'tmp-dsh-home');
    try {
      assert.equal(defaultPatchPath('desktop'), join('C:\\', 'tmp-dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});
