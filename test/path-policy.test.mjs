/** GPW 继承语义单测：子树许可、deny 优先、例外通道、敏感底线、删除需父写。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DECISION,
  assertRuleWritable,
  canonicalKey,
  decideOperation,
  decidePath,
  inside,
} from '../src/plugin/path-policy.mjs';

const W = (path, extra = {}) => ({ path, effect: 'allow', source: 'panel', ...extra });
const D = (path, extra = {}) => ({ path, effect: 'deny', source: 'panel', ...extra });
const platform = 'win32';

describe('词法规范化与包含', () => {
  it('path prefix normalization', () => {
    assert.equal(canonicalKey('\\\\?\\C:\\Work\\sub\\', { platform }), 'c:\\work\\sub');
    assert.equal(canonicalKey('C:/Work/Sub', { platform }), 'c:\\work\\sub');
    assert.equal(canonicalKey('C:\\work. \\sub', { platform }), 'c:\\work\\sub');
  });
  it('分段包含：C:\\work 不含 C:\\workshop；自反', () => {
    assert.equal(inside('c:\\work\\a', 'c:\\work', platform), true);
    assert.equal(inside('c:\\workshop\\a', 'c:\\work', platform), false);
    assert.equal(inside('c:\\work', 'c:\\work', platform), true);
    assert.equal(inside('c:\\work', 'c:\\work\\sub', platform), false);
  });
  it('U+212A 不被折成 k（禁 toLowerCase）', () => {
    assert.equal(canonicalKey('C:\\wor\u212A\\x', { platform }), 'c:\\wor\u212a\\x');
    assert.equal(inside('c:\\wor\u212a\\x', 'c:\\work', platform), false);
  });
});

describe('白名单子树继承', () => {
  it('父白名单覆盖任意深度后代；C:\\workshop 不命中', () => {
    const rules = [W('C:\\work')];
    assert.equal(decidePath({ target: 'C:\\work\\a\\b.txt', rules, platform }).decision, DECISION.ALLOW);
    assert.equal(decidePath({ target: 'C:\\workshop\\a.txt', rules, platform }).decision, DECISION.PASS);
  });
  it('更深的 allow 归因到更深条目，但结果不变', () => {
    const rules = [W('C:\\work'), W('C:\\work\\reports')];
    const verdict = decidePath({ target: 'C:\\work\\reports\\q1.csv', rules, platform });
    assert.equal(verdict.decision, DECISION.ALLOW);
    assert.equal(verdict.rule.path, 'C:\\work\\reports');
  });
});

describe('黑名单与例外', () => {
  it('黑父 + 白子（无例外）→ deny', () => {
    const rules = [W('C:\\work'), D('C:\\work\\secrets')];
    assert.equal(decidePath({ target: 'C:\\work\\secrets\\k.pem.txt', rules, platform }).decision, DECISION.DENY);
  });
  it('严格更深的配置例外 → approve（不是 allow）', () => {
    const rules = [D('C:\\work\\secrets')];
    const exceptions = [{ path: 'C:\\work\\secrets\\public', effect: 'allow', source: 'config', expiresAt: Date.now() + 60000 }];
    const verdict = decidePath({ target: 'C:\\work\\secrets\\public\\a.txt', rules, exceptions, platform });
    assert.equal(verdict.decision, DECISION.APPROVE);
    assert.equal(verdict.reason, 'EXCEPTION_REQUIRES_APPROVAL');
  });
  it('同深度例外无效', () => {
    const rules = [D('C:\\work\\secrets')];
    const exceptions = [{ path: 'C:\\work\\secrets', effect: 'allow', source: 'config' }];
    assert.equal(decidePath({ target: 'C:\\work\\secrets\\a', rules, exceptions, platform }).decision, DECISION.DENY);
  });
  it('黑名单内不能写白名单条目', () => {
    const result = assertRuleWritable({ path: 'C:\\work\\secrets\\public', rules: [D('C:\\work\\secrets')], platform });
    assert.equal(result.code, 'RULE_CONFLICT_DENY_ANCESTOR');
  });
});

describe('敏感底线与删除语义', () => {
  it('敏感路径不可被白名单覆盖', () => {
    const rules = [W('C:\\work')];
    for (const target of ['C:\\work\\.ssh\\id_rsa', 'C:\\work\\.env', 'C:\\work\\server.key', 'C:\\work\\gpw-folders.json']) {
      assert.equal(decidePath({ target, rules, platform }).decision, DECISION.DENY, target);
    }
  });
  it('删除需要父目录写权限', () => {
    const rules = [W('C:\\work\\sub\\a.txt')];
    const verdict = decideOperation({ target: 'C:\\work\\sub\\a.txt', operation: 'delete', rules, platform });
    assert.equal(verdict.decision, DECISION.APPROVE);
    assert.equal(verdict.reason, 'PARENT_WRITE_REQUIRED');
  });
  it('父目录也在白名单时删除放行', () => {
    const rules = [W('C:\\work')];
    assert.equal(decideOperation({ target: 'C:\\work\\sub\\a.txt', operation: 'delete', rules, platform }).decision, DECISION.ALLOW);
  });
});
