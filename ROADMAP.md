# Fleet roadmap — from a 5-machine fleet to a governed multi-agent system

Status: **plan, with one consumer already written.** This file exists so the roadmap lives in the
repository rather than in a conversation, and so each version's deliverable can be measured against
something rather than remembered.

Source: the operator's architecture document (2026-10-14), which specifies five layers — coordination,
memory, authority/scheduling, committee governance, and defence — across releases v4.7.0 to v4.13.0.

---

## 0. What this repository already is, stated honestly

Before the roadmap, the delta, because a plan that does not say where it starts is a wish.

| Layer | This repository today | The document's target |
|---|---|---|
| Networking | one relay, one fleet, five machines; P2P direct path when NAT allows | InterMesh/A2A/NATS-MQTT/libp2p/NLIP federation |
| Memory | **individual per-machine (shipped 0.9.6), collective curated document (0.9.7), conclusions (0.9.7)** | three-layer memory with field-level acceptance, lineage, consolidation and forgetting |
| Authority | one operator token; write scope; a global approval rate limiter | numeric `authority_level`, `matching_exempt_level`, a pending-approval index |
| Governance | none | AURA seven-phase council, weighted voting, recursive Sentinel/MetaSentinel |
| Scale | five machines, tasks in the hundreds | 1,000+ agents, sub-10 ms coordination, "coordination collapse" mitigation |
| Defence | hash-only ledger, HMAC signing, BFT-free consensus | three-tier sensor/analyst/coordinator with BFT |

**The gap is four to six orders of magnitude in agent count.** Nothing below claims otherwise, and the
roadmap is ordered so that what is built first is what the larger system would still need.

---

## 1. The one thing to build first, and why it is the only honest starting point

The document's own structure gives the answer: `authority_level` appears in **four of its five layers**.
It is in the permission model (§4.1), the approval flow (§4.2), the committee's weighted voting (§5.3,
weight includes authority) and the defence hierarchy (§2.3, where a Coordinator outranks an Analyst).
Nothing in the roadmap can be built without it, and building any of the rest first would mean inventing
authority implicitly — twice, differently.

**And it already has a consumer waiting.** §3.3's P1 is *field-level acceptance*: each agent decides
per field what to take from a peer, rather than accepting or rejecting a whole message. That is a
permission decision about a *field*, which is exactly what a numeric authority model expresses. The
memory layer shipped in 0.9.6/0.9.7 accepts everything or nothing today; `authority_level` is what turns
it into P1. So this is not a foundation poured in advance of a use — the use is already written.

## 2. Release plan

Each row states its **deliverable** and its **falsifying test** — the observation that would show it is
not working. A row without the second is a feature list, not a plan.

### v4.7.0 — authority model  **shipped in 0.9.8**

**Deliverable.** `src/agent/authority.mjs`: an integer `authority_level` on every actor, the four bands
(0–49 ordinary, 50–69 captain, 70–89 org admin, 90+ system admin), a rule evaluator carrying
`matching_exempt_level`, and a decision function returning `allow | needs_approval | deny` with the rule
that produced it.

**Falsifying tests.**
- an actor at exactly `matching_exempt_level` bypasses the membership check, and one level below does not
  (an off-by-one here is an escalation, so the boundary is tested from both sides);
- an actor never inherits another's level by acting on its behalf — delegation is not assumed, because
  the document does not grant it and inventing it would be the worst possible default;
- a rule with no `matching_exempt_level` exempts nobody, rather than exempting everybody.

### v4.8.0 — memory: field-level acceptance (MMP P1/P2)  **shipped in 0.9.9 (block + lineage); the authority half completed in 0.29.0**

**Deliverable.** Extend the shipped memory layer: a CAT7 seven-field cognitive block, per-field
acceptance driven by §2's authority model, and lineage — each accepted claim records the content hash of
its parent, so a returned claim is identifiable as the receiver's own earlier thought.

**Falsifying tests.** a field refused by policy is *absent* from the stored block rather than null; a
claim's ancestor chain survives a round trip; a claim whose parent is missing is refused rather than
silently re-rooted.

**Correction, 0.29.0.** This entry previously read *"shipped in 0.9.9, suite verified on MacMini"*, and that
was **half true**. The block, the lineage, the absent-not-null refusal and the missing-parent refusal all
shipped and are all asserted. But **"per-field acceptance driven by §2's authority model" was never built**:
measured, `src/agent/blocks.mjs` did not import `authority.mjs` at all, and the only chooser that shipped
refused `confidence` by name and accepted everything else. The connection now exists in
`src/agent/field-authority.mjs`, with the three inherited fields deliberately left undeclared because no
chooser is ever asked about them.

The lesson is recorded rather than tidied away: **a roadmap sentence is a claim, and this one was checkable
in one grep.** It stood for several releases because nothing tested the sentence itself.

### v4.9.0 — approval queue and scheduling  **shipped in 0.10.0 (index); the rate-limiter front door added in 0.30.0**

**Deliverable.** A cross-session pending-approval index (§4.2's "supervisor reviews every agent's pending
approvals from one queue"), with the already-shipped rate limiter as its front door. Scheduling stays
out of scope here — MARL is not buildable at five machines, and pretending otherwise would be the most
expensive kind of dishonesty in this roadmap.

**Correction, 0.30.0.** The index shipped and is substantial. **"With the already-shipped rate limiter as its
front door" did not**: measured, `approval-index.mjs` imports `authority.mjs` and nothing else, and the file
contains no limiter, window or cooldown — while the shipped `SlidingWindowRateLimiter` sat in
`relay/server.mjs` with no approval caller. The front door was a phrase, exactly as v4.8.0's authority half
was.

It now exists in `src/agent/approval-gate.mjs`, and **it limits raising and nothing else**. That asymmetry is
the design, not an omission: limiting the *view* would limit knowing what is waiting, and limiting *settling*
would punish the supervisor clearing the backlog. The key is the requester's identity rather than an address,
because a fleet's agents often share a host and an address-keyed budget would blame the wrong machine.

### v4.10.0 — committee governance  **shipped in 0.11.0, and verified against this entry in 0.30.0**

**Deliverable.** The AURA six-role council as a *single* decision engine with the seven phases, weighted
voting whose weights come from v4.7.0's authority plus reputation, and **dissent retention** — the losing
arguments are stored, because §5.1's "preserves dissenting agents' arguments" is the property that makes
a decision auditable later.

**Falsifying tests.** a phase cannot be skipped; a vote's weights are reproducible from stored inputs; a
decision with recorded dissent is retrievable *with* the dissent.

**Verification, 0.30.0.** All three are asserted in `test/council.test.mjs`, by name: *"starts in convene and
moves exactly one phase per advance"* and *"exposes no way to name a destination phase"*; *"reproduces a
recorded outcome from the stored ballots alone"*, *"is a pure function: same inputs, same weight, no hidden
state"* and *"detects a tampered weight instead of reproducing it"*; *"retains the losing arguments alongside
the outcome"* and *"keeps the dissent in the value the seal covers, so it cannot be dropped later"*.

**This entry is the reason the two above it were checked.** v4.8.0 and v4.9.0 each described something that
was not built; this one described something that was. Rather than assume the pattern, each sentence was
treated as a claim and tested — which is the practice the two corrections exist to record.

### v4.11.0–v4.13.0 — scale, defence, integration

Named for completeness, not planned in detail, because planning them now would produce fiction. The
document's own §6.4 is the reason: it reports 30–50 agents as the practical limit of current frameworks
and describes superlinear "coordination collapse" beyond 100. **A design that has not been measured at 50
cannot honestly specify 1,000**, and the bitmask/sub-10 ms claims are targets to be tested, not facts to
be designed around.

## 3. What this roadmap deliberately refuses

- **It does not adopt a protocol by name.** InterMesh, A2A, NLIP, AIX and MMP are cited in the source
  document; none is implemented here yet, and listing one as "chosen" before a line of its wire format
  exists would be a claim no test could falsify. What is implementable now is the *semantics* they share
  — identity, authority, field-level acceptance, lineage — and that is what v4.7.0 and v4.8.0 build.
- **It does not build consensus where there is nothing to agree on.** BFT among five machines on one
  relay adds latency and failure modes without adding trust. It becomes meaningful when there are
  mutually-distrusting organisations, which is a v4.12.0 precondition, not a v4.7.0 one.
- **It does not put a governance layer above a fleet that has no disagreements yet.** A council that
  decides nothing is indistinguishable from a delay. The council earns its place when two fleets want the
  same machine — and that is measurable, so it can wait for the measurement.
- **It does not scale the agent count by declaring it scaled.** §6.4's collapse is a real reported
  phenomenon; the response here is a benchmark before a design, not the reverse.

## 4. Where the numbers in the source document are treated as claims, not facts

Several figures in the source (20–40% faster convergence, 45% storage reduction, 37% stability
improvement, 85–120 ms decision latency at 100+ agents, 35–42% cache hit rates, 35–78% token reduction)
come from cited literature on other systems. They are recorded as *expectations to test at this fleet's
scale*, and no roadmap item above is justified by them. The one number this repository has measured
itself — the ~50 s task ceiling, from `heartbeatIntervalMs × missedHeartbeats + leaseGraceMs` — is in
`fleet-memory.md` with its three measurements, and it is the reason every long job here is started
detached.

## 5. Relationship to the memory layer already shipped

The shipped layer is not a detour from this roadmap; it is §3.1's L2 and part of L3, built early because
it was cheap and the gap it closed had been paid for repeatedly. Concretely:

- `memory.jsonl` per machine = **L2 individual memory**, persisted, owned by the machine.
- `fleet-memory.md` on the archive host = **L3 collective memory**, curated rather than generated.
- `w2m_memory` = the retrieval entry point for both, plus `record` for conclusions.
- **L1 conversation memory** and §3.2's *emergent* collective memory (environment traces) are **not**
  built.

The honest summary: the memory layer is at the point where the next thing it needs is authority, which is
why v4.7.0 is the next thing this roadmap builds.
