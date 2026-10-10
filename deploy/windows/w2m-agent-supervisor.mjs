// W2M Localside agent supervisor — the process a Windows service (or service-mode task) runs.
//
// WHY A SUPERVISOR AND NOT THE AGENT ITSELF
//
// Measured, twice: an agent started directly by a task or a service manager can be gone forty
// seconds later with `0xC000013A` (STATUS_CONTROL_C_EXIT — the console it was attached to went
// away) and **no log line anywhere**, because whatever was logging died with it. The fleet then
// reports the machine offline and nothing explains why. This loop owns the child instead: it
// respawns with a capped backoff and writes one line per run, so "silently gone" becomes "run 3
// exited code=3221225786 after 41s -- restarting".
//
// It also owns the log, which a service needs: stdout of a session-0 process goes nowhere.
//
//   node w2m-agent-supervisor.mjs --config %USERPROFILE%\.dsh\w2m\agent.json
//
//   # or, for a manual run, the flags directly:
//   node w2m-agent-supervisor.mjs \
//     --bin <path to the installed w2m-localside.mjs> \
//     --rabbit http://202.182.123.154:8787 \
//     --project E:\path\to\project \
//     --name win-desktop \
//     --state %USERPROFILE%\.dsh\w2m\localside \
//     --allowed-commands '["node --test","git status --porcelain"]' \
//     --log %USERPROFILE%\.dsh\w2m\agent.log \
//     [--p2p-port 41235] [--p2p-mode auto]
//
// WHY `--config` EXISTS, AND WHY IT IS THE FORM A SERVICE USES
//
// Measured: a service manager and Task Scheduler both mangle a JSON argument. The task's stored
// command line came back as `--allowed-commands "[node --version,node --test]"` -- the escaped
// quotes were gone, so the agent read `[node` and exited 2 with ALLOWED_COMMANDS_INVALID. Passing
// JSON through another program's command line is the trap this project has now hit three times
// (cmd, PowerShell 5.1, Task Scheduler). A config file has no quoting rules at all, it is one more
// thing the installer can write atomically, and it stays readable for whoever debugs the service.
//
// Nothing here is Windows-specific except the defaults; the same supervisor works on POSIX hosts.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Minimal `--flag value` / `--flag` parser: no dependency, no surprises. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';

/** The config file, when one was named. `--config` wins over the defaults, flags win over it. */
const configPath = typeof args.config === 'string' ? args.config : null;
let file = {};
if (configPath !== null) {
  try {
    // A BOM is stripped rather than rejected. Measured: PowerShell 5.1's `Set-Content -Encoding
    // utf8` writes one, `JSON.parse` refuses it, and the failure looks like "the config is
    // missing" -- the supervisor exited 78 with no log line because it had not opened the log yet.
    // Notepad writes BOMs too, so a hand-edited config would hit the same wall.
    const text = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    file = JSON.parse(text);
  } catch (error) {
    console.error(`w2m-supervisor: cannot read --config ${configPath}: ${error.message}`);
    process.exit(78); // EX_CONFIG
  }
}
/**
 * One setting, from either source.
 *
 * The command line uses the agent's own kebab-case flags (`--allowed-commands`); the JSON config
 * uses the camelCase name (`allowedCommands`), because it is JSON and reads better that way. Both
 * are accepted in both places rather than documented as different namespaces -- the first version
 * only looked for the kebab key in the file, so a perfectly correct config silently fell back to
 * the four-entry default allow-list. Silent, because a missing key is not an error.
 */
const camel = (key) => key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
const pick = (key, fallback) => {
  if (typeof args[key] === 'string') return args[key];
  if (typeof args[camel(key)] === 'string') return args[camel(key)];
  const value = file[key] ?? file[camel(key)];
  return value === undefined ? fallback : value;
};
const pickList = (key, fallback) => {
  if (typeof args[key] === 'string') return args[key];
  const value = file[key] ?? file[camel(key)];
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string' && value !== '') return value;
  return fallback;
};

// The installed package's bin is the default, because a service must run what the profile
// actually has: the plugin's updater replaces that copy and the next restart picks it up.
const defaultBin = join(
  process.env.DSH_HOME ?? join(home, '.dsh'),
  'profiles',
  process.env.DSH_PROFILE ?? 'desktop',
  'node_modules',
  '@twinsearth',
  'w2m-dsh-plugin',
  'bin',
  'w2m-localside.mjs',
);

const bin = pick('bin', defaultBin);
const rabbit = pick('rabbit', 'http://202.182.123.154:8787');
const project = pick('project', process.cwd());
const name = pick('name', 'win-desktop');
const state = pick('state', join(home, '.dsh', 'w2m', 'localside'));
const logPath = pick('log', join(home, '.dsh', 'w2m', 'agent.log'));
const allowed = pickList('allowed-commands', '["node --version","node --test","git status --porcelain","git rev-parse"]');
const backoffRaw = pick('backoff-ms', 60_000);
const backoffMs = Number.isFinite(Number(backoffRaw)) ? Number(backoffRaw) : 60_000;

/** Extra agent arguments: `agentArgs` in the config, `--flag value` on the command line. */
const consumed = new Set([
  'config', 'bin', 'rabbit', 'project', 'name', 'state', 'log', 'allowed-commands', 'backoff-ms', 'agent-args',
]);
const passthrough = [];
const fileAgentArgs = file.agentArgs ?? file['agent-args'];
// BOTH SHAPES, because both happen. The installer writes an array, but `ConvertTo-Json` collapses a
// single-element array to a string -- and this only handled the array, so `--p2p-mode auto` was
// silently dropped and the agent ran on its defaults. Silent, because an ignored field is not an
// error. A string is split on whitespace instead.
if (Array.isArray(fileAgentArgs)) passthrough.push(...fileAgentArgs.map(String));
else if (typeof fileAgentArgs === 'string') passthrough.push(...fileAgentArgs.split(/\s+/).filter(Boolean));
if (typeof args['agent-args'] === 'string') passthrough.push(...args['agent-args'].split(/\s+/).filter(Boolean));
for (const [key, value] of Object.entries(args)) {
  if (consumed.has(key)) continue;
  passthrough.push(`--${key}`);
  if (value !== true) passthrough.push(String(value));
}

if (!existsSync(bin)) {
  console.error(`w2m-supervisor: no agent at ${bin}`);
  console.error('install the plugin first: dsh plugin --profile desktop add <release tarball>');
  process.exit(78); // EX_CONFIG: a service manager should not keep retrying this
}

mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: 'a' });
// A second handle on the same file, as a descriptor: this is what the detached agent writes into,
// because a descriptor is not connected to this process's console or to any pipe of ours.
const logFd = openSync(logPath, 'a');
const stamp = () => new Date().toISOString();
const say = (line) => {
  console.log(line);
  log.write(`${line}\n`);
};

const argv = [
  bin,
  '--rabbit', rabbit,
  '--project', project,
  '--name', name,
  '--state', state,
  '--allowed-commands', allowed,
  ...passthrough,
];

say(`[w2m-supervisor ${stamp()}] supervising ${process.execPath} ${argv.join(' ')}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    stopping = true;
  });
}

// Declared before the heartbeat block, which reads it: a `let` referenced earlier in the same scope
// would be a temporal-dead-zone throw, not an undefined value.
let runs = 0;

// ---------------------------------------------------------------------------------------------
// HEARTBEAT AND DEGRADED MARKER
//
// WHY FILES AND NOT LOG LINES: the failure this exists for is a console-teardown death, and a death
// that arrives with the console cannot be logged from inside the process it kills -- the log simply
// stops. A file that an outside observer reads has no such dependency, so a watchdog task, a human,
// or (later) the fleet can answer "is this machine working?" without parsing a log that may itself be
// truncated.
//
// The state is one of:
//   running   a worker is alive right now
//   backoff   between runs, within the healthy band
//   degraded  the crash-loop breaker has tripped: too many exits inside the window, so the fleet
//             should see a machine that is present but unhealthy rather than one that is gone
//
// Written atomically (temp file + rename) so a reader never sees half a JSON document.
// ---------------------------------------------------------------------------------------------
const heartbeatPath = join(dirname(logPath), 'supervisor-heartbeat.json');
const degradedAfter = Number.isFinite(Number(pick('degraded-after', 3))) ? Number(pick('degraded-after', 3)) : 3;
const degradedWindowMs = 10 * 60_000;
const degradedBackoffMs = Number.isFinite(Number(pick('degraded-backoff-ms', 300_000)))
  ? Number(pick('degraded-backoff-ms', 300_000))
  : 300_000;
const exitTimes = [];

function writeHeartbeat(patch) {
  const recent = exitTimes.filter((at) => Date.now() - at < degradedWindowMs).length;
  const state = patch.state ?? (recent >= degradedAfter ? 'degraded' : 'backoff');
  const record = {
    updated_at: stamp(),
    state,
    supervisor_pid: process.pid,
    run: patch.run ?? runs,
    child_pid: patch.child_pid ?? null,
    child_started_at: patch.child_started_at ?? null,
    restarts_total: Math.max(0, runs - 1),
    restarts_within_10min: recent,
    last_exit_code: patch.last_exit_code ?? null,
    last_exit_at: patch.last_exit_at ?? null,
    // The known killer, recorded in decimal because that is how Node reports it: 3221225786 is
    // 0xC000013A, STATUS_CONTROL_C_EXIT. Signed, it is -1073741510.
    note: 'exit code 3221225786 means the console went away; it is not a crash of the agent logic',
    project,
    rabbit,
  };
  try {
    const tmp = `${heartbeatPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tmp, heartbeatPath);
  } catch (error) {
    say(`[w2m-supervisor] could not write the heartbeat: ${error.message}`);
  }
  return record;
}

writeHeartbeat({ state: 'backoff' });
// ---------------------------------------------------------------------------------------------
// START-TIME REAPING -- the cost of detaching the agent, paid here
//
// Detaching the agent is what stops a console teardown from taking the machine off the fleet, and it
// has a price that was measured: every supervisor generation that dies without stopping its child
// leaves an orphan behind. Three agents with one identity were found running at once, the newest
// unable to bind the punch port (`P2P_BIND_FAILED: EADDRINUSE 0.0.0.0:41235`) because an orphan held
// it -- two streams on one device token, and a port that pins nothing.
//
// So the supervisor reaps what it did not start: the heartbeat names the last child, and if that pid
// is still alive when a new supervisor starts, it is a previous generation's orphan and is terminated
// before anything else runs. "Trust a graceful exit" is exactly the assumption that failed.
// ---------------------------------------------------------------------------------------------
try {
  const previous = JSON.parse(readFileSync(heartbeatPath, 'utf8').replace(/^\uFEFF/, ''));
  const orphan = Number(previous.child_pid);
  if (Number.isInteger(orphan) && orphan > 0 && orphan !== process.pid) {
    let alive = true;
    try {
      process.kill(orphan, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(orphan);
        say(`[w2m-supervisor] reaped orphan agent pid=${orphan} left by an earlier supervisor`);
        await new Promise((resolve) => {
          setTimeout(resolve, 1500);
        });
      } catch (error) {
        say(`[w2m-supervisor] could not reap orphan pid=${orphan}: ${error.message}`);
      }
    }
  }
} catch {
  // No heartbeat yet, or unreadable: nothing to reap, and that is not an error worth stopping for.
}
// A periodic beat, so "the supervisor itself is alive but a worker is wedged" is visible too.
const beat = setInterval(() => writeHeartbeat({}), 30_000);
beat.unref();

while (!stopping) {
  runs += 1;
  const startedAt = Date.now();
  // ---------------------------------------------------------------------------------------------
  // THE AGENT MUST NOT SHARE THIS PROCESS'S CONSOLE.
  //
  // Measured twice on the fleet: the whole tree -- supervisor and agent together -- is killed with
  // 0xC000013A (STATUS_CONTROL_C_EXIT, "the console went away"), the log ends mid-sentence, and
  // nothing restarts it. A supervisor that shares the console dies with the thing it supervises,
  // which was its one job. A study of v2rayN (GPL-3.0, read-only; see deploy/networking/LESSONS.md)
  // turned up why its core cannot die this way: it is started with no console window and redirected
  // stdio at all.
  //
  // `detached: true` plus stdio that is NOT connected to this process is the documented way to make
  // a long-running child independent of its parent's console: with `detached`, a long-running child
  // "will not stay running in the background after the parent exits unless it is provided with a
  // `stdio` configuration that is not connected to the parent". So the agent gets file descriptors --
  // never `inherit`, never pipes -- and that is the whole of the console-severing change.
  //
  // NOT `child.unref()`. It was the obvious-looking addition and it is wrong here: unref'ing the
  // child leaves this process with no handle at all, so its event loop drains and **the supervisor
  // exits immediately after spawning the agent** -- measured, and caught by noticing that no
  // supervisor process existed at all. `unref()` is for a parent that intends to leave; this one
  // exists to stay. Pipes would be the other trap: a detached child writing into a pipe whose reader
  // has died blocks instead of failing loudly, which is why the log is a descriptor.
  // ---------------------------------------------------------------------------------------------
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  writeHeartbeat({ state: 'running', child_pid: child.pid ?? null, child_started_at: stamp() });

  const result = await new Promise((resolve) => {
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.on('error', (error) => {
      say(`[w2m-supervisor] spawn failed: ${error.message}`);
      resolve({ exitCode: null, signal: null });
    });
  });
  exitTimes.push(Date.now());

  const lived = Math.round((Date.now() - startedAt) / 1000);
  say(
    `[w2m-supervisor] run ${runs} exited code=${result.exitCode} signal=${result.signal} after ${lived}s` +
      `${stopping ? ' (stopping)' : ' -- restarting'}`,
  );
  if (stopping) break;
  const record = writeHeartbeat({ last_exit_code: result.exitCode, last_exit_at: stamp() });
  // Degraded is not "give up": it is "stop hammering and say so". The marker file is what makes the
  // difference visible from outside -- the fleet can then see a machine that is present and unwell
  // instead of one that silently vanished, which is the failure this whole file exists for.
  const wait = record.state === 'degraded' ? degradedBackoffMs : backoffMs;
  if (record.state === 'degraded') {
    say(
      `[w2m-supervisor] degraded: ${record.restarts_within_10min} exits within 10 minutes -- ` +
        `backing off ${Math.round(wait / 1000)}s and marking ${heartbeatPath}`,
    );
  }
  // Deliberately NOT unref'ed: an unref'ed timer with nothing else pending lets Node exit during the
  // backoff, which is the silent death this loop exists to prevent.
  await new Promise((resolve) => {
    setTimeout(resolve, wait);
  });
}
writeHeartbeat({ state: 'stopped' });
log.end();
