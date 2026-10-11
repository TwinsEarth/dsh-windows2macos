// verify-supervisor.mjs -- a reproducible, no-elevation check of the invariants
// `w2m-agent-supervisor.mjs` is supposed to hold: ONE supervisor generation, ONE agent, and the
// punch port bound by that agent.
//
//   node deploy/windows/verify-supervisor.mjs            # the mechanism, against a stub worker
//   node deploy/windows/verify-supervisor.mjs --keep     # ...and leave the temp tree for inspection
//
// WHY A CHECK AND NOT ONLY A TEST
//
// The failure this guards against is not a unit of logic, it is a *state* the machine reached:
// fourteen `w2m` processes, nine agents with one identity, and the punch port held by an agent from
// thirteen hours earlier, so every dispatch fell back to the relay (`P2P_UNREACHABLE`) while the
// heartbeat said nothing. The property that was violated is "one supervisor, one agent, port bound",
// and the honest way to check a property like that is to build the broken state and start the thing:
// orphan agents already holding the punch port, a lock file left behind by a supervisor that was
// killed, and then one supervisor start. Exactly one agent must be left, it must own the port, and
// the heartbeat must name the pids it reaped.
//
// WHAT IS EXERCISED, AND WHAT IS NOT
//
// The mechanism runs here exactly as it does in production: the real supervisor, the real lock file,
// a real detached worker, the real port probe, the same identity rule for reaping. What is stubbed
// is the *worker* -- a two-line UDP binder instead of the real agent -- so that the check can run on
// a free port, without admin rights, without Windows Task Scheduler, and without a second agent
// joining the fleet under a real device identity. A real scheduled-task run is deliberately NOT
// scripted here: it needs the live task registration, it needs the machine's punch port, and it
// would evict the machine's actual agent. Every run prints exactly which scenarios it covered.
//
// Nothing outside a temporary directory is touched: the lock, the heartbeat and the log are all
// under the tree created below, so a running installation cannot be disturbed by construction.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, 'w2m-agent-supervisor.mjs');
const keep = process.argv.includes('--keep');
/**
 * A STABLE identity, not a per-run one, and that is the point rather than a detail: a real
 * installation has one state directory, one punch port and one lock file that outlive every process
 * using them. An earlier version of this check made a fresh temp directory per run -- so each run's
 * agents were invisible to the next run's reap, they accumulated exactly as the fleet's did, and the
 * check became a demonstration of the bug it was written to catch. `/stale` and `/fresh` are two
 * identities for the two things that must not share one: state deliberately left behind to be
 * reaped, and a clean state to start against.
 */
const root = join(tmpdir(), 'w2m-supervisor-check');

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A port nothing is bound to, asked of the OS rather than guessed. */
function unboundPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.on('error', reject);
    socket.bind({ address: '0.0.0.0', port: 0 }, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.on('error', () => resolve(false));
    socket.bind({ address: '0.0.0.0', port }, () => socket.close(() => resolve(true)));
  });
}

/**
 * Every live `w2m-localside` process whose command line names this scenario's state directory: the
 * same identity rule the supervisor's reap uses, evaluated the same way (process table + command
 * line), so an assertion here is about the invariant and not about a copy of the implementation.
 *
 * The supervisor exclusion is part of that rule, not a detail: a supervisor's own command line
 * carries the stub's path (`--bin ...\w2m-localside-stub.mjs`), so "contains w2m-localside" is true
 * of the supervisor too. This check counted supervisors as agents for several runs and blamed the
 * supervisor for the difference -- the same mistake, and now the same fix, as the reap itself.
 */
function isAgentRow(row) {
  return String(row.cmd).includes('w2m-localside') && !String(row.cmd).includes('w2m-agent-supervisor');
}

/** Process-table rows whose command line names this identity. */
function listRows(marker) {
  if (process.platform !== 'win32') {
    const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return (out.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.trim().indexOf(' ');
        return { pid: Number(line.trim().slice(0, at)), cmd: line.trim().slice(at + 1) };
      })
      .filter((row) => Number.isInteger(row.pid) && row.cmd.includes(marker));
  }
  // The identity string travels in the environment, not in the script text: a Windows path is full
  // of backslashes, and a query that fails to parse returns nothing -- which would read as "no
  // agents", the one wrong answer that matters. The separator is a literal tab, written as one:
  // PowerShell's backtick escapes do not survive the trip through a spawn argument list.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:W2M_STATE_MARKER) } | ForEach-Object { \"$($_.ProcessId)\t$($_.CommandLine)\" }",
    "Write-Output '#end'",
  ].join('\n');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, W2M_STATE_MARKER: marker },
  });
  const lines = (out.stdout ?? '').split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes('#end')) return [];
  const rows = [];
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const pid = Number(line.slice(0, tab));
    const cmd = line.slice(tab + 1);
    if (Number.isInteger(pid) && pid > 0) rows.push({ pid, cmd });
  }
  return rows;
}

function agentsFor(stateDir) {
  return listRows(stateDir).filter(isAgentRow).map((row) => row.pid);
}

/** The pids *and command lines* of this identity's agents: evidence, not just a count. */
function agentRowsFor(stateDir) {
  return listRows(stateDir).filter(isAgentRow);
}

/** The pid the OS says holds the UDP port. Absence of an answer is reported as null, never guessed. */
function udpOwner(port) {
  if (process.platform !== 'win32') return null;
  // netstat first: measured here at ~0.09 s against ~2.6 s for one PowerShell start, and a check that
  // spends two seconds per probe cannot poll anything.
  const quick = spawnSync('netstat', ['-ano', '-p', 'UDP'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (!quick.error && typeof quick.stdout === 'string') {
    for (const line of quick.stdout.split(/\r?\n/)) {
      const match = /^\s*UDP\s+\S*:(\d+)\s+\S+\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[1]) === port) return Number(match[2]);
    }
    return null;
  }
  const out = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { encoding: 'utf8', windowsHide: true },
  );
  const pid = Number((out.stdout ?? '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * End a pid -- and check, because "the kill was issued" and "the process is gone" are different facts.
 *
 * Measured while writing this check: `taskkill /PID <pid> /T /F` exits 128 with "process not found"
 * and kills nothing when the named pid's parent has already exited, which is exactly what a detached
 * worker looks like after its supervisor is killed. A harness that trusted the exit code leaked
 * workers into the next scenario, where they read as orphans and made the supervisor look wrong.
 */
function killTree(pid) {
  if (!pid || !isAlive(pid)) return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!isAlive(pid)) return true;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  return !isAlive(pid);
}

/** `Stop-Process -Force`, exactly as the incident was reproduced by hand. */
function forceKill(pid) {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true });
}

/**
 * End ONE process and deliberately leave its children alone.
 *
 * This is the shape of a console teardown and of a `Stop-Process -Force`: the supervisor dies, and
 * the detached agent -- which is not in its tree, that being the whole point of detaching it -- keeps
 * running. A tree kill cannot model that, because a tree kill takes the survivor with it, so the
 * orphan this whole defect is about would never exist to be reaped.
 */
function killOnly(pid) {
  if (!pid || !isAlive(pid)) return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!isAlive(pid)) return true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  return !isAlive(pid);
}

const results = [];
function record(name, ok, detail, s) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  // A failing check must be able to explain itself: if a generation died before it opened its log,
  // its stderr is the only place the reason exists.
  if (!ok && s) {
    console.log(`      supervisor stdout/stderr (last lines):\n      ${supervisorStdio(s)}`);
    console.log(`      supervisor decision trace (last lines):\n      ${supervisorTrace(s)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// THE STUB WORKER
//
// It is `w2m-localside` in name and in argument shape so that the supervisor's identity rule (script
// name + state directory) matches it exactly as it matches the real agent; it binds the punch port
// on 0.0.0.0 because that is what the real agent binds; and it writes the pid it ended up as,
// because an assertion should know which process owns the port rather than trust a spawn.
// ---------------------------------------------------------------------------------------------
const stubSource = `import { createSocket } from 'node:dgram';
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(at('--p2p-port'));
const out = at('--port-file');
const state = at('--state');
const socket = createSocket('udp4');
socket.on('error', (error) => {
  writeFileSync(out, JSON.stringify({ pid: process.pid, state, bind: 'failed', code: error.code, at: new Date().toISOString() }));
  setTimeout(() => process.exit(3), 50);
});
socket.bind({ address: '0.0.0.0', port }, () => {
  writeFileSync(out, JSON.stringify({ pid: process.pid, state, bind: 'ok', bound_port: socket.address().port, at: new Date().toISOString() }));
});
setInterval(() => {}, 1000);
`;

/** One tree per scenario, so no two scenarios can see each other's lock, heartbeat or port. */
let activeScenario = null;
function scenario(name, port) {
  const dir = join(root, name);
  // The stub lives in `bin-w2m-localside/`, and its *path* is deliberately free of the string
  // `w2m-agent-supervisor`: that marker is how the supervisor recognises a supervisor, and a stub
  // whose path contained it would be reported as one. The directory name still carries the marker for
  // the diagnostic that counts live supervisor processes, which is the shape of a real installation
  // (`deploy/windows/` is under a `w2m-agent-supervisor`-named tree in the fleet's own layout).
  const binDir = join(dir, 'bin-w2m-localside');
  mkdirSync(binDir, { recursive: true });
  const stateDir = join(dir, 'localside');
  mkdirSync(stateDir, { recursive: true });
  const portFile = join(dir, 'port.json');
  if (existsSync(portFile)) rmSync(portFile, { force: true });
  writeFileSync(join(binDir, 'w2m-localside-stub.mjs'), stubSource, 'utf8');
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify({ note: 'written by verify-supervisor.mjs' }, null, 2)}\n`, 'utf8');
  activeScenario = {
    name,
    dir,
    port,
    stubPath: join(binDir, 'w2m-localside-stub.mjs'),
    stateDir,
    logPath: join(dir, 'agent.log'),
    lockPath: join(dir, 'supervisor.lock'),
    heartbeatPath: join(dir, 'supervisor-heartbeat.json'),
    portFile,
    stdioPath: null,
    tracePath: join(dir, 'supervisor-trace.jsonl'),
    stubs: [],
    // EVERY generation this check starts, not just the newest: the scenario that starts a second
    // supervisor to watch it refuse the lock would otherwise leak the first one and its agent.
    supervisors: [],
    generations: 0,
  };
  return activeScenario;
}

/**
 * Terminate every agent of this identity and forget the lock, the heartbeat and the trace -- the
 * "and now start from nothing" an operator does by hand, and one of the things being checked. It
 * reaches agents from *earlier runs* too, which is exactly what a stable identity buys.
 */
function cleanIdentity(s) {
  const killed = [];
  for (const pid of agentsFor(s.stateDir)) {
    killTree(pid);
    killed.push(pid);
  }
  for (const pid of s.supervisors.map((child) => child.pid)) killTree(pid);
  s.supervisors = [];
  for (const file of [s.lockPath, s.heartbeatPath, s.tracePath, s.portFile]) rmSync(file, { force: true });
  for (const generation of [0, 1, 2, 3, 4]) rmSync(join(s.dir, `supervisor-stdio-${generation}.log`), { force: true });
  s.stubs = [];
  s.generations = 0;
  return killed;
}

function startSupervisor(s) {
  const args = [
    supervisorPath,
    '--config', join(s.dir, 'agent.json'),
    '--bin', s.stubPath,
    '--state', s.stateDir,
    '--log', s.logPath,
    '--project', s.dir,
    '--p2p-port', String(s.port),
    '--p2p-mode', 'auto',
    '--port-file', s.portFile,
    '--backoff-ms', '2000',
    '--degraded-after', '99',
  ];
  // stdout/stderr go to a file rather than nowhere: if a generation dies before it opens its log,
  // the reason is a Node stack trace on stderr, and a check that swallows it is a check that cannot
  // explain its own failure.
  const stdioPath = join(s.dir, `supervisor-stdio-${s.generations}.log`);
  s.generations += 1;
  s.stdioPath = stdioPath;
  s.tracePath = join(s.dir, 'supervisor-trace.jsonl');
  const fd = openSync(stdioPath, 'a');
  const supervisor = spawn(process.execPath, args, {
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, W2M_SUPERVISOR_TRACE: s.tracePath },
  });
  closeSync(fd);
  s.supervisors.push(supervisor);
  return supervisor;
}

/** Whatever the generations wrote to stdout/stderr outside the log, for a failing check to print. */
function supervisorStdio(s) {
  try {
    return readFileSync(s.stdioPath, 'utf8').trim().split(/\r?\n/).slice(-12).join('\n      ');
  } catch {
    return '(none)';
  }
}

/** The supervisor's own decision trace, so a failing check can show what it decided and when. */
function supervisorTrace(s) {
  try {
    return readFileSync(s.tracePath, 'utf8').trim().split(/\r?\n/).slice(-16).join('\n      ');
  } catch {
    return '(none)';
  }
}

/** A stub worker started outside any supervisor: the orphan the incident was made of. */
function startOrphan(s, port) {
  const args = [s.stubPath, '--state', s.stateDir, '--p2p-port', String(port), '--port-file', s.portFile];
  const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  s.stubs.push(child.pid);
  return child;
}

async function waitFor(label, predicate, timeoutMs, stepMs = 250) {
  const began = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - began >= timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

function heartbeat(s) {
  try {
    return JSON.parse(readFileSync(s.heartbeatPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Wait until the heartbeat describes a *settled* agent: this supervisor's child, alive, with the
 * punch port recorded as bound by that child.
 *
 * Reading the heartbeat the instant the port looks busy races the supervisor's own bookkeeping -- the
 * port is bound a fraction of a second before `port.state: bound` is written -- and a check that
 * fails on that race reports a defect that is not there. This wait was added after three checks
 * "failed" that way.
 */
function waitForSettled(s, port, timeoutMs = 90_000) {
  return waitFor('a settled heartbeat: running, punch port bound by this generation\'s child', async () => {
    const hb = heartbeat(s);
    if (hb?.state !== 'running' || !Number.isInteger(hb.child_pid)) return null;
    if (hb.port?.state !== 'bound' || hb.port?.owner_pid !== hb.child_pid) return null;
    if (await portIsFree(port)) return null;
    if (agentsFor(s.stateDir).length !== 1) return null;
    return hb;
  }, timeoutMs, 700);
}

/**
 * Wait for a *new* generation to settle, one whose supervisor pid differs from `previousPid`. Without
 * the pid test a heartbeat left by the previous generation reads as current state, and the assertion
 * ends up being about a process that is already gone.
 */
function waitForSettledGeneration(s, port, previousPid, timeoutMs = 90_000) {
  return waitFor('a new settled generation', async () => {
    const hb = heartbeat(s);
    if (hb?.supervisor_pid === previousPid || hb?.state !== 'running' || !Number.isInteger(hb.child_pid)) return null;
    if (hb.port?.state !== 'bound' || hb.port?.owner_pid !== hb.child_pid) return null;
    if (await portIsFree(port)) return null;
    if (agentsFor(s.stateDir).length !== 1) return null;
    return hb;
  }, timeoutMs, 700);
}

function lockFile(s) {
  try {
    return JSON.parse(readFileSync(s.lockPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function logText(s) {
  try {
    return readFileSync(s.logPath, 'utf8');
  } catch {
    return '';
  }
}

function cleanupScenario(s) {
  // ORDER MATTERS, and this is the same lesson as the defect itself: `taskkill /T` follows the
  // *parent* link, and a detached agent has been re-parented away from its supervisor -- so killing
  // the supervisor's tree cannot reach it. Kill by identity first, then the supervisor, then confirm
  // by identity again. Workers this harness leaked would otherwise read as orphans to the next
  // scenario, which is precisely how the fleet accumulated nine agents.
  for (const supervisor of s.supervisors) killTree(supervisor.pid);
  s.supervisors = [];
  const trackedStubs = s.stubs.filter((pid) => !agentsFor(s.stateDir).includes(pid));
  for (const pid of trackedStubs) killTree(pid);
  for (const pid of agentsFor(s.stateDir)) killTree(pid);
  const left = agentsFor(s.stateDir);
  if (left.length > 0) console.log(`      WARNING: ${left.length} agent(s) of ${s.dir} survived cleanup: [${left.join(',')}]`);
}

// ---------------------------------------------------------------------------------------------
// SCENARIOS
// ---------------------------------------------------------------------------------------------
async function checkHealthyStart() {
  const port = await unboundPort();
  const s = scenario('stale', port);
  try {
    // A clean start: no lock file, no lock sidecar, no heartbeats, no agents. Anything left from an
    // earlier run would show up in `orphans_reaped`, which the assertion below checks is zero.
    cleanIdentity(s);
    startSupervisor(s);
    const hb = await waitForSettled(s, port);
    const agents = agentsFor(s.stateDir);
    const owner = udpOwner(port);
    const ok = agents.length === 1 && agents[0] === hb.child_pid && owner === hb.child_pid && hb.orphans_reaped === 0 && hb.port?.state === 'bound';
    record(
      'clean start: one supervisor, one agent, the punch port bound by that agent',
      ok,
      `agents=[${agentRowsFor(s.stateDir)
        .map((row) => `${row.pid}${row.pid === hb.child_pid ? ' (this generation)' : ' (NOT ours)'}`)
        .join(', ')}] port_owner=${owner} heartbeat.child_pid=${hb.child_pid} port.state=${hb.port?.state} ` +
        `orphans_reaped=${hb.orphans_reaped} lock=${hb.lock?.pid === hb.supervisor_pid ? 'held by this pid' : JSON.stringify(hb.lock)}`,
      s,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkStaleOrphansAndStaleLock() {
  const port = await unboundPort();
  const extraPort = await unboundPort();
  const s = scenario('stale', port);
  try {
    // The state this machine was actually in, built on purpose: two agents of ONE identity with the
    // oldest holding the punch port, a lock file left by a supervisor that was killed, and the
    // agent's own config naming the pinned port.
    cleanIdentity(s);
    writeFileSync(s.lockPath, `${JSON.stringify({ pid: 999_999_999, started_at: '1970-01-01T00:00:00.000Z', argv: 'a supervisor that was killed' }, null, 2)}\n`, 'utf8');
    const holder = startOrphan(s, port);
    const extra = startOrphan(s, extraPort);
    await waitFor('the oldest orphan to bind the punch port', async () => (await portIsFree(port)) === false, 20_000);
    await waitFor('the second orphan to be up', async () => isAlive(extra.pid), 20_000);
    await sleep(500);
    const before = agentsFor(s.stateDir);
    const portHolderBefore = udpOwner(port);

    startSupervisor(s);
    const hb = await waitForSettled(s, port);
    const owner = udpOwner(port);
    const log = logText(s);
    const agents = agentsFor(s.stateDir);
    const reapedNamed = Array.isArray(hb.orphans_reaped_pids) && hb.orphans_reaped_pids.includes(holder.pid) && hb.orphans_reaped_pids.includes(extra.pid);
    const lockTakenOver = /stale lock taken over/.test(log) && hb.lock?.takeovers_total >= 1;
    const ok = before.length === 2 && agents.length === 1 && owner === hb.child_pid && hb.orphans_reaped === 2 && reapedNamed && lockTakenOver;
    record(
      'stale orphans + stale lock: every agent of this identity reaped, exactly one left, port rebound',
      ok,
      `before=${before.length} agent(s) [pids ${before.join(',')}, punch-port holder=${holder.pid}, was holding the port=${portHolderBefore === holder.pid}] ` +
        `-> after=${agents.length} (pid=${hb.child_pid}); port_owner=${owner}; heartbeat.orphans_reaped=${hb.orphans_reaped} ` +
        `orphans_reaped_pids=[${(hb.orphans_reaped_pids ?? []).join(',')}]; lock.takeovers_total=${hb.lock?.takeovers_total}; ` +
        `log says "stale lock taken over"=${/stale lock taken over/.test(log)}`,
      s,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkLockStopsASecondGeneration() {
  const port = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    startSupervisor(s);
    const first = await waitForSettled(s, port);
    const firstAgents = agentsFor(s.stateDir);
    // The watchdog tick: the task starts a second supervisor while a healthy one runs.
    const second = startSupervisor(s);
    const exited = await Promise.race([
      new Promise((resolve) => {
        second.on('exit', (code) => resolve({ code }));
      }),
      sleep(20_000).then(() => ({ code: 'still-running' })),
    ]);
    await sleep(1_500);
    const hb = heartbeat(s);
    const agents = agentsFor(s.stateDir);
    const log = logText(s);
    // The second generation writes its no-op line and exits immediately; the log write is synchronous
    // for exactly this case, so the evidence is in the file by the time it is read here.
    const noOpSaid = /another supervisor generation already holds the lock/.test(log) && /exiting without spawning/.test(log);
    const secondPid = second.pid;
    const ok =
      exited.code === 0 &&
      agents.length === 1 &&
      hb.supervisor_pid === first.supervisor_pid &&
      hb.child_pid === first.child_pid &&
      noOpSaid &&
      !isAlive(secondPid);
    record(
      'watchdog tick during a healthy run: second generation exits without spawning',
      ok,
      `second generation (pid=${secondPid}) exit=${JSON.stringify(exited)}, still alive=${isAlive(secondPid)}; heartbeat still owned by ` +
        `supervisor_pid=${hb.supervisor_pid} (first was ${first.supervisor_pid}) with child_pid=${hb.child_pid}; agents before=${firstAgents.length} ` +
        `after=${agents.length}; log admits the no-op=${noOpSaid}`,
      s,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkUnreadableLock() {
  const port = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    writeFileSync(s.lockPath, '{"pid": 4242, "started_at"', 'utf8'); // half-written, as a kill can leave it
    startSupervisor(s);
    const hb = await waitForSettled(s, port);
    const log = logText(s);
    const agents = agentsFor(s.stateDir);
    const ok = agents.length === 1 && /stale lock taken over: not held because unreadable/.test(log) && hb.lock?.takeovers_total >= 1;
    record(
      'unreadable lock file: taken over, not treated as a live holder',
      ok,
      `heartbeat.state=${hb.state} agents=${agents.length} takeovers_total=${hb.lock?.takeovers_total} log="${/stale lock taken over[^\n]*/.exec(log)?.[0] ?? '(none)'}"`,
      s,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkForeignPortHolderIsFatalAndNamed() {
  const port = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    // Something that is NOT an agent of this identity holds the punch port: there is no orphan to
    // reap, so the only honest answers are "refuse and say why" or "run blind". Item 3 decides.
    const holderSource = `import { createSocket } from 'node:dgram';const s=createSocket('udp4');s.bind({address:'0.0.0.0',port:${port}},()=>{});setInterval(()=>{},1000);`;
    const foreign = spawn(process.execPath, ['--input-type=module', '-e', holderSource], { stdio: 'ignore', windowsHide: true });
    s.stubs.push(foreign.pid);
    await waitFor('the foreign holder to bind', async () => (await portIsFree(port)) === false, 15_000);
    startSupervisor(s);
    await waitFor('the refusal to be recorded', async () => heartbeat(s)?.last_reason === 'P2P_PORT_HELD_BY_OTHER', 60_000);
    const hb = heartbeat(s);
    const agents = agentsFor(s.stateDir);
    const ok = agents.length === 0 && hb.port?.state === 'bound-by-other' && hb.port?.owner_pid === foreign.pid;
    record(
      'punch port held by a foreign process: no agent is started, reason is named in the heartbeat',
      ok,
      // `state` is read from the last transition rather than asserted: the supervisor cycles
      // degraded -> backoff -> gate -> degraded while the port stays blocked, and any single sample
      // of it is a moment in that cycle. `last_reason` and `port.state` are the durable facts.
      `agents=${agents.length} heartbeat.state=${hb.state} last_reason=${hb.last_reason} port.state=${hb.port?.state} ` +
        `port.owner_pid=${hb.port?.owner_pid} (foreign pid=${foreign.pid})`,
      s,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkForceKillRecovery() {
  const port = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    startSupervisor(s);
    const g1 = await waitForSettled(s, port);
    forceKill(g1.supervisor_pid);
    await waitFor('generation 1 to be gone', async () => !isAlive(g1.supervisor_pid), 15_000);
    const orphanStillThere = isAlive(g1.child_pid);
    const lockLeftBehind = lockFile(s) !== null;
    // Generation 2 is the next watchdog tick.
    startSupervisor(s);
    const hb = await waitForSettledGeneration(s, port, g1.supervisor_pid);
    const agents = agentsFor(s.stateDir);
    const owner = udpOwner(port);
    const ok =
      orphanStillThere &&
      lockLeftBehind &&
      agents.length === 1 &&
      agents[0] === hb.child_pid &&
      owner === hb.child_pid &&
      hb.lock?.takeovers_total >= 1 &&
      (hb.orphans_reaped_pids ?? []).includes(g1.child_pid);
    record(
      'supervisor killed with Stop-Process -Force: stale lock taken over, orphan reaped, one agent left',
      ok,
      `after the kill: supervisor ${g1.supervisor_pid} gone, agent ${g1.child_pid} survived=${orphanStillThere}, lock file left behind=${lockLeftBehind}; ` +
        `generation 2 supervisor_pid=${hb.supervisor_pid} reaped=[${(hb.orphans_reaped_pids ?? []).join(',')}] agents=${agents.length} ` +
        `port_owner=${owner} takeovers_total=${hb.lock?.takeovers_total}`,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkTreeKillRecovery() {
  const port = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    startSupervisor(s);
    const g1 = await waitForSettled(s, port);
    // The console-teardown shape: Task Scheduler ends the task's tree with 0xC000013A. The detached
    // agent is not in that tree -- that is the whole point of detaching it -- so it survives, and
    // that survival is what used to leak. A forced tree kill is the reproducible stand-in.
    killOnly(g1.supervisor_pid);
    await waitFor('generation 1 to be gone', async () => !isAlive(g1.supervisor_pid), 15_000);
    const orphanStillThere = isAlive(g1.child_pid);
    startSupervisor(s);
    const hb = await waitForSettledGeneration(s, port, g1.supervisor_pid);
    const agents = agentsFor(s.stateDir);
    const owner = udpOwner(port);
    const ok =
      orphanStillThere &&
      agents.length === 1 &&
      agents[0] === hb.child_pid &&
      owner === hb.child_pid &&
      (hb.orphans_reaped_pids ?? []).includes(g1.child_pid);
    record(
      'tree kill (console-teardown shape): the detached orphan is reaped by the next generation',
      ok,
      `after the tree kill: supervisor ${g1.supervisor_pid} gone, detached agent ${g1.child_pid} survived=${orphanStillThere}; ` +
        `generation 2 reaped=[${(hb.orphans_reaped_pids ?? []).join(',')}] agents=${agents.length} port_owner=${owner}`,
    );
  } finally {
    cleanupScenario(s);
  }
}

async function checkRepeatedKillsDoNotAccumulate() {
  const port = await unboundPort();
  const extraPort = await unboundPort();
  const s = scenario('fresh', port);
  try {
    cleanIdentity(s);
    // The regime that produced fourteen processes: kill after kill, each leaving its detached agent.
    // The invariant is not "one orphan is cleaned up", it is "nothing accumulates" -- so the third
    // generation must still find exactly one agent of this identity, whoever started it.
    const counts = [];
    let firstOrphan = null;
    let previousPid = null;
    for (let generation = 1; generation <= 3; generation += 1) {
      if (generation === 1) startOrphan(s, extraPort); // a pre-existing orphan, older than any supervisor here
      startSupervisor(s);
      const hb = generation === 1 ? await waitForSettled(s, port) : await waitForSettledGeneration(s, port, previousPid);
      previousPid = hb.supervisor_pid;
      if (generation === 1) firstOrphan = hb.child_pid;
      const agents = agentsFor(s.stateDir);
      counts.push(agents.length);
      if (generation < 3) {
        forceKill(hb.supervisor_pid);
        await waitFor(`generation ${generation} to be gone`, async () => !isAlive(hb.supervisor_pid), 15_000);
      }
    }
    const hb = heartbeat(s);
    const agents = agentsFor(s.stateDir);
    const owner = udpOwner(port);
    const ok = counts.every((count) => count === 1) && agents.length === 1 && owner === hb.child_pid && firstOrphan !== null && !isAlive(firstOrphan);
    record(
      'three generations with kills in between: the agent count never exceeds one',
      ok,
      `agents observed after each generation start=[${counts.join(',')}] final agents=${agents.length} (pid=${agents[0]}) port_owner=${owner}; ` +
        `the pre-existing orphan pid=${firstOrphan} alive=${firstOrphan !== null && isAlive(firstOrphan)}`,
    );
  } finally {
    cleanupScenario(s);
  }
}

// ---------------------------------------------------------------------------------------------
console.log(`w2m supervisor invariant check -- ${new Date().toISOString()}`);
console.log(`supervisor : ${supervisorPath}`);
console.log(`temp tree  : ${root}${keep ? ' (kept)' : ''}`);
console.log('');

// Before anything runs, end every agent of both identities and forget their locks. This is also the
// first demonstration of the property under test: it reaches agents left by earlier runs precisely
// because the identity is stable, which is what the supervisor's reap does too.
const preCleaned = [...cleanIdentity(scenario('stale', 0)), ...cleanIdentity(scenario('fresh', 0))];
console.log(`pre-clean: terminated ${preCleaned.length} agent(s) left by earlier runs${preCleaned.length > 0 ? ` [pids ${preCleaned.join(',')}]` : ''}`);
console.log('');

const scenarios = [
  ['clean start', checkHealthyStart],
  ['stale orphans + stale lock', checkStaleOrphansAndStaleLock],
  ['live lock blocks a second generation', checkLockStopsASecondGeneration],
  ['unreadable lock', checkUnreadableLock],
  ['foreign punch-port holder', checkForeignPortHolderIsFatalAndNamed],
  ['Stop-Process -Force recovery', checkForceKillRecovery],
  ['tree-kill recovery', checkTreeKillRecovery],
  ['repeated kills do not accumulate', checkRepeatedKillsDoNotAccumulate],
];
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;
const selected = only === null ? scenarios : scenarios.filter(([name]) => name.includes(only));
if (selected.length === 0) {
  console.log(`no scenario matches "${only}"; known: ${scenarios.map(([name]) => name).join(' | ')}`);
  process.exit(2);
}
for (const [name, run] of selected) {
  try {
    await run();
  } catch (error) {
    record(name, false, `threw: ${error.message}`, activeScenario);
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
console.log('NOT exercised here: the real agent, the machine\'s real punch port, and Windows Task');
console.log('Scheduler. This check drives w2m-agent-supervisor.mjs directly with a stub worker, on');
console.log('ports the OS picks, so it needs no elevation and cannot disturb a running installation.');
if (!keep) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.log(`could not remove ${root}: ${error.message}`);
  }
}
process.exit(failed.length === 0 ? 0 : 1);
