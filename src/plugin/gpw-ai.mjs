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
/** 构造给模型的分类请求（严格 JSON、只允许四级/两种动作）。 */
export function buildClassifyMessages({ tool, paths, reason, mode } = {}) {
  const pathList = Array.isArray(paths) ? paths.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  const system = [
    '你是文件与命令操作的安全分级器。把操作分成四级：',
    'red=破坏性/不可恢复/敏感凭证/系统目录写入；yellow=影响范围不明确或需要人工判断；',
    'blue=常规但非只读；green=安全的只读或可逆操作。',
    '同时给出推荐动作 allow 或 deny，并给一句中文理由。',
    '只输出一行 JSON，不要代码块、不要解释、不要前后缀。',
    '{"level":"red|yellow|blue|green","action":"allow|deny","reason":"不超过80字"}',
  ].join(''); 
  const user = [
    `工具：${String(tool ?? 'tool')}`,
    `模式：${String(mode ?? 'unknown')}`,
    `理由：${String(reason ?? '').slice(0, 400)}`,
    pathList.length > 0 ? `涉及路径：\n${pathList.slice(0, 12).join('\n')}` : '涉及路径：（无）',
    '请严格按规定 JSON 输出：level 只能是 red/yellow/blue/green，action 只能是 allow/deny。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
/** 把文本里的等级词/数字映射到四级；识别不了返回 null。 */
export function levelFromText(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  if (/critical|极高|严重|不可恢复|红|\bred\b/.test(lower)) return 'red';
  if (/medium|中风险|中等|需人工|待确认|人工确认|黄|\byellow\b/.test(lower)) return 'yellow';
  if (/低风险|常规|可逆|蓝|\bblue\b/.test(lower)) return 'blue';
  if (/安全|只读|可忽略|绿|\bgreen\b|safe/.test(lower)) return 'green';
  const numeric = /(?:等级|level|风险)[^\d]{0,6}([1-4])/.exec(lower) ?? /([1-4])\s*级/.exec(lower);
  if (numeric !== null) return ({ 1: 'green', 2: 'blue', 3: 'yellow', 4: 'red' })[Number(numeric[1])] ?? null;
  return null;
}

/** 把模型返回的对象（允许中文键/数字等级）归一成 {level, action, reason}。 */
export function normalizeClassified(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      if (Object.hasOwn(parsed, key) && parsed[key] !== undefined && parsed[key] !== null) return parsed[key];
    }
    return undefined;
  };
  const levelRaw = pick('level', 'risk', 'riskLevel', 'risk_level', '等级', '危险等级', 'severity');
  let level = normalizeLevel(levelRaw);
  if (level === null && typeof levelRaw === 'number') level = ({ 1: 'green', 2: 'blue', 3: 'yellow', 4: 'red' })[levelRaw] ?? null;
  if (level === null) level = levelFromText(String(levelRaw ?? ''));
  if (level === null) level = levelFromText(JSON.stringify(parsed));
  if (level === null) return null;
  const actionRaw = String(pick('action', 'recommendation', 'decision', '建议', '动作') ?? '').trim().toLowerCase();
  const action = /deny|block|forbid|refuse|拒绝|拦截|禁止|阻止/.test(actionRaw) ? 'deny' : 'allow';
  const reason = String(pick('reason', '理由', '说明', 'explanation') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { level, action, reason };
}

/** 从模型回复里取出 JSON（容忍围栏、前后废话、中文键、数字等级、纯散文）。 */
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
      const classified = normalizeClassified(JSON.parse(candidate.trim()));
      if (classified !== null) return classified;
    } catch { /* try next candidate */ }
  }
  // 模型偶尔返回散文：按关键词兜底（仍然安全：识别不出就返回 null 走规则颜色）。
  const level = levelFromText(raw);
  if (level === null) return null;
  const action = /拒绝|拦截|禁止|阻止|deny|block|forbid/i.test(raw) && !/允许|放行|执行|allow|permit/i.test(raw) ? 'deny' : 'allow';
  const reason = raw.replace(/```[\s\S]*?```/g, ' ').replace(/\{[\s\S]*?\}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || '按关键词兜底分类';
  return { level, action, reason };
}

/** 单次模型调用：返回 {ok:true,text} 或 {ok:false,reason}。 */
async function requestClassification({ config, messages, fetchImpl, timeoutMs, model, baseUrl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 20_000));
  timer.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${String(config.apiKey).trim()}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 300,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `http-${response.status}: ${text.slice(0, 160)}` };
    let reply = '';
    try { reply = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? ''); } catch { return { ok: false, reason: 'invalid-json-response' }; }
    if (reply.trim() === '') return { ok: false, reason: 'empty-content' };
    return { ok: true, text: reply };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调一次 OpenAI 兼容的 chat/completions 做分级；解析失败会做一次“修复重试”。
 * @returns {Promise<{ok:true,level,action,reason,model} | {ok:false,reason:string,raw?:string}>}
 */
export async function classifyPendingWithAi(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : null;
  if (config === null || String(config.apiKey ?? '').trim() === '') return { ok: false, reason: 'ai-not-configured' };
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const baseUrl = String(config.baseUrl ?? DEFAULT_AI_BASE_URL).replace(/\/+$/, '');
  const model = String(config.model ?? DEFAULT_AI_MODEL);
  const first = await requestClassification({ config, messages: buildClassifyMessages(options), fetchImpl, timeoutMs: options.timeoutMs, model, baseUrl });
  if (!first.ok) return { ok: false, reason: first.reason };
  const parsed = parseClassifyReply(first.text);
  if (parsed !== null) return { ok: true, ...parsed, model };
  // 修复重试：把模型的原始回复发回去，明确要求只输出 JSON。
  const repairMessages = [
    ...buildClassifyMessages(options),
    { role: 'assistant', content: String(first.text).slice(0, 800) },
    { role: 'user', content: '上一条回复无法解析。只输出一行合法 JSON，格式：{"level":"red|yellow|blue|green","action":"allow|deny","reason":"不超过80字"}；不要输出任何其他文字。' },
  ];
  const second = await requestClassification({ config, messages: repairMessages, fetchImpl, timeoutMs: options.timeoutMs, model, baseUrl });
  if (second.ok) {
    const repaired = parseClassifyReply(second.text);
    if (repaired !== null) return { ok: true, ...repaired, model, repaired: true };
    return { ok: false, reason: 'unparseable-classification', raw: String(second.text).slice(0, 200) };
  }
  return { ok: false, reason: 'unparseable-classification', raw: String(first.text).slice(0, 200) };
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
