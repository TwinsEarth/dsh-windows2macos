// ============================================================================
//  acceptance.mjs -- does the fleet actually take the direct path?
// ============================================================================
//
//  This script answers one question with evidence instead of optimism: for a real
//  dispatched task, which rung of the delivery ladder did each machine land on, and
//  why. It dispatches a command to every online machine through the relay's own
//  HTTP API, waits for the aggregate, and maps each machine's recorded facts
//  (`transport`, `p2p.offer_path`, `p2p.reason`) onto the ladder in README.md.
//
//  THE LADDER, and what the ledger calls it:
//
//    1  live channel       transport p2p + offer_path p2p     (a channel was already open)
//    2  simultaneous punch transport p2p + offer_path p2p     (both sides dialled -- A)
//    3  reverse dial       transport p2p + offer_path relay   (the result found its own way back -- B)
//       ...and the result of a level-3 task may itself report result_path p2p in the agent's log;
//       that log is on the machine, which is why this script reads the aggregate the relay keeps.
//    4  tunnel             transport p2p on a WireGuard address. NOT DETECTABLE FROM THE LEDGER:
//                          level 4 looks exactly like level 1-2 from here. See README.md -- a
//                          tunnel makes the fleet reachable, and the bytes still cross the VPS.
//    5  relay              transport relay                   (the fallback, always available)
//
//  USAGE
//
//    node deploy/networking/acceptance.mjs \
//      --rabbit http://202.182.123.154:8787 \
//      --token <operator token> \
//      --project /path/to/the/fleet/project \
//      --command 'git rev-parse HEAD'
//
//    --require-direct   exit non-zero when any machine falls to the relay, so this can
//                       be a gate rather than a report
//    --json             print the aggregate as JSON instead of a table
//
//  WHY --command TAKES PLAIN TEXT
//
//  A JSON array is the natural spelling and it does not survive the trip: measured on Windows,
//  `--command '["git","rev-parse","HEAD"]'` arrives as `[git,rev-parse,HEAD]` -- the quotes are
//  consumed before the script ever sees them (the same trap that produced the config file in
//  deploy/windows). So plain whitespace-separated text is the documented form; a string that does
//  start with `[` is still parsed as JSON for callers whose shell does not mangle it.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//
//  It does not test the punch itself, inject packets, or bypass the relay. The punch is the
//  protocol's business; this only reads what the protocol recorded after a real task. A script
//  that synthesised its own punches would prove that the script can punch, which nobody doubts.
// ============================================================================
import { headCommit, treeFingerprint } from '../../src/agent/git.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = `acceptance.mjs --rabbit <url> [--token <operator token>] [--project <dir>]
               [--command '<json argv>'] [--timeout-ms <n>] [--poll-ms <n>]
               [--require-direct] [--json] [--state-dir <dir>]`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const rabbit = String(args.rabbit ?? 'http://202.182.123.154:8787').replace(/\/+$/, '');
const token = typeof args.token === 'string' ? args.token : (process.env.W2M_OPERATOR_TOKEN ?? '');
const project = String(args.project ?? process.cwd());
const timeoutMs = Number(args['timeout-ms'] ?? 180_000);
const pollMs = Number(args['poll-ms'] ?? 1500);
const requireDirect = args['require-direct'] === true;
const asJson = args.json === true;
const rawCommand = typeof args.command === 'string' ? args.command.trim() : '';
const commandArgv = rawCommand === ''
  ? ['git', 'rev-parse', 'HEAD']
  : rawCommand.startsWith('[')
    ? JSON.parse(rawCommand)
    : rawCommand.split(/\s+/).filter(Boolean);

if (!token) {
  console.error('no operator token: pass --token or set W2M_OPERATOR_TOKEN (the relay prints it once)');
  process.exit(2);
}
if (!Array.isArray(commandArgv) || commandArgv.length === 0) {
  console.error("--command must be a command, e.g. --command 'git rev-parse HEAD' (or a JSON array)");
  process.exit(2);
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

/**
 * Reading a task back is a DEVICE-scoped read, so it needs the device token; dispatching is what the
 * operator token is for. Measured: `GET /v1/tasks/<id>` carrying the operator token answers
 * `401 UNAUTHORIZED: missing or invalid device_token`. The split is deliberate -- the credential that
 * can order work around cannot also read every machine's results -- so this script carries both,
 * exactly as the plugin does.
 */
async function get(path) {
  // Transient transport failures are the norm on a link between continents (measured: this exact
  // script dispatched fine and then had its first poll time out connecting to the relay). An
  // acceptance run that reports "the fleet is broken" because one TCP connect timed out would be
  // worse than useless, so polls retry; an HTTP error still fails immediately, because that is the
  // relay telling us something.
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(`${rabbit}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${deviceToken ?? token}` },
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        if (res.status === 401) {
          throw new Error(
            `GET ${path} -> 401 ${text}\n` +
              'reading a task needs a device token: point --state-dir at the directory holding device.json',
          );
        }
        throw new Error(`GET ${path} -> ${res.status} ${text}`);
      }
      return res.json();
    } catch (error) {
      lastError = error;
      const transient = error?.cause?.code !== undefined || /fetch failed|timeout/i.test(String(error?.message ?? ''));
      if (!transient) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, 2000 * attempt);
      });
    }
  }
  throw new Error(`GET ${path} failed after 5 attempts: ${lastError?.message ?? lastError}`);
}

/** This machine's own identity, when it has one -- `origin_machine_id` must be a real machine. */
function localIdentity() {
  const stateDir = typeof args['state-dir'] === 'string'
    ? String(args['state-dir'])
    : join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'xclient');
  try {
    const device = JSON.parse(readFileSync(join(stateDir, 'device.json'), 'utf8').replace(/^\uFEFF/, ''));
    return {
      machine_id: device.machine_id ?? null,
      name: device.machine_name ?? device.name ?? null,
      device_token: typeof device.device_token === 'string' && device.device_token !== '' ? device.device_token : null,
    };
  } catch {
    return { machine_id: null, name: null, device_token: null };
  }
}

/** One machine's recorded path, read as a rung of the ladder. */
function classify(machine) {
  const transport = machine.transport ?? null;
  const offerPath = machine.p2p?.offer_path ?? null;
  const reason = machine.p2p?.reason ?? null;
  if (machine.outcome === 'ok' && transport === 'p2p') {
    return {
      rung: offerPath === 'relay' ? 3 : 2,
      label: offerPath === 'relay' ? 'reverse dial (offer by relay, result direct)' : 'direct channel',
      reason,
    };
  }
  if (machine.outcome === 'ok' && transport === 'relay') return { rung: 5, label: 'relay fallback', reason };
  if (machine.outcome === 'ok') return { rung: null, label: `ok over ${transport ?? 'an unknown path'}`, reason };
  return { rung: null, label: `${machine.outcome ?? 'no outcome'}`, reason: machine.refusal_reason ?? reason };
}

const identity = localIdentity();
// Declared before the first read: reading a task needs the device token, and this machine's own
// device.json is where it lives (`--state-dir` when it is somewhere else).
const deviceToken = identity.device_token;

const health = await get('/healthz');
const devices = health.devices ?? health.device_count ?? '?';

const commit = await headCommit({ cwd: project });
const tree = await treeFingerprint({ cwd: project });
if (!commit || !tree.fingerprint) {
  console.error(`cannot fingerprint ${project}: commit=${commit} tree=${tree.fingerprint} error=${tree.error ?? 'none'}`);
  console.error('every machine is compared against these anchors, so the project must be a git work tree');
  console.error('sitting at the same commit as the machines you are testing.');
  process.exit(2);
}

const cwdRel = '.';
const body = {
  mode: 'replicate',
  command_argv: commandArgv,
  cwd_rel: cwdRel,
  index_total: 1,
  timeout_ms: timeoutMs,
  write: false,
  base_commit: commit,
  base_tree: tree.fingerprint,
  requirements: { toolchain: {}, platform: [] },
  compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true, redact: [] },
  halt: 'never',
  created_by: identity.name ?? 'acceptance',
  p2p: { mode: 'auto' },
  ...(identity.machine_id ? { origin_machine_id: identity.machine_id } : {}),
};

const created = await fetch(`${rabbit}/v1/task`, { method: 'POST', headers, body: JSON.stringify(body) });
if (!created.ok) {
  console.error(`POST /v1/task -> ${created.status} ${(await created.text()).slice(0, 300)}`);
  process.exit(2);
}
const { task_id: taskId, seq } = await created.json();
if (!asJson) {
  console.log(`task ${taskId} (seq ${seq}) -- ${commandArgv.join(' ')}`);
  console.log(`anchors  ${commit.slice(0, 12)} / ${tree.fingerprint.slice(0, 12)}  (${tree.fingerprint_algo ?? 'git-temp-index-tree/v1'})`);
  console.log(`relay    ${rabbit}  devices ${devices}\n`);
}

const TERMINAL = new Set(['done', 'refused', 'expired', 'failed']);
let aggregate = null;
const started = Date.now();
while (Date.now() - started < timeoutMs) {
  const status = await get(`/v1/tasks/${encodeURIComponent(taskId)}`);
  aggregate = status.aggregate;
  const leases = status.leases ?? [];
  if (leases.length > 0 && leases.every((lease) => TERMINAL.has(lease.state))) break;
  if (aggregate && aggregate.state && aggregate.state !== 'pending' && leases.length === 0) break;
  await new Promise((resolve) => {
    setTimeout(resolve, pollMs);
  });
}

if (!aggregate) {
  console.error('no aggregate came back before the timeout');
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify({ task_id: taskId, anchors: { base_commit: commit, base_tree: tree.fingerprint }, aggregate }, null, 2));
} else {
  // `|| 'unknown'` rather than `??`: an empty `states` array joins to '' and `??` would happily
  // print nothing, which is the one thing a verdict line must not do.
  const verdict = aggregate.state ?? aggregate.verdict ?? ((aggregate.states ?? []).join(', ') || 'unknown');
  console.log(`verdict  ${verdict}\n`);
  const rows = (aggregate.machines ?? []).map((machine) => {
    const verdict = classify(machine);
    return {
      machine: machine.machine_name ?? machine.machine_id,
      outcome: machine.outcome ?? '',
      exit: machine.exit_code ?? '',
      rung: verdict.rung ?? '-',
      path: machine.transport ?? '-',
      offer: machine.p2p?.offer_path ?? '-',
      note: verdict.label + (verdict.reason ? ` -- ${verdict.reason}` : ''),
    };
  });
  const width = Math.max(...rows.map((row) => row.machine.length), 7);
  console.log(`${'machine'.padEnd(width)}  outcome  exit  rung  path   offer  note`);
  for (const row of rows) {
    console.log(
      `${String(row.machine).padEnd(width)}  ${String(row.outcome).padEnd(7)}  ${String(row.exit).padEnd(4)}  ` +
        `${String(row.rung).padEnd(4)}  ${String(row.path).padEnd(5)}  ${String(row.offer).padEnd(5)}  ${row.note}`,
    );
  }
  const ladderRungs = rows.map((row) => row.rung).filter((rung) => typeof rung === 'number');
  console.log(
    `\nladder: ${ladderRungs.length > 0 ? ladderRungs.join(', ') : 'no rung recorded'}  ` +
      `(5 = relay; see deploy/networking/README.md for what each rung claims)`,
  );
  if (aggregate.notes?.length) for (const note of aggregate.notes) console.log(`note: ${note}`);
}

const fellBack = (aggregate.machines ?? []).some((machine) => classify(machine).rung === 5);
const incomplete = (aggregate.machines ?? []).some((machine) => machine.outcome !== 'ok');
if (requireDirect && (fellBack || incomplete)) {
  console.error('\n--require-direct: at least one machine did not take a direct path (or did not answer)');
  process.exit(1);
}
