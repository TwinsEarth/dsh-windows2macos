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
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
if (Array.isArray(fileAgentArgs)) passthrough.push(...fileAgentArgs.map(String));
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

let runs = 0;
while (!stopping) {
  runs += 1;
  const startedAt = Date.now();
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });

  const result = await new Promise((resolve) => {
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.on('error', (error) => {
      say(`[w2m-supervisor] spawn failed: ${error.message}`);
      resolve({ exitCode: null, signal: null });
    });
  });

  const lived = Math.round((Date.now() - startedAt) / 1000);
  say(
    `[w2m-supervisor] run ${runs} exited code=${result.exitCode} signal=${result.signal} after ${lived}s` +
      `${stopping ? ' (stopping)' : ' -- restarting'}`,
  );
  if (stopping) break;
  // Deliberately NOT unref'ed: an unref'ed timer with nothing else pending lets Node exit during the
  // backoff, which is the silent death this loop exists to prevent.
  await new Promise((resolve) => {
    setTimeout(resolve, backoffMs);
  });
}
log.end();
