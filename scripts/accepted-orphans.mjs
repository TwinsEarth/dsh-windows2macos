/**
 * Modules nothing reaches, and the reason each one is accepted — the list that turns a report into a gate.
 *
 * ## Why a list rather than a rule
 *
 * `scripts/reachability-classify.mjs` measures whether a module is reached, directly or through another. What
 * it **cannot** decide is whether that is a defect: a module written to be a library has no caller by design,
 * and a module written to be wired and never wired is the defect this project shipped three times
 * (`council.mjs`, and the field-acceptance and approval-gate mechanisms before it).
 *
 * **The two are indistinguishable from the import graph alone**, so the difference is written down here, one
 * entry at a time, with a reason. A rule would guess; **a list forces a decision and leaves a diff.**
 *
 * ## The two reasons, and they are not equally comfortable
 *
 *   * **`library`** — written to be called programmatically. Nothing reaches it, and that is the design. Its
 *     contract is its suite. **The honest cost:** nothing proves it works anywhere but under a test.
 *   * **`interface-unrouted`** — built to be reached and not reached. **This is the defect**, kept on the list
 *     only because removing it needs a decision about *where* it should be reached from, which is a design
 *     question rather than a line of code.
 *
 * ## Why every entry names what would remove it
 *
 * An accepted orphan with no stated exit is a permanent exception, and a permanent exception is how the
 * original problem — three modules described as delivered while nothing ran them — happened in the first
 * place. Each entry therefore says what would take it off this list.
 */
export const REASON = Object.freeze({
  LIBRARY: 'library',
  INTERFACE_UNROUTED: 'interface-unrouted',
});

/**
 * Accepted orphans: repo-relative file, reason, and what would remove the entry.
 *
 * **Adding a line here is the whole cost of a new orphan**, deliberately — a check that failed on all eight
 * today would be turned off within a week, and a check that failed on a *ninth* forces exactly the
 * conversation the entry records.
 */
export const ACCEPTED_ORPHANS = Object.freeze([
  {
    file: 'src/agent/exit-channel.mjs',
    reason: REASON.LIBRARY,
    why: 'encodes a report into a sequence of exit codes; called by whoever needs to send one, and nothing in this repository does yet',
    removedBy: 'a caller that has a report and only an exit code to send it through -- the MacMini packet work came close but used a one-line equivalent instead',
  },
  {
    file: 'src/agent/field-authority.mjs',
    reason: REASON.INTERFACE_UNROUTED,
    why: 'drives per-field block acceptance from the authority model; `blocks.mjs` reaches it, but nothing reaches `blocks.mjs`. **Corrects a claim**: 0.29.0 said "the connection now exists" and it exists only inside this module',
    removedBy: 'a memory layer that stores a cognitive block and asks this module what may be accepted into it',
  },
  {
    file: 'src/agent/fleet-scale.mjs',
    reason: REASON.LIBRARY,
    why: 'the arithmetic a fleet report supports, and the refusals where it supports nothing; a tool has not been written over it',
    removedBy: 'a `w2m_scale` tool, or folding its summary into `w2m_stats`',
  },
  {
    file: 'src/agent/fleet-state.mjs',
    reason: REASON.LIBRARY,
    why: 'reconciles two relay endpoints that disagree about whether a machine is online; written after measuring that disagreement, and no tool consults it',
    removedBy: '`w2m_status` reporting the disagreement it already detects',
  },
  {
    file: 'src/agent/health.mjs',
    reason: REASON.INTERFACE_UNROUTED,
    why: 'the server-health sensor the user asked for by name ("增加一个Agent，做服务端健康检测&调控"); written, tested, and never run by anything',
    removedBy: 'a scheduled or on-demand call from the agent loop',
  },
  {
    file: 'src/agent/log-bounds.mjs',
    reason: REASON.INTERFACE_UNROUTED,
    why: 'the log-rotation answer to the 40x growth measured on MacMini; shipped in 0.12.0 as the fix and called by nothing',
    removedBy: 'the agent calling `apply()` on a schedule, which is what makes it a fix rather than a library',
  },
  {
    file: 'src/agent/storage.mjs',
    reason: REASON.INTERFACE_UNROUTED,
    why: 'the tiered store (temp/compressed/permanent/skill/law) with undelatable tiers; shipped in 0.10.2 and called by nothing',
    removedBy: 'a tool that writes through it, which is also the only way its undelatable tiers are ever exercised',
  },
  {
    file: 'src/agent/test-report.mjs',
    reason: REASON.LIBRARY,
    why: 'parses a `node --test` summary in both the `#` and `ℹ` forms; written to fix a real misreading and used by suites rather than by the program',
    removedBy: 'a tool that runs a suite and reports it, which is the job `machine-test-packet.mjs` does for exit codes',
  },
]);

/** The accepted paths, as a Set, for the checker. */
export function acceptedPaths() {
  return new Set(ACCEPTED_ORPHANS.map((e) => e.file));
}
