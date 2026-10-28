/**
 * S2-d: the joint-dev tool surface.
 *
 * Only the two inert halves live here: a plan can be created/read/listed, and a status can be read.
 * Approval and dispatch stay in `w2m-joint` (operator CLI) and the settings page — a model can never
 * sign an approval or send a command, which is the decision-2 boundary.
 */
import { buildPlan } from './joint-dev/dispatch.mjs';
import { assertDispatchAllowed, listPlans, loadApproval, loadPlan, savePlan } from './joint-dev/plan-store.mjs';
import { loadOperatorKey } from './operator-key.mjs';

const json = (value) => JSON.stringify(value, null, 2);

export function registerJointTools(ctx, { defineTool, stateDir, machineName, output }) {
  const requireStateDir = () => {
    if (typeof stateDir === 'string' && stateDir !== '') return stateDir;
    return null;
  };

  ctx.tools.register(defineTool({
    name: 'w2m_joint_plan',
    description:
      'Joint-dev plan store (metadata only). action=create builds a canonical plan from steps_json ' +
      '(an array of {step_id, machine_id, command_argv, depends_on?, write_scope?}), action=list lists ' +
      'saved plans, action=get reads one. Nothing is approved or dispatched by this tool.',
    parameters: {
      action: { type: 'string', enum: ['create', 'list', 'get'], description: 'create | list | get (default list)' },
      steps_json: { type: 'string', description: 'action=create: JSON array of steps' },
      base_commit: { type: 'string', description: 'action=create: base commit the plan is anchored to' },
      plan_sha256: { type: 'string', description: 'action=get: the 64-hex plan id' },
    },
    output: output ?? { type: 'json' },
    async execute(args) {
      const dir = requireStateDir();
      if (dir === null) return json({ ok: false, code: 'JOINT_STATE_UNAVAILABLE', detail: 'no stateDir configured for this plugin' });
      const action = typeof args?.action === 'string' ? args.action : 'list';
      if (action === 'list') return json({ ok: true, ...listPlans({ stateDir: dir }) });
      if (action === 'get') {
        const loaded = loadPlan({ stateDir: dir, planSha: String(args?.plan_sha256 ?? '') });
        return json(loaded);
      }
      if (action === 'create') {
        let steps;
        try { steps = JSON.parse(String(args?.steps_json ?? '')); } catch { return json({ ok: false, code: 'PLAN_STEPS_INVALID' }); }
        const built = buildPlan({ base_commit: typeof args?.base_commit === 'string' ? args.base_commit : undefined, steps });
        if (built.ok !== true) return json(built);
        const saved = savePlan({ stateDir: dir, plan: built.plan });
        if (saved.ok !== true) return json(saved);
        return json({
          ok: true,
          plan_sha256: built.plan.plan_sha256,
          steps: built.plan.steps.length,
          machines: [...new Set(built.plan.steps.map((step) => step.machine_id))],
          path: saved.path,
          reused: saved.reused,
          initiator: machineName ?? null,
        });
      }
      return json({ ok: false, code: 'PLAN_ACTION_INVALID', detail: { action } });
    },
    presentCall: () => ({ card: 'generic', title: 'joint plan', kind: 'read', rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: 'w2m_joint_status',
    description:
      'Read one joint-dev plan and its approval state (metadata only): approval strength, expiry, ' +
      'whether a signed approval allows dispatch, and the per-step machine/command hash. It never ' +
      'returns argv, output or file bytes, and it cannot approve or dispatch.',
    parameters: {
      plan_sha256: { type: 'string', description: 'the 64-hex plan id' },
    },
    output: output ?? { type: 'json' },
    async execute(args) {
      const dir = requireStateDir();
      if (dir === null) return json({ ok: false, code: 'JOINT_STATE_UNAVAILABLE' });
      const planSha = String(args?.plan_sha256 ?? '');
      const plan = loadPlan({ stateDir: dir, planSha });
      if (plan.ok !== true) return json(plan);
      const key = loadOperatorKey();
      const trusted = key.ok === true ? [key.key_id] : [];
      const gate = assertDispatchAllowed({ stateDir: dir, planSha, requireSignature: true, trustedOperatorKeyIds: trusted });
      const approval = loadApproval({ stateDir: dir, planSha, trustedOperatorKeyIds: trusted });
      return json({
        ok: true,
        plan_sha256: planSha,
        steps: plan.plan.steps.map((step) => ({ step_id: step.step_id, machine_id: step.machine_id, command_hash: step.command_hash })),
        approval: approval.ok === true
          ? { strength: approval.strength, approver: approval.approval.approver, expires_at: approval.approval.expires_at, key_id: approval.approval.operator_key?.key_id ?? null }
          : { state: approval.code },
        dispatch_allowed: gate.ok === true,
        blocked_by: gate.ok === true ? null : gate.code,
      });
    },
    presentCall: () => ({ card: 'generic', title: 'joint status', kind: 'read', rawInput: {} }),
  }));
}
