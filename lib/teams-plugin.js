/**
 * Package-facing entry for the opt-in Teams sub-plugin:
 * `@twinsearth/w2m-dsh-plugin/dsh-teams`.
 *
 * This is a seam, not a second implementation. The composition root is
 * `src/plugin/teams-plugin.mjs`; the service is `src/plugin/teams/service.mjs`; the transport rule
 * is `src/plugin/teams/transport-policy.mjs`; the WebRTC bulk path is `src/plugin/teams/data-plane.mjs`.
 *
 * Not re-exported from `lib/index.js`: installing the fleet plugin must not perform a relay read.
 * `cordis.patch.yml` ships this row `disabled: true`; enabling it is the operator's decision.
 */
export {
  apply,
  buildTools,
  DEFAULT_STALE_AFTER_MS,
  describeConfig,
  inject,
  name,
  normalizePluginConfig,
  TEAMS_ROW_ID,
  TOOL_NAMES,
} from '../src/plugin/teams-plugin.mjs';
export {
  normalizeTeamProjectId,
  safeTeamRelayUrl,
  TEAMS_CODE,
  TEAMS_DEFAULT_PROJECT_ID,
  TeamsService,
} from '../src/plugin/teams/service.mjs';
export {
  classifyTeamPayload,
  createTeamTransportRouter,
  normalizeTeamTransportPolicy,
  TEAM_CONTROL_CHANNEL,
  TEAM_DATA_CHANNEL,
  TEAM_DATA_MAX_ATTEMPTS,
  TEAM_TRANSPORT_CODE,
} from '../src/plugin/teams/transport-policy.mjs';
export {
  presenceFromDevices,
  TEAM_PRESENCE_DEFAULT_STALE_MS,
  TeamPresence,
  toTeamTimestampMs,
} from '../src/plugin/teams/presence.mjs';
export { createTeamsDataPlane, TeamsDataPlane } from '../src/plugin/teams/data-plane.mjs';
export { createTeamsV2Service, TEAMS_V2_VERSION } from '../src/plugin/teams/v2-service.mjs';
export { TEAMS_V2_CODE, planPath, evolutionPath, resolveTeamsV2Root } from '../src/plugin/teams/v2-store.mjs';
export {
  createBuiltinExecutor,
  FRAMEWORK_CATALOG,
  FRAMEWORK_NAMES,
  getFrameworkAdapter,
  listFrameworks,
  normalizeFramework,
  registerFrameworkAdapter,
  resetFrameworkAdaptersForTests,
  selectFramework,
} from '../src/plugin/teams/frameworks.mjs';
export {
  applyStep,
  checkGraph,
  createPlan,
  replan,
  summarizePlan,
  readySteps,
  blockedSteps,
  TEAM_ROLES,
  STEP_STATUSES,
  PLAN_STATUSES,
} from '../src/plugin/teams/orchestrator.mjs';
export {
  DEFAULT_VERIFY_THRESHOLD,
  VERIFIER_ID,
  VERIFY_MODES,
  verify,
} from '../src/plugin/teams/verification.mjs';
export {
  COST_UNITS,
  createCostLedger,
  estimateModelUnits,
  quoteCost,
  recordCost,
  summarizeCost,
} from '../src/plugin/teams/cost.mjs';
export {
  addCandidate,
  checkStop,
  compareMetrics,
  promoteCandidate,
  rollback,
  summarizeEvolution,
} from '../src/plugin/teams/evolution.mjs';
