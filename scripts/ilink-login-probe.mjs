/**
 * A real iLink login probe (not a test).
 *
 * Sends the actual requests to WeChat's ClawBot endpoints, prints the QR image so it can be
 * scanned, and polls until the login resolves. Everything here is the protocol from
 * `src/host/ilink/api.ts` of the audited plugin, verbatim, because guessing field names is
 * how a QR scan fails with no useful error.
 *
 * Usage: node scripts/ilink-login-probe.mjs [--out <dir>] [--verify <code>]
 *
 * Writes nothing except the QR image and the resulting token, and the token only to stdout
 * unless --out is given. That is deliberate: a bot token is a credential.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QR_BASE = 'https://ilinkai.weixin.qq.com/';
const APP_ID = 'bot';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6); // 2.4.6
const PROTOCOL_VERSION = '2.4.6';
const BOT_TYPE = '3';

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const verifyCode = args.includes('--verify') ? args[args.indexOf('--verify') + 1] : null;

const headers = {
  'content-type': 'application/json',
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': CLIENT_VERSION,
};

const baseInfo = () => ({ channel_version: PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/w2m-probe' });

async function post(endpoint, body, { token, timeoutMs = 40_000 } = {}) {
  const url = new URL(endpoint, QR_BASE).toString();
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response: ${text.slice(0, 300)}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') return { ret: 0, timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('== step 1: request a binding QR ==');
  const qr = await post(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, { base_info: baseInfo() });
  console.log('   raw response keys:', Object.keys(qr ?? {}).join(', '));
  console.log('   ret:', qr?.ret, ' errmsg:', qr?.errmsg ?? qr?.err_msg ?? '(none)');

  const qrcode = qr?.qrcode;
  const qrcodeUrl = qr?.qrcode_img_content;
  if (typeof qrcode !== 'string' || qrcode === '') {
    console.error('   NO qrcode token in the response. Full body:');
    console.error('  ', JSON.stringify(qr).slice(0, 1200));
    process.exit(2);
  }
  console.log('   qrcode token:', qrcode);
  console.log('   qr image url:', qrcodeUrl ?? '(absent)');

  // Fetch the QR image so it can actually be scanned, and keep it locally.
  if (typeof qrcodeUrl === 'string' && qrcodeUrl !== '') {
    try {
      const img = await fetch(qrcodeUrl);
      const bytes = Buffer.from(await img.arrayBuffer());
      console.log(`   image: HTTP ${img.status}  ${bytes.length} bytes  type=${img.headers.get('content-type')}`);
      if (img.ok && bytes.length > 0) {
        const path = join(outDir ?? '.', 'wechat-login-qr.png');
        writeFileSync(path, bytes);
        console.log(`   SAVED: ${path}`);
      } else {
        console.error('   the image URL did not return an image');
      }
    } catch (error) {
      console.error('   could not fetch the image:', error.message);
    }
  }

  console.log('\n== step 2: poll for the scan ==');
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    let status;
    try {
      status = await post(endpoint, { base_info: baseInfo() }, { timeoutMs: 40_000 });
    } catch (error) {
      console.log(`   poll ${polls}: transport error ${error.message}`);
      await sleep(1500);
      continue;
    }
    if (status?.timedOut) {
      process.stdout.write('.');
      continue;
    }
    const s = status?.status ?? status?.state ?? '(none)';
    if (s !== last) {
      console.log(`\n   poll ${polls}: status=${s}  ret=${status?.ret}  keys=${Object.keys(status ?? {}).join(',')}`);
      last = s;
    }

    if (s === 'need_verifycode' && !verifyCode) {
      console.log('\n   *** WeChat is asking for a verification code (验证码) shown in the app. ***');
      console.log('   Re-run with:  node scripts/ilink-login-probe.mjs --verify <code>');
      console.log('   Raw:', JSON.stringify(status).slice(0, 400));
      process.exit(3);
    }
    if (s === 'verify_code_blocked') {
      console.error('\n   the verification code was refused too many times; wait and retry');
      process.exit(4);
    }
    if (s === 'expired') {
      console.error('\n   the QR expired before it was scanned; re-run to get a new one');
      process.exit(5);
    }
    if (s === 'scaned_but_redirect' || s === 'binded_redirect') {
      console.log(`   redirect: baseurl=${status?.baseurl ?? '(none)'} (continuing to poll)`);
    }
    if (s === 'confirmed') {
      console.log('\n== LOGIN CONFIRMED ==');
      const token = status?.bot_token;
      const base = status?.baseurl;
      console.log('   bot_id:      ', status?.bot_id ?? '(none)');
      console.log('   owner_user:  ', status?.owner_user_id ?? '(none)');
      console.log('   baseurl:     ', base ?? '(none)');
      console.log('   bot_token:   ', token ? `${String(token).slice(0, 12)}… (${String(token).length} chars)` : '(MISSING)');
      if (outDir) {
        const p = join(outDir, 'ilink-login.json');
        writeFileSync(p, JSON.stringify({ bot_token: token, baseurl: base, bot_id: status?.bot_id, owner_user_id: status?.owner_user_id }, null, 2), { mode: 0o600 });
        console.log('   token written to', p, '(mode 0600)');
      }
      console.log('\n   Full response keys:', Object.keys(status ?? {}).join(', '));
      process.exit(0);
    }
    await sleep(1500);
  }
  console.error('\n   timed out waiting for the scan (5 minutes)');
  process.exit(6);
}

main().catch((error) => {
  console.error('FAILED:', error?.stack ?? error);
  process.exit(1);
});
