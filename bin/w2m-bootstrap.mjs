#!/usr/bin/env node
/**
 * w2m-bootstrap — one command to point a freshly installed plugin at the right relays.
 *
 * ## Why a tool instead of hand-editing the profile
 *
 * The profile patch is YAML that the loader merges into a bundle row, and three mistakes are easy
 * and silent: a `name:` assertion that skips the whole patch, an `insert:` that duplicates the row,
 * and an `autoStartAgent: false` that leaves the agent never starting. This tool writes the small,
 * known-good shape and refuses the inputs it cannot honour, so the Nth machine costs one command
 * instead of one careful copy-paste.
 *
 * ## Two sources, one destination
 *
 * `--bootstrap` accepts either
 *   * an **http(s) URL** — fetched and (when `--operator-key` is given) verified with the same
 *     signature check the runtime bootstrap uses, or
 *   * a **JSON document / file path** — `{"relays": ["https://…", …]}` (a signed answer is accepted
 *     only together with `--operator-key`; without a pin the document is used as operator-supplied
 *     configuration, which is the normal case for an install script that already carries the list).
 *
 * Nothing is written until every input parses and validates, and the existing patch is backed up.
 *
 * ## The temporary marker
 *
 * A machine that cannot reach its own fleet may be pointed at a fallback relay list so it is not
 * stranded. That is honest only if it is visible: `--temporary` writes `relayTemporary: true`, and
 * the fleet panel renders the relay section in red as **临时 Relay 节点**. Removing the marker (by a
 * later run without the flag) is what turns the fallback into a settled configuration.
 *
 * ## Usage
 *
 *   node bin/w2m-bootstrap.mjs \
 *     --bootstrap https://relays.example/bootstrap \
 *     --fleet-key <account fleet key> \
 *     [--operator-key <operator public key PEM file>] \
 *     [--profile desktop] [--name <machine name>] [--temporary] [--dry-run]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fleetIdOf, resolveBootstrap } from '../src/plugin/bootstrap.mjs';
import { decodeFleetKey } from '../src/chatops/fleet-join.mjs';

export const CLI_REFUSAL = Object.freeze({
  BAD_BOOTSTRAP: 'BOOTSTRAP_CLI_BAD_SOURCE',
  BAD_FLEET_KEY: 'BOOTSTRAP_CLI_BAD_FLEET_KEY',
  BAD_RELAYS: 'BOOTSTRAP_CLI_BAD_RELAYS',
  PATCH_MISSING_ROW: 'BOOTSTRAP_CLI_PATCH_MISSING_ROW',
  PATCH_MISSING_CONFIG: 'BOOTSTRAP_CLI_PATCH_MISSING_CONFIG',
  REFUSED: 'BOOTSTRAP_CLI_REFUSED',
});

/**
 * Parse the command line. Every flag has one spelling; an unknown flag is a refusal, not a silent
 * miss — a bootstrap that quietly ignored `--fleet-key` would write a config that cannot join.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseBootstrapCliArgs(argv) {
  const out = {
    bootstrap: null,
    fleetKey: null,
    operatorKeyPath: null,
    profile: 'desktop',
    name: null,
    temporary: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--bootstrap': out.bootstrap = value(); break;
      case '--fleet-key': out.fleetKey = value(); break;
      case '--operator-key': out.operatorKeyPath = value(); break;
      case '--profile': out.profile = value(); break;
      case '--name': out.name = value(); break;
      case '--temporary': out.temporary = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help':
      case '-h': out.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (out.help === true) return out;
  if (typeof out.bootstrap !== 'string' || out.bootstrap.trim() === '') {
    throw new Error('--bootstrap <json|url> is required');
  }
  if (typeof out.fleetKey !== 'string' || out.fleetKey.trim() === '') {
    throw new Error('--fleet-key <key> is required');
  }
  if (decodeFleetKey(out.fleetKey.trim()) === null) {
    throw Object.assign(new Error('--fleet-key is not a 32-byte base64url fleet key'), { reason_code: CLI_REFUSAL.BAD_FLEET_KEY });
  }
  return out;
}

/**
 * Turn the `--bootstrap` value into a relay list.
 *
 * @param {object} args Parsed CLI args.
 * @param {{fetchImpl?: Function, nowMs?: number}} [deps]
 * @returns {Promise<{ok: true, relays: string[], source: 'url'|'json'|'file'}|{ok: false, reason_code: string, detail: string}>}
 */
export async function resolveBootstrapSource(args, deps = {}) {
  const raw = String(args.bootstrap).trim();
  const fleetKey = args.fleetKey.trim();
  if (/^https?:\/\//.test(raw)) {
    const operatorPublicKeyPem = args.operatorKeyPath === null
      ? ''
      : readFileSync(resolve(args.operatorKeyPath), 'utf8');
    if (operatorPublicKeyPem === '') {
      // A URL without a pin cannot be verified; fetch it as operator-supplied JSON instead and say
      // so in the returned source, so the caller can warn rather than pretend it was verified.
      try {
        const response = await (deps.fetchImpl ?? globalThis.fetch)(raw, { method: 'GET' });
        if (!response.ok) return { ok: false, reason_code: CLI_REFUSAL.BAD_BOOTSTRAP, detail: `HTTP ${response.status}` };
        const body = await response.json();
        return relaysFromDocument(body);
      } catch (error) {
        return { ok: false, reason_code: CLI_REFUSAL.BAD_BOOTSTRAP, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    const resolved = await resolveBootstrap({
      url: raw,
      fleetKey,
      operatorPublicKeyPem,
      cacheFile: '',
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
    });
    return resolved.ok === true
      ? { ok: true, relays: resolved.relays, source: 'url' }
      : { ok: false, reason_code: resolved.reason_code, detail: resolved.detail };
  }
  // Inline JSON may be an object or a bare array; anything else is a path. The distinction is the
  // first non-space character, not "does it parse", so a typo'd path fails as a path (a named error)
  // rather than as a JSON parse error that hides which input was actually read.
  const trimmed = raw.trim();
  const text = (trimmed.startsWith('{') || trimmed.startsWith('[')) ? trimmed : readFileSync(resolve(trimmed), 'utf8');
  try {
    return relaysFromDocument(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason_code: CLI_REFUSAL.BAD_BOOTSTRAP, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Accept `{relays:[…]}` (or an array of URLs) and normalize it. */
export function relaysFromDocument(document) {
  const list = Array.isArray(document) ? document
    : (document !== null && typeof document === 'object' && Array.isArray(document.relays) ? document.relays : null);
  if (list === null) {
    return { ok: false, reason_code: CLI_REFUSAL.BAD_RELAYS, detail: 'the bootstrap document must be {"relays": [...]} or an array of relay URLs' };
  }
  const relays = [...new Set(list
    .filter((url) => typeof url === 'string' && url.trim() !== '')
    .map((url) => url.trim().replace(/\/+$/, '')))];
  if (relays.length === 0) return { ok: false, reason_code: CLI_REFUSAL.BAD_RELAYS, detail: 'the document carries no relay URLs' };
  for (const url of relays) {
    if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, reason_code: CLI_REFUSAL.BAD_RELAYS, detail: `${JSON.stringify(url)} is not an http(s) base URL` };
  }
  return { ok: true, relays, source: 'json' };
}

/**
 * Rewrite the `- id: w2m` block's config with the resolved values, in place and with a backup.
 *
 * Deliberately line-based: this file is edited by humans and must stay readable, and a YAML emitter
 * would rewrite comments the operator relies on. The block is found by its exact id row, the config
 * block by its `config:` child; only the keys this tool owns are replaced or appended.
 *
 * @param {string} file
 * @param {{relays: string[], fleetKey: string, relayUrl: null|string, temporary: boolean, machineName: string|null}} values
 * @returns {{ok: true, file: string, backup: string}|{ok: false, reason_code: string, detail: string}}
 */
export function writeBootstrapPatch(file, values) {
  if (!existsSync(file)) {
    return { ok: false, reason_code: CLI_REFUSAL.PATCH_MISSING_ROW, detail: `profile patch not found at ${file}` };
  }
  // Normalize here as well as in the source resolver: callers that pass a document straight through
  // must not be able to write a trailing-slash base URL that later compares unequal to every other
  // use of the same relay.
  const relays = [...new Set((Array.isArray(values.relays) ? values.relays : [])
    .filter((url) => typeof url === 'string' && url.trim() !== '')
    .map((url) => url.trim().replace(/\/+$/, '')))];
  if (relays.length === 0) {
    return { ok: false, reason_code: CLI_REFUSAL.BAD_RELAYS, detail: 'no relay URLs were supplied' };
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^-\s*id:\s*w2m\s*$/.test(line.trim()));
  if (start < 0) {
    return { ok: false, reason_code: CLI_REFUSAL.PATCH_MISSING_ROW, detail: 'no `- id: w2m` row exists in the patch; the bundle should have inserted it' };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s*id:\s*\S+/.test(lines[i].trim())) { end = i; break; }
  }
  let configIndex = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s*config:\s*$/.test(lines[i])) { configIndex = i; break; }
  }
  if (configIndex < 0) {
    return { ok: false, reason_code: CLI_REFUSAL.PATCH_MISSING_CONFIG, detail: 'the `- id: w2m` row has no `config:` block to write into' };
  }
  const indent = `${(lines[configIndex].match(/^\s*/) ?? [''])[0]}  `;
  const managed = {
    flock: undefined,
    rabbitUrl: relays[0],
    fleetKey: `'${values.fleetKey}'`,
    autoStartAgent: 'true',
    relayTemporary: values.temporary === true ? 'true' : null,
    machineName: values.machineName === null ? null : values.machineName,
  };
  let block = lines.slice(configIndex + 1, end);
  // Drop managed keys from the block (they are re-emitted below), keep everything else untouched.
  block = block.filter((line) => {
    const key = (line.match(/^\s*([A-Za-z][\w]*)\s*:/) ?? [])[1];
    return key === undefined || !(key in managed);
  });
  const emitted = [];
  if (managed.machineName !== null) emitted.push(`${indent}machineName: ${managed.machineName}`);
  emitted.push(`${indent}rabbitUrl: ${managed.rabbitUrl}`);
  emitted.push(`${indent}relayUrls:`);
  for (const relay of relays) emitted.push(`${indent}  - ${relay}`);
  emitted.push(`${indent}fleetKey: ${managed.fleetKey}`);
  emitted.push(`${indent}autoStartAgent: true`);
  if (values.temporary === true) emitted.push(`${indent}relayTemporary: true`);
  const next = [...lines.slice(0, configIndex + 1), ...emitted, ...block, ...lines.slice(end)];
  const text = `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '')}\n`;
  const backup = `${file}.bak-${Date.now()}`;
  writeFileSync(backup, lines.join('\n'), 'utf8');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { ok: true, file, backup };
}

/** Default patch path for a profile, resolved the same way the loader does. */
export function defaultPatchPath(profile) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'profiles', profile, 'cordis.patch.yml');
}

async function main() {
  let args;
  try {
    args = parseBootstrapCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`w2m-bootstrap: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help === true) {
    process.stdout.write('usage: w2m-bootstrap.mjs --bootstrap <json|url> --fleet-key <key> [--operator-key <pem>] [--profile desktop] [--name <machine>] [--temporary] [--dry-run]\n\n'
      + 'Writes relayUrls (first = primary), fleetKey and autoStartAgent: true into the profile patch.\n'
      + '--temporary marks the relay list as a fallback; the fleet panel then renders it as 临时 Relay 节点.\n');
    return;
  }
  const resolved = await resolveBootstrapSource(args);
  if (resolved.ok !== true) {
    process.stderr.write(`w2m-bootstrap: ${resolved.reason_code}: ${resolved.detail}\n`);
    process.exit(1);
  }
  const patch = defaultPatchPath(args.profile);
  if (args.dryRun === true) {
    process.stdout.write(`w2m-bootstrap: dry run — would write to ${patch}\n  relays: ${resolved.relays.join(', ')}\n  fleet: ${fleetIdOf(args.fleetKey)?.slice(0, 16)}…\n  temporary: ${args.temporary}\n`);
    return;
  }
  const written = writeBootstrapPatch(patch, {
    relays: resolved.relays,
    fleetKey: args.fleetKey.trim(),
    relayUrl: resolved.relays[0],
    temporary: args.temporary,
    machineName: args.name,
  });
  if (written.ok !== true) {
    process.stderr.write(`w2m-bootstrap: ${written.reason_code}: ${written.detail}\n`);
    process.exit(1);
  }
  process.stdout.write([
    `w2m-bootstrap: wrote ${patch}`,
    `  relays (primary first): ${resolved.relays.join(', ')}`,
    `  fleet: ${fleetIdOf(args.fleetKey)?.slice(0, 16)}…`,
    args.temporary === true ? '  relayTemporary: true — this machine uses a fallback relay list (临时 Relay 节点)' : '  relayTemporary: off',
    `  backup: ${written.backup}`,
    'Restart DSH (quick-reload does not re-read the profile), then check w2m_status:',
    '  rabbitUrl should name the first relay, and the fleet panel should list the relay pool.',
  ].join('\n') + '\n');
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`w2m-bootstrap: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
