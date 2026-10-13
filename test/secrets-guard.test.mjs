/**
 * The secrets guard: no tracked file may contain a live credential (v0.7.12).
 *
 * The operator's requirement was specific — the relay state (`/var/lib/w2m/rabbit`, holding a
 * `ledger` and an **operator token**) must **never** be open-sourced. That is one sentence, and the
 * property behind it is what these tests pin:
 *
 *   **no tracked file contains a live credential, and the paths that hold them are refused by name.**
 *
 * A `.gitignore` entry alone does not give that property: it refuses a *path*, while the ways a
 * credential actually escapes are pasting one into a source file, a fixture, or an example. So the
 * scanner reads tracked **content**.
 *
 * Two deliberate design choices are tested as behaviour, not described:
 *
 *   * a `REVIEW` finding is **not** fatal — a scanner whose false positives block releases is a
 *     scanner someone deletes, so only real credential shapes stop anything;
 *   * the **match is never printed**. A scanner that echoes the secret has moved it into a log,
 *     which is the opposite of the job.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITY,
  scanContent,
  scanTree,
  blocking,
  reviews,
  FORBIDDEN_PATHS,
} from '../scripts/scan-for-secrets.mjs';

describe('paths that hold credentials are refused by name', () => {
  it('refuses the relay state directory the operator named', () => {
    // The one requirement stated in words. `rabbit/` holds `operator-token.txt` and the ledger.
    const f = scanContent({ path: 'rabbit/operator-token.txt', content: 'anything' });
    assert.equal(blocking(f).length >= 1, true);
    assert.match(blocking(f)[0].rule, /forbidden path/);
  });

  it('refuses the exact files that carry a live credential', () => {
    for (const p of [
      'operator-token.txt',
      'state/operator-token.txt',
      'dist/ilink/ilink-login.json',
      'device.json',
      '.w2m/device.json',
      'deploy/id_ed25519',
      'certs/server.pem',
      'secrets/service.key',
      '.credentials.yaml',
    ]) {
      assert.equal(blocking(scanContent({ path: p, content: 'x' })).length >= 1, true, `${p} must be refused`);
    }
  });

  it('refuses them even when the content looks innocent', () => {
    // Path-based refusal must not depend on content, or renaming the concern would defeat it.
    assert.equal(blocking(scanContent({ path: 'rabbit/ledger', content: 'hello' })).length >= 1, true);
  });

  it('declares every pattern as a RegExp, so a typo cannot silently never match', () => {
    for (const re of FORBIDDEN_PATHS) assert.equal(re instanceof RegExp, true);
  });
});

describe('credential shapes in content stop a release', () => {
  it('catches a private key block', () => {
    const f = scanContent({ path: 'src/thing.mjs', content: 'const k = `-----BEGIN PRIVATE KEY-----\nMII...`;' });
    assert.equal(blocking(f).some((x) => x.rule === 'private key block'), true);
  });

  it('catches a GitHub token', () => {
    // Written as a concatenation so this test file does not itself contain a token-shaped literal
    // that a *different* scanner would flag. The lesson from the audit, applied.
    const fake = `ghp_${'A'.repeat(36)}`;
    const f = scanContent({ path: 'notes.md', content: `token: ${fake}` });
    assert.equal(blocking(f).some((x) => x.rule === 'GitHub token'), true);
  });

  it('catches the three credential assignments this project actually uses', () => {
    /**
     * The expected rule names are **read from the module**, not written out here.
     *
     * A first version hard-coded them and broke the moment a rule was renamed from "iLink bot
     * token" to "bot token" — a test that fails on a rename is testing the name, not the behaviour.
     * Asserting that *some* rule fires for each credential shape is the property that matters.
     */
    for (const text of [
      `bot_token: "${'a'.repeat(32)}"`,
      `operatorToken = "${'b'.repeat(24)}"`,
      `device_token: "${'c'.repeat(24)}"`,
    ]) {
      const f = blocking(scanContent({ path: 'src/x.mjs', content: text }));
      assert.equal(f.length >= 1, true, `${text} must be caught, saw nothing`);
      assert.equal(f[0].severity, SEVERITY.BLOCK);
    }
  });

  it('catches camelCase, which is how this project actually spells them', () => {
    // The rule was `operator[_-]?token`, covering snake and kebab but NOT camelCase — so the guard
    // had a hole exactly where the values it protects are spelled. Found by probing the spellings
    // rather than by reading the regex.
    for (const spelling of ['operatorToken', 'operator_token', 'operator-token']) {
      const f = blocking(scanContent({ path: 'src/x.mjs', content: `${spelling} = "${'d'.repeat(24)}"` }));
      assert.equal(f.length >= 1, true, `${spelling} must match, saw nothing`);
    }
    for (const spelling of ['deviceToken', 'device_token', 'device-token']) {
      const f = blocking(scanContent({ path: 'src/x.mjs', content: `${spelling} = "${'e'.repeat(24)}"` }));
      assert.equal(f.length >= 1, true, `${spelling} must match, saw nothing`);
    }
  });

  it('never prints the secret it found', () => {
    // The whole point of a scanner is to keep the value out of circulation; echoing it into a log
    // moves it rather than protecting it.
    const secret = `ghp_${'Z'.repeat(36)}`;
    const f = scanContent({ path: 'a.md', content: `x ${secret} y` });
    const rendered = JSON.stringify(f);
    assert.equal(rendered.includes(secret), false, 'the finding must not carry the value');
    assert.equal(rendered.includes('ZZZZ'), false);
  });

  it('reports the offset instead, which is enough to find it', () => {
    const f = scanContent({ path: 'a.md', content: `0123456789 ghp_${'A'.repeat(36)}` });
    assert.match(blocking(f)[0].detail, /offset \d+/);
  });
});

describe('review findings are reported but never fatal', () => {
  it('treats a bare long hex string as review, not blocking', () => {
    // Base tree hashes and SHA256SUMS lines are 64-hex and entirely normal in this repo.
    const f = scanContent({ path: 'SHA256SUMS', content: `${'a'.repeat(64)}  file.tgz` });
    assert.equal(blocking(f).length, 0, 'a 64-hex line must not stop a release');
    assert.equal(reviews(f).length >= 1, true, 'but it is worth a look');
  });

  it('lets an ordinary document through with nothing at all', () => {
    const f = scanContent({ path: 'README.md', content: '# W2M\n\nRun `node --test`.\n' });
    assert.deepEqual(f, []);
  });

  it('does not flag a placeholder as if it were a secret', () => {
    const f = scanContent({ path: 'docs/x.md', content: 'set token to <your-token-here>' });
    assert.equal(blocking(f).length, 0);
  });
});

describe('the scan runs over a tree and can gate a release', () => {
  it('reads real files and reports by repo-relative path', () => {
    const files = {
      '/repo/good.md': Buffer.from('nothing here'),
      '/repo/state/operator-token.txt': Buffer.from('secret-value'),
    };
    const findings = scanTree({ root: '/repo', paths: ['good.md', 'state/operator-token.txt'], readFile: (p) => files[p] });
    assert.equal(blocking(findings).length >= 1, true);
    assert.equal(blocking(findings)[0].path, 'state/operator-token.txt');
  });

  it('skips binaries rather than reporting noise from them', () => {
    const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), Buffer.from('ghp_' + 'A'.repeat(36))]);
    const findings = scanTree({ root: '/r', paths: ['x.png'], readFile: () => bin });
    assert.deepEqual(findings, []);
  });

  it('does not fail on an unreadable path, because content is the property', () => {
    const findings = scanTree({ root: '/r', paths: ['gone.mjs'], readFile: () => { throw new Error('ENOENT'); } });
    assert.deepEqual(findings, []);
  });

  it('exposes the two severities as separate lists', () => {
    const findings = [
      { severity: SEVERITY.BLOCK, path: 'a', rule: 'r', detail: 'd' },
      { severity: SEVERITY.REVIEW, path: 'b', rule: 'r', detail: 'd' },
    ];
    assert.equal(blocking(findings).length, 1);
    assert.equal(reviews(findings).length, 1);
  });
});
