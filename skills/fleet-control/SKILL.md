---
name: fleet-control
description: Use when dispatching a command to the W2M fleet, choosing between replicate, split, broadcast and pipeline, interpreting a verdict's aggregate state or a per-machine refusal_reason, or diagnosing why a task was partial instead of consistent. Covers the four modes, the anchors that decide comparability, and every refusal code a dispatch can return.
---

# Fleet control

Dispatch one command to many machines and read the verdict honestly. The tools are `w2m_run`, `w2m_wait`,
`w2m_report`, `w2m_devices`, `w2m_stats`, `w2m_history`, `w2m_status`.

## The relay carries one exit code and no output

**This is the single fact that changes how you read every result.** A result envelope carries
`exit_code`, `stdout_sha256`, `stdout_bytes`, `stdout_normalized_sha256`, `stderr_sha256`, and `artifacts` —
**never stdout itself.** So:

- You can compare two machines byte-for-byte and you cannot read what either printed.
- To get a value back, encode it in the **exit code**. One bit per question, eight bits per exit code.
- To get bytes back, write a file and declare it in `artifacts`.

Do not write a task that prints its answer and expect to read it. **The verdict is the product.**

## Pick the mode by what you mean, not by how many machines answer

| Mode | Meaning | `index_total` |
|---|---|---|
| `replicate` | every machine runs the whole command, results are compared | must be 1 |
| `split` | each machine takes its share by index | the number of slices |
| `broadcast` | **one** machine runs it; the rest are told the outcome and never run anything | 1 |
| `pipeline` | every machine runs the whole chain in order, stopping at the first failing stage | 1 |

`broadcast` needs `executor_machine_id`. Without it the first machine the relay lists is chosen
deterministically — **so the same task record describes the same execution twice**, which is the point.

**`broadcast`'s observers are recorded as `observing` and are never counted as having verified the result.**
If you want N machines to agree, you want `replicate`, not `broadcast`.

**A single command is wrapped as a one-stage chain and run through the pipeline loop.** There is exactly one
spawn path, so a mode-specific claim about `cwd` or argv must hold for the chain form too.

## Read the verdict before you act on it

Nine states, and **the difference between two of them is the difference between "it ran" and "it never
started"**:

| State | Means |
|---|---|
| `consistent` | every machine that answered agreed |
| `divergent` | machines answered, and their comparable fields differ |
| `divergent-platform` | **the differences are fully explained by OS/arch** — not a defect |
| `partial` | some machines answered and others did not |
| `failed` | a machine ran the command and it returned non-zero |
| `unverifiable` | the comparison could not be made |
| `timeout` | the wait elapsed |
| `cancelled` | an operator cancelled it |
| `degraded` | the relay reports a reduced condition |

**`exit_code: null` with `lease_state: expired` means the machine never ran it.** `exit_code` non-zero with
`lease_state: done` means it ran and failed. **A non-zero exit is a result; an expiry is an absence.**

## Refusals are values, not exceptions

A refusal is a machine declining before execution, and it is reported per machine:

| `refusal_reason` | Means | Your move |
|---|---|---|
| `COMMAND_NOT_ALLOWED` | the entry is not in **that machine's** allow-list | check the allow-list; do not retry blindly |
| `COMMAND_REPARSING_ARGUMENT` | an argument would make the interpreter load code | name the flag in an entry of its own, or stop |
| `COMMAND_EXECUTABLE_PATH_MISMATCH` | `argv[0]` is not the executable that entry names | call the entry by the name it declares |
| `COMMAND_EXECUTABLE_RELATIVE_PATH` | `argv[0]` is a relative path | it names a different file in every directory, which is why it is refused |
| `CWD_OUTSIDE_PROJECT` | `cwd_rel` escapes the project | pass `cwd_outside_project: true` **only** when that is intended |
| `PATH_INVALID` | no such cwd | **A missing directory is reported as a missing executable** — read the detail, not just the name |

**Allow-lists are per machine.** The same command can be allowed on one host and refused on another in the
same task, and that is a `partial` verdict rather than a bug.

## Anchors decide whether the comparison was meaningful

`base_commit`, `base_tree`, and `command_hash` are computed from the dispatcher's working tree; each machine
reports its own `pre_tree_fingerprint`. **When the dispatcher's own tree cannot be fingerprinted, no anchor is
declared and the note says so** — agreement is then agreement *with each other*, not with a named tree.

**Read that note.** A `consistent` verdict with no anchor is weaker than it looks, and `w2m_report` states
which case you are in.

## Before dispatching

1. `w2m_devices` — who is actually online. **A machine listed may still refuse the next command.**
2. `w2m_stats` — the cheap shape of the fleet, and whether the relay restarted.
3. Choose the mode from the *meaning*, not the machine count.
4. After the wait, read `counts`, `notes`, and every `refusal_reason` **before** reading the aggregate state.
