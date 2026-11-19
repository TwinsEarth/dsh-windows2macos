/**
 * Governance-domain tools: w2m_approvals, w2m_council.
 *
 * Each `register<Name>(ctx, deps)` factory is invoked by `apply()` in the same order the tools have
 * always been registered; the body is the same block that used to be inline in `apply()`, with the
 * apply-scope glue it closed over now arriving through `deps`.
 */

// v0.37.0: v4.10.0's council, reached at last. `reachability-classify.mjs` found it imported by nothing but
// its own suite, and that is the defect this import fixes.
import { PHASES, ROLES } from '../../agent/council.mjs';
import { AUTHORITY_MAX, isAuthorityLevel } from '../../agent/authority.mjs';
import { fleetCouncilThread } from '../council-fleet.mjs';

import { readDevice, request, requireToken, resolveToken, throwIfAborted, W2MError } from './shared.mjs';

  /**
   * v0.25.0: the tool that makes the approval chain reachable by an operator.
   *
   * ## Why it reports refusals instead of hiding them
   *
   * Every row carries `may_act` and, when false, `why_not`. A list filtered down to what the caller may
   * answer would be shorter and **would make the fleet look idle at the moment it is most blocked** — the
   * work above their authority is exactly the work they most need to know exists.
   *
   * ## Why `actor_level` is a parameter and not read from config
   *
   * This machine's own `actorAuthorityLevel` says what it may *dispatch as*. An approver's level is a fact
   * about the person answering, and a decision made on the dispatcher's level would let a machine approve its
   * own escalations — which the index already refuses by name (`APPROVAL_SELF_APPROVAL`) when the ids match.
   * Making it explicit keeps that refusal meaningful rather than incidental.
   */
export function registerApprovals(ctx, deps) {
  const { approvalQueue, cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_approvals',
    description:
      'List and settle the dispatches that are waiting for an approver. A dispatch whose actor level is ' +
      'exactly one band below what it needs is QUEUED rather than refused, and this is where that queue is ' +
      'read and answered. Every row reports whether YOU may act on it and why not if you may not, so work ' +
      'above your authority is visible rather than filtered away. Settling a request does not run the ' +
      'dispatch: approval means the next attempt is allowed, not that anything already happened.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'approve', 'reject'],
        description: 'list (default) shows the queue; approve and reject settle one request by approval_id.',
        default: 'list',
      },
      approval_id: {
        type: 'string',
        description: 'Which request to settle. Required for approve and reject.',
      },
      actor_id: {
        type: 'string',
        description: 'Who is answering. Defaults to this machine\'s name; it is recorded on the decision, and it is what makes a self-approval refusable.',
      },
      actor_level: {
        type: 'number',
        description: 'The authority level of the person answering, 0..100. Required to approve or reject: an approver with no level cannot be placed relative to the request, and the index refuses rather than guessing one.',
      },
      include_settled: {
        type: 'boolean',
        description: 'Also show recently settled requests. They are kept briefly as receipts, so a supervisor returning to a busy queue can tell "already dealt with" from "never seen".',
        default: false,
      },
    },
    output: jsonOutput,
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m approvals ${typeof args?.action === 'string' ? args.action : 'list'}`,
      // Only `approve` and `reject` change anything; a list is a read. Labelling the whole tool 'write' would
      // make the common case -- looking at the queue -- read as an action.
      kind: args?.action === 'approve' || args?.action === 'reject' ? 'write' : 'read',
      rawInput: {},
    }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const action = typeof args?.action === 'string' ? args.action : 'list';
      const queue = approvalQueue();

      if (action === 'approve' || action === 'reject') {
        const approvalId = typeof args?.approval_id === 'string' ? args.approval_id.trim() : '';
        if (approvalId === '') {
          throw new W2MError('W2M_APPROVAL_ID', 'W2M_APPROVAL_ID: settling a request needs `approval_id`', {
            hint: 'call w2m_approvals with action="list" to see the pending ids',
          });
        }
        if (!isAuthorityLevel(args?.actor_level)) {
          // Refused rather than defaulted, and refused HERE rather than left to the index, so the message can
          // say what to do about it. A decision attributed to a level nobody supplied is a decision nobody
          // can audit.
          throw new W2MError(
            'W2M_APPROVAL_LEVEL',
            'W2M_APPROVAL_LEVEL: `actor_level` must be an integer 0..' + AUTHORITY_MAX + ' to settle a request',
            { hint: 'an approver with no level cannot be placed relative to the request it is answering' },
          );
        }
        const actor = { id: typeof args?.actor_id === 'string' && args.actor_id.trim() !== '' ? args.actor_id.trim() : cfg.machineName, level: args.actor_level };
        const outcome = action === 'approve' ? 'approved' : 'rejected';
        /**
         * v1.1.16: a fleet-admission request is settled at the RELAY, because that is where the request lives and where
         * the quorum rules are enforced. The local index would accept the write and change nothing that matters.
         *
         * The actor id is the person answering; the relay records it on the decision. A refusal is reported as such
         * (`ALREADY_DECIDED` included) rather than thrown: the caller is looking at a list that may be a second old.
         */
        if (/^adm-/.test(approvalId)) {
          const decideDevice = await readDevice(cfg);
          const decideRelay = cfg.rabbitUrl ?? null;
          const settled = decideRelay === null || decideDevice.device_token === null
            ? { ok: false, json: { code: 'W2M_NO_RELAY' } }
            : await request({
              rabbitUrl: decideRelay,
              token: requireToken(decideDevice),
              method: 'POST',
              pathname: '/v1/fleet/admission/' + encodeURIComponent(approvalId) + '/decide',
              body: { decision: action === 'approve' ? 'approve' : 'reject', decided_by: actor.id, auto: false },
            });
          return JSON.stringify({
            ok: settled?.ok === true,
            action,
            approval_id: approvalId,
            kind: 'fleet_admission',
            settled: settled?.ok === true ? outcome : null,
            reason_code: settled?.ok === true ? null : (settled?.json?.error?.code ?? settled?.json?.code ?? settled?.error?.code ?? null),
            detail: settled?.ok === true ? null : (settled?.json?.error?.message ?? null),
            acted_by: actor,
            note: settled?.ok === true
              ? 'the machine is admitted; it will appear in w2m_devices once its agent reconnects'
              : 'the decision was refused; the request is unchanged (already decided requests are normal when the ten-second window has passed)',
          });
        }
        const result = queue.decide(approvalId, actor, outcome);
        return JSON.stringify({
          ok: result.ok === true,
          action,
          approval_id: approvalId,
          settled: result.ok === true ? outcome : null,
          reason_code: result.reason_code ?? null,
          detail: result.detail ?? null,
          acted_by: actor,
          // Said every time, because a reader who assumes approval ran the dispatch will wait for a result
          // that is never coming.
          note: result.ok === true
            ? 'the request is settled; the dispatch did not run and must be attempted again'
            : 'the decision was refused; the request is unchanged and still waiting',
        });
      }

      const actor = {
        id: typeof args?.actor_id === 'string' && args.actor_id.trim() !== '' ? args.actor_id.trim() : cfg.machineName,
        level: isAuthorityLevel(args?.actor_level) ? args.actor_level : null,
      };
      // An actor with no level still gets the list: knowing what is waiting does not require the authority to
      // answer it, and a queue only its supervisors can see is a queue that stays full.
      /**
       * v1.1.16: a machine waiting to join the fleet is a request waiting for a human, which is what this tool is.
       *
       * It is NOT a permission escalation, so it must not be shoved through `approvalRequestFor` -- that shape requires
       * a needs-approval verdict and a capability, and faking one would record a lie in the audit trail. The list is
       * shared; the store underneath is not.
       *
       * The countdown uses the RELAY's clock: `requested_at_ms` was stamped there, and three machines in this fleet
       * disagree on the time by tens of seconds. A local-clock countdown would fire the automatic approval early on a
       * fast machine and late on a slow one. The relay still owns the decision (it refuses to auto-approve with no
       * member online); this is display only.
       */
      let admissionRows = [];
      try {
        const admissionDevice = await readDevice(cfg);
        const admissionRelay = cfg.rabbitUrl ?? null;
        // A relay URL and a device token are what the rest of this file passes on every authenticated call; omitting
        // them made this request throw into the catch below, which is why the merged rows were silently missing.
        const admissionPending = admissionRelay === null || admissionDevice.device_token === null
          ? { ok: false }
          : await request({ rabbitUrl: admissionRelay, token: requireToken(admissionDevice), method: 'GET', pathname: '/v1/fleet/admission/pending' });
        if (admissionPending?.ok === true && Array.isArray(admissionPending.json?.pending)) {
          const relayNow = Date.parse(String(admissionPending.json.rabbit_time ?? '')) || Date.now();
          admissionRows = admissionPending.json.pending.map((row) => ({
            approval_id: row.request_id,
            kind: 'fleet_admission',
            machine_id: row.machine_id ?? null,
            machine_name: row.machine_name ?? null,
            requested_at_ms: row.requested_at_ms ?? null,
            countdown_ms: Number.isFinite(row.requested_at_ms) ? Math.max(0, 10_000 - (relayNow - row.requested_at_ms)) : null,
            may_act: true,
            note: 'approving admits this machine to the fleet; the ten-second window is enforced by the relay and needs a member online',
          }));
        }
      } catch {
        // The approval list must still work when the relay is unreachable: the permission queue is local.
      }
      const rows = queue.listFor(
        actor.level === null ? { id: actor.id, level: 0 } : actor,
        { includeSettled: args?.include_settled === true },
      );
      const summary = queue.summary(actor.level === null ? { id: actor.id, level: 0 } : actor);
      return JSON.stringify({
        ok: true,
        action: 'list',
        as: actor,
        level_known: actor.level !== null,
        summary,
        count: rows.length + admissionRows.length,
        rows: rows.concat(admissionRows),
        note: actor.level === null
          ? 'no actor_level was supplied, so may_act is reported as if the level were 0: the queue is visible, but whether you may answer any of it is not known'
          : 'may_act reflects the actor_level supplied',
      });
    },
  }));
}

  /**
   * v0.37.0: the eleventh tool -- a question put to a council, and the outcome read back with its dissent.
   *
   * ## Why one tool with an action rather than seven
   *
   * The seven phases are a **state machine over one object**, and the machine already refuses an operation in
   * the wrong phase with a named refusal. Seven tools would let a model call the wrong one and have to learn
   * the order from errors; one tool with an action can report `phase` and `phases` on every call, so the
   * legal next move is visible rather than inferred.
   *
   * ## What it will not do
   *
   * It does not break a tie. `decide()` refuses one by name, because a split council is exactly the case a
   * person must see -- and a tool that returned *some* outcome for a tie would hide the only situation where
   * the council exists to escalate.
   */
export function registerCouncil(ctx, deps) {
  const { cfg, councilSessions, defineTool, fleetCouncil, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_council',
    description:
      'Put a question to a council of agents and read the outcome back WITH its dissent. A council walks seven ' +
      'phases (' + PHASES.join(' -> ') + ') and every action reports the phase it is in and the whole phase list, so the ' +
      'legal next move is visible rather than guessed. Roles are assigned during "convene", arguments are ' +
      'recorded during "deliberate", votes during "vote", the outcome is fixed during "decide", and "record" ' +
      'seals it. A TIE IS REFUSED, not broken: a split council is the case a person must see. Votes carry a ' +
      'weight computed from the voter\'s authority and reputation, and that weight is reproducible from the ' +
      'stored ballots, which every read reports.',
    parameters: {
      action: {
        type: 'string',
        enum: ['open', 'advance', 'assign', 'argue', 'vote', 'decide', 'record', 'state', 'decision', 'list', 'fleet-open', 'fleet-vote', 'fleet-decide', 'fleet-state', 'fleet-list'],
        description: 'What to do. "open" starts a council, "state" reports one mid-flight, "decision" reads a sealed one back with its dissent.',
        default: 'state',
      },
      council_id: {
        type: 'string',
        description: 'Which council. Required for everything except "list"; chosen by the caller so it can be addressed later.',
      },
      question: { type: 'string', description: 'What the council is deciding. Used by "open" only.' },
      participant: { type: 'string', description: 'Who is acting. Used by assign, argue and vote.' },
      role: { type: 'string', enum: [...ROLES], description: 'The hat being worn. Used by "assign" only.' },
      stance: { type: 'string', enum: ['for', 'against'], description: 'Which side an argument takes. Used by "argue" only.' },
      text: { type: 'string', description: 'The argument itself. Used by "argue" only.' },
      authority: { type: 'number', description: 'The voter authority level, 0..100. Used by "vote"; the weight comes from this and reputation.' },
      reputation: { type: 'number', description: 'The voter reputation. Used by "vote"; it can never overturn authority.' },
      choice: { type: 'string', description: 'What the voter votes for. Used by "vote" only.' },
      reason: { type: 'string', description: 'Why the voter chose it. Carried with the ballot and read back with the dissent.' },
    },
    output: jsonOutput,
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m council ${typeof args?.action === 'string' ? args.action : 'state'}`,
      // Only actions that change the council are writes; reading one is not.
      kind: ['open', 'advance', 'assign', 'argue', 'vote', 'decide', 'record'].includes(args?.action) ? 'write' : 'read',
      rawInput: {},
    }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const action = typeof args?.action === 'string' ? args.action : 'state';
      const id = typeof args?.council_id === 'string' ? args.council_id : null;

      // v1.2.2: the FLEET council. Same decision rule as the single-machine one (reproducible weights, a tie is a
      // refusal); the difference is transport -- ballots are chat messages on `council-<id>`, so every machine can read
      // the same ballots and recount to the same outcome.
      if (typeof action === 'string' && action.startsWith('fleet-')) {
        const threadId = fleetCouncilThread(id);
        if (action === 'fleet-open') {
          const opened = fleetCouncil.open({ councilId: id, question: typeof args?.question === 'string' ? args.question : '', openedByMachineId: 'local' });
          return JSON.stringify({ ok: opened.ok, action, council_id: id, thread_id: threadId, reason_code: opened.code ?? null, council: opened.council ?? null });
        }
        if (action === 'fleet-vote') {
          const voted = fleetCouncil.vote({
            councilId: id,
            machineId: typeof args?.participant === 'string' && args.participant !== '' ? args.participant : 'local',
            choice: args?.choice,
            reason: args?.reason ?? null,
            authority: args?.authority ?? null,
            reputation: args?.reputation ?? null,
          });
          return JSON.stringify({ ok: voted.ok, action, council_id: id, thread_id: threadId, reason_code: voted.code ?? null, council: voted.council ?? null });
        }
        if (action === 'fleet-decide') {
          const decided = fleetCouncil.decide({ councilId: id });
          // The decision travels as an append-only memory record: a decision that exists only in one process memory
          // is a decision nobody can audit later. Writing it is best-effort -- the outcome is returned either way and
          // `trail` says which happened, rather than implying the record exists when it does not.
          let trail = 'not-written';
          if (decided.ok === true && decided.council?.decision != null) {
            try {
              const trailUrl = cfg?.rabbitUrl ?? null;
              const trailToken = trailUrl === null ? null : await resolveToken(cfg);
              if (trailUrl !== null && typeof trailToken === 'string' && trailToken !== '') {
                const decision = decided.council.decision;
                const line = 'council ' + String(id) + ': ' + String(decision.choice) + ' (weight ' + String(decision.weight) + ', '
                  + String(decided.council.ballots.length) + ' ballot(s))';
                const appended = await request({
                  rabbitUrl: trailUrl, token: trailToken, method: 'PUT',
                  pathname: '/v1/fleet/memory/fleet', body: { records: [line] }, signal: exec?.signal,
                });
                trail = appended?.ok === true ? 'appended' : 'refused';
              }
            } catch {
              trail = 'error';
            }
          }
          return JSON.stringify({ ok: decided.ok, action, council_id: id, thread_id: threadId, reason_code: decided.code ?? null, detail: decided.detail ?? null, trail, council: decided.council ?? null });
        }
        if (action === 'fleet-list') {
          return JSON.stringify({ ok: true, action, ...fleetCouncil.list() });
        }
        const read = fleetCouncil.state({ councilId: id });
        return JSON.stringify({ ok: read.ok, action, council_id: id, thread_id: threadId, reason_code: read.code ?? null, council: read.council ?? null });
      }

      if (action === 'list') {
        return JSON.stringify({ ok: true, action, ...councilSessions.ids(), phases: PHASES, roles: [...ROLES] });
      }
      if (action === 'open') {
        const opened = councilSessions.open(id, { question: typeof args?.question === 'string' ? args.question : '' });
        return JSON.stringify({ ok: opened.ok, action, council_id: id, phase: opened.phase ?? null, phases: PHASES, roles: [...ROLES], reason_code: opened.reason_code ?? null, detail: opened.detail });
      }
      if (action === 'decision') {
        const read = councilSessions.decision(id);
        return JSON.stringify({
          ok: read.ok,
          action,
          council_id: id,
          reason_code: read.reason_code ?? null,
          detail: read.detail ?? null,
          decision: read.decision ?? null,
          // A dissent without its reason is a number rather than a position, and a decision whose outcome does
          // not reproduce from its own ballots is one nobody should act on. Both travel with every read.
          dissent: read.decision?.dissent ?? null,
          unanimous: read.decision?.unanimous ?? null,
          recount: read.recount ?? null,
        });
      }

      const found = councilSessions.get(id);
      if (!found.ok) {
        return JSON.stringify({ ok: false, action, council_id: id, reason_code: found.reason_code, detail: found.detail });
      }
      const council = found.council;

      // Every mutation goes through the council's own refusals rather than a check here, so the phase rules
      // live in exactly one place and a tool cannot disagree with the module about them.
      try {
        if (action === 'advance') {
          const moved = council.advance();
          return JSON.stringify({ ok: true, action, council_id: id, phase: moved.phase, phases: PHASES, moved: moved.moved, detail: moved.detail ?? null });
        }
        if (action === 'assign') {
          const assigned = council.assign(args?.participant, args?.role);
          return JSON.stringify({ ok: true, action, council_id: id, phase: council.phase, assigned });
        }
        if (action === 'argue') {
          const recorded = council.argue({ participant: args?.participant, stance: args?.stance, text: args?.text });
          return JSON.stringify({ ok: true, action, council_id: id, phase: council.phase, argument: recorded });
        }
        if (action === 'vote') {
          const ballot = council.vote({ participant: args?.participant, authority: args?.authority, reputation: args?.reputation, choice: args?.choice, reason: args?.reason ?? null });
          // The weight is returned because it is the thing a reader would otherwise have to recompute to
          // believe the tally.
          return JSON.stringify({ ok: true, action, council_id: id, phase: council.phase, ballot });
        }
        if (action === 'decide') {
          const decision = council.decide();
          return JSON.stringify({ ok: true, action, council_id: id, phase: council.phase, decision, dissent: decision.dissent, unanimous: decision.unanimous });
        }
        if (action === 'record') {
          const sealed = council.record();
          const moved = councilSessions.seal(id);
          return JSON.stringify({ ok: moved.ok, action, council_id: id, phase: council.phase, seal: sealed, reason_code: moved.reason_code ?? null, detail: moved.detail ?? null });
        }
      } catch (error) {
        // A phase refusal is a value, not a crash: the caller is told which phase it is in and what the phase
        // list is, so it can correct itself without a second call to find out.
        if (error?.name === 'CouncilRefusal') {
          return JSON.stringify({ ok: false, action, council_id: id, phase: council.phase, phases: PHASES, reason_code: error.code, detail: error.message, extra: error.extra ?? null });
        }
        throw error;
      }

      // "state" and anything unrecognised: report rather than mutate.
      return JSON.stringify({
        ok: true,
        action: 'state',
        council_id: id,
        phase: council.phase,
        phases: PHASES,
        members: council.members,
        votes: council.votes,
        arguments: council.arguments,
        decision: council.decision,
      });
    },
  }));
}
