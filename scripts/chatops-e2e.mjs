/**
 * The real end-to-end path: a WeChat message runs a command on the fleet.
 *
 * Not a test double anywhere. The bridge is the shipped one, the channel is the shipped adapter
 * talking to live WeChat, the executor is the shipped one talking to the live relay, and the
 * message is injected the way the platform injects one.
 *
 * Usage: node scripts/chatops-e2e.mjs [--say "<reply text>"] [--argv "node --test"] [--watch]
 *
 * `--watch` keeps polling WeChat and answering whatever arrives, which is the actual product. The
 * default does one synthetic dispatch and reports, so a run cannot hang on a human.
 */

import { readFileSync } from 'node:fs';
import { createBridge } from '../src/chatops/bridge.mjs';
import { createILinkChannel } from '../src/chatops/ilink.mjs';
import { createFleetExecutor } from '../src/chatops/fleet.mjs';
import { createChatopsActions } from '../src/chatops/actions.mjs';


const LOGIN = 'dist/ilink/ilink-login.json';
const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const say = argv.includes('--say') ? argv[argv.indexOf('--say') + 1] : null;
const command = argv.includes('--argv') ? argv[argv.indexOf('--argv') + 1].split(/\s+/) : ['node', '--test'];
const waitMs = argv.includes('--wait') ? Number(argv[argv.indexOf('--wait') + 1]) : 90_000;

const login = JSON.parse(readFileSync(LOGIN, 'utf8'));
const RABBIT = process.env.W2M_RABBIT_URL ?? 'http://202.182.123.154:8787';
const TOKEN = process.env.W2M_OPERATOR_TOKEN ?? readFileSync('dist/ilink/operator-token.txt', 'utf8').trim();

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---- the shipped pieces, wired exactly as apply() wires them -------------------------------
const channel = createILinkChannel({
  token: login.bot_token,
  apiBase: login.baseurl,
  audit: (e, d) => { if (!String(e).includes('poll-idle')) log(`  ilink ${e} ${JSON.stringify(d ?? {})}`); },
});

const executor = createFleetExecutor({
  rabbitUrl: RABBIT,
  token: TOKEN,
  audit: (e, d) => log(`  fleet ${e} ${JSON.stringify(d ?? {})}`),
});

// The peer, so policy admits exactly the human who scanned the code and nobody else.
const peer = login.ilink_user_id;
const actions = createChatopsActions({
  executor,
  host: {}, // no session surface in this harness; /sessions will say so, by design
  waitMs,
  audit: (e, d) => log(`  chatops ${e} ${JSON.stringify(d ?? {})}`),
});

const bridge = createBridge({
  channels: [channel],
  actions,
  policy: { trustedContacts: [`ilink:${peer}`] },
  throttleMs: 0,
  audit: (e, d) => log(`  bridge ${e} ${JSON.stringify(d ?? {})}`),
});

log(`peer (trusted) = ilink:${peer}`);
log(`relay          = ${RABBIT}`);
log(`channel        = ${channel.name}`);
await bridge.start();
log(`bridge started; channel state = ${channel.state}`);

/** Inject one message the way the platform does, and report what the bridge decided. */
async function deliver(text, label) {
  log(`→ inbound ${label}: ${JSON.stringify(text)}`);
  const started = Date.now();
  let outcome;
  try {
    outcome = await bridge.handleInbound({ windowKey: `user:${peer}`, talkerId: peer, text, addressed: true });
  } catch (error) {
    log(`  !! handleInbound threw: ${error.stack ?? error}`);
    return null;
  }
  log(`  action=${outcome.action}${outcome.name ? ` name=/${outcome.name}` : ''}${outcome.refusal ? ` refusal=${outcome.refusal}` : ''} in ${Date.now() - started}ms`);
  const sent = channel.sent ?? [];
  const last = sent.at(-1);
  if (last) log(`  reply → ${JSON.stringify(String(last.text).slice(0, 400))}`);
  return outcome;
}

try {
  // A live check first: the fleet, as the relay sees it.
  const devices = await executor.devices();
  if (!devices.ok) {
    log(`fleet unreachable: ${devices.text}`);
  } else {
    log(`fleet holds ${devices.devices.length} machine(s):`);
    for (const d of devices.devices) log(`  - ${d.name ?? d.machine_id}  ${d.platform ?? '?'}/${d.arch ?? '?'}  online=${d.online}`);
  }

  if (watch) {
    log('watching WeChat. Send a message to the bot; /help lists the commands. Ctrl-C to stop.');
    const seen = new Set();
    for (;;) {
      let inbound = [];
      try {
        inbound = await channel.pollOnce();
      } catch (error) {
        log(`  poll failed: ${error.message}`);
      }
      for (const message of inbound) {
        if (seen.has(message.messageId)) continue;
        seen.add(message.messageId);
        await deliver(message.text, `from ${message.talkerId}`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // One synthetic dispatch through the real bridge, so the result is deterministic.
  await deliver('/help', 'command surface');
  await deliver('/machines', 'fleet');
  await deliver(`/run ${command.join(' ')}`, 'fleet dispatch');
  if (say !== null) await deliver(say, 'prompt');

  if (channel.sent && channel.sent.length > 0) {
    log('replies the bridge produced:');
    for (const s of channel.sent) log(`  ---\n${String(s.text).split('\n').map((l) => `  | ${l}`).join('\n')}`);
  } else {
    log('NO REPLIES WERE PRODUCED — the bridge decided nothing needed answering');
  }
} finally {
  await bridge.stop();
  log('bridge stopped');
}
