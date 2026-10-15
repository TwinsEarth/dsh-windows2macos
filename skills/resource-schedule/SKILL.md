---
name: resource-schedule
description: Use when deciding how to consume the fleet's capacity across machines, when a task came back partial because a machine was offline, when a lease expired instead of failing, or when a long command needs a timeout that fits inside the agent's execution ceiling. Covers lease states, the ~50s agent ceiling, w2m_update's schedule, and why an expiry is not a failure.
---

# Resource scheduling

The fleet is a small pool of heterogeneous machines, and most disappointing results come from treating it as
a queue of identical workers.

## Lease states are the scheduling vocabulary

| State | Means | Retry? |
|---|---|---|
| `queued` | handed to the machine | — |
| `offered` | published, not yet taken | — |
| `done` | **the command ran.** `exit_code` is meaningful, including non-zero | no |
| `refused` | the machine declined before running; read `refusal_reason` | only after fixing the cause |
| `expired` | **nobody ran it.** `exit_code` is `null` | yes — the machine was not there |
| `observing` | `broadcast` chose another executor; this machine was told, not asked | no, by design |

**`expired` and `failed` are different findings with different responses.** An expiry says the fleet lacked
capacity; a failure says the command was wrong. Aggregating them into "it didn't work" loses the only
information that decides what to do next.

## The ~50 second ceiling, measured repeatedly

**An agent-side execution has a ceiling near 50 seconds, and it has been hit more than eight times in a single
working session.** Symptoms are an expiry rather than an error, so it reads as a missing machine.

Consequences for scheduling:

- **Keep a dispatched command under the ceiling**, or expect the lease to expire and the task to come back
  `partial`.
- `--timeout` and `timeout_ms` bound **the whole pipeline chain, not each stage.** Three 20-second stages
  inside a 50-second timeout will be cut off at the third.
- **A long job belongs on one machine with a written artifact, not replicated.** Replicating a job that
  outlives the ceiling multiplies the expiries by the machine count.

## Offline is the normal case, not an error

`w2m_devices` lists machines the relay holds a lease for; `w2m_stats` reports how many are online.
**These two have disagreed in practice** — a machine can be listed and answer `silent`. Treat "online" as
"worth trying", and read the per-machine outcome afterwards.

**Partial is therefore the expected verdict for any replicated task on a fleet with offline members**, and it
is not a signal that the command was wrong. Check `counts.expired` before concluding anything about the code.

## Time is not the only scarce resource

- **One writable lease at a time** is available via `require_exclusive_write`. Two machines writing the same
  paths without it is a race the relay will not prevent for you.
- **`write_scope` is project-relative prefixes.** A write outside the declared scope is not made, so a task
  that needs to write must declare where.
- **Read-only is the default.** A dispatch that must not modify anything needs no flags — that is the default,
  and `write: true` is the deliberate opt-in.

## Scheduled work in this system

- **Update checks run at 00:00, 03:00 and 05:00 Beijing time**, and a new version is installed **only after
  verifying the hash published with it**. A check that cannot reach the network comes back as a **recorded
  error**, which is deliberately different from "already up to date" — **do not read a negative result as a
  positive one.**
- **An install takes effect at the next start.** Nothing hot-swaps, and `w2m_status` reports
  `restart_required` so the deferral is visible rather than silent.

## Scheduling checklist

1. `w2m_devices` or `w2m_stats` — **how much capacity actually exists right now.**
2. Estimate the runtime against **the ~50s ceiling**, and reshape the work if it exceeds it.
3. Choose `replicate` only when you need agreement; otherwise pick the smallest set that answers the question.
4. After the wait, read `counts` first: `expired` is capacity, `failed` is the command, `refused` is policy.
