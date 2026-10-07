/**
 * Diagnostic probe #2: why does a two-machine replicate come back `unverifiable`?
 *
 * Prints the per-machine envelopes and the Step 1 anchor comparison so the
 * mismatching field is named rather than guessed.
 *
 * Usage: node scripts/probe-anchors.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/DS/w2m';
const TMP = 'E:/DS/_work/w2m/probe-tmp';
const NODE = process.execPath;
const log = (m) => process.stdout.write(`[anchors] ${m}\n`);

function git(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, 'anchors-'));
const origin = join(root, 'origin');
mkdirSync(origin, { recursive: true });
git(['init', '--initial-branch=main', '.'], origin);
writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n');
writeFileSync(join(origin, 'app.mjs'), 'export const answer = 42;\n');
git(['add', '-A'], origin);
git(['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-m', 'base'], origin);
const base = git(['rev-parse', 'HEAD'], origin);
const a = join(root, 'a');
const b = join(root, 'b');
git(['worktree', 'add', '--detach', a, base], origin);
git(['worktree', 'add', '--detach', b, base], origin);

const { createRelayServer } = await import(pathToFileURL(join(ROOT, 'src/relay/server.mjs')).href);
const { createAgent } = await import(pathToFileURL(join(ROOT, 'src/agent/agent.mjs')).href);
const { loadOrCreateIdentity } = await import(pathToFileURL(join(ROOT, 'src/agent/identity.mjs')).href);
const { probeCaps, detectPlatform } = await import(pathToFileURL(join(ROOT, 'src/agent/caps.mjs')).href);
const { treeFingerprint } = await import(pathToFileURL(join(ROOT, 'src/agent/git.mjs')).href);

const caps = await probeCaps({});
const platform = await detectPlatform({});
const relay = createRelayServer({ pairingCodeReusable: true });
const info = await relay.listen({ host: '127.0.0.1', port: 0 });

const fpA = await treeFingerprint({ cwd: a });
const fpB = await treeFingerprint({ cwd: b });
log(`base_commit        = ${base}`);
log(`treeFingerprint(a) = ${JSON.stringify(fpA)}`);
log(`treeFingerprint(b) = ${JSON.stringify(fpB)}`);

const agents = [];
const running = [];
for (const [i, dir] of [a, b].entries()) {
  const stateDir = join(root, `state-${i}`);
  mkdirSync(stateDir, { recursive: true });
  const identity = loadOrCreateIdentity({ dir: stateDir, name: `anchors-${i}`, rabbitUrl: info.url }).identity;
  const agent = createAgent({
    rabbitUrl: info.url, project: dir, stateDir, identity, caps, platform,
    allowedCommands: ['node -e'], log: () => {},
  });
  agents.push(agent);
  await agent.pair(info.pairingCode);
  running.push(agent.start());
}
log('agents started');

const token = agents[0].identity.device_token;
const title = await fetch(`${info.url}/v1/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    mode: 'replicate',
    command_argv: [NODE, '-e', 'console.log("same")'],
    index_total: 1,
    timeout_ms: 20_000,
    write: false,
    // Anchors supplied by the operator, as the design intends: the relay cannot
    // know them because it never holds a working copy.
    base_commit: base,
    base_tree: fpA.fingerprint ?? fpA.tree ?? null,
  }),
});
const created = await title.json();
log(`task ${created.task_id} base_tree sent = ${fpA.fingerprint ?? fpA.tree ?? null}`);

for (let i = 0; i < 24; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const res = await fetch(`${info.url}/v1/tasks/${created.task_id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (body.aggregate?.status && body.aggregate.status !== 'pending') {
    log(`status = ${body.aggregate.status}`);
    log(`counts = ${JSON.stringify(body.aggregate.counts)}`);
    for (const m of body.aggregate.machines ?? []) {
      log(`machine ${m.machine_id.slice(0, 8)} outcome=${m.outcome} status=${m.status} lease=${m.lease_state}`);
      log(`   exit=${m.exit_code} refusal=${m.refusal_reason}`);
      log(`   reasons=${JSON.stringify(m.reasons ?? [])}`);
    }
    log(`steps = ${JSON.stringify(body.aggregate.steps, null, 1).slice(0, 1600)}`);
    log(`anchor notes = ${JSON.stringify(body.aggregate.notes ?? [])}`);
    log(`diffs = ${JSON.stringify(body.aggregate.differences ?? [])}`);
    break;
  }
  log(`poll ${i}: ${body.aggregate?.status}`);
}

for (const agent of agents) await agent.stop();
await Promise.allSettled(running);
await relay.close();
log('done');
