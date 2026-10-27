import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DECISION, colorOf, decideMany } from '../src/plugin/path-policy.mjs';
const W=(path)=>({path,effect:'allow',source:'panel'});
const D=(path)=>({path,effect:'deny',source:'panel'});
const platform='win32';
describe('P0-1/P0-2', () => {
  it('C36 多路径：白名单 + 未列 → approve（不再 fail-open allow）', () => {
    const verdict = decideMany({ targets: ['C:\\work\\a.txt', 'C:\\other\\b.txt'], rules: [W('C:\\work')], platform });
    assert.equal(verdict.decision, DECISION.APPROVE);
  });
  it('C36b 任一 deny → deny', () => {
    const verdict = decideMany({ targets: ['C:\\work\\a.txt', 'C:\\work\\secrets\\b'], rules: [W('C:\\work'), D('C:\\work\\secrets')], platform });
    assert.equal(verdict.decision, DECISION.DENY);
  });
  it('C36c 全部 allow → allow', () => {
    const verdict = decideMany({ targets: ['C:\\work\\a.txt', 'C:\\work\\b.txt'], rules: [W('C:\\work')], platform });
    assert.equal(verdict.decision, DECISION.ALLOW);
  });
  it('P0-2 颜色映射：allow→green / deny→red / approve|pass→yellow', () => {
    assert.equal(colorOf(DECISION.ALLOW), 'green');
    assert.equal(colorOf(DECISION.DENY), 'red');
    assert.equal(colorOf(DECISION.APPROVE), 'yellow');
    assert.equal(colorOf(DECISION.PASS), 'yellow');
  });
});