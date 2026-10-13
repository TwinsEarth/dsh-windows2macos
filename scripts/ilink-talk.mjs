/**
 * Talk to the bound WeChat bot: read what arrived, reply to it.
 *
 * This is the real end-to-end path with the headers the protocol actually requires. Kept as a
 * script because it is the ground truth the adapter must be rewritten against: every field
 * name below came from a live response, not from reading someone else's source.
 *
 * Usage: node scripts/ilink-talk.mjs [--say "text"] [--buf <cursor>]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

const LOGIN = 'dist/ilink/ilink-login.json';
const CURSOR = 'dist/ilink/ilink-cursor.txt';

const login = JSON.parse(readFileSync(LOGIN, 'utf8'));
const BASE = login.baseurl.endsWith('/') ? login.baseurl : `${login.baseurl}/`;
const APP_ID = 'bot';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

const argv = process.argv.slice(2);
const say = argv.includes('--say') ? argv[argv.indexOf('--say') + 1] : null;
let cursor = argv.includes('--buf') ? argv[argv.indexOf('--buf') + 1] : existsSync(CURSOR) ? readFileSync(CURSOR, 'utf8') : '';

/** The random per-request UIN the reference client sends, and the type header it cannot omit. */
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
const headers = () => ({
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': CLIENT_VERSION,
  'content-type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': uin(),
  Authorization: `Bearer ${login.bot_token}`,
});

const baseInfo = () => ({ channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m' });

async function post(endpoint, payload, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, BASE).toString(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null; the caller sees the raw text */
    }
    return { http: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Text of a message, using the item shape a live response actually has. */
function textOf(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const parts = [];
  for (const item of items) {
    const t = item?.text_item?.text;
    if (typeof t === 'string' && t !== '') parts.push(t);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

console.log('== reading updates ==');
const updates = await post('ilink/bot/getupdates', { get_updates_buf: cursor, base_info: baseInfo() });
if (updates.json?.errcode !== undefined) {
  console.error(`   refused: errcode=${updates.json.errcode} errmsg=${updates.json.errmsg}`);
  process.exit(1);
}
const messages = Array.isArray(updates.json?.msgs) ? updates.json.msgs : [];
console.log(`   ret=${updates.json?.ret} msgs=${messages.length}`);
if (typeof updates.json?.get_updates_buf === 'string') {
  writeFileSync(CURSOR, updates.json.get_updates_buf);
  console.log('   cursor saved');
}

for (const m of messages) {
  const text = textOf(m);
  console.log(`   --- message_id=${m.message_id} from=${m.from_user_id} type=${m.message_type}`);
  console.log(`       text: ${text === null ? '(non-text)' : JSON.stringify(text)}`);
  console.log(`       client_id: ${m.client_id}`);
  console.log(`       item types: ${(m.item_list ?? []).map((i) => i.type).join(',')}`);
}

if (say !== null) {
  // Reply to the most recent sender, or to the bound owner if nothing arrived.
  const peer = messages.at(-1)?.from_user_id ?? login.ilink_user_id;
  console.log(`== replying to ${peer} ==`);
  const sent = await post('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: peer,
      client_id: `w2m-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: say } }],
    },
    base_info: baseInfo(),
  });
  console.log(`   HTTP ${sent.http}  ${sent.text.slice(0, 300)}`);
  if (sent.json?.errcode !== undefined) {
    console.error(`   REFUSED: errcode=${sent.json.errcode} errmsg=${sent.json.errmsg}`);
    process.exit(2);
  }
  console.log('   SENT');
}
