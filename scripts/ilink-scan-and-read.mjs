/**
 * Scan, then read immediately — because the token does not live long enough to do it by hand.
 *
 * ## Why this script has to exist
 *
 * The iLink session answers `errcode: -14, "session timeout"` to every authenticated call, and it
 * has been observed doing so to a token roughly **30 seconds old**. A human workflow — mint a QR,
 * show it, wait for a scan, then open another terminal and run a reader — cannot fit inside that
 * window, which is why the previous attempt read nothing and looked like a bot problem when it was
 * a timing problem.
 *
 * So the QR is minted, rendered to a PNG the user can open, and the moment the scan confirms, this
 * process **immediately** calls `getupdates` and prints whatever is there. No second command, no
 * hand-off, no window for the token to die in.
 *
 * The QR is written to disk rather than drawn as ASCII: a real image is what a phone camera locks
 * onto, and the ASCII renderer needed polarity, aspect and bit-depth all correct at once, which is
 * three chances to be subtly wrong about a code that must be exact.
 *
 * Usage: node scripts/ilink-scan-and-read.mjs [--minutes 5] [--wait 8]
 */

import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = 'https://ilinkai.weixin.qq.com/';
const OUT_DIR = 'dist/ilink';
const LOGIN = `${OUT_DIR}/ilink-login.json`;
const CURSOR = `${OUT_DIR}/ilink-cursor.txt`;

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const minutes = Number(opt('--minutes', 5));
/** How long to keep polling for messages after the scan confirms. */
const waitSeconds = Number(opt('--wait', 8));

const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The three headers every authenticated call needs.
 *
 * `AuthorizationType: ilink_bot_token` is **mandatory and undocumented**: without it the endpoint
 * answers 401 with no explanation, which reads as a bad token rather than a missing header.
 */
const headers = (token) => {
  const h = {
    'content-type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION,
    'X-WECHAT-UIN': uin(),
    AuthorizationType: 'ilink_bot_token',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
};

async function post(endpoint, payload, { token, timeoutMs = 25_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(endpoint, BASE).toString(), {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(payload),
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const BASE_INFO = () => ({ channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m-scan' });

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  log('minting a login QR...');
  const qr = await post('ilink/bot/get_bot_qrcode?bot_type=3', { base_info: BASE_INFO() });
  if (typeof qr?.qrcode !== 'string') {
    console.log('FAILED to mint a QR:', JSON.stringify(qr).slice(0, 300));
    process.exit(1);
  }
  const url = qr.qrcode_img_content;
  log(`qrcode = ${qr.qrcode}`);

  // A real PNG, so the phone camera has something unambiguous to lock onto.
  try {
    const png = await fetch(
      `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&format=png&data=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(25_000) },
    );
    writeFileSync(`${OUT_DIR}/qr-latest.png`, Buffer.from(await png.arrayBuffer()));
    writeFileSync(`${OUT_DIR}/qr-latest.url`, url);
    log(`QR saved to ${OUT_DIR}/qr-latest.png`);
  } catch (err) {
    log(`could not save the QR image (${err.message}); open this instead:`);
  }
  console.log('');
  console.log('  SCAN THIS (or open the PNG above):');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  Waiting up to ${minutes} minute(s) for the scan...`);
  console.log('');

  const deadline = Date.now() + minutes * 60_000;
  let token = null;
  let lastState = '';

  while (Date.now() < deadline && token === null) {
    await sleep(2000);
    let st;
    try {
      st = await post(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { base_info: BASE_INFO() });
    } catch (err) {
      lastState = `poll error: ${err.message}`;
      continue;
    }
    const state = String(st?.status ?? st?.state ?? '');
    // The raw poll is appended to a file: the previous run showed `scaned` then `expired` with no
    // token in between, and whether the token appears in a later poll or needs an activation call is
    // the whole question. Recording it means the next attempt answers it instead of guessing.
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), state, keys: Object.keys(st ?? {}), raw: st });
      appendFileSync(`${OUT_DIR}/qr-polls.jsonl`, `${line}\n`);
    } catch { /* a diagnostic must never break the login it is diagnosing */ }
    if (state !== lastState) {
      log(`status = ${state || '(empty)'}`);
      lastState = state;
    }
    token = st?.bot_token ?? st?.token ?? null;
    if (token) {
      writeFileSync(
        LOGIN,
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
      log(`SCANNED. token ${token.length} chars, saved 0600. Reading IMMEDIATELY.`);
    }
    if (state === 'expired') {
      log('RESULT=qr_expired -- run again');
      process.exit(2);
    }
  }

  if (token === null) {
    log('RESULT=timeout -- nobody scanned in the window');
    process.exit(3);
  }

  // No delay here on purpose: every millisecond spent is one the session may not have.
  let cursor = existsSync(CURSOR) ? readFileSync(CURSOR, 'utf8').trim() : '';
  const seen = [];
  const until = Date.now() + waitSeconds * 1000;

  do {
    let upd;
    try {
      upd = await post('ilink/bot/getupdates', { base_info: BASE_INFO(), buf: cursor, limit: 20 }, { token });
    } catch (err) {
      log(`getupdates threw: ${err.message}`);
      break;
    }
    if (upd?.errcode === -14 || upd?.errmsg === 'session timeout') {
      log(`RESULT=session_timeout after ${seen.length} message(s) -- the token died, which is the known limit`);
      break;
    }
    const list = upd?.msg_list ?? upd?.messages ?? upd?.updates ?? [];
    if (Array.isArray(list) && list.length > 0) {
      for (const m of list) {
        seen.push(m);
        const from = m?.from_user_name ?? m?.from ?? '?';
        const text = m?.content ?? m?.text ?? '';
        console.log(`  MESSAGE  from=${from}  text=${typeof text === 'string' ? text : JSON.stringify(text)}`);
      }
    }
    if (typeof upd?.buf === 'string' && upd.buf !== '') {
      cursor = upd.buf;
      writeFileSync(CURSOR, cursor);
    }
    if (upd?.errcode && upd.errcode !== 0) {
      log(`getupdates errcode=${upd.errcode} errmsg=${upd.errmsg ?? ''}`);
    }
    await sleep(1500);
  } while (Date.now() < until);

  log(`RESULT=${seen.length} message(s) read`);
  if (seen.length === 0) {
    console.log('  (nothing arrived. If you sent a message while the QR was displayed, it may predate');
    console.log('   the session -- send another one now that the token is live, and re-run with --wait 20.)');
  } else {
    writeFileSync(`${OUT_DIR}/messages.json`, JSON.stringify(seen, null, 2));
    log(`raw messages saved to ${OUT_DIR}/messages.json`);
  }
}

main().catch((err) => {
  console.log('FAILED:', err?.stack ?? err);
  process.exit(1);
});
