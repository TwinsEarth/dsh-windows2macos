/** P0-1/P0-2 适配层测试：C19/C24/C13/C01/C36 + 颜色/预算短路。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCall } from '../src/plugin/gpw-policy-adapter.mjs';

const platform = 'win32';
const call = (paths, over = {}) => evaluateCall({ paths, whitelist: [], blacklist: [], platform, ...over });

describe('P0-1 单一匹配器（C19/C24/C13/C01）', () => {
  it('C19 C:\\workshop 不被 C:\\work 命中 → pass/yellow', () => {
    const r = call(['C:\\workshop\\a.txt'], { whitelist: ['C:\\work'] });
    assert.equal(r.decision, 'pass');
    assert.equal(r.color, 'yellow');
    assert.equal(r.skipBudget, false);
  });
  it('C24 C:\\WindowsApps 不被 C:\\Windows 误杀 → pass（不是 red）', () => {
    const r = call(['C:\\WindowsApps\\x.exe'], { blacklist: ['C:\\Windows'] });
    assert.equal(r.color, 'yellow');
    assert.notEqual(r.decision, 'deny');
  });
  it('C13 U+212A 不被折叠 → pass', () => {
    const r = call(['C:\\wor\u212A\\x'], { whitelist: ['C:\\work'] });
    assert.equal(r.decision, 'pass');
  });
  it('C01 \\\\?\\C:\\work\\sub 归一后命中白名单 → green + skipBudget', () => {
    const r = call(['\\\\?\\C:\\work\\sub\\a.txt'], { whitelist: ['C:\\work'] });
    assert.equal(r.decision, 'allow');
    assert.equal(r.color, 'green');
    assert.equal(r.skipBudget, true);
  });
});

describe('P0-2 颜色层短路（C36 与预算）', () => {
  it('C36 白名单 + 未列 同一调用 → approve/yellow（不再 fail-open allow）', () => {
    const r = call(['C:\\work\\a.txt', 'C:\\other\\b.txt'], { whitelist: ['C:\\work'] });
    assert.equal(r.decision, 'approve');
    assert.equal(r.color, 'yellow');
    assert.equal(r.skipBudget, false);
  });
  it('全部命中白名单 → green + skipBudget=true（不进预算）', () => {
    const r = call(['C:\\work\\a.txt', 'C:\\work\\sub\\b.txt'], { whitelist: ['C:\\work'] });
    assert.equal(r.decision, 'allow');
    assert.equal(r.skipBudget, true);
  });
  it('任一黑名单命中 → deny/red', () => {
    const r = call(['C:\\work\\a.txt', 'C:\\work\\secrets\\k.txt'], { whitelist: ['C:\\work'], blacklist: ['C:\\work\\secrets'] });
    assert.equal(r.decision, 'deny');
    assert.equal(r.color, 'red');
  });
  it('workspace 命中但无白名单条目 → green + skipBudget', () => {
    const r = call(['E:\\proj\\src\\a.ts'], { workspace: 'E:\\proj' });
    assert.equal(r.color, 'green');
    assert.equal(r.skipBudget, true);
  });
  it('颜色只做渲染：decision 字段与 color 一一对应', () => {
    const map = { allow: 'green', approve: 'yellow', pass: 'yellow', deny: 'red' };
    for (const [paths, over] of [
      [['C:\\work\\a'], { whitelist: ['C:\\work'] }],
      [['C:\\x\\a'], {}],
      [['C:\\work\\secrets\\a'], { whitelist: ['C:\\work'], blacklist: ['C:\\work\\secrets'] }],
    ]) {
      const r = call(paths, over);
      assert.equal(r.color, map[r.decision]);
    }
  });
});
