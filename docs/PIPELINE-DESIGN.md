# Pipeline mode: the design question that has to be answered first

> **Status: resolved and implemented — keep reading for the reasoning, not for a to-do list.**
> `pipeline` shipped in **v0.3.4** as **Option C** below (`replicate` applied to a sequence): every
> machine runs the whole `stages` chain in order, stopping at the first stage that fails, with no
> cross-machine data flow. `src/relay/state.mjs`'s `createTask` accepts `mode: 'pipeline'`, requires a
> non-empty `stages` array of at most `MAX_PIPELINE_STAGES` (16) entries, and refuses `index_total > 1`.
> `CHANGELOG.md`'s `[0.3.4]` entry is the record, and `test/pipeline-e2e.test.mjs` drives a real relay
> and a real agent over it.
>
> **This header used to say "unresolved, and `pipeline` is deliberately not implemented", and that had
> been false since v0.3.4.** The sections below are left as they were written — the analysis is the
> reason the answer is Option C and not Option B, and editing the argument to match its conclusion would
> destroy the only thing this file is good for. Two things in it are now historical rather than
> current: the recommendation was **Option A**, and Option A is **not** what shipped; and "what
> implementing Option A requires" describes a plan, not the implementation.

## What is already settled

`broadcast` (v0.3.2) covers "run once, tell everyone":

| mode | who runs | who is told |
|---|---|---|
| `replicate` | every machine | — |
| `split` | every machine, its own slice by index | — |
| `broadcast` | exactly one machine (deterministic) | every other machine, as an observer |

Observers hold an `observing` lease and are excluded from every aggregation step, so a machine that
did not run can never be counted as agreeing. That much is implemented and tested.

## The question

A pipeline is a chain: stage 1 produces something, stage 2 consumes it, stage 3 consumes that.
On one machine that is unambiguous. On a fleet it is not, because the fleet can run stage 1 on *n*
machines and produce *n* different outputs. So before any code:

> **Which machine's stage-1 output does stage 2 receive?**

There is no default answer that is obviously right. The three defensible ones behave very
differently, and picking wrong is expensive to undo because the aggregate report, the CLI, the tool
schema and the protocol all encode the choice.

## Option A — one machine runs the whole chain

The pipeline executes entirely on a single machine, stage after stage. `broadcast` then selects which
machine, and `pipeline` describes the sequence. Composition: `broadcast + pipeline` = "run this chain
on machine X and tell everyone".

- **Reproducible.** One machine, one chain, one record. Directly restartable: rerun the same chain
  and you get the same shape.
- **Honest.** No cross-machine data flow to model, so nothing can be silently dropped in transit.
- **No new protocol surface.** Stages ship as a list inside the existing offer.
- **Cost:** no parallelism across stages, and the fleet is not used for the chain.

## Option B — stages fan out, results converge

Stage 1 runs on the target set; the relay collects every machine's output and feeds the whole set to
stage 2, which also runs on the target set. This is a fan-out/fan-in graph.

- **Uses the fleet** for the chain, which is the obvious appeal.
- **Cost, and it is the serious one:** "feed the whole set to stage 2" is not a well-defined input.
  Concatenated in what order? What does stage 2 do with three different outputs — run three times in
  parallel on each machine, or once with all three as input? Each answer is a different feature, and
  the aggregate report's meaning changes with each. Ordering alone is a correctness problem: two
  machines finishing in a different order would produce different stage-2 inputs, so the same task id
  would not describe the same execution — which breaks the property this project exists to provide.

## Option C — each machine runs the whole chain independently

Every machine runs stage 1, then its own stage 2, then its own stage 3. No cross-machine flow at all;
it is `replicate` applied to a sequence.

- **Trivial to implement** — stage list inside the existing offer, no relay changes beyond validation.
- **Unambiguous** and keeps per-machine reproducibility.
- **Cost:** it is `replicate` with a for-loop. It adds no capability that running three `replicate`
  tasks in sequence does not already give, so it earns little.

## Recommendation

**Option A**, with Option C as a cheap follow-on if useful.

> **What shipped was Option C, not Option A.** v0.3.4 implemented the chain as `replicate` applied to a
> sequence: no `executor_machine_id`, every machine runs every stage. Option A — "one machine runs the
> whole chain, composed with `broadcast`" — remains **unbuilt**. The recommendation below is kept as
> written, because the reasons it gives are still the reasons Option B was refused; the divergence
> between this recommendation and the shipped behaviour is recorded rather than smoothed over.

Reasons, in order of weight:

1. Option B is the only one that needs cross-machine data flow, and it is the only one whose
   semantics are unclear. Not implementing it is a decision, not an omission.
2. Option A composes with `broadcast`, so it adds a real capability: "run this chain on that machine
   and inform the fleet."
3. Option A keeps the property the rest of the system is built on — a task id identifies one
   execution, reproducible from its own record.

## What implementing Option A requires

**None of this is a to-do list: Option C was implemented instead (v0.3.4), and it met four of these
five points on the way.** It is kept because it is still the checklist for Option A if that is ever
built, and because it records which parts of the system a chain touches.

- `state.mjs`: accept `mode: 'pipeline'` with `stages: [{command_argv, cwd_rel, ...}]`; keep
  `executor_machine_id` meaningful; reject `index_total > 1` for the same reason `broadcast` does.
  — **Done in v0.3.4 for Option C.** One difference: `executor_machine_id` is *not* used by a
  pipeline, so a chain cannot be pinned to one machine this way.
- `agent.mjs`: execute stages in order, stop on the first non-`ok` stage, and report per-stage
  outcomes. This is the substantial part — the envelope currently describes exactly one command.
  — **Done in v0.3.4.** The per-stage record travels in the envelope, and `command_hash` binds
  **every** stage rather than stage 0 alone.
- `report.mjs`: a chain failure must be distinguishable from a chain that never started. — **Done.**
- `tools.mjs`: `w2m_run` gains `stages`. — **Done**, and `stages` is refused rather than ignored
  under any other mode.
- `PROTOCOL`: the new field, and a compatibility note. — **Done**; the mode enum is in §5.1 and the
  chain semantics are in §4.1.

**Not verified, and it cannot be verified here:** whether Option A is what was actually wanted. That
is a product question, not a technical one, and guessing it is how a fleet ends up with a chained
mode nobody asked for. As shipped, the question is answered for Option C by the fact that it exists
and is tested; whether Option A is *also* wanted is still open.
