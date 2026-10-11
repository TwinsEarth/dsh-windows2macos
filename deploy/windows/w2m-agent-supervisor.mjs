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
// ONE SUPERVISOR, ONE AGENT -- WHY THE LOCK EXISTS
//
// Measured on this machine, over one afternoon: the watchdog trigger restarted the supervisor every
// five minutes while the previous generation's *detached* agent was still alive, and the start-time
// reap below could only ever see the single pid the heartbeat remembered. Fourteen `w2m` processes
// accumulated, nine of them `w2m-localside` agents sharing one identity. The punch port (41235) was
// held by an agent started thirteen hours earlier, so every later agent logged
// `P2P_BIND_FAILED: bind EADDRINUSE 0.0.0.0:41235`, the relay saw `streams: 9`, and every dispatch
// fell back to the relay with `P2P_UNREACHABLE`. The machine was on the fleet and useless for
// fourteen hours, and nothing in the heartbeat said so.
//
// The lock at the top of this file is what makes "one supervisor, one agent" true *by construction*
// rather than by remembering to clean up: a second supervisor generation cannot start work at all.
// Nothing here is Windows-specific except the defaults; the same supervisor works on POSIX hosts.
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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

// Where this generation's lock, heartbeat and sidecar state live. The log's directory is the run
// directory: everything the installer wrote for one service sits together, and two services with
// different logs are two unrelated installations that must not share a lock.
const PROC_MARKER_AGENT = 'w2m-localside';
const PROC_MARKER_SUPERVISOR = 'w2m-agent-supervisor';

/**
 * Does this command line belong to a supervisor of THIS installation?
 *
 * Used for two decisions that must agree with each other: whether a pid recorded in the lock is still
 * a supervisor (the lock may be taken over otherwise), and whether a process of this identity is an
 * agent to reap or a supervisor to leave alone. A supervisor's command line carries the agent stub's
 * path -- `--bin ...\w2m-localside-stub.mjs` -- so "mentions w2m-localside" is true of a supervisor,
 * and a reap that matched on identity alone would kill its own program. Measured: it did.
 */
function isSupervisorCommandLine(cmd) {
  return (
    typeof cmd === 'string' &&
    cmd.includes(PROC_MARKER_SUPERVISOR) &&
    cmd.includes('--config') &&
    (configPath === null || cmd.includes(configPath))
  );
}
const runDir = dirname(logPath);
mkdirSync(runDir, { recursive: true });
// A second handle on the same file, as a descriptor: this is what the detached agent writes into,
// because a descriptor is not connected to this process's console or to any pipe of ours.
const logFd = openSync(logPath, 'a');
const stamp = () => new Date().toISOString();
/**
 * One line, two destinations, both synchronous, and both for a measured reason.
 *
 * The log is written with `appendFileSync` rather than through a `WriteStream`: a stream buffers, and
 * the generation that most needs to explain itself is the one that exits immediately -- the watchdog
 * tick that finds the lock held prints its no-op line and exits, while a buffered write is still in
 * memory and is discarded with the process. Measured: the line was missing from the log, so the log
 * said nothing about the most common thing this file now does.
 */
const say = (line) => {
  console.log(line);
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* the console line is still out; a log that cannot be written must not stop the supervisor */
  }
};
/**
 * An opt-in trace of the decisions that are otherwise only visible as their consequences, written
 * as a JSON line per event. `verify-supervisor.mjs` sets `W2M_SUPERVISOR_TRACE` when it needs to
 * explain a failure; nothing in a normal service run sets it, and an unset variable costs one
 * comparison.
 */
const tracePath = typeof process.env.W2M_SUPERVISOR_TRACE === 'string' && process.env.W2M_SUPERVISOR_TRACE !== ''
  ? process.env.W2M_SUPERVISOR_TRACE
  : null;
const traceFd = tracePath === null ? null : openSync(tracePath, 'a');
function trace(event, detail) {
  if (traceFd === null) return;
  try {
    writeSync(traceFd, `${JSON.stringify({ at: stamp(), event, ...detail })}\n`);
  } catch {
    /* a trace that cannot be written must never be a reason to stop supervising */
  }
}
// The last line of defence: a process that vanishes without a word is the exact failure this file
// exists to make impossible, so nothing is allowed to end it silently.
process.on('uncaughtException', (error) => {
  trace('uncaught-exception', { message: error?.message ?? String(error), stack: error?.stack ?? null });
  say(`[w2m-supervisor] uncaught exception: ${error?.stack ?? error?.message ?? String(error)}`);
});
process.on('unhandledRejection', (reason) => {
  trace('unhandled-rejection', { message: reason?.message ?? String(reason), stack: reason?.stack ?? null });
  say(`[w2m-supervisor] unhandled rejection: ${reason?.stack ?? reason?.message ?? String(reason)}`);
});

// ---------------------------------------------------------------------------------------------
// THE SINGLE-INSTANCE LOCK
//
// The watchdog trigger in `install-service.ps1` exists because a console-teardown death cannot be
// logged from inside the process it kills: the task must be able to say "be running, or start".
// That trigger is only safe if starting a *second* generation while a healthy one runs is a no-op,
// and that is exactly what the lock buys. Without it the trigger is a process factory: every
// restart of a supervisor whose agent survived leaves another agent behind, and the old reap --
// which trusted the single `child_pid` in the heartbeat -- could never catch up.
//
// `wx` is the atomic part: `open(..., 'wx')` is O_CREAT|O_EXCL, so of two generations racing to
// start, exactly one creates the file and the other gets EEXIST. The file *is* the lock only until
// its holder dies, though, and this project has measured two ways for that to happen abruptly:
// `Stop-Process -Force`, and a console teardown that kills the tree with 0xC000013A. Neither runs
// any handler here, so the file is simply left behind. It is therefore not the existence of the
// file that decides anything -- it is the liveness of the pid written in it. That is why a stale
// lock (holder gone, or the file unreadable) is taken over loudly instead of blocking the machine
// forever, and why `orphans_reaped`/`lock_takeovers` are in the heartbeat: taking a lock over is
// the normal aftermath of exactly the death this file exists to survive.
// ---------------------------------------------------------------------------------------------
const lockPath = typeof pick('lock', null) === 'string' ? pick('lock', null) : join(runDir, 'supervisor.lock');
/** Takeovers, cumulative across generations: kept beside the lock so a restart does not erase it. */
const lockStatePath = `${lockPath}.state.json`;

function readLockState(file_) {
  try {
    const parsed = JSON.parse(readFileSync(file_, 'utf8').replace(/^\uFEFF/, ''));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Best effort, and only used for numbers: an unreadable sidecar is not a reason to refuse to run. */
function bumpLockTakeovers() {
  try {
    const previous = Number(readLockState(lockStatePath).takeovers ?? 0);
    const next = Number.isFinite(previous) ? previous + 1 : 1;
    const tmp = `${lockStatePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ takeovers: next, updated_at: stamp() }, null, 2)}\n`, 'utf8');
    renameSync(tmp, lockStatePath);
    return next;
  } catch {
    return null;
  }
}

const takeoversTotal = Number(lockStatePath === '' ? 0 : readLockState(lockStatePath).takeovers ?? 0) || 0;
const lockInfo = {
  path: lockPath,
  pid: process.pid,
  started_at: stamp(),
  takeovers_total: takeoversTotal,
  takeovers_this_run: 0,
};

/**
 * Is another supervisor generation working right now?
 *
 * Alive is not enough on its own: Windows reuses pids, and a lock left by a killed supervisor can
 * name a pid that now belongs to something else entirely -- long-lived, unrelated, and none of this
 * program's business. Treating that as "held" would wedge the machine until the process happened to
 * exit, which is the failure this whole file is against. So the pid is checked for being a
 * *supervisor*: node, running this script, with this `--config`. When the process table cannot be
 * read the answer is "assume held", because the one irreversible mistake is a second agent -- the
 * watchdog ticks again in five minutes, and the log line says which of the two happened.
 *
 * @returns {{held: boolean, reason: string}}
 */
function lockHolder() {
  if (!existsSync(lockPath)) return { held: false, reason: 'lock file is gone (the holder removed it)' };
  let pid = null;
  let holderStartedAt = null;
  let parseNote = 'unreadable';
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
    // A pid written as a string is still a pid: the field has been written by hand at least once.
    if (Number.isInteger(Number(parsed?.pid)) && Number(parsed.pid) > 0) {
      pid = Number(parsed.pid);
      holderStartedAt = typeof parsed?.started_at === 'string' ? parsed.started_at : null;
      parseNote = 'readable';
    } else {
      parseNote = 'readable but has no usable pid';
    }
  } catch (error) {
    // Unreadable is treated exactly like a dead holder -- see the block comment above: a truncated
    // or half-written lock must not be able to keep the fleet down with a stale claim on the port.
    parseNote = `unreadable (${error.code ?? error.message})`;
  }
  if (pid === null) return { held: false, reason: parseNote };
  if (pid === process.pid) return { held: false, reason: `this process (pid=${pid}) owns it` };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { held: false, reason: `pid=${pid} is not running (${error.code ?? error.message})` };
  }
  const rows = listProcesses();
  if (rows !== null) {
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row !== undefined && !isSupervisorCommandLine(row.cmd)) {
      return {
        held: false,
        reason: `pid=${pid} is alive but is not a supervisor of this installation (${row.cmd.slice(0, 140)})`,
      };
    }
  }
  return { held: true, reason: `pid=${pid} is a supervisor running this config (lock written ${holderStartedAt ?? 'at an unknown time'}, ${parseNote})` };
}

// The lock is the first thing this process does that can have a side effect, and the last thing it
// gives up. Everything above this line is argument/config parsing, which changes nothing.
let lockFd = null;
for (let attempt = 0; attempt < 3 && lockFd === null; attempt += 1) {
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // EX_CONFIG, not a crash: no lock means two agents is possible, and running anyway would
      // trade a visible failure for the exact invisible one this file exists to prevent.
      console.error(`w2m-supervisor: cannot create the lock ${lockPath}: ${error.message}`);
      process.exit(78);
    }
    const holder = lockHolder();
    if (holder.held) {
      say(`[w2m-supervisor ${stamp()}] another supervisor generation already holds the lock: ${holder.reason}`);
      say(`[w2m-supervisor ${stamp()}] lock=${lockPath} -- exiting without spawning; the watchdog tick is a no-op`);
      // Deliberately exit 0: a no-op start is the *designed* outcome of a watchdog tick, not a
      // failure, and a non-zero code would make Task Scheduler's RestartOnFailure spin on it.
      process.exit(0);
    }
    try {
      rmSync(lockPath, { force: true });
      say(
        `[w2m-supervisor ${stamp()}] stale lock taken over: not held because ${holder.reason} -- ` +
          `${lockPath} removed, this generation now owns it`,
      );
      const total = bumpLockTakeovers();
      if (Number.isFinite(total)) {
        lockInfo.takeovers_total = total;
        lockInfo.takeovers_this_run += 1;
      }
    } catch (removeError) {
      say(`[w2m-supervisor ${stamp()}] could not clear the stale lock ${lockPath}: ${removeError.message}`);
      process.exit(78);
    }
  }
}
if (lockFd === null) {
  say(`[w2m-supervisor ${stamp()}] could not take the lock ${lockPath} after 3 attempts -- exiting without spawning`);
  process.exit(0);
}
writeSync(lockFd, `${JSON.stringify({ pid: process.pid, started_at: lockInfo.started_at, argv: process.argv.join(' ') }, null, 2)}\n`);
// Closed immediately: the lock is the file's existence plus the liveness of the pid inside it, not
// an open descriptor -- `wx` is what makes the create atomic and that has already happened.
closeSync(lockFd);

let lockHeld = true;
/** Give the lock up on the way out, so the next generation does not have to call it stale. */
function dropLock(why) {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    rmSync(lockPath, { force: true });
    say(`[w2m-supervisor ${stamp()}] lock released (${why})`);
  } catch (error) {
    say(`[w2m-supervisor ${stamp()}] could not remove the lock on exit: ${error.message}`);
  }
}

say(`[w2m-supervisor ${stamp()}] supervising ${process.execPath} ${[bin, '--rabbit', rabbit, '--project', project, '--name', name, '--state', state, '--allowed-commands', allowed, ...passthrough].join(' ')}`);
say(`[w2m-supervisor] lock=${lockPath} holder=pid:${process.pid} takeovers_total=${lockInfo.takeovers_total}`);

const argv = [
  bin,
  '--rabbit', rabbit,
  '--project', project,
  '--name', name,
  '--state', state,
  '--allowed-commands', allowed,
  ...passthrough,
];

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    stopping = true;
  });
}

// Declared before the heartbeat block, which reads it: a `let` referenced earlier in the same scope
// would be a temporal-dead-zone throw, not an undefined value.
let runs = 0;
/** The worker that is alive right now, tracked here so every heartbeat can name it. */
let currentChildPid = null;
let currentChildStartedAt = null;
/** Item 2 and item 3 facts, kept for the life of this generation and repeated in every heartbeat. */
let orphansReaped = 0;
let orphansReapedPids = [];
let lastReason = null;

// Extra agent flags this supervisor understands for its own bookkeeping. They are still passed to
// the agent (which ignores unknown `--flags`) and exist so `verify-supervisor.mjs` can drive this
// file against a stub worker without Windows Task Scheduler and without touching the live agent.
const reapMatch = typeof pick('reap-match', null) === 'string' ? pick('reap-match', null) : state;
/**
 * The punch port, taken from the same place the agent takes it. `--p2p-port` arrives through
 * `passthrough` (it is an agent flag, written as `agentArgs: "--p2p-mode auto --p2p-port 41235"` in
 * the installer's config), with the flag/config forms as fallbacks for a direct command line.
 * `0` means "let the OS choose" and is refused by the agent itself, so it is no port to gate on.
 */
const p2pPort = (() => {
  const at = passthrough.indexOf('--p2p-port');
  const value = at >= 0 ? passthrough[at + 1] : pick('p2p-port', null);
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
})();
const p2pMode = String(pick('p2p-mode', 'auto')).toLowerCase();
/** Item 3's facts, repeated in every heartbeat for the life of this generation. */
const portInfo = { configured: p2pPort, state: 'unknown', owner_pid: null, note: null };

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
//   stopped   this generation has given up the lock and exited
//
// Two fields are worth reading before the state:
//   orphans_reaped / orphans_reaped_pids   what the start-time reap terminated, by pid
//   port.state                             free | bound | bound-by-other | held | unknown
//
// Written atomically (temp file + rename) so a reader never sees half a JSON document.
// ---------------------------------------------------------------------------------------------
const heartbeatPath = join(runDir, 'supervisor-heartbeat.json');
const degradedAfter = Number.isFinite(Number(pick('degraded-after', 3))) ? Number(pick('degraded-after', 3)) : 3;
const degradedWindowMs = 10 * 60_000;
const degradedBackoffMs = Number.isFinite(Number(pick('degraded-backoff-ms', 300_000)))
  ? Number(pick('degraded-backoff-ms', 300_000))
  : 300_000;
const exitTimes = [];

function writeHeartbeat(patch) {
  const recent = exitTimes.filter((at) => Date.now() - at < degradedWindowMs).length;
  // With a live child the state is `running`, whoever is asking. The 30 s beat passes no state of its
  // own, and defaulting it to `backoff` published "backoff" alongside a `child_pid` that named a live
  // agent -- measured on this machine at 17:30, with pid 9860 serving `stream ready`. The one file an
  // outside observer reads must not be the one file that contradicts itself.
  const state = patch.state ?? (currentChildPid !== null ? 'running' : recent >= degradedAfter ? 'degraded' : 'backoff');
  const record = {
    updated_at: stamp(),
    state,
    supervisor_pid: process.pid,
    run: patch.run ?? runs,
    // `currentChildPid`, never `null`, unless the patch says otherwise: this field used to be
    // written as `patch.child_pid ?? null` on the 30 s beat, so a healthy generation with a live
    // agent published `child_pid: null` -- measured on this machine at 17:30 while pid 9860 was
    // serving `stream ready`. A field that is null exactly when the agent is fine is worse than no
    // field: it is what made the old single-pid reap look like it had nothing to do.
    child_pid: patch.child_pid !== undefined ? patch.child_pid : currentChildPid,
    child_started_at: patch.child_started_at !== undefined ? patch.child_started_at : currentChildStartedAt,
    restarts_total: Math.max(0, runs - 1),
    restarts_within_10min: recent,
    last_exit_code: patch.last_exit_code ?? null,
    last_exit_at: patch.last_exit_at ?? null,
    // Why the last attempt did not end in a running agent, when it did not: one of
    // P2P_PORT_HELD_BY_OTHER, P2P_PORT_NOT_BOUND, or null.
    last_reason: patch.last_reason !== undefined ? patch.last_reason : lastReason,
    // Item 2: what this generation reaped, by pid. Counted across generations in the log.
    orphans_reaped: orphansReaped,
    orphans_reaped_pids: orphansReapedPids,
    // Item 1: who holds the single-instance lock, and how often a dead generation had to be
    // cleaned out of the way.
    lock: { path: lockInfo.path, pid: lockInfo.pid, takeovers_total: lockInfo.takeovers_total, takeovers_this_run: lockInfo.takeovers_this_run },
    // Item 3: the punch port, which is the difference between a machine that is *on* the fleet and
    // one that is merely *listed* on it.
    port: {
      configured: portInfo.configured,
      mode: p2pMode,
      state: portInfo.state,
      owner_pid: portInfo.owner_pid,
      note: portInfo.note,
    },
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

// ---------------------------------------------------------------------------------------------
// PROCESS IDENTITY: HOW A PROCESS IS RECOGNISED, AND WHY NOT BY A REMEMBERED PID
//
// The old reap read `child_pid` out of the heartbeat and killed that one pid. Measured cost: with
// nine agents alive, eight were invisible to it, so it terminated one and left the rest holding the
// identity and the punch port. A remembered pid is a fact about the past; what is needed is a fact
// about the present, so this enumerates the process table and matches on **identity**:
//
//   * the process is node (`node.exe` or a `node` basename of the actual executable), AND
//   * its command line contains `w2m-localside`, AND
//   * its command line contains this installation's identity string -- the agent's `--state`
//     directory by default, `--reap-match` when a test harness or a second checkout needs its own.
//
// Everything a reap touches therefore belongs to *this* agent's identity; an unrelated node process
// -- a test runner, an editor's language server, DSH itself -- cannot match, because it has neither
// the agent script name nor this state directory on its command line. The command line, rather than
// a pid file or a parent link, is the only one of those that survives both deaths this project has
// measured: `Stop-Process -Force` and a console teardown. A detached child is re-parented (or
// orphaned) by both, so the parent link is worthless exactly when it is needed, while `--state` was
// on the command line from the first generation to the last and is what one identity *means*.
//
// The second marker (`w2m-agent-supervisor` + this `--config`) identifies superseded supervisor
// generations. They are reported, and are not killed: a live supervisor's lock is authoritative (the
// lock already makes a second generation exit), while killing a *live* supervisor by command-line
// match would race its own spawn. Orphaned agents, which cannot hold a lock, are the leak that
// actually took the port, and they are killed.
// ---------------------------------------------------------------------------------------------

/** The process table, or null when it cannot be read (then the caller says so rather than guessing). */
function listProcesses() {
  if (process.platform !== 'win32') {
    // POSIX: `ps` is the table. Kept here so the same reap works on the hosts this file claims to
    // support, but the argument shape is the only thing shared -- the matching above is identical.
    const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(' ');
        return { pid: Number(line.slice(0, at)), cmd: line.slice(at + 1) };
      })
      .filter((row) => Number.isInteger(row.pid));
  }
  // ONE query for the whole table, filtered in JavaScript. It used to ask PowerShell for the match
  // and paid for it twice: every filter was another `Get-CimInstance` (each with a CIM round trip)
  // and, worse, the `if`/`elseif` block was joined with `;`, which PowerShell reads as an empty
  // statement where a block is required -- a parse error that `-ErrorAction SilentlyContinue` hid
  // while returning nothing. Nothing is exactly what "no orphans to reap" looks like, so the reap
  // silently did nothing. The identity strings travel in the environment (no quoting rules apply)
  // and every match is made here, where a wrong answer is a visible test failure rather than a
  // missing row.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation",
    "Write-Output '#end'",
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error || typeof result.stdout !== 'string' || !result.stdout.includes('#end')) return null;
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue;
    // CSV from PowerShell: '"pid","command line"', with embedded quotes doubled. The command line
    // itself contains commas, so the pid is taken from the front and the remainder is re-joined
    // rather than split into fields.
    const parts = trimmed.split('","');
    const pid = Number(parts[0].replace(/^"|"$/g, ''));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, cmd: parts.join('","').replace(/^"|"$/g, '').replace(/""/g, '"') });
  }
  trace('process-table', { rows: rows.length });
  return rows;
}

/** Every live process that is this installation's agent, whoever started it. */
function agentProcesses() {
  const rows = listProcesses();
  if (rows === null) return null;
  const wanted = String(reapMatch).toLowerCase().replace(/\//g, '\\');
  const matched = [];
  for (const row of rows) {
    if (typeof row.cmd !== 'string') continue;
    // A supervisor is never an agent, and this one is never a candidate for anything. Both checks
    // are load-bearing: the identity string is an argument of the supervisor as well as of the agent
    // (`--state <dir>` was in this file's own command line), so matching on identity alone made the
    // supervisor reap *itself* -- measured, and it died between `reap-before-kill` and the kill
    // returning, which is the worst possible version of this bug: a process that kills the agent of
    // a different installation, or itself, is worse than one that leaves orphans behind.
    if (row.pid === process.pid) continue;
    const identity = row.cmd.toLowerCase().replace(/\//g, '\\');
    if (!identity.includes(wanted)) continue;
    if (isSupervisorCommandLine(row.cmd)) {
      trace('reap-skipped-supervisor', { pid: row.pid });
      continue;
    }
    if (!row.cmd.toLowerCase().includes(PROC_MARKER_AGENT)) {
      trace('reap-skipped-no-agent-marker', { pid: row.pid, cmd: row.cmd.slice(0, 160) });
      continue;
    }
    matched.push(row);
  }
  trace('agent-processes', { rows: rows.length, wanted, matched: matched.map((row) => row.pid) });
  return matched;
}

/** Superseded supervisor generations, for the report only -- see the block comment above. */
function supervisorProcesses() {
  const rows = listProcesses();
  if (rows === null) return null;
  const self = process.pid;
  return rows.filter((row) => row.pid !== self && isSupervisorCommandLine(row.cmd));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate one pid, hard on Windows -- and then *check*, because this is the operation that decides
 * whether an orphan is really gone.
 *
 * `process.kill(pid, 'SIGKILL')` cannot end a process this one has no console relationship with, and
 * a Task Scheduler agent has none, so `taskkill /T /F` is the Windows way to end a tree; `/T` matters
 * for a grandchild an agent may have spawned. But `/T` alone is not enough, and its failure is
 * silent: measured, `taskkill /PID <pid of an exited parent> /T /F` exits 128 with "process not
 * found" and kills nothing at all -- and a detached agent is exactly a pid whose parent has already
 * exited. A reap that trusted taskkill's exit code would report success while the orphan kept its
 * claim on the punch port, which is this defect all over again. So: retry, escalate to a direct kill
 * of the pid itself, and return the truth of `isAlive` rather than taskkill's opinion.
 */
function terminate(pid, timeoutMs = 2_000) {
  // Never this process. `taskkill /PID <self>` succeeds, so a matching bug upstream would end the
  // supervisor silently -- the exact class of death this file exists to make impossible.
  if (pid === process.pid) {
    say(`[w2m-supervisor] refusing to terminate pid=${pid}: that is this supervisor`);
    return false;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return !isAlive(pid);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!isAlive(pid)) return true;
    for (const flags of [['/T', '/F'], ['/F']]) {
      spawnSync('taskkill', ['/PID', String(pid), ...flags], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    }
  }
  return !isAlive(pid);
}

// ---------------------------------------------------------------------------------------------
// ITEM 2: REAP BY IDENTITY, AT STARTUP
//
// Detaching the agent is what stops a console teardown from taking the machine off the fleet, and it
// has a price that was measured: every supervisor generation that dies without stopping its child
// leaves an orphan behind, and a five-minute watchdog makes a new generation per tick. The reap
// below is the payment: it looks at every agent process of this identity and keeps none of them,
// because at this point in the file this generation has the lock and has not spawned anything, so
// **any** agent process alive right now belongs to a dead generation. "Trust a graceful exit" is the
// assumption that failed; "trust the process table" is the one that holds.
// ---------------------------------------------------------------------------------------------
let startupReapNote = 'not attempted';
try {
  const stale = agentProcesses();
  if (stale === null) {
    startupReapNote = 'could not enumerate the process table; nothing reaped';
    say(`[w2m-supervisor] ${startupReapNote}`);
  } else {
    const killedPids = [];
    const survivors = [];
    for (const row of stale) {
      if (row.pid === currentChildPid) continue; // impossible before the first spawn, but never kill our own child
      const killed = terminate(row.pid);
      if (killed) killedPids.push(row.pid);
      else survivors.push(row.pid);
      say(
        `[w2m-supervisor] reaped orphan agent pid=${row.pid}${killed ? '' : " (would not die; it may belong to another user)"}` +
          ` cmd=${row.cmd.slice(0, 200)}`,
      );
    }
    orphansReaped = killedPids.length;
    orphansReapedPids = killedPids;
    startupReapNote =
      stale.length === 0
        ? 'no orphan agents found'
        : `reaped ${killedPids.length} of ${stale.length}${survivors.length > 0 ? ` (survived: pids=[${survivors.join(',')}])` : ''}`;
    say(
      `[w2m-supervisor] start-time reap by identity (state=${state}): ${startupReapNote}` +
        `${killedPids.length > 0 ? ` pids=[${killedPids.join(',')}]` : ''}`,
    );
  }
} catch (error) {
  startupReapNote = `reap failed: ${error.message}`;
  say(`[w2m-supervisor] ${startupReapNote}`);
}
// The heartbeat is written *before* the first spawn so the reap and the port decision are visible
// even if this generation dies in the next second -- a fact in a file outlives a process.
const startupSuperseded = (() => {
  try {
    const others = supervisorProcesses();
    return others === null ? null : others.length;
  } catch {
    return null;
  }
})();
if (startupSuperseded !== null && startupSuperseded > 0) {
  say(
    `[w2m-supervisor] note: ${startupSuperseded} other supervisor process(es) of this identity are alive; ` +
      `the lock -- not a kill -- is what stops them from supervising anything. Reported, not killed: ` +
      `ending a live supervisor here would race the agent it may be about to own.`,
  );
}
trace('startup-reap', { orphans_reaped: orphansReaped, pids: orphansReapedPids, note: startupReapNote });
writeHeartbeat({ state: 'backoff' });

// ---------------------------------------------------------------------------------------------
// ITEM 3: A HELD PUNCH PORT IS A FATAL STARTUP ERROR, NOT A QUIET DEGRADATION
//
// The agent's own design is deliberate and correct as library behaviour: `startP2P()` records
// `P2P_BIND_FAILED` and returns `{ok:false}` because a machine whose fast path is broken is still a
// working machine over the relay, and the agent's comment says so: "never fatal". The fleet measured
// what that costs when the port is held by an *orphan of the same identity*: nine agents ran, eight
// of them with no direct path, every dispatch fell back to the relay with `P2P_UNREACHABLE`, and
// because a degraded agent is indistinguishable from a healthy one from outside -- same log line
// volume, same stream, `state: running` -- nothing on this machine or on the fleet noticed for
// fourteen hours.
//
// So the choice between (a) fatal and (b) degraded-but-visible is made here as (a), for these
// reasons:
//   * The supervisor can decide it *before* spawning, which is the only place the information is
//     clean: `probePort()` binds the punch port itself. If the bind succeeds, the port is free and
//     the agent's own bind cannot fail for the one reason that has ever been observed here; if it
//     fails, something holds the port and the agent's bind will fail in exactly the same way.
//   * (b) cannot be implemented honestly from out here. The supervisor cannot see the agent's
//     in-process `p2pStartResult`, and parsing the agent's log for `P2P_BIND_FAILED` makes a log
//     line load-bearing -- the file this whole design exists because a log line is not guaranteed
//     to be written. A heartbeat that says "degraded" only when a log happened to be flushed is a
//     heartbeat that lies during the incident it is for.
//   * Retrying is what an operator would do, and it is safe to automate *because of the lock*: with
//     one generation possible, a retry cannot produce a second agent, so "reap and retry" costs one
//     backoff and removes the accumulated state rather than compounding it.
// The state is not hidden: the heartbeat carries `port.state` (free/bound/bound-by-other/held) and a
// named `last_reason` (P2P_PORT_HELD_BY_OTHER / P2P_PORT_NOT_BOUND), so "the agent is up but has no
// punch port" can never again be a silent condition -- it is either repaired or said out loud.
// ---------------------------------------------------------------------------------------------

/**
 * Can this process bind the punch port? The probe is the agent's own setup (`udp4`, `0.0.0.0`), so
 * its answer is the agent's answer. A successful bind is closed immediately: it is a question, not
 * a claim on the port.
 *
 * @returns {Promise<{free: boolean, code: string|null}>}
 */
function probePort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let socket;
    try {
      socket = createSocket('udp4');
    } catch (error) {
      done({ free: false, code: error.code ?? error.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* never bound */
      }
      done({ free: false, code: 'ETIMEDOUT' });
    }, 3_000);
    timer.unref?.();
    socket.on('error', (error) => {
      clearTimeout(timer);
      done({ free: false, code: error.code ?? error.message });
    });
    socket.bind({ address: '0.0.0.0', port }, () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* closing a bound socket cannot fail meaningfully */
      }
      done({ free: true, code: null });
    });
  });
}

function notePort(state_, ownerPid, note) {
  portInfo.state = state_;
  portInfo.owner_pid = ownerPid;
  portInfo.note = note;
}

/**
 * The pid holding the port, when the OS will say. Diagnostic only: absence is not a failure.
 *
 * `netstat -ano` rather than `Get-NetUDPEndpoint`: measured on this machine, one PowerShell start is
 * ~2.6 s against ~0.09 s for netstat, and this runs inside the startup path where a slow answer is
 * indistinguishable from a hung agent. The cmdlet is the fallback for a host without netstat, and
 * `withName` asks for the process name too -- worth 2.6 s only when a human has to read the answer,
 * which is exactly when a foreign process holds the port.
 */
function portOwner(withName = false) {
  if (process.platform !== 'win32') return null;
  const fromNetstat = () => {
    const result = spawnSync('netstat', ['-ano', '-p', 'UDP'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.error || typeof result.stdout !== 'string') return null;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*UDP\s+\S*:(\d+)\s+\S+\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[1]) === p2pPort) return { pid: Number(match[2]), name: null };
    }
    return null;
  };
  try {
    const quick = fromNetstat();
    if (quick !== null && !withName) return quick;
    // Ask the cmdlet once: it names the process, and it is the only route when netstat is absent or
    // when its output has no line for this port at all.
    const script = `$e=Get-NetUDPEndpoint -LocalPort ${p2pPort} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($e) { $p=Get-Process -Id $e.OwningProcess -ErrorAction SilentlyContinue; "$($e.OwningProcess) $($p.ProcessName)" }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const [pidText, name] = text.split(/\s+/);
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0) return { pid, name: name ?? 'unknown' };
    return quick;
  } catch {
    return null;
  }
}

const killedByUs = (pid) => typeof pid === 'number' && pid === currentChildPid;

/**
 * Wait for the punch port to be free, reaping every other agent of this identity while waiting.
 *
 * UDP has no TIME_WAIT, so a killed holder releases the port as soon as its process is gone; the
 * wait is for `taskkill` to finish, not for a timer. The one case this cannot repair is a foreign
 * process on the same port, and that is reported by name rather than swallowed.
 *
 * @returns {Promise<{free: boolean, reason: string|null, heldBy: object|null}>}
 */
async function ensurePortFree() {
  trace('port-gate', { port: p2pPort, mode: p2pMode });
  if (p2pPort === null || p2pMode === 'relay') {
    notePort('not-configured', null, p2pPort === null ? 'no pinned punch port; the agent picks an ephemeral one' : 'p2p mode is relay');
    return { free: true, reason: null, heldBy: null };
  }
  portInfo.configured = p2pPort;
  let probe = await probePort(p2pPort);
  trace('port-gate-probe', { free: probe.free, code: probe.code });
  if (probe.free) {
    notePort('free', null, 'the punch port was free before the spawn');
    return { free: true, reason: null, heldBy: null };
  }
  // Something holds it. If it is an agent of this identity, it is an orphan that the start-time reap
  // should already have taken; a second pass covers the race where it appeared afterwards.
  const holder = portOwner();
  const agents = agentProcesses();
  const agentPids = agents === null ? [] : agents.map((row) => row.pid);
  const extra = agentPids.filter((pid) => !killedByUs(pid));
  if (extra.length > 0) {
    say(`[w2m-supervisor] punch port ${p2pPort} is held and ${extra.length} agent process(es) of this identity are alive: pids=[${extra.join(',')}] -- reaping and retrying`);
    const killedNow = [];
    for (const pid of extra) {
      if (terminate(pid)) killedNow.push(pid);
    }
    orphansReaped += killedNow.length;
    orphansReapedPids = [...new Set(orphansReapedPids.concat(killedNow))];
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    probe = await probePort(p2pPort);
    trace('port-gate-retry', { attempt, free: probe.free, code: probe.code });
    if (probe.free) {
      notePort('free', null, `the punch port came free after the reap${extra.length > 0 ? ` of pids=[${extra.join(',')}]` : ''}`);
      return { free: true, reason: null, heldBy: null };
    }
  }
  // Still held after every agent of this identity was taken out: it is somebody else's socket. No
  // amount of retrying will change that, and starting the agent anyway is the fourteen-hour failure.
  const owner = holder ?? portOwner(true);
  notePort('bound-by-other', owner?.pid ?? null, `the punch port is held by ${owner ? `pid=${owner.pid} (${owner.name})` : 'another process'}, which is not an agent of this identity`);
  return {
    free: false,
    reason: 'P2P_PORT_HELD_BY_OTHER',
    heldBy: owner,
  };
}

/** Give up on the port and let the named reason reach the heartbeat before the next backoff. */
async function refuseToSpawn(reason, heldBy) {
  lastReason = reason;
  const detail =
    reason === 'P2P_PORT_HELD_BY_OTHER'
      ? `punch port ${p2pPort} is held by ${heldBy ? `pid=${heldBy.pid} (${heldBy.name})` : 'an unidentified process'} and it is not an agent of this identity`
      : `the agent did not bind punch port ${p2pPort} within the deadline`;
  say(`[w2m-supervisor] refusing to start: ${reason}: ${detail} -- the agent would run with no direct path and every dispatch would fall back to the relay`);
  if (portInfo.state !== 'bound-by-other') notePort('held', heldBy?.pid ?? null, detail);
  writeHeartbeat({ state: 'degraded', last_reason: reason, child_pid: null, child_started_at: null });
}

/**
 * Did the agent actually take the punch port?
 *
 * `probePort` answers "is the port free": after the spawn, free means the agent has not bound it. As
 * the agent's own bind is not observable from here (it is in-process), this is the honest check the
 * supervisor can make, and it turns the one silent degradation that has actually happened into a
 * named restart: if the port is still free after the deadline, the agent is running without a direct
 * path, so it is stopped and reported rather than left to look healthy.
 *
 * @returns {Promise<{bound: boolean, code: string|null}>}
 */
async function waitForPortBound(childPid, deadlineMs) {
  const began = Date.now();
  for (;;) {
    const probe = await probePort(p2pPort);
    trace('port-after-spawn-probe', { pid: childPid, free: probe.free, code: probe.code });
    if (!probe.free) {
      const owner = portOwner();
      trace('port-after-spawn-owner', { owner: owner?.pid ?? null, name: owner?.name ?? null });
      if (owner === null) {
        // Bound, but the OS would not name the holder. The bind succeeded for us one moment ago and
        // the agent is alive, so the honest reading is "the agent took it"; `portOwner` is a
        // diagnostic, and its absence must not turn a working agent into a restart loop.
        notePort('bound', childPid, `punch port ${p2pPort} is bound and the agent (pid=${childPid}) is alive; the OS did not name the holder`);
        return { bound: true, code: null };
      }
      if (owner.pid === childPid) {
        notePort('bound', owner.pid, `the punch port is bound by the agent (pid=${owner.pid})`);
        return { bound: true, code: null };
      }
      notePort('bound-by-other', owner.pid, `the punch port is bound by pid=${owner.pid} (${owner.name}), not by the agent pid=${childPid}`);
      return { bound: false, code: 'P2P_PORT_HELD_BY_OTHER' };
    }
    if (!isAlive(childPid) || Date.now() - began >= deadlineMs) return { bound: false, code: probe.code };
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
}

async function stopChild(child, why) {
  if (!child || child.pid === undefined) return;
  if (!isAlive(child.pid)) return;
  say(`[w2m-supervisor] stopping agent pid=${child.pid} (${why})`);
  terminate(child.pid);
}

// A periodic beat, so "the supervisor itself is alive but a worker is wedged" is visible too.
const beat = setInterval(() => {
  trace('beat', { port_state: portInfo.state, child: currentChildPid });
  writeHeartbeat({});
}, 30_000);
beat.unref();

const portWaitMs = Number.isFinite(Number(pick('port-wait-ms', 30_000))) ? Number(pick('port-wait-ms', 30_000)) : 30_000;

while (!stopping) {
  runs += 1;
  const startedAt = Date.now();
  trace('loop-iteration', { runs, stopping, currentChildPid });
  // Item 3, first half: never spawn into a port that is already taken. This is where an orphan from
  // a previous generation is discovered even if it appeared after the start-time reap.
  const gate = await ensurePortFree();
  if (stopping) break;
  if (!gate.free) {
    await refuseToSpawn(gate.reason, gate.heldBy);
    exitTimes.push(Date.now());
    const record = writeHeartbeat({});
    const wait = record.state === 'degraded' ? degradedBackoffMs : backoffMs;
    // No hot loop here: the port gate is paced by the same backoff a crashed agent gets, so a
    // persistently occupied port produces a slow, visible, well-labelled heartbeat rather than a
    // spawn storm.
    say(`[w2m-supervisor] run ${runs} refused to start (${gate.reason}) -- waiting ${Math.round(wait / 1000)}s`);
    await new Promise((resolve) => {
      setTimeout(resolve, wait);
    });
    continue;
  }
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
  currentChildPid = child.pid ?? null;
  currentChildStartedAt = stamp();
  lastReason = null;
  if (child.pid === undefined) {
    // No pid at all: there is nothing to own and nothing to check, so this is one named run rather
    // than a spawn followed by a 30 s port wait that could only ever conclude "not bound".
    exitTimes.push(Date.now());
    const failed = await exited;
    say(`[w2m-supervisor] run ${runs} never started (spawn returned no pid); exit code=${failed.exitCode} -- restarting`);
    const record = writeHeartbeat({ last_exit_code: failed.exitCode, last_exit_at: stamp(), last_reason: 'SPAWN_FAILED', child_pid: null, child_started_at: null });
    await new Promise((resolve) => {
      setTimeout(resolve, record.state === 'degraded' ? degradedBackoffMs : backoffMs);
    });
    continue;
  }
  writeHeartbeat({ state: 'running', child_pid: currentChildPid, child_started_at: currentChildStartedAt });
  say(`[w2m-supervisor] run ${runs} started agent pid=${currentChildPid}`);
  trace('spawned', { pid: currentChildPid });

  // Item 3, second half: confirm the agent really took the port, and stop it if it did not. Two
  // checks run concurrently, because either is a reason to stop: the port deadline, and the child's
  // own exit (the loop below must not hold a dead child's heartbeat open as `running`).
  const exited = new Promise((resolve) => {
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.on('error', (error) => {
      say(`[w2m-supervisor] spawn failed: ${error.message}`);
      resolve({ exitCode: null, signal: null });
    });
  });
  const portCheck =
    p2pPort === null || p2pMode === 'relay'
      ? Promise.resolve({ bound: true, code: null })
      : waitForPortBound(child.pid, portWaitMs);
  const winner = await Promise.race([
    portCheck.then((result) => ({ kind: 'port', result })),
    exited.then((result) => ({ kind: 'exit', result })),
  ]).catch((error) => {
    // A rejection here would otherwise be the one death this file cannot describe: Node ends the
    // process on an unhandled rejection, so the supervisor would disappear with nothing but a stack
    // trace. Named, logged, and turned into a decision instead.
    say(`[w2m-supervisor] the punch-port check failed: ${error.stack ?? error.message}`);
    trace('port-check-threw', { message: error.message });
    return { kind: 'exit', result: { exitCode: null, signal: null } };
  });
  if (winner.kind === 'port' && !winner.result.bound && isAlive(child.pid)) {
    // The port went to somebody else between the gate and the bind: the agent is alive but had no
    // direct path, which is the exact condition that used to run silently for fourteen hours.
    const reason = winner.result.code === 'P2P_PORT_HELD_BY_OTHER' ? 'P2P_PORT_HELD_BY_OTHER' : 'P2P_PORT_NOT_BOUND';
    if (reason === 'P2P_PORT_NOT_BOUND') {
      notePort('held', portOwner()?.pid ?? null, `nothing bound punch port ${p2pPort} within ${Math.round(portWaitMs / 1000)}s of the spawn`);
    }
    await refuseToSpawn(reason, portInfo.owner_pid === null ? null : { pid: portInfo.owner_pid, name: 'unknown' });
    await stopChild(child, `${reason}: it had no punch port, so every dispatch would use the relay`);
  }
  const result = await exited;
  if (currentChildPid === child.pid) currentChildPid = null;
  currentChildStartedAt = null;
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
dropLock('this generation is exiting');
