/**
 * GPW 智能风险分级（v3.2.7）
 *
 * 把 GPW 的待审批调用交给大模型打 红/黄/蓝/绿 四级，并给出推荐动作（allow/deny）与理由；
 * 同时定义每级的倒计时策略。纯函数集中在这里，宿主接线在 gpw.mjs，便于单测。
 *
 * 约定（与用户要求一致）：
 *   red    立即暂停，必须人工选择并确认（不自动倒计时）
 *   yellow 倒计时 180s 后执行 AI 推荐选项（无推荐则放行）
 *   blue   倒计时 30s 后执行 AI 推荐选项（无推荐则放行）
 *   green  倒计时 3s 后默认放行
 *
 * 任何一步失败都不会自动放宽：解析失败退回规则颜色，AI 不可用时按规则颜色走倒计时。
 */

export const GPW_AI_LEVELS = Object.freeze(['red', 'yellow', 'blue', 'green']);

/** 默认倒计时（毫秒）；测试可用 overrides 缩短。 */
export const GPW_AI_COUNTDOWN_MS = Object.freeze({
  red: 0,
  yellow: 180_000,
  blue: 30_000,
  green: 3_000,
});

export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_AI_MODEL = 'deepseek-flash';
export const DEFAULT_AI_PROVIDER = 'deepseek';

/** @param {string} value @returns {'red'|'yellow'|'blue'|'green'|null} */
export function normalizeLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  return GPW_AI_LEVELS.includes(level) ? level : null;
}

/** 规则颜色到分级（规则颜色只有 4 档，未知按 yellow 处理）。 */
export function levelOfColor(color) {
  return normalizeLevel(color) ?? 'yellow';
}

/** 某级的倒计时毫秒；red 恒为 0（不自动执行）。 */
export function countdownMsOfLevel(level, overrides = null) {
  const normalized = normalizeLevel(level) ?? 'yellow';
  if (normalized === 'red') return 0;
  const override = overrides !== null && typeof overrides === 'object' ? Number(overrides[normalized]) : NaN;
  if (Number.isFinite(override) && override >= 0) return override;
  return GPW_AI_COUNTDOWN_MS[normalized];
}

/**
 * 倒计时到点时的默认动作。
 * green 默认放行（用户要求）；yellow/blue 执行 AI 推荐，缺失时放行；red 永远返回 null。
 * @returns {'allow'|'deny'|null}
 */
export function autoActionOfLevel(level, aiAction = null) {
  const normalized = normalizeLevel(level) ?? 'yellow';
  if (normalized === 'red') return null;
  if (normalized === 'green') return 'allow';
  return String(aiAction ?? '').trim().toLowerCase() === 'deny' ? 'deny' : 'allow';
}

/** 构造给模型的分类请求（中文、只输出 JSON）。 */
export function buildClassifyMessages({ tool, paths, reason, mode } = {}) {
  const pathList = Array.isArray(paths) ? paths.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  const system = [
    '你是文件与命令操作的安全分级器。根据操作的工具、路径和理由，把风险分成四级：',
    'red=破坏性/不可恢复/敏感凭证/系统目录写入；yellow=影响范围不明确或需要人工判断；',
    'blue=常规但非只读；green=安全的只读或可逆操作。',
    '同时给出推荐动作 allow 或 deny，并给一句中文理由。',
    '只输出一行 JSON：{"level":"red|yellow|blue|green","action":"allow|deny","reason":"<=80字"}',
  ].join('');
  const user = [
    `工具：${String(tool ?? 'tool')}`,
    `模式：${String(mode ?? 'unknown')}`,
    `理由：${String(reason ?? '').slice(0, 400)}`,
    pathList.length > 0 ? `涉及路径：\n${pathList.slice(0, 12).join('\n')}` : '涉及路径：（无）',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 从模型回复里取出 JSON（容忍 ```json 围栏、前后废话）。 */
export function parseClassifyReply(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence !== null) candidates.push(fence[1]);
  candidates.push(raw);
  const inline = /\{[\s\S]*\}/.exec(raw);
  if (inline !== null) candidates.push(inline[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      const level = normalizeLevel(parsed?.level);
      if (level === null) continue;
      const action = String(parsed?.action ?? '').trim().toLowerCase() === 'deny' ? 'deny' : 'allow';
      const reason = String(parsed?.reason ?? '').trim().slice(0, 200);
      return { level, action, reason };
    } catch { /* try next candidate */ }
  }
  // 模型偶尔返回散文而不是 JSON：按关键词做最后兜底（仍然安全，识别不出就返回 null 走规则颜色）。
  const lower = raw.toLowerCase();
  const LEVEL_WORDS = [
    ['red', /\bred\b|红色|极高风险|高危/i],
    ['yellow', /\byellow\b|黄色|中风险|需人工/i],
    ['blue', /\bblue\b|蓝色|低风险|常规/i],
    ['green', /\bgreen\b|绿色|安全|只读/i],
  ];
  let level = null;
  for (const [name, pattern] of LEVEL_WORDS) {
    if (pattern.test(lower)) { level = name; break; }
  }
  if (level === null) return null;
  const action = /拒绝|deny|禁止|拦截/i.test(raw) && !/允许|放行|allow/i.test(raw) ? 'deny' : 'allow';
  const reason = raw.replace(/^[\s\S]{0,40}?(?:风险|level)[:：]?/i, '').slice(0, 120).trim() || '按关键词兜底分类';
  return { level, action, reason };
}

/**
 * 调一次 OpenAI 兼容的 chat/completions 做分级。
 * @param {{config: object, tool: string, paths: string[], reason: string, mode: string, fetchImpl?: Function, timeoutMs?: number}} options
 * @returns {Promise<{ok: true, level, action, reason, model} | {ok: false, reason: string}>}
 */
export async function classifyPendingWithAi(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : null;
  if (config === null || String(config.apiKey ?? '').trim() === '') return { ok: false, reason: 'ai-not-configured' };
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const baseUrl = String(config.baseUrl ?? DEFAULT_AI_BASE_URL).replace(/\/+$/, '');
  const model = String(config.model ?? DEFAULT_AI_MODEL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || 20_000));
  timer.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${String(config.apiKey).trim()}` },
      body: JSON.stringify({
        model,
        messages: buildClassifyMessages(options),
        temperature: 0,
        max_tokens: 200,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `http-${response.status}: ${text.slice(0, 160)}` };
    let reply = null;
    try {
      reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      return { ok: false, reason: 'invalid-json-response' };
    }
    const classified = parseClassifyReply(reply);
    if (classified === null) return { ok: false, reason: 'unparseable-classification' };
    return { ok: true, ...classified, model };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** GPW 面板用的 AI 配置归一化（与决策中心一致的最小字段集）。 */
export function normalizeGpwAiConfig(input = {}) {
  const provider = String(input?.provider ?? DEFAULT_AI_PROVIDER).trim().toLowerCase() || DEFAULT_AI_PROVIDER;
  const apiKey = String(input?.apiKey ?? '').trim();
  if (apiKey.length < 8) return { ok: false, reason: 'api-key-required' };
  const baseUrl = String(input?.baseUrl ?? DEFAULT_AI_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_AI_BASE_URL;
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, reason: 'base-url-required' };
  const model = String(input?.model ?? DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL;
  return { ok: true, config: { provider, apiKey, baseUrl, model } };
}
