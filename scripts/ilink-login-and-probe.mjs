/**
 * Full iLink login-and-probe cycle, with no human in the middle of the timing.
 *
 * Why this exists: the session returned by a QR login answers `errcode: -14, "session
 * timeout"` to every authenticated call, and the token was only ~30 seconds old when that was
 * first observed. Either the session is never activated, or it expires faster than a human can
 * open a browser and scan. Those have different fixes, so this script closes the gap: it mints
 * a QR, waits for the scan, and the moment the login confirms it exercises every endpoint
 * immediately.
 *
 * Usage: node scripts/ilink-login-and-probe.mjs [--minutes 5]
 */

import { writeFileSync } from 'node:fs';

const QR_BASE = 'https://ilinkai.weixin.qq.com/';
const HEADERS = {
  'content-type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
};
const BASE_INFO = () => ({ channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m-probe' });

const argv = process.argv.slice(2);
const minutes = argv.includes('--minutes') ? Number(argv[argv.indexOf('--minutes') + 1]) : 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function post(endpoint, payload, { token, base = QR_BASE, timeoutMs = 20_000 } = {}) {
  const headers = { ...HEADERS };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(new URL(endpoint, base).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return { http: response.status, ms: Date.now() - started, text: text.slice(0, 500) };
  } catch (error) {
    return { http: 'ERR', ms: Date.now() - started, text: `${error.name}: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- step 1: a fresh QR --------------------------------------------------------------
const qr = JSON.parse((await post('ilink/bot/get_bot_qrcode?bot_type=3', { base_info: BASE_INFO() })).text);
console.log(`[${stamp()}] QR minted: qrcode=${qr.qrcode}`);
console.log(`[${stamp()}] SCAN THIS: ${qr.qrcode_img_content}`);

// ---- step 2: wait for the scan -------------------------------------------------------
const deadline = Date.now() + minutes * 60_000;
let confirmed = null;
let last = null;
while (Date.now() < deadline) {
  const r = await post(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { base_info: BASE_INFO() }, { timeoutMs: 30_000 });
  let s;
  try {
    s = JSON.parse(r.text);
  } catch {
    await sleep(1200);
    continue;
  }
  if (s.status !== last) {
    console.log(`[${stamp()}] status=${s.status} ret=${s.ret} keys=${Object.keys(s).join(',')}`);
    last = s.status;
  }
  if (s.status === 'expired') {
    console.log('RESULT=qr_expired');
    process.exit(5);
  }
  if (s.status === 'confirmed') {
    confirmed = s;
    break;
  }
  await sleep(1200);
}
if (!confirmed) {
  console.log('RESULT=timeout_waiting_for_scan');
  process.exit(6);
}

const token = confirmed.bot_token;
const base = confirmed.baseurl && !confirmed.baseurl.endsWith('/') ? `${confirmed.baseurl}/` : confirmed.baseurl ?? QR_BASE;
console.log(`[${stamp()}] CONFIRMED  bot_id=${confirmed.ilink_bot_id}  user_id=${confirmed.ilink_user_id}`);
console.log(`[${stamp()}] baseurl=${base}  token=${String(token).slice(0, 8)}…(${String(token).length})`);
writeFileSync(
  'dist/ilink/ilink-login.json',
  JSON.stringify({ bot_token: token, baseurl: base, ilink_bot_id: confirmed.ilink_bot_id, ilink_user_id: confirmed.ilink_user_id }, null, 2),
  { mode: 0o600 },
);
console.log(`[${stamp()}] saved dist/ilink/ilink-login.json (0600)`);

// ---- step 3: exercise everything immediately, with no human delay ---------------------
const probe = async (label, endpoint, payload, opts = {}) => {
  const r = await post(endpoint, payload, { token, base, timeoutMs: 25_000, ...opts });
  console.log(`[${stamp()}] ${label}  http=${r.http} ${r.ms}ms  ${r.text}`);
  return r;
};

console.log(`[${stamp()}] --- immediate probe (T+0) ---`);
await probe('notifystart  ', 'ilink/bot/msg/notifystart', { base_info: BASE_INFO() });
const upd = await probe('getupdates   ', 'ilink/bot/getupdates', { get_updates_buf: '', base_info: BASE_INFO() }, { timeoutMs: 40_000 });
await probe('sendmessage  ', 'ilink/bot/sendmessage', {
  msg: {
    from_user_id: '',
    to_user_id: confirmed.ilink_user_id ?? '',
    client_id: 'w2m-probe-1',
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: 'w2m probe: hello from the Windows host' } }],
  },
  base_info: BASE_INFO(),
});

// ---- step 4: does the session survive? ----------------------------------------------
console.log(`[${stamp()}] --- waiting 20s to see whether the session persists ---`);
await sleep(20_000);
await probe('getupdates+20', 'ilink/bot/getupdates', { get_updates_buf: '', base_info: BASE_INFO() }, { timeoutMs: 40_000 });

console.log(`[${stamp()}] RESULT=probe_complete`);
console.log('  getupdates raw: ' + upd.text);
