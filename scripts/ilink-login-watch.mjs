/**
 * Mint a login QR and keep one alive until somebody scans it.
 *
 * ## Why this loops instead of minting once
 *
 * The iLink QR lives about **two minutes**. Measured, not documented: a QR minted at 03:30:08 was
 * `expired` by 03:32:10. Any flow where a person has to see a code, walk to a phone, and scan —
 * with a chat message in between — is slower than that, so it fails every time and looks like the
 * scan is the problem when it is the latency.
 *
 * So this prints a fresh URL whenever the current one dies, and keeps doing it for as long as it
 * runs. The human scans whichever is live; nothing has to be coordinated.
 *
 * ## Why it prints a URL rather than a picture
 *
 * A terminal cannot draw a QR from a URL without a renderer, and the endpoints that render one are
 * a third party. The URL is what the phone needs anyway — open it on the phone itself, or scan it
 * from another screen. `--render` asks a public renderer for a PNG, which is convenient and sends
 * the login URL to that service; the trade is stated rather than made silently.
 *
 * Usage: node ilink-login-watch.mjs [--minutes 30] [--render]
 */

import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = 'https://ilinkai.weixin.qq.com/';
const BOT_INFO = { channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m' };
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const minutes = Number(opt('--minutes', 30));
const render = argv.includes('--render');

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');

const headers = (token) => {
  const h = {
    'content-type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
    'X-WECHAT-UIN': uin(),
    // Undocumented and mandatory: without it every call answers 401 with no explanation.
    AuthorizationType: 'ilink_bot_token',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
};

async function post(endpoint, payload, token) {
  const res = await fetch(new URL(endpoint, BASE).toString(), {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  return res.json();
}

async function mint() {
  const qr = await post('ilink/bot/get_bot_qrcode?bot_type=3', { base_info: BOT_INFO });
  if (typeof qr?.qrcode !== 'string') throw new Error(`no qrcode in ${JSON.stringify(qr).slice(0, 200)}`);
  return qr;
}

async function show(qr) {
  console.log('');
  console.log('============================================================');
  console.log('  SCAN THIS — it expires in about 2 minutes');
  console.log('');
  console.log(`  ${qr.qrcode_img_content}`);
  console.log('============================================================');
  console.log('');
  if (render) {
    try {
      const png = await fetch(
        `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&format=png&data=${encodeURIComponent(qr.qrcode_img_content)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      writeFileSync('qr-latest.png', Buffer.from(await png.arrayBuffer()));
      log('also saved qr-latest.png in this directory (the URL was sent to api.qrserver.com)');
    } catch (err) {
      log(`could not render a PNG (${err.message}); the URL above is enough`);
    }
  }
}

const deadline = Date.now() + minutes * 60_000;
let qr = await mint();
log(`WATCHING for up to ${minutes} minute(s). Re-mints automatically when one expires.`);
await show(qr);

let lastState = '';
for (;;) {
  if (Date.now() > deadline) { log('TIMEOUT — nobody scanned'); process.exit(3); }
  await new Promise((r) => setTimeout(r, 2000));

  let st;
  try {
    st = await post(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { base_info: BOT_INFO });
  } catch {
    continue; // a poll failure is not a scan failure
  }
  const state = String(st?.status ?? st?.state ?? '');
  if (state !== lastState) { log(`state = ${state}`); lastState = state; }

  if (state === 'expired') {
    // The whole point: a dead code is replaced rather than reported as a failure.
    log('expired — minting a fresh one');
    lastState = '';
    qr = await mint();
    await show(qr);
    continue;
  }

  // The token appears at `confirmed`, NOT at `scaned`. Waiting on `scaned` misses it entirely.
  const token = st?.bot_token ?? st?.token ?? null;
  if (token) {
    writeFileSync(
      'ilink-login.json',
      JSON.stringify(
        {
          bot_token: token,
          baseurl: st.baseurl ?? BASE,
          ilink_bot_id: st.ilink_bot_id ?? null,
          ilink_user_id: st.ilink_user_id ?? null,
          obtained_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    log(`SCANNED. token ${token.length} chars written to ilink-login.json (0600)`);
    log(`ilink_bot_id  = ${st.ilink_bot_id}`);
    log(`ilink_user_id = ${st.ilink_user_id}`);
    process.exit(0);
  }
}
