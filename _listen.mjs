import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const login = JSON.parse(readFileSync('dist/ilink/ilink-login.json', 'utf8'));
const BASE = login.baseurl.endsWith('/') ? login.baseurl : login.baseurl + '/';
const BOT_INFO = { channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m' };
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
const headers = () => ({
  'content-type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
  'X-WECHAT-UIN': uin(),
  AuthorizationType: 'ilink_bot_token',
  authorization: `Bearer ${login.bot_token}`,
});
const stamp = () => new Date().toISOString().slice(11, 19);
let buf = '';
const deadline = Date.now() + 150000;
let total = 0;
console.log('  listening for 150s -- send a WeChat message to the bot NOW');
while (Date.now() < deadline) {
  let j;
  try {
    const r = await fetch(new URL('ilink/bot/getupdates', BASE).toString(), {
      method: 'POST', headers: headers(), body: JSON.stringify({ base_info: BOT_INFO, buf, limit: 50 }),
      signal: AbortSignal.timeout(20000),
    });
    j = await r.json();
  } catch (e) { console.log(`  [${stamp()}] poll threw: ${e.message}`); await new Promise(r=>setTimeout(r,2000)); continue; }
  if (j?.errcode === -14) { console.log(`  [${stamp()}] SESSION TIMEOUT after ${total} msgs`); break; }
  const msgs = j?.msgs ?? [];
  if (msgs.length) {
    total += msgs.length;
    console.log(`  [${stamp()}] *** ${msgs.length} MESSAGE(S) ***`);
    for (const m of msgs) {
      console.log('    ----');
      console.log('    from   :', m.from_user_name ?? m.from ?? '?');
      console.log('    content:', JSON.stringify(m.content ?? m.text ?? '').slice(0, 400));
      console.log('    raw    :', JSON.stringify(m).slice(0, 500));
      appendFileSync('dist/ilink/messages.jsonl', JSON.stringify(m) + String.fromCharCode(10));
    }
  }
  if (j?.get_updates_buf) { buf = j.get_updates_buf; writeFileSync('dist/ilink/ilink-cursor.txt', buf); }
  console.log(`  [${stamp()}] poll ok, msgs=${msgs.length}, total=${total}`);
  await new Promise((r) => setTimeout(r, 2500));
}
console.log(`  DONE. total messages: ${total}`);
