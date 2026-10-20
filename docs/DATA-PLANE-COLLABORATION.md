# Data plane and collaboration: the design this fleet is building toward

> Status: **design + first slice (v1.2.9-beta.1)**. The slice is a pure function that turns an aggregate into a *reduce
> suggestion*; it dispatches nothing. Everything below the slice is the plan the slice is measured against, not a claim that it
> exists.

## 1. What "data plane" means here

A task has three planes in this fleet:

| plane | what moves | owns |
|---|---|---|
| control | dispatch, leases, retries, cancellation | relay (`state.mjs`) |
| data | command output, stage artifacts, blobs | agent (`agent.mjs`) + relay blob store |
| collaboration | chat, turns, memory, council | plugin (`tools.mjs`, `ask-store.mjs`, `council-fleet.mjs`) |

The data plane is **not allowed to make a verdict**. It moves bytes; the aggregate decides. That rule is why the reduce plan is
computed by a reader (`w2m_wait`) from published facts, and why this release adds only a *suggestion*: a party that has the plan
must still be the one that says "run the reduce".

## 2. The shard contract (implemented in v1.2.7)

1. A task declares `index_total`. It is the completeness contract, not a hint.
2. A result claims a shard with `index`; only machines that actually reported count.
3. `buildReducePlan({ results, reducerMachineId, expectedIndexTotal })` refuses:
   - `MISSING_SHARD` + `{ missing, expectedIndexTotal }`,
   - `MAP_INDEX_MISSING`, `MAP_INDEX_OUT_OF_RANGE`,
   - `BLOB_MISSING`, `MAP_MACHINE_MISSING`, `NO_MAP_RESULTS`.
4. An artifact above the inline cap is a blob (`blob_sha256` + `output_mode: 'blob'`), uploaded by the agent, addressed by its own
   hash, transport frame 16 MiB.
5. **A partial fleet never reduces.** `dataflow_degraded: true` is the value; a caller that ignores it is ignoring a stated fact.

## 3. What v1.2.9-beta.1 adds: `suggestReduce`

`w2m_wait` now returns a `reduce_suggestion` alongside the verdict:

```json
{
  "ready": true,
  "plan": { "ok": true, "reducerMachineId": "…", "inputs": [ … ] },
  "candidates": [{ "machine_id": "…", "reason": "reported-shard" }],
  "next": "dispatch the reduce yourself; this tool does not run it"
}
```

Rules it encodes:

- **Ready means all declared shards reported and a reducer is named.** Anything else is a value with the missing indexes.
- **The reducer is not chosen by the tool.** It lists candidates (machines that reported, preferring the declared
  `reducer_machine_id` when present) and refuses to invent one: a reduce that runs on an arbitrary machine is a second dispatch
  decision, and dispatch belongs to the caller.
- **The suggestion is derived, never stored.** Two readers of the same aggregate get the same suggestion, and no relay state
  changes by reading it.

## 4. The reduce execution question (open)

Two shapes are possible, and the fleet has not chosen one:

| shape | dispatch of reduce | trade |
|---|---|---|
| **caller-dispatched** (current direction) | the caller reads the plan and dispatches a task with `reduce_argv` to the named reducer | relay never decides to run a command; one extra round trip and the caller can ignore the plan |
| **auto-reduce** | the relay, on all-shards-reported, dispatches the reduce itself | fewer steps; the relay becomes an executor of a command it chose, which is the boundary every other design decision avoids |

The design leans caller-dispatched. A beta that flips that default would be the wrong place to discover it.

## 5. Collaboration plane, next

The collaboration gaps that remain after v1.2.6/v1.2.7 (turns, DAG, membership, memory CAS) are:

1. **Conflict merge UI** — `w2m_memory read` returns `behind_by`/`unread_records`; a reader can see a conflict but has no guided
   merge. Next slice: a pure `renderMergeHint()` and a re-read flow that shows both sides of a conflicting record.
2. **Council decision trail** — `council-fleet.mjs` decides and reports; the decision is not written to shared memory. Next slice:
   an explicit, caller-invoked append of the decision as a memory record (same CAS as any other write).
3. **DAG visibility in the client** — the board exists in `w2m_tasks`; the composer panel does not show it. Next slice: a read-only
   board view from the same endpoint.

## 6. Acceptance for this design

- The suggestion is a pure function with unit tests for: all shards present, missing shards, no reducer named, mixed
  inline+blob inputs, and a duplicate machine index.
- `w2m_wait` carries it for every complete aggregate and never dispatches anything.
- Gate GREEN twice before the beta tag; beta artifacts are a GitHub prerelease, never npm.
