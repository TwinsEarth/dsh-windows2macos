/**
 * Run the WeChat → fleet bridge against the live service.
 *
 * This is the composition: the measured wire protocol, the `/run` parser, and the fleet executor.
 * Everything interesting is in the modules it imports — this file's job is the loop and the failure
 * handling, and its comments record what the loop has to get right.
 *
 * ## Why it acknowledges before it dispatches
 *
 * A fleet run takes seconds to minutes. A chat window that stays silent for a minute reads as
 * broken, and the operator's reaction is to send the command again — which dispatches it twice. So
 * the acknowledgement goes out first and the verdict follows.
 *
 * ## Why one bad message does not stop the loop
 *
 * The long poll is the only thing keeping the channel alive. An exception from a dispatch, a
 * rendering bug, or a malformed message must be reported and skipped; letting it escape ends the
 * session and the bot goes silent with no indication why.
 *
 * Usage: node scripts/ilink-fleet-bridge.mjs [--once] [--dry-run]
 *
 * `--dry-run` means **nothing reaches the fleet and nothing is sent to WeChat** -- the poll still runs,
 * so it is how you check the login and see which forms the parser accepts, and it is not a way to
 * dispatch "safely". Until v0.48.0 it guarded the reply only, so a dry run really did dispatch
 * (measured: `node--version` sent to five machines, twice).
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { buildHeaders, buildReply, sendSucceeded, planMessage, renderTaskOutcome, renderFailure, MESSAGE_TYPE, dryRunPolicy } from '../src/chatops/ilink-fleet-bridge.mjs';
import { createFleetExecutor } from '../src/chatops/fleet.mjs';
/**
 * The capability probe, used to say at startup whether vision is usable.
 *
 * **This is `src/chatops/vision.mjs`'s first production caller**, and the pre-flight's orphan gate is what
 * required one: a mechanism with no caller is indistinguishable from a finished feature, and this repository has
 * shipped four of those. The probe is deliberately the smallest useful consumer -- **not** the analysis path,
 * which is the separate WeChat work.
 *
 * It earns its place beyond satisfying the gate: "is vision configured on this machine" is a real question at
 * startup, and without a line here the only way to learn the answer is to send an image and read the refusal.
 */
import { visionStatus } from '../src/chatops/vision.mjs';

const LOGIN = 'dist/ilink/ilink-login.json';
const CURSOR = 'dist/ilink/ilink-cursor.txt';
const LOG = 'dist/ilink/bridge.log';

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const dryRun = argv.includes('--dry-run');
/**
 * What `--dry-run` permits, read from the library rather than decided here.
 *
 * The three usages below were all `dryRun` checks before, and there were two of them: one on the reply
 * and **none on the dispatch**. Deriving both from one value is what stops that happening again.
 */
const dry = dryRunPolicy({ dryRun });

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => {
  const line = `[${stamp()}] ${m}`;
  console.log(line);
  try { appendFileSync(LOG, `${line}\n`); } catch { /* logging must never break the loop */ }
};

if (!existsSync(LOGIN)) {
  log(`no login at ${LOGIN}. Run scripts/ilink-scan-and-read.mjs first to scan a QR.`);
  process.exit(1);
}
const login = JSON.parse(readFileSync(LOGIN, 'utf8'));
const BASE = login.baseurl.endsWith('/') ? login.baseurl : `${login.baseurl}/`;
const TOKEN = login.bot_token;
if (typeof TOKEN !== 'string' || TOKEN === '') {
  log('the cached login has no bot_token; scan again.');
  process.exit(1);
}

const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');

/**
 * Configuration, read from the environment rather than hard-coded.
 *
 * ## The relay needs TWO credentials, and using one gives a silent wrong answer
 *
 * Measured, and the reason this script refuses to start without both:
 *
 * | credential | what it is for |
 * |---|---|
 * | operator token | `POST /v1/task` — dispatching |
 * | **device token** | `GET /v1/tasks/{id}` — reading the verdict |
 *
 * Supplying only the operator token **dispatches successfully** and then fails every read with
 * `UNAUTHORIZED / device_token_required`. A first version of this script did exactly that, and
 * because the failure surfaced as an unreadable response rather than an error, the chat window was
 * told `判定：unknown` — a **wrong answer presented as a result**, which is worse than a refusal.
 *
 * The device token is the machine's own identity, so it is read from the local `device.json`
 * rather than asked for separately: one machine, one identity.
 *
 * `W2M_CAPABILITIES` defaults to **the beginner form only**. A bridge with no configuration must not
 * be able to dispatch — the default has to be the safe one for a process someone starts to see
 * whether it works.
 */
const RABBIT = process.env.W2M_RABBIT_URL ?? 'http://202.182.123.154:8787';
const OPERATOR = process.env.W2M_OPERATOR_TOKEN ?? '';
const caps = new Set(
  (process.env.W2M_CAPABILITIES ?? 'operate').split(',').map((s) => s.trim()).filter((s) => s !== ''),
);
const authorize = (capability) => caps.has(capability);
const canDispatch = authorize('fleet.dispatch');

/** The device token, from this machine's own identity file. */
function findDeviceToken() {
  const candidates = [
    process.env.W2M_DEVICE_FILE,
    process.env.DSH_DEVICE_FILE,
    'dist/device/device.json',
    'device.json',
  ].filter((p) => typeof p === 'string' && p !== '');
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const token = parsed?.device_token ?? parsed?.deviceToken ?? parsed?.token;
      if (typeof token === 'string' && token !== '') return { token, from: path };
    } catch { /* a malformed identity file is reported by absence, below */ }
  }
  return null;
}

const device = findDeviceToken();

log(`relay       : ${RABBIT}`);
log(`capabilities: ${[...caps].join(', ')}`);
log(`device token: ${device ? `from ${device.from}` : 'NOT FOUND'}`);

/**
 * Refuse to start in the state that produces confident wrong answers.
 *
 * Three cases, and each is a **refusal with a reason** rather than a degraded run:
 *
 *   * dispatch capability but no operator token -> every dispatch would 401;
 *   * dispatch capability but no device token   -> dispatch succeeds and the verdict is unreadable,
 *     which the operator sees as `unknown` and reasonably reads as "the machines did not answer";
 *   * no dispatch capability                    -> not an error; the beginner form is answered
 *     without touching the relay at all.
 */
const problems = [];
if (canDispatch && OPERATOR === '') problems.push('fleet.dispatch is enabled but W2M_OPERATOR_TOKEN is empty, so every dispatch would be refused (401).');
if (canDispatch && device === null) {
  problems.push(
    'fleet.dispatch is enabled but no device token was found, so a dispatch would succeed and its '
    + 'verdict would be unreadable -- the window would be told "unknown", which reads as "the '
    + 'machines did not answer". Set W2M_DEVICE_FILE to this machine\'s device.json.',
  );
}
if (problems.length > 0) {
  log('');
  log('REFUSING TO START:');
  for (const p of problems) log(`  - ${p}`);
  log('');
  log(canDispatch && device === null && OPERATOR !== ''
    ? 'To run the beginner form only (no relay access needed): unset W2M_CAPABILITIES.'
    : 'Fix the above, or unset W2M_CAPABILITIES to run the beginner form only.');
  process.exit(1);
}

log(`dry run     : ${dryRun}`);

const fleet = createFleetExecutor({
  rabbitUrl: RABBIT,
  token: OPERATOR,
  deviceToken: device?.token ?? null,
  log: (level, message, detail) => log(`  fleet[${level}] ${message} ${detail ? JSON.stringify(detail) : ''}`),
});

async function post(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch(new URL(endpoint, BASE).toString(), {
      method: 'POST',
      headers: buildHeaders({ token: TOKEN, makeUin: uin }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const BASE_INFO = () => ({ channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m-bridge' });

async function reply(to, contextToken, text) {
  if (!dry.reply) { log(`  [dry-run] would reply to ${to}: ${text.split('\n')[0]}`); return true; }
  try {
    const body = await post('ilink/bot/sendmessage', {
      base_info: BASE_INFO(),
      ...buildReply({ toUserId: to, contextToken, text }),
    });
    const ok = sendSucceeded(body);
    if (!ok) log(`  reply REFUSED: ${JSON.stringify(body).slice(0, 200)}`);
    return ok;
  } catch (err) {
    log(`  reply threw: ${err.message}`);
    return false;
  }
}

/**
 * Dispatch and report. Never throws: a failure here is a message to the operator, not the end of
 * the channel.
 */
async function dispatchAndReport(plan) {
  /**
   * The guard that was missing, at the TOP of the only function that can reach `fleet.run`.
   *
   * Placed here rather than at the call site because a guard at the call site is one edit away from
   * being bypassed by a second caller; a guard above the dangerous call is a property of the function.
   * **This is the whole fix**: two dry runs previously dispatched `node--version` to five machines
   * because the reply was guarded and this was not.
   */
  if (!dry.dispatch) { log(`  [dry-run] would dispatch ${plan.argv.join(' ')} -- not sent`); return; }
  try {
    const started = await fleet.run(plan.argv, {
      mode: plan.flags.mode,
      ...(plan.flags.machines ? { target_machines: plan.flags.machines } : {}),
      ...(plan.flags.timeoutMs ? { timeout_ms: plan.flags.timeoutMs } : {}),
    });
    const taskId = started?.task_id ?? started?.taskId;
    log(`  dispatched task ${taskId}`);
    if (!taskId) { await reply(plan.to, plan.contextToken, `派发没有返回任务号：${JSON.stringify(started).slice(0, 300)}`); return; }

    const verdict = await fleet.wait(taskId, { maxMs: plan.flags.timeoutMs ?? 120_000, pollMs: 1500 });
    const text = renderTaskOutcome({ taskId, body: verdict?.body ?? verdict });
    log(`  verdict for ${taskId}: ${(verdict?.body?.aggregate?.status ?? verdict?.state ?? '?')}`);
    await reply(plan.to, plan.contextToken, text);
  } catch (error) {
    log(`  dispatch failed: ${error?.code ?? error?.message}`);
    await reply(plan.to, plan.contextToken, renderFailure(error));
  }
}

async function main() {
  let cursor = existsSync(CURSOR) ? readFileSync(CURSOR, 'utf8').trim() : '';
  /**
   * Say whether vision is usable, before the poll loop starts.
   *
   * The refusal block above runs at module scope, before `main()` is ever called, **so a bridge that refuses to
   * start prints nothing here** -- which is the right way round: the refusal already says what is wrong, and a
   * second complaint about vision would bury it.
   *
   * An image arriving with vision unconfigured is answered by the help text either way, **and that message is
   * the same sentence whether the skill is missing, the key is absent, or `python3` is not installed.** This line
   * turns three indistinguishable failures into a named one, at startup, where it is still cheap to fix.
   */
  const vision = await visionStatus();
  log(`vision      : ${vision.ready ? `ready (${vision.provider})` : `NOT ready -- ${vision.reason}`}`);
  log(`listening (cursor ${cursor === '' ? 'empty' : `${cursor.length} chars`}) -- send /run ... in WeChat`);
  let handled = 0;

  for (;;) {
    let update;
    try {
      update = await post('ilink/bot/getupdates', { base_info: BASE_INFO(), get_updates_buf: cursor, buf: cursor, limit: 20 });
    } catch (err) {
      log(`poll threw: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (update?.errcode === -14) { log('SESSION EXPIRED (-14). Scan again.'); process.exit(2); }

    const msgs = Array.isArray(update?.msgs) ? update.msgs : [];
    if (typeof update?.get_updates_buf === 'string' && update.get_updates_buf !== '') {
      cursor = update.get_updates_buf;
      try { writeFileSync(CURSOR, cursor); } catch { /* cursor loss means a repeat, not a failure */ }
    }

    for (const message of msgs) {
      if (message?.message_type !== MESSAGE_TYPE.USER) continue;
      const plan = planMessage({ message, authorize });
      if (plan.act === 'ignore') { log(`  ignored (${plan.why})`); continue; }

      handled += 1;
      if (plan.act === 'reply') {
        // A shape report, when the message carried no text. **Key paths and value types only** -- enough to learn
        // what iLink sends for an image, and never the user's content.
        if (typeof plan.shape === 'string') log(`  shape: ${plan.shape}`);
        log(`  reply: ${plan.text.split('\n')[0].slice(0, 80)}`);
        await reply(plan.to, plan.contextToken, plan.text);
      } else if (plan.act === 'dispatch') {
        log(`  DISPATCH ${plan.argv.join(' ')}`);
        await reply(plan.to, plan.contextToken, plan.ack);
        await dispatchAndReport(plan);
      }
      if (once) { log(`--once: handled ${handled} message(s), exiting`); process.exit(0); }
    }
  }
}

main().catch((err) => { log(`FATAL ${err?.stack ?? err}`); process.exit(1); });
