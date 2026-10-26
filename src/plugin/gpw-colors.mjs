/**
 * GPW four-colour audit model (v1.7.10).
 *
 * DSH already has a rich set of audit behaviours across many plugins. This module re-homes every one of them into
 * exactly four colours, so the operator sees one vocabulary instead of a dozen plugin names:
 *
 *   green  (通过)   safe, reversible, read-only, or a whitelist hit -> run, no prompt, no interruption
 *   blue   (正常)   the audit already happened: approved this session, learned, or covered by an established grant
 *   yellow (警报)   a human has to nod: privileged writes, non-whitelisted exec, sandbox escalation, medium risk
 *   red    (风险)   hard boundary: denied outright, never auto-approved, fail-closed when nobody answers
 *
 * The one-sentence distinction: green is "don't care", blue is "cared before", yellow is "care now", red is
 * "care won't help — it does not pass, or only a human override can".
 *
 * This file is pure: no session, no filesystem, no plugin context. The gate itself lives in gpw.mjs, which calls
 * classifyGpwCall() and turns the colour into allow / pending / deny.
 */

export const GPW_COLORS = Object.freeze(['green', 'blue', 'yellow', 'red']);

/** Human labels, used by the panel and by log lines. */
export const GPW_COLOR_LABELS = Object.freeze({
  green: '通过（自动放行）',
  blue: '正常（已授权/已确认）',
  yellow: '警报（需要人工确认）',
  red: '风险（直接拒绝/强制拦截）',
});

/** Tools that only read: green by their nature. */
const READONLY_TOOLS = /^(read|search|grep|glob|list|dir|ls|web_search|web_fetch|fetch|cat|head|tail|status|health|metrics|inspect)$/i;

/** Command tools: their argv decides, not the tool name. */
const COMMAND_TOOLS = /^(bash|pwsh|powershell|shell|terminal|run_command|exec)$/i;

/** Write/edit tools. */
const WRITE_TOOLS = /^(write|edit|create|apply_patch|delete|remove|mv|move|rename|mkdir|touch|copy|cp)$/i;

/** Known read-only command prefixes (L1/L2 safe). */
const READONLY_COMMAND = /^(ls|cat|head|tail|grep|find|stat|wc|pwd|echo|which|where|node -v|node --version|npm --version|git status|git log|git diff|git show|git branch)\b/;

/** Commands that hit the whitelist rule in the operator's definition (explicit allow-list entries). */
const ALLOWED_COMMAND = /^(python\s+_scripts\/lint\.py|node\s+scripts\/lint\.mjs|npm\s+run\s+lint|npx\s+prettier)\b/;

/** Hard-red command forms: no approval path at all (matching DSH's dangerous-command blacklist). */
const RED_COMMANDS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, // rm -rf /
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /\b(curl|wget)[^|;]*\|\s*(ba|z|da)?sh\b/i,
  /\bchmod\s+(-R\s+)?(777|000)\s+\//i,
];

/** Sensitive path patterns: reading them is red (DSH treats .env/.ssh/id_rsa/*.pem//etc/passwd as forbidden). */
const SENSITIVE_PATH = /(?:^|[\\/])(\.env(\..*)?|\.ssh|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials|passwd|shadow|\.gnupg)(?:[\\/]|$)/i;

/** System paths: writes are red, reads are red too (DSH hard-denies system-path destruction/credential access). */
const SYSTEM_PATH = /^(?:[A-Za-z]:[\\/](?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:[\\/]|$)|\/(?:etc|usr|bin|sbin|boot|dev|proc|sys)(?:\/|$))/i;

/** Medium risk commands: approved by a human, then learned. */
const YELLOW_COMMANDS = [
  /\bgit\s+reset\s+--hard\b/i,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)/i, // recursive delete of a project directory
  /\brmdir\s+/i,
  /\bnpm\s+(i|install|publish)\b/i,
  /\bpip\s+install\b/i,
  /\b(curl|wget)\b/i, // network egress
];

/** Fingerprint of an operation, for session grants and learned approvals. */
export function fingerprintOf(call) {
  const name = String(call?.name ?? 'tool').toLowerCase();
  const args = call?.arguments ?? null;
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  // Normalise the volatile parts so the same operation twice is the same fingerprint.
  return name + '|' + text.replace(/\s+/g, ' ').slice(0, 400);
}

/**
 * Classify one tool call into a colour.
 *
 * @param {{name?: string, arguments?: string|object, paths?: string[], whitelist?: string[], blacklist?: string[],
 *          workspace?: string|null, authorized?: boolean|Set<string>, fingerprint?: string}} input
 * @returns {{color: 'green'|'blue'|'yellow'|'red', reason: string, label: string}}
 */
export function classifyGpwCall(input) {
  const name = String(input?.name ?? 'tool');
  const args = input?.arguments;
  const paths = Array.isArray(input?.paths) ? input.paths : [];
  const workspace = typeof input?.workspace === 'string' && input.workspace !== '' ? input.workspace : null;
  const authorized = input?.authorized === true;

  const commandText = (() => {
    if (typeof args === 'string') return args;
    if (args !== null && typeof args === 'object') {
      if (typeof args.command === 'string') return args.command;
      if (typeof args.cmd === 'string') return args.cmd;
    }
    return '';
  })();

  const say = (color, reason) => ({ color, reason, label: GPW_COLOR_LABELS[color] });

  // ---- red: hard boundaries, no approval path ---------------------------------------------------------------
  if (COMMAND_TOOLS.test(name) && commandText !== '') {
    for (const pattern of RED_COMMANDS) {
      if (pattern.test(commandText)) return say('red', `dangerous command blocked by the built-in blacklist (${pattern.source.slice(0, 40)})`);
    }
  }
  for (const path of paths) {
    if (SENSITIVE_PATH.test(path)) return say('red', `sensitive path "${path}" is never readable`);
    if (SYSTEM_PATH.test(path)) return say('red', `system path "${path}" is never writable`);
  }
  for (const path of paths) {
    if (Array.isArray(input?.blacklist) && input.blacklist.some((folder) => path.replace(/\\/g, '/').toLowerCase().startsWith(folder.replace(/\\/g, '/').toLowerCase()))) {
      return say('red', `folder "${path}" is on the explicit deny list`);
    }
  }

  // ---- blue: the audit already happened ----------------------------------------------------------------------
  if (authorized) return say('blue', 'approved earlier in this session, so it runs as an established grant');

  // ---- green: no human needed ---------------------------------------------------------------------------------
  if (READONLY_TOOLS.test(name)) return say('green', 'read-only operation');
  if (COMMAND_TOOLS.test(name) && commandText !== '') {
    if (READONLY_COMMAND.test(commandText.trim())) return say('green', 'read-only command');
    if (ALLOWED_COMMAND.test(commandText.trim())) return say('green', 'command hits the configured allow-list');
  }
  if (WRITE_TOOLS.test(name) && paths.length > 0 && workspace !== null) {
    const inWorkspace = paths.every((path) => path.replace(/\\/g, '/').toLowerCase().startsWith(workspace.replace(/\\/g, '/').toLowerCase()));
    if (inWorkspace) return say('green', 'write stays inside the workspace (L2)');
  }

  // ---- yellow: a human has to nod -----------------------------------------------------------------------------
  if (COMMAND_TOOLS.test(name) && commandText !== '') {
    for (const pattern of YELLOW_COMMANDS) {
      if (pattern.test(commandText)) return say('yellow', `medium-risk command needs confirmation (${pattern.source.slice(0, 30)})`);
    }
    return say('yellow', 'command is not in the read-only or allow-listed set');
  }
  if (WRITE_TOOLS.test(name)) return say('yellow', 'write needs confirmation (outside the workspace or unnamed path)');
  return say('yellow', 'tool is not known to be safe, so a human decides (unknown tool -> fail-closed to the operator)');
}
