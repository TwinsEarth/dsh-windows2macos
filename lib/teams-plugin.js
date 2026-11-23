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
export {
  createTeamsDataPlane,
  TeamsDataPlane,
} from '../src/plugin/teams/data-plane.mjs';
