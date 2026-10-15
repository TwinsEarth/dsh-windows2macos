/**
 * Service health: measure, classify, and recommend — never act.
 *
 * ## Why this module only advises
 *
 * A component that both decides a server is unhealthy *and* changes that server is one bug away from
 * deleting the thing it was protecting. Today gave a real example: the Linux host's root filesystem
 * reached 100% because a process wrote 14.7 GB/day with no cap, and the recovery was `truncate` — **not**
 * `rm` — because rsyslog still held the file descriptor open and removing it would have freed nothing
 * while appearing to. A cleaner that had decided on its own to delete "the big log file" would have
 * looked successful and changed nothing.
 *
 * So the split here is deliberate: this module produces measurements and named recommendations, and a
 * separate caller with a human in the loop performs them. Every destructive idea is expressed as a
 * *proposal with a reason*, and the ones that are safe to automate are marked as such and nothing more.
 *
 * ## Where the thresholds come from
 *
 * Not from a style guide. Each is tied to something that actually happened:
 *
 *   * **Disk** — the incident above. `critical` at 90% used or under 1 GB free; `warn` at 80%. The host
 *     was at 100% with 268 MB free, which is the state this is for.
 *   * **Log growth** — 14.7 GB/day is the measured rate that caused it. Any single log growing faster
 *     than 1 GB/day is reported by name, because "the disk is filling" is not actionable and "this file
 *     is filling it" is.
 *   * **The 50-second task ceiling** — a machine whose load average is high enough to slow task
 *     execution is a machine that will start expiring tasks, so load is compared against CPU count
 *     rather than against an absolute number.
 *   * **Memory** — the relay host ran with 896 MB free of 16384 MB on MacMini during this session, which
 *     was fine; the threshold is set where the host starts swapping, not where it looks comfortable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { hostname, loadavg, cpus, freemem, totalmem, uptime, platform, arch, release } from 'node:os';

/** Severity, ordered. A caller compares `>=` rather than matching strings. */
export const SEVERITY = Object.freeze({ OK: 0, WARN: 1, CRITICAL: 2 });

/** Exit codes, so a fleet health check can report through a channel that carries only a status. */
export const HEALTH_EXIT = Object.freeze({ OK: 1, WARN: 2, CRITICAL: 3, UNREADABLE: 4 });

/** Bytes in a gigabyte, because every threshold below is about disk. */
const GB = 1024 ** 3;

/** The measured rate that filled the Linux host: 14.7 GB/day. A tenth of it is already too fast. */
export const LOG_GROWTH_WARN_BYTES_PER_DAY = 1 * GB;

/**
 * Which paths are worth checking for growth, by platform.
 *
 * Deliberately short. A health check that walks a whole filesystem is itself a load source, and the
 * incident was caused by *two* files rather than by a general untidiness — so the check names the places
 * where an unbounded writer has actually been observed.
 */
export const LOG_PATHS = Object.freeze({
  linux: ['/var/log', '/var/lib/w2m', '/tmp'],
  darwin: ['/var/log', '/tmp', '/Users'],
  win32: ['C:\\Windows\\Logs', 'C:\\Windows\\Temp'],
});

/** Run a command and never throw; a missing tool is a state, not a failure. */
function run(file, args, timeout = 15000) {
  try {
    return { ok: true, out: String(execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })).trim() };
  } catch (e) {
    return { ok: false, code: e.status ?? e.code ?? null, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? e.message ?? '').trim().slice(0, 300) };
  }
}

/**
 * Free space for a path, in bytes, or `null` when it cannot be determined.
 *
 * `df -Pk` is the portable form: `-P` gives one line per filesystem in a fixed order, `-k` gives
 * kilobytes regardless of the block size the platform would prefer. On Windows `df` does not exist, so
 * the answer is `null` — and `null` is reported as "not measured" rather than as "plenty", because
 * collapsing those two is how a full disk reads as an empty one.
 */
export function diskFree(pathname) {
  const df = run('df', ['-Pk', pathname]);
  if (!df.ok) return null;
  const lines = df.out.split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const parts = lines[lines.length - 1].split(/\s+/);
  // Filesystem, 1K-blocks, Used, Available, Capacity, Mounted-on
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const available = Number(parts[3]);
  if (!Number.isFinite(total) || !Number.isFinite(available)) return null;
  return {
    path: pathname,
    total_bytes: total * 1024,
    used_bytes: Number.isFinite(used) ? used * 1024 : null,
    free_bytes: available * 1024,
    used_percent: total > 0 ? Math.round(((total - available) / total) * 1000) / 10 : null,
  };
}

/** Directory size in bytes, bounded by a file count so a health check cannot become the load. */
export function directoryBytes(pathname, { maxEntries = 5000 } = {}) {
  if (!existsSync(pathname)) return { path: pathname, bytes: 0, files: 0, truncated: false, missing: true };
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = [pathname];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxEntries) { truncated = true; break; }
      const full = `${dir}/${entry.name}`;
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) { bytes += statSync(full).size; files += 1; }
      } catch { /* unreadable entry: counted as neither */ }
    }
    if (truncated) break;
  }
  return { path: pathname, bytes, files, truncated, missing: false };
}

/** Largest files under a path, which is the actionable half of "the disk is filling". */
export function largestFiles(pathname, { limit = 5, maxEntries = 5000 } = {}) {
  if (!existsSync(pathname)) return [];
  const found = [];
  let seen = 0;
  const stack = [pathname];
  while (stack.length > 0 && seen < maxEntries) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break;
      const full = `${dir}/${entry.name}`;
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) { seen += 1; found.push({ path: full, bytes: statSync(full).size }); }
      } catch { /* skip */ }
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/**
 * Measure this machine.
 *
 * Every field is either a number or `null`, and `null` always means "not measured here" — never zero.
 */
export function sample({ now = Date.now() } = {}) {
  const load = loadavg();
  const cpuCount = cpus().length;
  const free = freemem();
  const total = totalmem();

  const disks = [];
  for (const p of ['/', ...(platform() === 'darwin' ? ['/System/Volumes/Data'] : [])]) {
    const d = diskFree(p);
    if (d !== null) disks.push(d);
  }

  const logDirs = LOG_PATHS[platform()] ?? [];
  const logs = logDirs.map((p) => {
    const sized = directoryBytes(p);
    return { ...sized, largest: largestFiles(p, { limit: 3 }) };
  });

  return {
    at: new Date(now).toISOString(),
    host: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    uptime_s: Math.round(uptime()),
    cpu_count: cpuCount,
    load_1m: load[0] ?? null,
    load_5m: load[1] ?? null,
    load_15m: load[2] ?? null,
    mem_total_bytes: total,
    mem_free_bytes: free,
    mem_used_percent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null,
    disks,
    log_dirs: logs,
    node: process.version,
  };
}

/**
 * Classify a sample.
 *
 * Returns findings rather than a single verdict, because "the disk is 91% full" and "this log grew a
 * gigabyte today" need different responses and a single word hides which one you have. The overall
 * severity is the worst finding, and it is reported *with* the findings rather than instead of them.
 */
export function assess(s, options = {}) {
  const diskWarnPercent = options.diskWarnPercent ?? 80;
  const diskCriticalPercent = options.diskCriticalPercent ?? 90;
  const diskCriticalFreeBytes = options.diskCriticalFreeBytes ?? 1 * GB;
  const loadPerCpuWarn = options.loadPerCpuWarn ?? 1.5;
  /**
   * The critical multiple, named rather than derived.
   *
   * It was `loadPerCpuWarn * 2`, which reads as a rule and is a coincidence: it happens to equal 3.0 only
   * while the warning threshold is 1.5, so changing one would silently move the other. Its own test
   * asserted the documented 1.5/3.0 pair and failed, which is how this was found.
   */
  const loadPerCpuCritical = options.loadPerCpuCritical ?? 3;
  const memWarnPercent = options.memWarnPercent ?? 90;
  const growthWarn = options.logGrowthWarnBytesPerDay ?? LOG_GROWTH_WARN_BYTES_PER_DAY;

  const findings = [];
  const add = (severity, code, detail, action) => findings.push({ severity, code, detail, action });

  if (s === null || typeof s !== 'object') {
    return { severity: SEVERITY.CRITICAL, findings: [{ severity: SEVERITY.CRITICAL, code: 'NO_SAMPLE', detail: 'no sample was produced', action: null }] };
  }

  for (const d of s.disks ?? []) {
    if (d.used_percent === null) continue;
    if (d.used_percent >= diskCriticalPercent || d.free_bytes < diskCriticalFreeBytes) {
      add(SEVERITY.CRITICAL, 'DISK_CRITICAL',
        `${d.path} is ${d.used_percent}% used with ${(d.free_bytes / GB).toFixed(2)} GB free`,
        `truncate the largest file under ${d.path} rather than removing it if a process still holds it open`);
    } else if (d.used_percent >= diskWarnPercent) {
      add(SEVERITY.WARN, 'DISK_WARN', `${d.path} is ${d.used_percent}% used`, 'check growth before it reaches 90%');
    }
  }

  for (const dir of s.log_dirs ?? []) {
    if (dir.missing === true) continue;
    if (dir.truncated === true) {
      add(SEVERITY.WARN, 'LOG_SCAN_TRUNCATED', `${dir.path} holds more files than the scan reads`, null);
    }
    for (const f of dir.largest ?? []) {
      if (f.bytes >= growthWarn) {
        add(SEVERITY.WARN, 'LOG_FILE_LARGE',
          `${f.path} is ${(f.bytes / GB).toFixed(2)} GB`,
          `confirm what writes it; today's incident was ${(14.7).toFixed(1)} GB/day from one daemon, and logrotate is the fix`);
      }
    }
  }

  if (Number.isFinite(s.load_1m) && Number.isFinite(s.cpu_count) && s.cpu_count > 0) {
    const perCpu = s.load_1m / s.cpu_count;
    if (perCpu >= loadPerCpuCritical) {
      add(SEVERITY.CRITICAL, 'LOAD_CRITICAL', `load ${s.load_1m} over ${s.cpu_count} CPUs (${perCpu.toFixed(2)}/cpu)`,
        'a machine this loaded will start expiring tasks at the ~50s lease ceiling');
    } else if (perCpu >= loadPerCpuWarn) {
      add(SEVERITY.WARN, 'LOAD_WARN', `load ${s.load_1m} over ${s.cpu_count} CPUs (${perCpu.toFixed(2)}/cpu)`, null);
    }
  }

  if (Number.isFinite(s.mem_used_percent) && s.mem_used_percent >= memWarnPercent) {
    add(SEVERITY.WARN, 'MEM_WARN', `${s.mem_used_percent}% of memory used (${((s.mem_total_bytes - s.mem_free_bytes) / GB).toFixed(1)} GB of ${(s.mem_total_bytes / GB).toFixed(1)} GB)`,
      'identify the largest resident process before adding work');
  }

  const severity = findings.reduce((worst, f) => Math.max(worst, f.severity), SEVERITY.OK);
  return { severity, findings };
}

/** The severity, as an exit code that a channel carrying only a status can transport. */
export function exitCodeFor(assessment) {
  if (assessment?.severity === SEVERITY.CRITICAL) return HEALTH_EXIT.CRITICAL;
  if (assessment?.severity === SEVERITY.WARN) return HEALTH_EXIT.WARN;
  return HEALTH_EXIT.OK;
}

/** The name to print for a severity. */
export function severityName(severity) {
  if (severity === SEVERITY.CRITICAL) return 'critical';
  if (severity === SEVERITY.WARN) return 'warn';
  return 'ok';
}

/**
 * A one-line claim, for a fleet roll-up.
 *
 * Deliberately the *worst* finding rather than a count, because a status line that says "3 findings" makes
 * the reader ask which one matters and a line that names it does not.
 */
export function headline(s, assessment) {
  const worst = (assessment?.findings ?? []).find((f) => f.severity === assessment.severity);
  if (worst === undefined) return 'ok';
  return `${severityName(worst.severity)}: ${worst.code} - ${worst.detail}`;
}

/**
 * Which of this machine's own files are worth keeping forever.
 *
 * This is the "permanent storage" half, and it is expressed as a **classification** rather than as a copy
 * action, because deciding to copy is a policy about where data may live and this module has no standing
 * to make it. What it can say is which data is irreplaceable, and that is a fact:
 *
 *   * `memory.jsonl` — the relay keeps hashes and never the text, so this file is the **only** durable copy
 *     of what a command printed. Deleting it deletes the fleet's ability to answer what it already tried.
 *   * `device.json` and `device.key` — identity and the key peers know this machine by. Losing the key
 *     makes every peer that holds the old one refuse this machine, with no visible cause.
 *   * `fleet-memory.md` — curated knowledge, written by hand, and therefore not reproducible from anything.
 *
 * Everything else is `disposable`: state that is rebuilt, spools that are in flight, and any log whose
 * value is in its tail rather than its whole.
 */
export const DATA_CLASS = Object.freeze({ IRREPLACEABLE: 'irreplaceable', REBUILDABLE: 'rebuildable', DISPOSABLE: 'disposable' });

/** Known filenames and their class, so the answer is the same on every machine. */
export const DATA_CLASSES = Object.freeze({
  'memory.jsonl': DATA_CLASS.IRREPLACEABLE,
  'memory.jsonl.1': DATA_CLASS.IRREPLACEABLE,
  'device.json': DATA_CLASS.IRREPLACEABLE,
  'device.key': DATA_CLASS.IRREPLACEABLE,
  'fleet-memory.md': DATA_CLASS.IRREPLACEABLE,
  'agent-state.json': DATA_CLASS.REBUILDABLE,
  'ledger.jsonl': DATA_CLASS.IRREPLACEABLE,
  'devices.json': DATA_CLASS.REBUILDABLE,
  'spool': DATA_CLASS.DISPOSABLE,
});

/** @param {string} name @returns {string} */
export function classifyData(name) {
  const base = String(name).split(/[/\\]/).pop();
  return DATA_CLASSES[base] ?? DATA_CLASS.DISPOSABLE;
}
