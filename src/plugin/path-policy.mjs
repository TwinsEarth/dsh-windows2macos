/**
 * GPW 路径继承语义（单一判定点）。
 *
 * 白名单 = 子树许可（向下任意深度、不向上、分段比较、自反）。
 * 黑名单 = 子树拒绝，默认优先；同深度 deny 胜。
 * 父黑名单下的子目录默认 deny；唯一通道是显式例外：
 *   严格更深、仅配置来源、带 TTL、效果 approve（每次人工确认）。
 * 删除还需父目录写权限；敏感底线不可被白名单覆盖。
 * 未在名单内 → pass（问人），绝不自动 allow。
 */

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'credentials']);
const SENSITIVE_EXT = /\.(pem|key|pfx|p12|jks|kdbx)$/i;
const SENSITIVE_NAMES = new Set(['.env', 'id_rsa', 'id_ed25519', 'wallet.dat', 'login data', 'gpw-folders.json', 'gpw-folders.json.key']);

export const DECISION = Object.freeze({ ALLOW: 'allow', DENY: 'deny', APPROVE: 'approve', PASS: 'pass' });

const isWindows = (platform) => platform === 'win32';

/** 词法规范化：别名、尾点/空格、. / ..、分隔符；Win32 只折 ASCII。 */
export function canonicalKey(raw, { platform = process.platform } = {}) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '' || text.includes('\u0000')) return null;
  const win = isWindows(platform);
  if (win) {
    text = text.replace(/^\\\\[?.]\\UNC\\(.*)$/i, '\\\\$1').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
    text = text.replace(/\//g, '\\');
  }
  const segments = [];
  const drive = win ? /^([A-Za-z]):(.*)$/.exec(text) : null;
  let rest = text;
  if (drive !== null) {
    if (drive[2].startsWith('\\') === false) return null; // C:foo 盘符相对不可判定
    rest = drive[2];
  }
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    let segment = part;
    if (win) segment = segment.replace(/[. ]+$/g, ''); // Win32 去尾点/空格
    if (segment !== '') segments.push(win ? segment.replace(/[A-Z]/g, (c) => c.toLowerCase()) : segment);
  }
  if (win) return (drive === null ? '' : drive[1].toLowerCase() + ':\\') + segments.join('\\');
  return '/' + segments.join('/');
}

function segmentsOf(key, platform) {
  if (typeof key !== 'string' || key === '') return null;
  if (isWindows(platform)) {
    const match = /^([A-Za-z]):\\(.*)$/.exec(key);
    return match === null ? null : [match[1] + ':', ...match[2].split('\\').filter(Boolean)];
  }
  return key.split('/').filter(Boolean);
}

/** 分段包含：自反；C:\work 不含 C:\workshop。 */
export function inside(targetKey, rootKey, platform = process.platform) {
  const target = segmentsOf(targetKey, platform);
  const root = segmentsOf(rootKey, platform);
  if (target === null || root === null || target.length < root.length) return false;
  for (let index = 0; index < root.length; index += 1) {
    if (target[index] !== root[index]) return false;
  }
  return true;
}

/** 敏感底线：段名/文件名/扩展名命中即 deny，任何白名单不能覆盖。 */
export function sensitiveMatch(raw) {
  const lowered = String(raw).toLowerCase();
  for (const segment of lowered.split(/[\\/]+/)) {
    if (SENSITIVE_SEGMENTS.has(segment)) return { hit: true, reason: 'SENSITIVE_SEGMENT', segment };
    if (SENSITIVE_NAMES.has(segment)) return { hit: true, reason: 'SENSITIVE_NAME', segment };
    if (SENSITIVE_EXT.test(segment)) return { hit: true, reason: 'SENSITIVE_EXTENSION', segment };
  }
  return { hit: false };
}

function ruleDepth(rule, target, platform) {
  const root = canonicalKey(rule.path, { platform });
  if (root === null || !inside(target, root, platform)) return -1;
  return segmentsOf(root, platform).length;
}

/**
 * 判定。规则：{path, effect:'allow'|'deny', source:'config'|'panel', expiresAt?, ops?}
 * @returns {{decision: string, source: string, reason: string, rule?: object}}
 */
export function decidePath({ target, rules = [], exceptions = [], workspace = null, platform = process.platform, now = Date.now() }) {
  const key = canonicalKey(target, { platform });
  if (key === null) return { decision: DECISION.PASS, source: 'canonicalize', reason: 'UNRESOLVABLE' };

  const sensitive = sensitiveMatch(target);
  if (sensitive.hit) return { decision: DECISION.DENY, source: 'floor', reason: sensitive.reason };

  const covering = [];
  for (const rule of rules) {
    const depth = ruleDepth(rule, key, platform);
    if (depth >= 0) covering.push({ rule, depth });
  }
  const denies = covering.filter((entry) => entry.rule.effect === 'deny');
  if (denies.length > 0) {
    const deepestDeny = Math.max(...denies.map((entry) => entry.depth));
    const exception = exceptions.find((entry) => entry.source === 'config'
      && (entry.expiresAt === undefined || entry.expiresAt > now)
      && ruleDepth(entry, key, platform) > deepestDeny);
    if (exception !== undefined) {
      return { decision: DECISION.APPROVE, source: 'exception', reason: 'EXCEPTION_REQUIRES_APPROVAL', rule: exception };
    }
    return { decision: DECISION.DENY, source: 'rule', reason: 'DENY_RULE', rule: denies.sort((a, b) => b.depth - a.depth)[0].rule };
  }

  const allows = covering.filter((entry) => entry.rule.effect === 'allow').sort((a, b) => b.depth - a.depth);
  if (allows.length > 0) return { decision: DECISION.ALLOW, source: 'rule', reason: 'ALLOW_RULE', rule: allows[0].rule };
  if (workspace !== null) {
    const root = canonicalKey(workspace, { platform });
    if (root !== null && inside(key, root, platform)) return { decision: DECISION.ALLOW, source: 'workspace', reason: 'ALLOW_WORKSPACE' };
  }
  return { decision: DECISION.PASS, source: 'unlisted', reason: 'NO_RULE' };
}

/**
 * 操作维度：delete/rename 需要父目录写权限。
 * @param {{target: string, operation: 'read'|'write'|'delete'|'exec', ...decidePathInput}} input
 */
export function decideOperation(input) {
  const verdict = decidePath(input);
  if (verdict.decision !== DECISION.ALLOW || input.operation !== 'delete') return verdict;
  const parent = canonicalKey(input.target, { platform: input.platform });
  if (parent === null) return verdict;
  const parentPath = parent.replace(/[\\/][^\\/]+$/, '');
  const parentVerdict = decidePath({ ...input, target: parentPath, operation: 'write' });
  if (parentVerdict.decision !== DECISION.ALLOW) {
    return { decision: DECISION.APPROVE, source: 'parent', reason: 'PARENT_WRITE_REQUIRED', parent: parentVerdict };
  }
  return verdict;
}

/** 写入期：不允许在黑名单子树内添加白名单（避免静默开洞）。 */
export function assertRuleWritable({ path, rules = [], platform = process.platform }) {
  const key = canonicalKey(path, { platform });
  if (key === null) return { ok: false, code: 'RULE_PATH_INVALID' };
  for (const rule of rules) {
    if (rule.effect !== 'deny') continue;
    const depth = ruleDepth(rule, key, platform);
    if (depth >= 0) return { ok: false, code: 'RULE_CONFLICT_DENY_ANCESTOR', detail: { ancestor: rule.path } };
  }
  return { ok: true };
}

/**
 * 多路径聚合（C36 语义）：任一 deny → deny；全部 allow → allow；否则 approve。
 * 现状 gpw 的 classifyToolCall 是"任一 allow 就 allow"（fail-open），这里是修正版。
 */
export function decideMany({ targets, ...input }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { decision: DECISION.PASS, source: 'unlisted', reason: 'NO_PATHS', results: [] };
  }
  const results = targets.map((target) => decidePath({ ...input, target }));
  if (results.some((entry) => entry.decision === DECISION.DENY)) {
    return { decision: DECISION.DENY, source: 'aggregate', reason: 'ANY_DENY', results };
  }
  if (results.every((entry) => entry.decision === DECISION.PASS)) {
    return { decision: DECISION.PASS, source: 'aggregate', reason: 'NO_RULE', results };
  }
  if (results.every((entry) => entry.decision === DECISION.ALLOW)) {
    return { decision: DECISION.ALLOW, source: 'aggregate', reason: 'ALL_ALLOW', results };
  }
  return { decision: DECISION.APPROVE, source: 'aggregate', reason: 'NEEDS_APPROVAL', results };
}

/** P0-2：判定 → 颜色（颜色只做渲染，不参与判定）。 */
export function colorOf(decision) {
  if (decision === DECISION.ALLOW) return 'green';
  if (decision === DECISION.DENY) return 'red';
  return 'yellow';
}

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * FS 层：对最长已存在前缀取 realpath，剩余不存在尾部按词法拼回。
 * 返回 { real, key, rest }；无法解析时 real=null（调用方按更严处理）。
 */
export function realpathPrefix(raw, { platform = process.platform } = {}) {
  const key = canonicalKey(raw, { platform });
  if (key === null) return null;
  let probe = key;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      const normalized = canonicalKey(real, { platform });
      if (normalized === null) return { real: null, key, rest: key };
      const rest = key.slice(probe.length);
      return { real, key: normalized + rest, rest };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return { real: null, key, rest: key };
      probe = parent;
    }
  }
}

const SEVERITY = { allow: 0, pass: 1, approve: 2, deny: 3 };

/** 词法与 FS 两层取更严（更严者胜）；FS 不可用则用词法。 */
export function decidePathSecure(input) {
  const lexical = decidePath(input);
  const resolved = realpathPrefix(input.target, { platform: input.platform ?? process.platform });
  if (resolved === null || resolved.real === null || resolved.key === canonicalKey(input.target, { platform: input.platform ?? process.platform })) return lexical;
  const real = decidePath({ ...input, target: resolved.key });
  return SEVERITY[real.decision] > SEVERITY[lexical.decision] ? real : lexical;
}
