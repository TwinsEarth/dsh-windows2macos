/**
 * Mint an iLink login QR and render it as scannable ASCII, with no dependencies.
 *
 * `ilink-login-and-probe.mjs` prints `qrcode_img_content`, which is a **URL to a PNG**, not a
 * scannable matrix — so a human cannot scan it from a terminal. `qrcode-terminal` would render one
 * from text, but only from the *text* being encoded, and here the text is whatever the QR image
 * encodes, which we do not know. So the image is fetched, decoded, and drawn.
 *
 * Decoding a QR in pure JavaScript is a large job, so this does not attempt it. Instead it:
 *
 *   1. fetches the QR PNG,
 *   2. decodes the PNG (zlib inflate + PNG unfiltering — the only part that has to be real), and
 *   3. prints the **image itself** as half-block characters, which is exactly what a phone camera
 *      needs. No matrix decoding, no error correction, no format parsing: the pixels are the code.
 *
 * The PNG path is chosen because every QR service returns a PNG, and Node ships `zlib`, so this
 * needs nothing installed. A JPEG or a WebP is refused by name rather than mis-rendered.
 *
 * Usage: node scripts/ilink-qr-ascii.mjs [--minutes 5] [--size 2]
 */

import { writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const QR_BASE = 'https://ilinkai.weixin.qq.com/';
const HEADERS = {
  'content-type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
  // Undocumented and mandatory: without it every call answers 401 with no explanation.
  AuthorizationType: 'ilink_bot_token',
};
const BASE_INFO = () => ({ channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/w2m-qr' });

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const minutes = Number(opt('--minutes', 5));
// Each character cell is 2 pixels tall (upper half block), so a cell also covers 2 horizontal
// pixels to stay square. `--size 2` therefore prints the QR at 2x, which is what a phone needs
// when the terminal font is small.
const scale = Math.max(1, Number(opt('--size', 2)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);

async function post(endpoint, payload, { token, timeoutMs = 20_000 } = {}) {
  const headers = { ...HEADERS };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, QR_BASE).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode a PNG into `{width, height, get(x,y)}` with 1-bit luminance.
 *
 * Only the subset every QR PNG uses: 8-bit greyscale or RGB/RGBA, no interlacing. Anything else is
 * refused with the reason, because a silently mis-decoded QR produces a code that scans to
 * nothing and looks like a WeChat problem.
 */
function decodePng(buffer) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(SIG)) throw new Error('not a PNG (bad signature)');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  /**
   * 1-bit greyscale, which is what a QR service usually returns because a QR *is* one bit per pixel.
   *
   * A first version supported only 8-bit and refused this, and the fallback renderer's output was
   * drawn wrongly — the quiet zone came out as solid blocks. A QR drawn inverted is not a slightly
   * worse QR; it is one no camera reads.
   */
  if (bitDepth === 1 && colorType === 0) {
    const raw = inflateSync(Buffer.concat(idat));
    const stride = Math.ceil(width / 8);
    const out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
      const cur = out.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x += 1) {
        const a = x >= 1 ? cur[x - 1] : 0;
        const b = prev === null ? 0 : prev[x];
        const c = prev === null || x < 1 ? 0 : prev[x - 1];
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v & 0xff;
      }
    }
    // 1 = black in a greyscale PNG.
    return {
      width,
      height,
      dark: (x, y) => ((out[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) === 1,
    };
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // PNG unfiltering, per scanline. `a` is the pixel to the left, `b` the one above, `c` the one
  // above-left -- the standard prediction filters.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev === null || x < channels ? 0 : prev[x - channels];
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }

  return {
    width,
    height,
    /** True when the pixel is dark. QR modules are dark-on-light, and the quiet zone is light. */
    dark(x, y) {
      const i = y * stride + x * channels;
      if (channels === 1) return out[i] < 128;
      const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
      return lum < 128;
    },
  };
}

/** Draw a 1-bit image using half blocks, which doubles the vertical resolution of a text cell. */
function render(img) {
  const { width, height } = img;
  const cellW = 1;
  const lines = [];
  for (let y = 0; y + 1 < height; y += 2) {
    let row = '';
    for (let x = 0; x < width; x += cellW) {
      const top = img.dark(x, y);
      const bottom = img.dark(x, y + 1);
      // ' ' none, '▀' top, '▄' bottom, '█' both. Scanners want dark modules on light, and a
      // terminal usually renders light text on a dark background, so invert: dark modules become
      // spaces and light ones become blocks.
      row += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(row);
  }
  // Repeat horizontally `scale` times so the aspect ratio stays square, since a terminal cell is
  // about twice as tall as it is wide.
  const wide = lines.map((l) => l.split('').map((ch) => ch.repeat(scale)).join(''));
  return (scale > 1 ? wide.flatMap((l) => [l, l]) : wide).join('\n');
}

async function main() {
  log('minting a login QR...');
  const qr = await post('ilink/bot/get_bot_qrcode?bot_type=3', { base_info: BASE_INFO() });
  if (!qr || typeof qr.qrcode !== 'string') {
    console.log('FAILED to mint a QR:', JSON.stringify(qr).slice(0, 400));
    process.exit(1);
  }
  log(`qrcode = ${qr.qrcode}`);

  const imgUrl = qr.qrcode_img_content;
  if (typeof imgUrl !== 'string' || imgUrl === '') {
    console.log('no qrcode_img_content was returned; cannot render');
    process.exit(1);
  }
  log(`image  = ${imgUrl}`);

  let img;
  try {
    const res = await fetch(imgUrl, { signal: AbortSignal.timeout(20_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    img = decodePng(buf);
  } catch (err) {
    // The endpoint answers `text/html` and draws the QR in the browser, so there is no bitmap to
    // decode. The *content* of the code is the URL itself, so a renderer is asked to encode that
    // URL and the result is drawn here.
    //
    // ## The disclosure this makes, stated rather than left implicit
    //
    // It sends the login URL to a third-party QR service. That URL is a **single-use login token**,
    // and anyone who scans it first becomes the bot's operator — so this is a real, if narrow,
    // exposure, not a theoretical one. It is a deliberate trade for being able to scan from a
    // terminal at all, it is bounded by the code's short life, and it is **reported**: the service
    // used is named in the output and `--no-third-party` refuses it in favour of printing the URL.
    if (argv.includes('--no-third-party')) {
      console.log(`could not render the QR image (${err.message}); --no-third-party was given.`);
      console.log('Scan this instead, from the phone itself or another screen:');
      console.log(imgUrl);
      process.exit(0);
    }
    log(`the iLink endpoint returned no bitmap (${err.message}); asking a renderer to encode the URL`);
    const renderers = [
      ['api.qrserver.com', (t) => `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data=${encodeURIComponent(t)}`],
      ['quickchart.io', (t) => `https://quickchart.io/qr?size=420&margin=10&text=${encodeURIComponent(t)}`],
    ];
    for (const [name, build] of renderers) {
      try {
        const res = await fetch(build(imgUrl), { signal: AbortSignal.timeout(25_000) });
        img = decodePng(Buffer.from(await res.arrayBuffer()));
        log(`rendered via ${name} (the login URL was sent to it; use --no-third-party to avoid that)`);
        break;
      } catch (renderErr) {
        log(`  ${name} failed: ${renderErr.message}`);
      }
    }
    if (img === undefined) {
      log('no renderer produced a decodable image; scan the URL directly');
      console.log(imgUrl);
      process.exit(0);
    }
  }

  console.log('');
  console.log('='.repeat(Math.min(120, img.width + 8)));
  console.log(render(img));
  console.log('='.repeat(Math.min(120, img.width + 8)));
  console.log('');
  console.log('Scan with WeChat. If the camera will not lock on, open this URL on the phone:');
  console.log(imgUrl);
  console.log('');

  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(2500);
    let status;
    try {
      status = await post(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, {
        base_info: BASE_INFO(),
      });
    } catch (err) {
      last = `poll error: ${err.message}`;
      continue;
    }
    const state = String(status?.status ?? status?.state ?? '');
    if (state && state !== last) {
      log(`status = ${state}`);
      last = state;
    }
    if (state === 'confirmed' || state === 'scaned' || status?.bot_token) {
      const token = status.bot_token ?? status.token ?? null;
      const out = {
        bot_token: token,
        baseurl: status.baseurl ?? QR_BASE,
        ilink_bot_id: status.ilink_bot_id ?? null,
        ilink_user_id: status.ilink_user_id ?? null,
        obtained_at: new Date().toISOString(),
        raw_status: status,
      };
      const file = new URL('../dist/ilink/ilink-login.json', import.meta.url);
      try {
        writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
        log(`token written to ${file.pathname} (0600)`);
      } catch (err) {
        log(`could not write the token file: ${err.message}`);
      }
      log(`RESULT=confirmed  ilink_bot_id=${out.ilink_bot_id}  token=${token ? `${token.length} chars` : 'MISSING'}`);
      console.log(JSON.stringify({ ...out, raw_status: undefined }, null, 2));
      process.exit(0);
    }
    if (state === 'expired') {
      log('RESULT=qr_expired -- run this again for a fresh code');
      process.exit(2);
    }
  }
  log('RESULT=timeout -- nobody scanned within the window');
  process.exit(3);
}

main().catch((err) => {
  console.log('FAILED:', err?.stack ?? err);
  process.exit(1);
});
