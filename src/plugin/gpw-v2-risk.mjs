/**
 * GPW-V2 five-level risk model.
 *
 * The operator's vocabulary is not the four-colour audit model of `gpw-colors.mjs`: it is the
 * guardrail ladder G0 / G1-1 / G1-2 / G2 / G3, rendered as green / blue / gray / yellow / red.
 * The mapping is fixed here and nowhere else:
 *
 *   green  G0    read-only, new files in the workspace, or a purely local read  -> allow now
 *   blue   G1-1  an ordinary in-project mutation                                  -> allow after 1 minute
 *   gray   G1-2  dependency install / test / build / long local task              -> allow after 10 minutes
 *   yellow G2    an action a human must see and confirm                          -> pending, no auto-allow
 *   red    G3    a hard boundary                                                 -> deny outright
 *
 * ## Why a separate classifier rather than another colour in gpw-colors
 *
 * The four-colour model answers "should a human look at this?". It has no delay vocabulary and its
 * blue means "already approved this session", which is the opposite of GPW-V2's blue ("not yet, wait
 * one minute"). Reusing it would silently reinterpret every existing blue grant. This module is pure
 * (no filesystem, no context) so the ladder can be tested without mounting a plugin.
 *
 * ## Fail-closed, but not paranoid
 *
 * A tool this module does not recognise is yellow, never green: the cost of asking is one confirmation,
 * the cost of guessing wrong is an unread write. Read-only tools are green because their own names are
 * a closed set here, not because they are unknown.
 */

import { pathsOfToolCall } from './folder-policy.mjs';

export const GPW_V2_LEVELS = Object.freeze(['green', 'blue', 'gray', 'yellow', 'red']);

/** The operator's own labels, kept next to the mapping so a UI cannot drift from the ladder. */
export const GPW_V2_G_LEVELS = Object.freeze({
  green: 'G0',
  blue: 'G1-1',
  gray: 'G1-2',
  yellow: 'G2',
  red: 'G3',
});

export const GPW_V2_LABELS = Object.freeze({
  green: '绿 · 自动放行（G0）',
  blue: '蓝 · 延迟 1 分钟放行（G1-1）',
  gray: '灰 · 延迟 10 分钟放行（G1-2）',
  yellow: '黄 · 弹窗警告 + 二次确认（G2）',
  red: '红 · 直接禁止（G3）',
});

export const GPW_V2_DEFAULT_TIMING = Object.freeze({
  blueDelayMs: 60_000,
  grayDelayMs: 600_000,
  /** Zero means wait for the operator indefinitely; a yellow action is never auto-approved. */
  yellowTimeoutMs: 0,
});

const READONLY_TOOLS = new RegExp(
  '^(' +
    'read|read_file|read_text|search|search_memory|grep|glob|glob_files|list|list_files|dir|ls|cat|head|tail|view|' +
    'web_search|web_fetch|fetch|general_search|status|health|metrics|inspect|image_search|video_search|extract_video|' +
    'canvasreadfile|tool_search|present_cards|present_files|get_current_time|calculator|wait|taskoutput|' +
    'seed_finance_lookup|seed_legal_search|seed_medical_search|seed_finance_search|seed_scholar_search|' +
    'w2m_status|w2m_devices|w2m_tasks|w2m_history|w2m_report|w2m_wait|w2m_stats|' +
    'list_cron_jobs|get_cron_job|get_agent_relation|peek_task_progress|tasklist|taskget|' +
    'list_collaborative_project_artifacts|list_collaborative_project_cloud_resources|get_collaborative_project_overview|' +
    'get_lark_event_job|get_recording|get_computer_recording_status|read_resources' +
  ')$',
  'i',
);

const COMMAND_TOOLS = /^(bash|pwsh|powershell|powershell_tool|bash_tool|shell|terminal|run_command|exec)$/i;

const WRITE_TOOLS = /^(write|write_file|edit|edit_file|create|create_file|apply_patch|mkdir|create_directory|touch)$/i;
const COPY_TOOLS = /^(copy|cp|copy_file)$/i;
const DELETE_TOOLS = /^(delete|delete_file|remove|remove_file|unlink|rmdir)$/i;
const MOVE_TOOLS = /^(mv|move|move_file|rename|rename_file|ren)$/i;

/** Read-only command prefixes. Anything not here is at least yellow, so the list may stay narrow. */
const READONLY_COMMAND = new RegExp(
  '^(' +
    'ls|dir|cat|type|head|tail|grep|findstr|find|stat|wc|pwd|echo|which|where|' +
    'get-content|get-childitem|get-item|get-itemproperty|test-path|select-string|measure-object|resolve-path|' +
    'node -v|node --version|npm --version|pnpm --version|yarn --version|git status|git log|git diff|git show|' +
    'git rev-parse|git describe|git tag -l|git branch --show-current|git branch --list|git remote --verbose|git remote show' +
  ')\\b',
  'i',
);

/** Commands that are a hard boundary on their own, regardless of path arguments. */
const RED_COMMANDS = [
  /(?:^|[;&|]\s*)(?:shutdown|reboot|halt|poweroff)(?:\s|$)/i,
  /\bmkfs(?:[.\w]+)?\b/i,
  /\bdd\s+if=/i,
  /\b(?:diskpart|bcdedit|clear-disk|initialize-disk|format-volume)\b/i,
  /\bformat\b[^\n]*\b[A-Za-z]:/i,
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(?:\*|\.)?(?:\s|$)/,
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*[A-Za-z]:[\\/](?:\*|\.)?(?:\s|$)/,
  /\bdel\s+\/[a-z]*\s*[A-Za-z]:[\\/](?:\*|\.)?(?:\s|$)/i,
  /\bremove-item\b[^\n]*-recurse[^\n]*(?:[A-Za-z]:[\\/](?:\*|\.)?(?:\s|$)|(?:\/(?:\*|\.)?(?:\s|$)))/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /\b(curl|wget|irm|invoke-restmethod|invoke-webrequest)[^|;]*\|\s*(?:ba|z|da|pw|po)?sh\b/i,
  /\bchmod\s+(-R\s+)?(?:777|000)\s+\/(?:\s|$)/i,
  /\b(?:mimikatz|secretsdump|hashdump|procdump[^\n]*lsass|reg\s+save\s+hklm\\sam|ntdsutil)\b/i,
];

/** A pipe or command chain into an interpreter executes arbitrary text; it is not a read. */
const PIPE_INTERPRETER = /(?:[|;]|&&)\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh|fish|powershell|pwsh|python(?:3)?|node|perl|ruby|php)\b/i;
/** `find -exec`/`-delete`/`-fprint*` mutates or writes even though `find` is a read-only prefix. */
const FIND_EXEC = /\bfind\b[^\n]*\s-?(?:exec|execdir|delete|fprint|fprintf|fls)\b/i;
/** Redirection to a real file is a write, even when the command name is a read-only prefix. */
const SHELL_FILE_OUTPUT = /(?:^|[^0-9])(?:>>?|&>)\s*(?!&?\d+|\/dev\/null)[^\s|;&]+/i;
const SHELL_TEE = /\b(?:tee|out-file)\b/i;
/** A read-only first token must never lend its verdict to later pipeline/chain segments. */
const SHELL_CHAIN = /&&|\|\||[;|]|(?<!>)&(?!>)|\r?\n|\r/;
/** Command/process substitution hides another command even when the visible prefix is read-only. */
const SHELL_SUBSTITUTION = /\$\(|`|<\(|>\(/;

/** Allow only the deliberately simple case: unquoted separators and a closed read-only prefix per segment. */
function isReadOnlyChain(text) {
  // Quoting rules differ between POSIX shells and PowerShell. If a chain also contains quotes, do not
  // guess where its real segment boundaries are; the caller keeps it at G2 instead of auto-allowing it.
  if (/["']/.test(text)) return false;
  const segments = text.split(SHELL_CHAIN).map((segment) => segment.trim());
  return segments.length > 1 && segments.every((segment) => segment !== '' && READONLY_COMMAND.test(segment));
}

/** Credential-shaped paths are red even for reads. */
const SENSITIVE_PATH = /(?:^|[\\/])(\.env(?:\..*)?|\.ssh|\.aws|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials|passwd|shadow|\.gnupg)(?:[\\/]|$)/i;

/** System paths are red for reads and writes, matching the host's hard boundary. */
const SYSTEM_PATH = /^(?:[A-Za-z]:[\\/](?:Windows|Program Files|Program Files \(x86\)|ProgramData|System32)(?:[\\/]|$)|\/(?:etc|usr|bin|sbin|lib|boot|dev|proc|sys|root|var\/lib|var\/log)(?:\/|$))/i;

/** Commands that need a human but are not hard boundaries. */
const YELLOW_COMMANDS = [
  /\bgit\s+config\b[^\n]*--(?:global|system)\b/i,
  /\bgit\s+(?:diff|log|show)\b[^\n]*--output\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\bgit\s+restore\b/i,
  /\b(?:rm|del|rmdir|remove-item)\b/i,
  /\b(?:move|move-item|ren|rename-item|mv)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\b(?:npm|pnpm|yarn)\s+unpublish\b/i,
  /\b(?:npm|pnpm|yarn)\s+uninstall\b/i,
  /\bpip\s+uninstall\b/i,
  /\b(?:gh|hub)\s+(?:release|pr|issue|api)\b/i,
  /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|scp|sftp|ssh|rsync)\b/i,
  /\b(?:docker|docker-compose|kubectl|helm|terraform\s+apply|ansible|vagrant)\b/i,
  /\b(?:systemctl|service|sc|reg\s+(?:add|delete)|setx|netsh|winget|choco|scoop|taskkill|stop-process|start-process)\b/i,
  /\b(?:format|chkdsk|sfc|dism)\b/i,
  /\b(?:takeown|icacls|attrib|fsutil)\b/i,
  /\b(?:find)\b[^\n]*-delete\b/i,
  /\b(?:npm|pnpm|yarn)\s+link\b/i,
];
/** Commands that are routine in-project mutation: one minute. */
const BLUE_COMMANDS = [
  /\bgit\s+(?:add|commit|tag|stash|merge|rebase|switch|checkout|config)\b/i,
  /\bnpm\s+version\b/i,
  /\b(?:new-item|set-content|add-content|out-file)\b/i,
];
/** Commands that are G1-2: dependency work, test/build loops, long local tasks. */
const GRAY_COMMANDS = [
  /\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|test|run|exec|update)\b/i,
  /\bnpx\b/i,
  /\bpip\s+install\b/i,
  /\b(?:cargo|go|mvn|gradle|make|cmake|dotnet|msbuild|vite|webpack|rollup|esbuild|turbo|nx)\b/i,
  /\b(?:node|python|python3|pwsh|powershell)\s+(?:-e|-c|--eval|-File|scripts\/|\S+\.(?:mjs|cjs|js|ts|py|ps1))\b/i,
];

const EXTERNAL_TOOLS = /^(send_message|send_email|reply_email|forward_email|create_issue|create_pull_request|push|deploy|publish|release|upload_file|filebatchupload|create_cron_job|update_cron_job|delete_cron_job|create_lark_event_job|update_lark_event_job|delete_lark_event_job)$/i;
const FLEET_MUTATING_TOOLS = /^(w2m_run|w2m_cancel|w2m_intent|w2m_update|w2m_memory)$/i;
const CONTROL_TOOLS = /^(computer_use_tool|mac_computer_use_tool|browser_use|general_computer_use)$/i;
const AGENT_TOOLS = /^(create_agent|app_builder_agent)$/i;

function fold(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function slash(value) {
  const raw = String(value).replace(/\\/g, '/');
  const unc = raw.startsWith('//') ? '//' : '';
  const drive = /^[A-Za-z]:/.exec(raw)?.[0] ?? '';
  const absolute = unc !== '' || drive !== '' || raw.startsWith('/');
  const rest = raw.slice(unc.length + drive.length).replace(/^\/+/, '');
  const parts = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  const body = parts.join('/');
  if (unc !== '') return `${unc}${body}`;
  if (drive !== '') return `${drive}/${body}`;
  if (absolute) return `/${body}`;
  return body;
}

/** Resolve a raw path against the workspace when it is relative; leave absolute/UNC paths alone. */
function absolutePath(value, workspace) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw)) return slash(raw);
  if (typeof workspace !== 'string' || workspace.trim() === '') return slash(raw);
  const base = slash(workspace);
  if (raw.startsWith('./') || raw.startsWith('.\\')) return slash(base + '/' + raw.slice(2));
  return slash(base + '/' + raw);
}

function inside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string' || target === '' || root === '') return false;
  const t = fold(slash(target));
  const r = fold(slash(root));
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : r + '/');
}

function everyInside(paths, workspace) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  if (typeof workspace !== 'string' || workspace.trim() === '') return false;
  return paths.every((path) => inside(absolutePath(path, workspace), workspace));
}

function commandTextOf(args) {
  if (typeof args === 'string') {
    const raw = args.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.command === 'string') return parsed.command;
        if (typeof parsed?.cmd === 'string') return parsed.cmd;
      } catch {
        /* the raw string is the command */
      }
    }
    return args;
  }
  if (args !== null && typeof args === 'object') {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    if (typeof args.script === 'string') return args.script;
  }
  return '';
}

function labelOf(level) {
  return GPW_V2_LABELS[level] ?? GPW_V2_LABELS.yellow;
}

function verdict(level, reason) {
  return { level, color: level, gLevel: GPW_V2_G_LEVELS[level], label: labelOf(level), reason };
}

function redReasonOf(path, blacklist, workspace) {
  if (SENSITIVE_PATH.test(path)) return `凭据/密钥路径 "${path}" 属于 G3 红线`;
  if (SYSTEM_PATH.test(path)) return `系统路径 "${path}" 属于 G3 红线`;
  for (const folder of Array.isArray(blacklist) ? blacklist : []) {
    // A panel may store a relative blacklist entry (e.g. `secrets`); resolve it against the same
    // workspace as the target, otherwise a relative entry could never match its own children.
    const root = absolutePath(folder, workspace);
    if (inside(path, root)) return `路径 "${path}" 在用户黑名单 "${folder}" 内（G3）`;
  }
  return null;
}

function redFromPaths(paths, workspace, blacklist) {
  for (const raw of Array.isArray(paths) ? paths : []) {
    const path = absolutePath(raw, workspace);
    const reason = redReasonOf(path, blacklist, workspace);
    if (reason !== null) return verdict('red', reason);
  }
  return null;
}

function commandVerdict(command, paths, workspace) {
  const text = String(command ?? '').trim();
  if (text === '') return verdict('yellow', '命令为空，无法判定风险（G2）');
  for (const pattern of RED_COMMANDS) {
    if (pattern.test(text)) return verdict('red', `命令命中 G3 红线（${pattern.source.slice(0, 48)}）`);
  }
  if (/(?:\.ssh[\\/]|id_rsa|id_ed25519|\.env(?:[\\s/\\]|$)|credentials|passwd|shadow)/i.test(text)) {
    return verdict('red', '命令触及凭据/密钥路径（G3）');
  }
  if (PIPE_INTERPRETER.test(text)) {
    return verdict('red', '命令把文本通过管道/串联交给解释器执行（G3）');
  }
  if (FIND_EXEC.test(text)) {
    return verdict('yellow', 'find 的 -exec/-delete 会改变文件或执行外部命令（G2）');
  }
  if (SHELL_FILE_OUTPUT.test(text) || SHELL_TEE.test(text)) {
    return verdict('yellow', '命令通过重定向/tee/Out-File 写文件（G2）');
  }
  for (const pattern of YELLOW_COMMANDS) {
    if (pattern.test(text)) return verdict('yellow', `命令需要弹窗确认（G2，${pattern.source.slice(0, 40)}）`);
  }
  if (SHELL_SUBSTITUTION.test(text)) {
    return verdict('yellow', '命令包含命令/进程替换，无法证明隐藏部分是只读（G2）');
  }
  if (SHELL_CHAIN.test(text)) {
    if (isReadOnlyChain(text)) return verdict('green', '复合命令的每一段都是只读前缀（G0）');
    return verdict('yellow', '复合命令不能逐段证明只读，按 G2 交人工确认');
  }
  for (const pattern of GRAY_COMMANDS) {
    if (pattern.test(text)) {
      if (paths.length > 0 && !everyInside(paths, workspace)) {
        return verdict('yellow', '命令涉及工作区外路径（G2）');
      }
      return verdict('gray', `依赖安装/测试/构建/长任务（G1-2，${pattern.source.slice(0, 36)}）`);
    }
  }
  for (const pattern of BLUE_COMMANDS) {
    if (pattern.test(text)) {
      if (paths.length > 0 && !everyInside(paths, workspace)) {
        return verdict('yellow', '命令涉及工作区外路径（G2）');
      }
      return verdict('blue', `项目内常规变更（G1-1，${pattern.source.slice(0, 36)}）`);
    }
  }
  if (READONLY_COMMAND.test(text)) return verdict('green', '只读命令（G0）');
  if (paths.length > 0 && everyInside(paths, workspace)) {
    return verdict('blue', '工作区内命令变更（G1-1）');
  }
  return verdict('yellow', '命令不在只读/项目内白名单，按 G2 交人工确认');
}

/**
 * Classify one tool call into the five-level ladder.
 *
 * @param {{name?: string, arguments?: string|object, paths?: string[], workspace?: string|null, blacklist?: string[]}} input
 * @returns {{level: 'green'|'blue'|'gray'|'yellow'|'red', color: string, gLevel: string, label: string, reason: string}}
 */
export function classifyGpwV2Call(input) {
  const name = String(input?.name ?? 'tool');
  const args = input?.arguments;
  const givenPaths = Array.isArray(input?.paths) ? input.paths.filter((path) => typeof path === 'string' && path.trim() !== '') : [];
  const workspace = typeof input?.workspace === 'string' && input.workspace.trim() !== '' ? input.workspace : null;
  const blacklist = Array.isArray(input?.blacklist) ? input.blacklist : [];
  const command = commandTextOf(args);
  const paths = givenPaths.length > 0
    ? givenPaths
    : pathsOfToolCall({ name, arguments: args }, { allowRelative: workspace !== null });

  const redByPath = redFromPaths(paths, workspace, blacklist);
  if (redByPath !== null) return redByPath;

  if (COMMAND_TOOLS.test(name)) {
    if (command !== '') return commandVerdict(command, paths, workspace);
    return verdict('yellow', '命令工具没有可读命令行，按 G2 交人工确认');
  }

  if (READONLY_TOOLS.test(name)) return verdict('green', '只读/纯查询工具（G0）');

  if (DELETE_TOOLS.test(name)) {
    if (paths.length > 20) return verdict('yellow', '批量删除超过 20 个路径（G2）');
    return verdict('yellow', '删除动作必须弹窗确认（G2）');
  }
  if (MOVE_TOOLS.test(name)) return verdict('yellow', '移动/重命名必须弹窗确认（G2）');

  if (WRITE_TOOLS.test(name)) {
    if (paths.length === 0) return verdict('yellow', '写入没有指明路径，按 G2 交人工确认');
    if (paths.length > 20) return verdict('yellow', '批量写入超过 20 个路径（G2）');
    if (everyInside(paths, workspace)) {
      if (/^(mkdir|create_directory|touch)$/i.test(name)) return verdict('green', '工作区内新建目录/文件（G0）');
      return verdict('green', '工作区内写入/编辑（G0）');
    }
    return verdict('yellow', '写入/编辑工作区外路径（G2）');
  }
  if (COPY_TOOLS.test(name)) {
    if (paths.length > 0 && everyInside(paths, workspace)) return verdict('blue', '工作区内复制（G1-1）');
    return verdict('yellow', '复制涉及工作区外路径（G2）');
  }

  if (FLEET_MUTATING_TOOLS.test(name)) {
    if (/^w2m_memory$/i.test(name)) return verdict('blue', '编队记忆写入（G1-1）');
    return verdict('yellow', '会改变其他机器/任务状态（G2）');
  }
  if (EXTERNAL_TOOLS.test(name)) return verdict('yellow', '对外发送/发布/定时任务（G2）');
  if (CONTROL_TOOLS.test(name)) return verdict('yellow', '桌面/浏览器控制可能改变外部状态（G2）');
  if (AGENT_TOOLS.test(name)) return verdict('gray', '创建/编排子代理属于长任务（G1-2）');
  if (/^(kill_agent|taskstop)$/i.test(name)) return verdict('yellow', '终止代理/后台任务（G2）');

  if (/^(manage_environment|manage_preference|notebookedit|canvascreatefile|taskcreate|taskupdate|submit_plan|execute_defer_tool|multitool_use_parallel)$/i.test(name)) {
    return verdict('blue', '本机状态/项目文件变更（G1-1）');
  }
  if (/^(image_edit|video_edit|audio_to_audio_plus|media_to_video)$/i.test(name)) {
    return verdict('blue', '编辑已有媒体资产（G1-1）');
  }
  if (/^(image_gen|text_to_video|image_to_video|text_to_audio_plus)$/i.test(name)) {
    return verdict('green', '生成新媒体资产（G0）');
  }
  if (/^interaction_authorize_folder$/i.test(name)) return verdict('yellow', '申请文件夹访问授权会扩大可写范围（G2）');
  if (/^(interaction_ask|interaction_request_action|sidebar_create_tab|sidebar_close_tab|sidebar_list_tabs|sidebar_read_tab)$/i.test(name)) {
    return verdict('green', '与本机 UI/用户交互（G0）');
  }

  return verdict('yellow', '未识别的工具按 G2 交人工确认（fail-closed）');
}
