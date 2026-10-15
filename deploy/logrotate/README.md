# Bounding the log writers on a fleet machine

Two incidents put this file here, and both are recorded in the CHANGELOG with their measurements:

* **2026-10-14, the Linux relay host** — root filesystem reached 100% from a single uncapped writer at
  **14.7 GB/day**. Recovery was `truncate`, **not** `rm`, because rsyslog still held the descriptor open.
* **2026-10-11 → 10-12, MacMini** — `relay-test` and node logs grew **40×** in a day.

## What this directory is, and what it is not

`w2m.logrotate` is a **host-level** configuration. It has to be installed on the machine, by someone with
root, and it is therefore something this repository can *offer* and cannot *enforce*. Saying otherwise would
be the kind of claim the fleet rules exist to prevent.

What the repository **can** enforce is `src/agent/log-bounds.mjs`: it finds what is growing, decides the
method (`truncate` for anything a process writes, `remove` for build output), and refuses anything
irreplaceable. That runs from a task on any machine, needs no root, and reports through an exit code.

**Use both.** The configuration is the durable fix; the module is what tells you it is needed and proves it
was applied.

## Install the configuration

```sh
# Debian/Ubuntu, as root
install -m 0644 deploy/logrotate/w2m.logrotate /etc/logrotate.d/w2m

# Check what it would do, without doing it
logrotate --debug /etc/logrotate.d/w2m

# Force one pass now
logrotate --force /etc/logrotate.d/w2m
```

On a systemd host the timer is usually already enabled:

```sh
systemctl status logrotate.timer
```

## The two directives that matter, and why

**`copytruncate` is not optional here.** Without it, rotation renames the file and the daemon keeps writing
to the old descriptor: the new file stays empty and **the disk stays full**. That is the 2026-10-14 failure
in a different costume, and it is why `src/agent/log-bounds.mjs` returns `truncate` rather than `remove` for
anything a process is writing. The cost of `copytruncate` is a brief window where writes to the file can be
lost, which is acceptable for logs and would not be for a ledger.

**`maxsize` is set as well as the schedule.** A file growing 40× in a day reaches any sane cap long before a
daily timer looks at it. `daily` plus `maxsize 256M` means "at least once a day, and immediately if it gets
big", which is the behaviour both incidents needed.

## If the paths are not these paths

The configuration names the directories this fleet actually uses. Confirm them on the machine before
installing, rather than trusting this list:

```sh
# The largest files under the directories that matter, largest first
du -ah /var/log /var/lib/w2m /tmp 2>/dev/null | sort -rh | head -30

# What is growing right now, over 60 seconds
node -e '
  const { snapshot, growth } = await import("./src/agent/log-bounds.mjs");
  const before = snapshot("/var/log");
  await new Promise((r) => setTimeout(r, 60000));
  const after = snapshot("/var/log");
  for (const f of growth(before, after, 60000).findings) {
    console.log((f.bytes_per_day / 1024 ** 3).toFixed(2) + " GB/day  " + f.path);
  }
'
```

## Build artefacts: `cargo clean` and its equivalents

The third part of the same problem is that build output accumulates in project copies and in `/tmp`. The
general rule the module applies is **rebuildable things are preferred cleanup targets over anything unique**
(`classFor` returns `rebuildable` for `node_modules`, `dist`, `target` and `build`).

```sh
cargo clean                       # a Rust target/ directory is routinely tens of GB
rm -rf node_modules dist .next    # rebuildable from the lockfile and the source
git -C <repo> clean -xdf          # removes ignored files; check `git clean -xdn` first
```

`git clean -xdf` is the one to be careful with: it removes *everything* untracked and ignored, which includes
any local notes that were never committed. Run `git clean -xdn` first and read the list.

## What must never be cleaned, whatever the pressure

`src/agent/log-bounds.mjs` refuses these by resolved path and by name, and the refusal carries its reason:

| Path | Why |
|---|---|
| `memory.jsonl` | The **only** durable copy of what a command printed — the relay keeps `stdout_sha256` and never the text. |
| `device.json`, `device.key` | The identity peers know this machine by. Losing the key makes every peer holding the old one refuse this machine, with no visible cause. |
| `fleet-memory.md` | Curated by hand; not reproducible from anything. |
| `.git/` | The history, which is the only record of what was verified. |
| `src/`, `lib/`, `bin/`, `deploy/`, `profiles/` | The tree and the data directory. |

A directory that fills up is a reason to clean the *rebuildable* things first. It is never a reason to delete
the database.
