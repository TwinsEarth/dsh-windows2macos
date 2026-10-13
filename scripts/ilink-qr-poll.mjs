/**
 * Poll one iLink QR login to completion, and print the result.
 *
 * The QR token is single-use and expires, so this is started *before* the user is handed the
 * link: the scan can then land at any moment and the login completes immediately.
 *
 * Usage: node scripts/ilink-qr-poll.mjs <qrcode> [--verify <code>] [--out <dir>]
 */

const QR_BASE = 'https://ilinkai.weixin.qq.com/';
const headers = {
  'content-type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
};

const argv = process.argv.slice(2);
const qrcode = argv[0];
if (!qrcode) {
  console.error('usage: node scripts/ilink-qr-poll.mjs <qrcode> [--verify <code>] [--out <dir>]');
  process.exit(2);
}
const verifyCode = argv.includes('--verify') ? argv[argv.indexOf('--verify') + 1] : null;
const minutes = argv.includes('--minutes') ? Number(argv[argv.indexOf('--minutes') + 1]) : 10;

const body = () => JSON.stringify({ base_info: { channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m-probe' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(endpoint, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, QR_BASE).toString(), {
      method: 'POST',
      headers,
      body: body(),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (error) {
    if (error.name === 'AbortError') return { ret: 0, timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);
const deadline = Date.now() + minutes * 60_000;
let last = null;
let polls = 0;

while (Date.now() < deadline) {
  polls += 1;
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  let status;
  try {
    status = await post(endpoint);
  } catch (error) {
    console.log(`[${stamp()}] poll ${polls}: transport error: ${error.message}`);
    await sleep(2000);
    continue;
  }
  if (status?.timedOut) continue;

  const s = status?.status ?? '(no status)';
  if (s !== last) {
    console.log(`[${stamp()}] poll ${polls}: status=${s} ret=${status?.ret} keys=${Object.keys(status ?? {}).join(',')}`);
    last = s;
  }

  if (s === 'need_verifycode' && !verifyCode) {
    console.log(`[${stamp()}] RESULT=need_verifycode  (re-run with --verify <code>; raw: ${JSON.stringify(status).slice(0, 300)})`);
    process.exit(3);
  }
  if (s === 'verify_code_blocked') {
    console.log(`[${stamp()}] RESULT=verify_code_blocked`);
    process.exit(4);
  }
  if (s === 'expired') {
    console.log(`[${stamp()}] RESULT=expired  (the QR must be re-minted)`);
    process.exit(5);
  }
  if (s === 'confirmed') {
    console.log(`[${stamp()}] RESULT=confirmed`);
    console.log('  bot_id:     ' + (status?.bot_id ?? '(none)'));
    console.log('  owner_user: ' + (status?.owner_user_id ?? '(none)'));
    console.log('  baseurl:    ' + (status?.baseurl ?? '(none)'));
    const token = status?.bot_token;
    console.log('  bot_token:  ' + (token ? `${String(token).slice(0, 10)}… (${String(token).length} chars)` : '(MISSING)'));
    console.log('  full keys:  ' + Object.keys(status ?? {}).join(','));
    if (argv.includes('--out') && token) {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dir = argv[argv.indexOf('--out') + 1];
      const path = join(dir, 'ilink-login.json');
      writeFileSync(
        path,
        JSON.stringify({ bot_token: token, baseurl: status?.baseurl, bot_id: status?.bot_id, owner_user_id: status?.owner_user_id }, null, 2),
        { mode: 0o600 },
      );
      console.log('  written:    ' + path + ' (mode 0600)');
    }
    process.exit(0);
  }
  await sleep(1500);
}
console.log(`[${stamp()}] RESULT=timeout after ${minutes} minutes`);
process.exit(6);
