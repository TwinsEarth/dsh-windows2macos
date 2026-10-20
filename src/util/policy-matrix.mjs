/**
 * The permission matrix: which fleet role may perform which action.
 *
 * ## Why a table, and why refusals are named
 *
 * A role check scattered across call sites drifts: one route checks, another forgets, and the matrix exists only in a document.
 * This table is the single answer, and a refusal always names the action, the role required and the role held -- an
 * "access denied" without those three facts is a support ticket, not a diagnostic.
 *
 * ## Why the levels are ordinal
 *
 * Roles form an order (observer < worker < owner). Stating a minimum level rather than enumerating every allowed role means a
 * new role slots in between two existing ones without rewriting every action.
 */
export const FLEET_ACTIONS = Object.freeze(['read_private', 'vote', 'join', 'dispatch', 'approve', 'manage_members']);

/** Lower number = fewer rights. */
export const ROLE_LEVEL = Object.freeze({ observer: 0, worker: 1, owner: 2 });

/** The minimum level an action needs. `manage_members` is owner-only; approving is owner-only for the same reason. */
export const ACTION_MIN_LEVEL = Object.freeze({
  read_private: 0,
  vote: 1,
  join: 1,
  dispatch: 1,
  approve: 2,
  manage_members: 2,
});

/** The role a level maps back to, for a refusal that says which role would have been enough. */
export function roleForLevel(level) {
  const best = Object.entries(ROLE_LEVEL).filter(([, value]) => value === level)[0];
  return best === undefined ? null : best[0];
}

/**
 * @param {{role?: string|null, action: string}} input
 * @returns {{ok: true, action: string, role: string}} | {ok: false, code: 'FORBIDDEN_ACTION', action: string, required_level: number, current_level: number, required_role: string|null, current_role: string}}
 */
export function can({ role = null, action } = {}) {
  const currentRole = typeof role === 'string' && role in ROLE_LEVEL ? role : 'worker'; // unknown device = worker, never owner
  if (!FLEET_ACTIONS.includes(action)) {
    return {
      ok: false, code: 'FORBIDDEN_ACTION', action, required_level: null, current_level: ROLE_LEVEL[currentRole],
      required_role: null, current_role: currentRole,
    };
  }
  const requiredLevel = ACTION_MIN_LEVEL[action];
  const currentLevel = ROLE_LEVEL[currentRole];
  if (currentLevel >= requiredLevel) return { ok: true, action, role: currentRole };
  return {
    ok: false,
    code: 'FORBIDDEN_ACTION',
    action,
    required_level: requiredLevel,
    current_level: currentLevel,
    required_role: roleForLevel(requiredLevel),
    current_role: currentRole,
  };
}

/** Every action with its verdict for one role -- the board an operator reads. */
export function matrixFor(role) {
  return FLEET_ACTIONS.map((action) => ({ action, ...can({ role, action }) }));
}