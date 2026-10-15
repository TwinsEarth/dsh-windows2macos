/**
 * Fleet sync: broadcast, sync, merge  - with a decision, not a guess.
 *
 * ## The rule this implements
 *
 * `FLEET-RULES.md` rule 1: a machine in the fleet broadcasts, syncs and merges without being asked. The
 * reason is the largest time sink of 2026-10-14  - one copy of the truth on one machine, a different copy
 * on another, and a human having to notice.
 *
 * ## Why it decides rather than just running `git pull`
 *
 * `git pull` hides the one case that needs judgement. There are exactly four states a machine can be in,
 * and conflating them is how an automatic merge discards somebody's verified work:
 *
 * | State | Meaning | Action |
 * |---|---|---|
 * | `up-to-date` | local == remote | nothing |
 * | `behind` | local is an ancestor of remote | **fast-forward**  - no work can be lost |
 * | `diverged-unpublished` | local has commits the remote lacks, remote has commits local lacks, and the local commits are **not** on any remote branch | **rebase**  - nothing published can be lost |
 * | `diverged-published` | both sides have published commits | **stop and report**  - this is the only state where merging could discard verified work |
 *
 * The distinction between the last two is the whole design. A commit that exists only on this machine is
 * safe to rebase because it exists nowhere else; a commit that is already on the remote belongs to
 * whoever pushed it, and rewriting it is how one machine silently deletes another's work.
 *
 * ## What it never does
 *
 * It does not commit. Uncommitted changes are the operator's or a running task's, and a syncer that
 * committed them would be attaching a message to work it does not understand. It reports a dirty tree and
 * stops.
 *
 * Usage:
 *   node scripts/fleet-sync.mjs            # report the state, change nothing
 *   node scripts/fleet-sync.mjs --write    # perform the safe action for the state
 *   node scripts/fleet-sync.mjs --json     # machine-readable, for a task that reports back
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Run git and hand back its answer without throwing; a missing repo is a state, not a crash.
 *
 * ## Why every caller must check `ok` and not only read `out`
 *
 * `git rev-parse <ref>` **echoes an argument it does not recognise to stdout** and *then* exits non-zero.
 * So a failed lookup yields `{ok: false, out: 'origin/main'}` -- a plausible-looking ref name attached to an
 * exit status that says it does not exist. The first version of `inspect` read `out` alone, concluded the
 * ref existed, and reported a repository with **no remote at all** as `ahead` with `ahead/behind: NaN/0`.
 *
 * Two defences, because one is not enough for a value that decides whether it is safe to rewrite history:
 * this helper reports `ok`, and every ref lookup asks for `--verify`, which suppresses the echo and fails
 * cleanly when the ref is absent.
 */
export function git(args, options = {}) {
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', timeout: options.timeout ?? 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, code: e.status ?? e.code ?? null, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? e.message ?? '').trim().slice(0, 500) };
  }
}

/**
 * Where the local branch stands relative to its upstream, as a decision rather than a description.
 *
 * @param {string} [cwd]
 * @param {{remote?: string, branch?: string}} [options]
 * @returns {object}
 */
export function inspect(cwd = process.cwd(), options = {}) {
  const remote = options.remote ?? 'origin';
  const at = (args) => git(['-C', cwd, ...args]);

  if (!existsSync(`${cwd}/.git`)) {
    // `action: 'none'`, not `null`: every other state names an action, and a caller that has to handle
    // "the action is null" separately from "the action is none" is a caller that will eventually forget.
    // Found by a test asserting the two states agree.
    return { state: 'no-repo', detail: `no git repository at ${cwd}`, action: 'none' };
  }

  const branch = options.branch ?? at(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const headResult = at(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headResult.ok ? headResult.out : '';
  const dirtyOut = at(['status', '--porcelain']).out;
  const dirty = dirtyOut === '' ? [] : dirtyOut.split('\n').map((l) => l.trim());

  const fetched = at(['fetch', '--quiet', remote]);
  const remoteRef = `${remote}/${branch}`;
  // `--verify --quiet`: without them a missing ref is echoed back as if it were an answer. See `git()`.
  const remoteResult = at(['rev-parse', '--verify', '--quiet', remoteRef]);
  const remoteHead = remoteResult.ok ? remoteResult.out : '';

  const base = {
    branch,
    head,
    remote_ref: remoteRef,
    remote_head: remoteHead || null,
    dirty,
    ahead: null,
    behind: null,
    action: null,
    state: null,
    detail: null,
  };

  if (!remoteHead) {
    // No upstream is not an error: a machine may be the first to work on a branch. It is reported as such
    // because "nothing to sync from" and "already in sync" must not read alike.
    return { ...base, state: 'no-upstream', detail: `${remoteRef} does not exist; fetch ok=${fetched.ok}`, action: 'none' };
  }

  const counts = at(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]).out;
  const [behindRaw, aheadRaw] = counts.split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  // Guarded rather than trusted. `Number(undefined)` is `NaN`, and `NaN` compares false against everything
  // -- so a failed `rev-list` would have fallen through every branch below and been reported as... nothing
  // matched. This is the one place where a malformed answer could silently become "safe to rewrite".
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return { ...base, ahead: null, behind: null, state: 'unreadable', detail: `could not compare ${remoteRef} with HEAD (rev-list said ${JSON.stringify(counts)})`, action: 'stop' };
  }

  if (ahead === 0 && behind === 0) {
    return { ...base, ahead, behind, state: 'up-to-date', detail: 'local and remote agree', action: 'none' };
  }
  if (ahead === 0) {
    return { ...base, ahead, behind, state: 'behind', detail: `${behind} commit(s) to fast-forward`, action: 'fast-forward' };
  }
  if (behind === 0) {
    return { ...base, ahead, behind, state: 'ahead', detail: `${ahead} local commit(s) not yet broadcast`, action: 'push' };
  }

  // Diverged. Whether a rebase is safe turns on a question that is *not* "are these commits published":
  //
  //   An earlier version compared `git log --branches --not --remotes` against `ahead` and called the
  //   divergence safe when the local-only count was smaller. That comparison can never be true: `ahead`
  //   counts exactly the commits absent from the remote-tracking branch, and `--not --remotes` selects
  //   exactly those commits, so the two sets are the same and the test was dead code.
  //
  //   A second attempt asked whether the merge base was an ancestor of the remote branch. That is true for
  //   every ordinary rebase, so it refused to sync in the case rebasing is *for*.
  //
  // The question that actually matters is narrower: **would this rebase rewrite a commit that some remote
  // already reachable from here has seen?** So the local commits are listed, and each is checked for
  // reachability from the remote refs. If none of them is reachable anywhere, replaying them rewrites
  // nothing that has been published and the rebase is safe. If any one of them is, a peer may already have
  // it and rewriting is how one machine silently deletes another's work.
  const baseResult = at(['merge-base', remoteRef, 'HEAD']);
  const mergeBase = baseResult.ok ? baseResult.out : '';
  if (mergeBase === '') {
    return { ...base, ahead, behind, state: 'unreadable', detail: `no merge base between ${remoteRef} and HEAD, so the two histories are unrelated; refusing to guess`, action: 'stop' };
  }

  const localList = at(['rev-list', `${mergeBase}..HEAD`]);
  const localCommits = localList.ok && localList.out !== '' ? localList.out.split('\n').filter(Boolean) : [];
  const reachable = at(['rev-list', '--remotes']);
  const reachableSet = new Set(reachable.ok ? reachable.out.split('\n').filter(Boolean) : []);
  const publishedHere = localCommits.filter((c) => reachableSet.has(c));

  if (publishedHere.length === 0) {
    return {
      ...base,
      ahead,
      behind,
      merge_base: mergeBase,
      local_only: localCommits.length,
      published_commits: 0,
      state: 'diverged-unpublished',
      detail: `${localCommits.length} local commit(s), none reachable from any remote ref, so replaying them rewrites nothing published`,
      action: 'rebase',
    };
  }
  return {
    ...base,
    ahead,
    behind,
    merge_base: mergeBase,
    local_only: localCommits.length - publishedHere.length,
    published_commits: publishedHere.length,
    state: 'diverged-published',
    detail: `${publishedHere.length} local commit(s) are already reachable from a remote ref, so rebasing would rewrite published history; merging here could discard verified work`,
    action: 'stop',
  };
}

/**
 * Perform the action the state calls for, or explain why it did not.
 *
 * @param {object} state as returned by `inspect`
 * @param {{cwd?: string, write?: boolean}} [options]
 * @returns {{performed: boolean, action: string, detail: string}}
 */
export function act(state, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write === true;
  const at = (args) => git(['-C', cwd, ...args]);

  if (state.state === 'no-repo' || state.state === 'no-upstream') {
    return { performed: false, action: state.action ?? 'none', detail: state.detail };
  }
  // A dirty tree stops everything. The uncommitted changes belong to whoever made them -- a running task,
  // most likely -- and rebasing or fast-forwarding under them is how a machine loses work it never
  // claimed.
  if (state.dirty.length > 0) {
    return { performed: false, action: 'stop', detail: `${state.dirty.length} uncommitted path(s); refusing to sync under them` };
  }
  if (!write) {
    return { performed: false, action: state.action, detail: `would ${state.action} (dry run)` };
  }

  if (state.action === 'none') return { performed: false, action: 'none', detail: 'nothing to do' };

  if (state.action === 'fast-forward') {
    const r = at(['merge', '--ff-only', state.remote_ref]);
    return { performed: r.ok, action: 'fast-forward', detail: r.ok ? `now at ${at(['rev-parse', '--short', 'HEAD']).out}` : r.err };
  }
  if (state.action === 'rebase') {
    /**
     * A rebase needs a committer identity, and a rebase that fails part-way leaves the repository in a
     * detached HEAD with `.git/rebase-merge` present -- which needs a person to resolve.
     *
     * Both halves of that were found by running it, and the second is the serious one: this tool exists to
     * be automatic, and an automatic tool that can wedge a repository is worse than one that does nothing.
     * So the identity is checked *before* starting, and a failure *aborts* the rebase to put the tree back
     * exactly where it was.
     */
    const email = at(['config', 'user.email']).out || process.env.GIT_COMMITTER_EMAIL || '';
    const name = at(['config', 'user.name']).out || process.env.GIT_COMMITTER_NAME || '';
    if (email === '' || name === '') {
      return {
        performed: false,
        action: 'stop',
        detail: 'no committer identity (user.name/user.email): a rebase would fail part-way and leave the repository detached; set an identity or commit first',
      };
    }
    const r = at(['rebase', state.remote_ref]);
    if (r.ok) return { performed: true, action: 'rebase', detail: `now at ${at(['rev-parse', '--short', 'HEAD']).out}` };
    // Put it back. `--abort` is the only recovery that restores the original branch and its commits, and a
    // failure to abort is reported loudly because it is the one outcome that genuinely needs a person.
    const abort = at(['rebase', '--abort']);
    return {
      performed: false,
      action: 'stop',
      detail: abort.ok
        ? `rebase failed and was aborted, tree restored: ${r.err}`
        : `REBASE FAILED AND COULD NOT BE ABORTED (${abort.err}); the repository is mid-rebase and needs a person: ${r.err}`,
    };
  }
  if (state.action === 'push') {
    // Push is broadcast, and it is only safe when the local commits are a superset of the remote's --
    // which `ahead` with `behind === 0` guarantees.
    const r = at(['push', 'origin', state.branch]);
    return { performed: r.ok, action: 'push', detail: r.ok ? `pushed ${state.ahead} commit(s)` : r.err };
  }
  return { performed: false, action: 'stop', detail: state.detail };
}

/** Human-readable report. Deliberately leads with the decision, not the git output. */
export function report(state, outcome) {
  const lines = [];
  const dirty = Array.isArray(state?.dirty) ? state.dirty : [];
  lines.push(`branch      : ${state?.branch ?? '(unknown)'}`);
  lines.push(`state       : ${state?.state ?? '(unknown)'}`);
  lines.push(`detail      : ${state?.detail ?? '(none)'}`);
  if (state?.head) lines.push(`head        : ${String(state.head).slice(0, 12)}`);
  if (state?.remote_head) lines.push(`remote      : ${String(state.remote_head).slice(0, 12)}`);
  if (state?.ahead !== null && state?.ahead !== undefined) lines.push(`ahead/behind: ${state.ahead}/${state.behind}`);
  lines.push(`dirty       : ${dirty.length === 0 ? 'no' : dirty.length + ' path(s)'}`);
  for (const d of dirty.slice(0, 10)) lines.push(`              ${d}`);
  lines.push(`action      : ${state?.action ?? 'none'}`);
  if (outcome) lines.push(`performed   : ${outcome.performed} - ${outcome.detail}`);
  return lines.join('\n');
}

/**
 * Is this file the process entry point?
 *
 * `import.meta.url === 'file://' + argv[1]` is the idiom that looks right and is wrong on Windows: the
 * URL is `file:///E:/path/...` with three slashes and forward slashes, while `argv[1]` is
 * `E:\path\...` with backslashes. The comparison silently fails, the script body never runs, and the
 * process exits 0 having done nothing -- which is the worst possible failure mode for a tool whose job
 * is to tell you whether your tree is in sync.
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const write = process.argv.includes('--write');
  const json = process.argv.includes('--json');
  const cwdArg = process.argv.find((a) => a.startsWith('--cwd='));
  const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : process.cwd();
  const state = inspect(cwd);
  const outcome = act(state, { cwd, write });
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...state, outcome }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(state, outcome)}\n`);
  }
  // Exit 0 for a state that was handled or needed nothing; 2 for the one state that needs a human, so a
  // caller can branch on the exit code without parsing prose.
  process.exit(state.state === 'diverged-published' || outcome.action === 'stop' ? 2 : 0);
}
