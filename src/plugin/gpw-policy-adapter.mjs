/**
 * P0-1 / P0-2 适配层：gpw-colors 的唯一调用入口。
 *
 * 规则：白名单 = allow 规则，黑名单 = deny 规则；判定只走 path-policy.decideMany
 * （分段比较、deny 优先、最长前缀、例外 approve）。颜色由 colorOf 渲染，
 * 不参与判定；白名单/工作区全部命中时 skipBudget=true（不进 10 次/分预算）。
 */
import { DECISION, colorOf, decideMany } from './path-policy.mjs';

export function evaluateCall(input) {
  const platform = input?.platform ?? process.platform;
  const paths = Array.isArray(input?.paths) ? input.paths : [];
  const rules = [];
  for (const path of input?.whitelist ?? []) rules.push({ path, effect: 'allow', source: 'panel' });
  for (const path of input?.blacklist ?? []) rules.push({ path, effect: 'deny', source: 'panel' });
  const verdict = decideMany({
    targets: paths,
    rules,
    exceptions: input?.exceptions ?? [],
    workspace: input?.workspace ?? null,
    platform,
  });
  return {
    decision: verdict.decision,
    color: colorOf(verdict.decision),
    skipBudget: verdict.decision === DECISION.ALLOW,
    reason: verdict.reason,
    results: verdict.results ?? [],
  };
}
