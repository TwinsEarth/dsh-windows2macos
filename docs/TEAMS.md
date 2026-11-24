# Teams: shared room, two planes, one WebRTC pool

Status: **design + implemented slice + Teams V2 local MVP (2026-11-24)**. Teams is an opt-in sub-plugin (`dsh-teams`),
disabled by default. It adds a shared-room view and a bulk-data path; it does not add an approval
or dispatch entry point.

## 1. Two planes

| plane   | carries                                                                                           | channel     | attempts   |
| ------- | ------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| control | heartbeat, presence, user info, roster, plan, approval, lease, task control, council, room events | `relay-tcp` | 1          |
| data    | file, image, artifact, blob, data sync                                                            | `webrtc-v1` | exactly 33 |

Control is small and must be reliable. Data is large and must not quietly become a relay bandwidth
bill. The asymmetry is the policy, not an implementation detail.

When all 33 WebRTC attempts fail, `transport-policy.bulk()` returns
`TEAM_DATA_P2P_EXHAUSTED` with an `alert`. The data plane does **not** call `sendControl()` and does
not fall back to the relay. The relay still carries the control-plane ledger for the task; that is
a different plane.

## 2. One pool, not one per subsystem

`WebRtcTransportPool` owns one 1:1 transport per peer pair. `tools/shared.mjs` builds the process's
pool when `config.webrtc` is buildable and publishes it through `webrtc-pool-registry.mjs`.

`TeamsDataPlane` consumes that same pool:

- `sendArtifact()` chunks bytes into bounded frames and calls `transport-policy.bulk()` per frame;
- `onMessage()` accepts `team.artifact.chunk` frames, reassembles them, verifies SHA-256, and writes
  the verified bytes through `deliverArtifact()` into the configured artifact sink (dir / lan-git /
  ssh) or local retention when no sink exists;
- an exhausted transfer writes `teams/data-plane-alerts.jsonl` and calls the injected alert hook.

A CLI that needs the same path uses `createTeamsDataPlaneFromEnv()`. It refuses to guess: it requires
`W2M_WEBRTC_SIGNAL_URL` and `W2M_WEBRTC_PROVIDER_COMMAND`, and reads the machine identity from
`device.json`. This prevents a one-shot CLI from starting a second signaling role on a machine id
that a long-running agent already owns.

## 3. Artifact sink

`deliverArtifact({dataPlane, peer, bytes, taskId, kind, name})` is the wiring point:

1. if `dataPlane` and `peer` are present, bytes go over WebRTC to the peer's sink;
2. success returns `transport: 'webrtc-v1'`, the digest and the peer;
3. exhaustion returns `TEAM_DATA_P2P_EXHAUSTED`, `alert`, and keeps a local copy;
4. without a peer, the existing local-sink behavior is unchanged.

The receiver verifies the digest before writing. A mismatch is reported as `digest-mismatch` and
nothing reaches the sink.

## 4. Merge CLI

`bin/w2m-joint.mjs merge --peer <machine-id>` sends the patch manifest through the same data plane
before the local merge:

```bash
node bin/w2m-joint.mjs merge \
  --repo <dir> --base <sha> --target-ref refs/heads/<branch> \
  --expected-old <sha> --patches <manifest.json> --peer <machine-id>
```

The printed report includes `data_plane: {transport, channel, peer, sha256, bytes}`. Without `--peer`
the command is unchanged and stays fully local.

## 5. Status surface

`w2m_team_status` reports:

- `transport.control.channel = 'relay-tcp'`, `max_attempts = 1`;
- `transport.data.channel = 'webrtc-v1'`, `max_attempts = 33`;
- `transport.data.data_plane`: pool availability, pool diagnostics, send/receive counters, alert
  count and last alert.

`w2m_team_artifact` sends one local file to a peer over the same path. It is a byte mover, not a
dispatch tool.

## 6. Failure codes

| code                             | meaning                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `TEAM_DATA_P2P_EXHAUSTED`        | 33 WebRTC attempts failed; abandoned, alert raised, relay not used |
| `TEAM_DATA_POOL_REQUIRED`        | no shared WebRTC pool is attached                                  |
| `TEAM_DATA_PEER_REQUIRED`        | no target machine id                                               |
| `TEAM_DATA_ARTIFACT_EMPTY`       | zero-byte artifact                                                 |
| `TEAM_DATA_ARTIFACT_TOO_LARGE`   | above the 64 MiB Teams artifact cap                                |
| `TEAM_DATA_FRAME_INVALID`        | malformed chunk frame                                              |
| `TEAM_DATA_DIGEST_MISMATCH`      | reassembled bytes do not match the declared SHA-256                |
| `TEAM_DATA_PLANE_NOT_CONFIGURED` | CLI factory has no signal URL or provider command                  |
| `TEAM_DEVICE_IDENTITY_MISSING`   | CLI factory cannot find `device.json`                              |

## 7. Teams V2: five pillars as local behavior

Teams V2 is a second opt-in slice inside the same `dsh-teams` row. It is a **local task and
quality ledger**, not a second scheduler. Remote commands, approvals and machine execution still
belong to `w2m-joint` / `w2m_run`; V2 never gains `target_machines`, approval, or dispatch authority.

The five pillars and their code:

| pillar                   | local implementation                                                                                                    | what it deliberately is not                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| dynamic orchestration    | `teams/orchestrator.mjs`: plan create/status/list/step/replan, dependency graph, ready frontier, attempts, events       | not a process launcher; it does not call `w2m_run`                      |
| framework mixing         | `teams/frameworks.mjs`: declarative catalog + `selectFramework()`; `builtin` executes, external names fall back visibly | not a LangGraph/CrewAI/AutoGen install or hidden Python sidecar         |
| adversarial verification | `teams/verification.mjs`: `score`, `reflexion`, `debate`, `process`; executor context rejected                          | not a multi-verifier vote; one small deterministic verifier is the MVP  |
| cost control             | `teams/cost.mjs`: cache-first / route-second ledger in abstract units                                                   | not currency, not a provider invoice, not a promise of a measured ratio |
| self-evolution           | `teams/evolution.mjs`: candidate, promote, rollback, stop-check, version snapshots                                      | not in-place prompt mutation and not unrollbackable learning            |

### 7.1 Tool surface

The package now exposes eight Teams tools. The original three remain unchanged; the new five
are registered only when the mount has a V2 service, which `apply()` always supplies. A test that
calls `buildTools({service, defineTool})` without `v2` still gets exactly the legacy three.

| tool                   | actions                                        | boundary                                             |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `w2m_team_orchestrate` | create, status, list, step, replan             | writes a local ledger; no dispatch                   |
| `w2m_team_verify`      | score, reflexion, debate, process              | rejects executor context; no vote                    |
| `w2m_team_cost`        | quote, record, report                          | abstract units; cache read first, model route second |
| `w2m_team_evolve`      | candidate, list, promote, rollback, stop-check | snapshots; no in-place mutation                      |
| `w2m_team_frameworks`  | list, select                                   | requested vs effective is always visible             |

### 7.2 State

`stateDir` comes from the Teams row (`state_dir` / `stateDir`). V2 writes under:

```text
<stateDir>/teams-v2/plans/<plan_id>.json
<stateDir>/teams-v2/evolution/<agent_id>.json
```

With no `stateDir`, the root is `~/.dsh/teams-v2`. Writes are atomic JSON replacements with mode
`0600`; plan and agent ids are bounded and path-checked. A missing plan is `TEAM_V2_PLAN_NOT_FOUND`,
never an empty invented plan.

### 7.3 Dynamic orchestration contract

- A plan has a goal, a framework preference, a version, steps, events, replans and a cost ledger.
- Step states: `pending → running → done|failed`, and `failed → running` for a retry. `done` is a
  hard gate: `verification.verdict === 'pass'`, `verification.context_isolated === true`, and at
  least one evidence entry, otherwise `TEAM_V2_VERIFICATION_REQUIRED`,
  `TEAM_V2_CONTEXT_NOT_ISOLATED` or `TEAM_V2_EVIDENCE_REQUIRED`.
- A step can start only when every dependency is `done`; otherwise `TEAM_V2_DEPENDENCY_MISSING`.
- Attempts are capped (`max_attempts`, default 3). A failed step at its cap makes the plan `blocked`.
- `replan` requires a reason. It may add/update/remove only **pending** steps; running or done steps
  are locked (`TEAM_V2_REPLAN_TARGET_LOCKED`), and removing a step with any dependent is refused
  (`TEAM_V2_REPLAN_DEPENDENT_EXISTS`). Dependency cycles are rejected at create and at replan.

### 7.4 Verification contract

`w2m_team_verify` accepts `checks`, `evidence`, `step_trace`, `artifact_summary`, `support`,
`challenge` and `threshold`. It rejects `executor_context`, `executor_trace`, `raw_context`,
`messages` and `transcript` with `TEAM_V2_CONTEXT_NOT_ISOLATED`. The persisted verification object
keeps only mode, verdict, score, threshold, verifier id, check summaries and findings; it never
copies executor traces into the plan.

- `score`: weighted checks; a critical failure fails even at a high score.
- `reflexion`: score plus a bounded retry lesson; it does not automatically retry a step.
- `debate`: support and challenge are scored independently; support-pass + challenge-fail passes,
  both-pass escalates, a critical challenge fails.
- `process`: checks the step trace for failed/skipped steps, done-without-evidence, and unmet
  dependencies; it is about where the process went wrong, not just the final artifact.

### 7.5 Cost contract

The ledger orders **cache first, route second**. `quote` is a planning estimate
(`assumption_based: true`) over abstract `cost_units`; `record` stores a hit or miss, the model
tier, tokens and per-step totals; `report` returns totals, hit rate and the cache-vs-route lever.
No currency or vendor price sheet is embedded. The default quote is an assumption used to make the
ordering testable, not a claim about a real invoice.

### 7.6 Evolution contract

- A candidate is a prompt string plus tracked metrics (`pass_rate`, `quality`, `cost_units`,
  `latency_ms`, `hallucination_rate`).
- `promote` refuses any tracked metric regression against the current baseline and records a new
  snapshot; the previous version remains available.
- `rollback` restores any prior snapshot and appends a rollback marker.
- `stop-check` evaluates three independent conditions: iteration limit, quality threshold, and
  `patience` consecutive no-improvement versions. The result is a decision; it does not silently
  stop or restart a running loop.
- Every promotion keeps a full prompt snapshot, so a bad improvement is always reversible.

### 7.7 Framework adapter boundary

`builtin` is the only runnable adapter shipped in this package: `createBuiltinExecutor(handlers)`
runs a caller-supplied handler table locally, with no shell and no dispatch. LangGraph, CrewAI and
AutoGen are declared with capabilities but `runnable: false` and `reason:
'adapter-not-installed'`; a requested external framework therefore returns `effective: 'builtin'`
with the reason in the plan and the tool result. A native adapter can be added later through
`registerFrameworkAdapter(name, {run})` behind the same `selectFramework()` contract without
changing the orchestrator or the tool arguments. The V2 MVP is a native adapter layer, not a
Python dependency.

### 7.8 V2 error codes

| code                                   | meaning                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `TEAM_V2_PLAN_NOT_FOUND`               | no persisted plan with that id                                      |
| `TEAM_V2_PLAN_INVALID`                 | a supplied plan id is unsafe, or the create goal/steps are invalid  |
| `TEAM_V2_STEP_NOT_FOUND`               | no step with that id                                                |
| `TEAM_V2_STEP_INVALID`                 | a step is missing a title or has an unknown role/id                 |
| `TEAM_V2_STEP_TRANSITION_INVALID`      | the requested state transition is not allowed                       |
| `TEAM_V2_VERIFICATION_REQUIRED`        | `done` was requested without a passing verification                 |
| `TEAM_V2_EVIDENCE_REQUIRED`            | `done` was requested with no evidence                               |
| `TEAM_V2_STEP_ATTEMPTS_EXHAUSTED`      | the step has used all attempts                                      |
| `TEAM_V2_DEPENDENCY_MISSING`           | a dependency is absent/non-done at start, or missing from the graph |
| `TEAM_V2_DEPENDENCY_CYCLE`             | the step graph contains a cycle                                     |
| `TEAM_V2_REPLAN_REASON_REQUIRED`       | replan was called without a reason                                  |
| `TEAM_V2_REPLAN_TARGET_LOCKED`         | replan tried to edit a running/done step                            |
| `TEAM_V2_REPLAN_DEPENDENT_EXISTS`      | removal would orphan a dependent                                    |
| `TEAM_V2_FRAMEWORK_INVALID`            | unknown framework or framework operation                            |
| `TEAM_V2_FRAMEWORK_UNAVAILABLE`        | an adapter has no `run` function or a builtin handler is missing/failed |
| `TEAM_V2_CHECKS_REQUIRED`              | a verification mode had no usable checks                            |
| `TEAM_V2_CONTEXT_NOT_ISOLATED`         | the verifier received executor/raw context                          |
| `TEAM_V2_PROCESS_TRACE_REQUIRED`       | process verification had no step trace                              |
| `TEAM_V2_EVOLUTION_INVALID`            | invalid agent/candidate/operation                                   |
| `TEAM_V2_EVOLUTION_VERSION_NOT_FOUND`  | rollback target does not exist                                      |
| `TEAM_V2_EVOLUTION_VERSION_INELIGIBLE` | promotion would regress a tracked metric                            |
| `TEAM_V2_COST_INPUT_INVALID`           | a cost record lacked a cache hit/miss or had an invalid op          |
| `TEAM_V2_COST_PLAN_REQUIRED`           | a record/report had no plan to attach to                            |
| `TEAM_V2_STATE_UNAVAILABLE`            | the local state directory could not be written                      |

### 7.9 P7 / TURN boundary remains separate

The local V2 MVP does not claim any cross-machine media result. A plan that says `done` with local
evidence is not a three-physical-node WebRTC pass. The P7 report keeps the physical-node row at
**not passed** until a public TURN host completes `Allocate` and a Mac + Windows pair establishes a
real DataChannel with `typ relay`; Cloudflare tunnel `/health` and same-host multi-process runs do
not substitute for that.
