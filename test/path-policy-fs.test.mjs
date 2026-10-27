import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decidePath, decidePathSecure, realpathPrefix } from '../src/plugin/path-policy.mjs';

describe('FS 层 realpathPrefix', () => {
  it('已存在目录解析出真实路径；不存在尾部拼回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-rp-'));
    writeFileSync(join(dir, 'a.txt'), 'x');
    const rp = realpathPrefix(join(dir, 'a.txt'));
    assert.ok(rp !== null);
    assert.ok(rp.key.toLowerCase().includes('a.txt'));
  });

  it('decidePathSecure 与词法判定一致（普通路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-rp2-'));
    // The rule names the RESOLVED directory: decidePathSecure resolves the target but not the
    // rule text, so a /var -> /private/var (macOS) or an 8.3 symlink (Windows) rule would never
    // match. Real deployments should register real paths for the same reason.
    const ruleDir = realpathPrefix(dir)?.key ?? dir;
    const rules = [{ path: ruleDir, effect: 'allow', source: 'panel' }];
    const target = join(dir, 'a.txt');
    const platform = process.platform;
    assert.equal(
      decidePathSecure({ target, rules, platform }).decision,
      decidePath({ target, rules, platform }).decision,
    );
  });
});
