/**
 * GPW 智能分级（v3.2.7）的纯函数与模型调用：红/黄/蓝/绿倒计时、自动动作、回复解析、配置归一化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPW_AI_COUNTDOWN_MS,
  autoActionOfLevel,
  buildClassifyMessages,
  classifyPendingWithAi,
  countdownMsOfLevel,
  levelOfColor,
  normalizeGpwAiConfig,
  parseClassifyReply,
} from '../src/plugin/gpw-ai.mjs';

test('gpw ai: countdowns match the operator rules (red manual, yellow 180s, blue 30s, green 3s)', () => {
  assert.equal(countdownMsOfLevel('red'), 0);
  assert.equal(countdownMsOfLevel('yellow'), 180_000);
  assert.equal(countdownMsOfLevel('blue'), 30_000);
  assert.equal(countdownMsOfLevel('green'), 3_000);
  assert.equal(GPW_AI_COUNTDOWN_MS.red, 0);
  // overrides (tests / operator tuning), red can never be given a countdown
  assert.equal(countdownMsOfLevel('yellow', { yellow: 5 }), 5);
  assert.equal(countdownMsOfLevel('red', { red: 1 }), 0);
  assert.equal(countdownMsOfLevel('nonsense'), 180_000);
});

test('gpw ai: auto action follows the level (green always allows, red never auto-resolves)', () => {
  assert.equal(autoActionOfLevel('red', 'allow'), null);
  assert.equal(autoActionOfLevel('green', 'deny'), 'allow');
  assert.equal(autoActionOfLevel('yellow', 'deny'), 'deny');
  assert.equal(autoActionOfLevel('yellow', null), 'allow');
  assert.equal(autoActionOfLevel('blue', 'deny'), 'deny');
  assert.equal(autoActionOfLevel('blue', 'allow'), 'allow');
});

test('gpw ai: rule colours map to levels with a yellow fallback', () => {
  assert.equal(levelOfColor('red'), 'red');
  assert.equal(levelOfColor('GREEN'), 'green');
  assert.equal(levelOfColor('unknown'), 'yellow');
  assert.equal(levelOfColor(null), 'yellow');
});

test('gpw ai: reply parsing accepts fenced and noisy JSON and rejects garbage', () => {
  assert.deepEqual(
    parseClassifyReply('{"level":"red","action":"deny","reason":"写到系统目录"}'),
    { level: 'red', action: 'deny', reason: '写到系统目录' },
  );
  assert.deepEqual(
    parseClassifyReply('```json\n{"level":"green","action":"allow","reason":"只读"}\n```'),
    { level: 'green', action: 'allow', reason: '只读' },
  );
  assert.deepEqual(
    parseClassifyReply('判定如下：{"level":"blue","action":"allow","reason":"常规写入"} 以上'),
    { level: 'blue', action: 'allow', reason: '常规写入' },
  );
  assert.equal(parseClassifyReply('not json'), null);
  assert.equal(parseClassifyReply('{"level":"purple"}'), null);
  assert.equal(parseClassifyReply(''), null);
  // 模型偶尔返回散文：关键词兜底仍给出等级/动作（test: prose fallback）
  assert.deepEqual(parseClassifyReply('该操作属于红色风险，建议拒绝：递归删除不可恢复'), { level: 'red', action: 'deny', reason: '，建议拒绝：递归删除不可恢复' });
  assert.deepEqual(parseClassifyReply('这是安全的只读操作，允许执行'), { level: 'green', action: 'allow', reason: '这是安全的只读操作，允许执行' });
  assert.equal(parseClassifyReply('无法判断'), null);
});

test('gpw ai: config normalization requires a token and accepts the deepseek default', () => {
  assert.equal(normalizeGpwAiConfig({}).ok, false);
  assert.equal(normalizeGpwAiConfig({ apiKey: 'short' }).reason, 'api-key-required');
  const ok = normalizeGpwAiConfig({ provider: 'DeepSeek', apiKey: 'sk-0123456789abcdef' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.provider, 'deepseek');
  assert.equal(ok.config.model, 'deepseek-flash');
  assert.equal(ok.config.baseUrl, 'https://api.deepseek.com/v1');
  const custom = normalizeGpwAiConfig({ apiKey: 'sk-0123456789abcdef', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1/' });
  assert.equal(custom.ok, true);
  assert.equal(custom.config.model, 'deepseek-v4-pro');
  assert.equal(custom.config.baseUrl, 'https://api.deepseek.com/v1');
});

test('gpw ai: the prompt carries the tool, the mode and the paths', () => {
  const messages = buildClassifyMessages({ tool: 'write_file', paths: ['C:/Windows/x'], reason: '改系统文件', mode: 'advanced' });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /red/);
  assert.match(messages[1].content, /write_file/);
  assert.match(messages[1].content, /C:\/Windows\/x/);
  assert.match(messages[1].content, /advanced/);
});

test('gpw ai: a configured model is called and its level/recommendation returned', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"level":"yellow","action":"deny","reason":"路径不明确"}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const out = await classifyPendingWithAi({
    config: { apiKey: 'sk-0123456789abcdef', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    tool: 'run_command',
    paths: ['D:/data'],
    reason: '批量脚本',
    mode: 'advanced',
    fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.level, 'yellow');
  assert.equal(out.action, 'deny');
  assert.equal(out.reason, '路径不明确');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.temperature, 0);
});

test('gpw ai: an unavailable model falls back without inventing a level', async () => {
  const httpFail = await classifyPendingWithAi({
    config: { apiKey: 'sk-0123456789abcdef' },
    tool: 't',
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(httpFail.ok, false);
  assert.match(httpFail.reason, /http-500/);

  const badJson = await classifyPendingWithAi({
    config: { apiKey: 'sk-0123456789abcdef' },
    tool: 't',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sorry' } }] }), { status: 200 }),
  });
  assert.equal(badJson.ok, false);

  const notConfigured = await classifyPendingWithAi({ config: null, tool: 't' });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.reason, 'ai-not-configured');
});
