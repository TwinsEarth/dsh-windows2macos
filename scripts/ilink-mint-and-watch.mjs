/**
 * Mint, then poll continuously, then read the instant it confirms.
 *
 * Written because a gap between "mint" and "poll" is what lost the token twice: the QR expired
 * while nothing was watching it. This process mints and watches in one breath, so a scan is
 * captured the moment it happens rather than whenever someone next runs a command.
 */
import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const BASE = 'https://ilinkai.weixin.qq.com/';
const BOT_INFO = { channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m' };
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
const H = (t) => { const h = { 'content-type':'application/json','iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|6),'X-WECHAT-UIN':uin(), AuthorizationType:'ilink_bot_token' }; if (t) h.authorization = 'Bearer ' + t; return h; };
const post = async (ep, body, t) => {
  const r = await fetch(new URL(ep, BASE).toString(), { method:'POST', headers:H(t), body:JSON.stringify(body), signal:AbortSignal.timeout(25000) });
  return r.json();
};

const qr = await post('ilink/bot/get_bot_qrcode?bot_type=3', { base_info: BOT_INFO });
const url = qr.qrcode_img_content;
log('QRCODE=' + qr.qrcode);
log('URL=' + url);
try {
  const png = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&format=png&data=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30000) });
  writeFileSync('dist/ilink/qr-latest.png', Buffer.from(await png.arrayBuffer()));
  writeFileSync('dist/ilink/qr-latest.url', url);
  log('PNG saved to dist/ilink/qr-latest.png');
} catch (e) { log('png failed: ' + e.message); }
log('WATCHING. Scan now.');

let token = null, st = null, lastState = '';
const deadline = Date.now() + 30 * 60 * 1000;
while (Date.now() < deadline && token === null) {
  await new Promise(r => setTimeout(r, 2000));
  try { st = await post(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { base_info: BOT_INFO }); }
  catch (e) { continue; }
  const state = String(st?.status ?? st?.state ?? '');
  if (state !== lastState) { log('state=' + state); lastState = state; }
  token = st?.bot_token ?? st?.token ?? null;
  if (state === 'expired') { log('EXPIRED before a scan'); process.exit(2); }
}
if (!token) { log('TIMEOUT, nobody scanned'); process.exit(3); }

writeFileSync('dist/ilink/ilink-login.json', JSON.stringify({ bot_token: token, baseurl: st.baseurl ?? BASE, ilink_bot_id: st.ilink_bot_id ?? null, ilink_user_id: st.ilink_user_id ?? null, obtained_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
log(`TOKEN OBTAINED (${token.length} chars, saved 0600) bot_id=${st.ilink_bot_id}`);
log('reading immediately');
let buf = existsSync('dist/ilink/ilink-cursor.txt') ? readFileSync('dist/ilink/ilink-cursor.txt','utf8').trim() : '';
let total = 0;
for (let i = 0; i < 30; i += 1) {
  let u;
  try { u = await post('ilink/bot/getupdates', { base_info: BOT_INFO, buf, limit: 50 }, token); }
  catch (e) { log('poll threw ' + e.message); break; }
  if (u?.errcode === -14) { log(`SESSION TIMEOUT after ${total} msg(s)`); break; }
  const msgs = u?.msgs ?? [];
  for (const m of msgs) {
    const text = m?.item_list?.find((it) => it?.type === 1)?.text_item?.text ?? '(non-text)';
    total += 1;
    log(`*** MESSAGE from ${m.from_user_id}: ${JSON.stringify(text)}`);
    appendFileSync('dist/ilink/messages.jsonl', JSON.stringify(m) + String.fromCharCode(10));
  }
  if (u?.get_updates_buf) { buf = u.get_updates_buf; writeFileSync('dist/ilink/ilink-cursor.txt', buf); }
  if (msgs.length) log(`msgs=${msgs.length} total=${total}`);
  await new Promise(r => setTimeout(r, 2000));
}
log(`DONE. ${total} message(s) read`);
process.exit(0);
