/**
 * Fleet-domain tools: w2m_devices, w2m_status, w2m_update, w2m_stats.
 *
 * Each `register<Name>(ctx, deps)` factory is invoked by `apply()` in the same order the tools have
 * always been registered; the body is the same block that used to be inline in `apply()`, with the
 * apply-scope glue it closed over now arriving through `deps`.
 */

import { diagnoseFleetBinding } from '../fleet-binding.mjs';
import { resolveChannels } from '../update-channels.mjs';
import { fetchLatestRelease, fetchPrereleaseRelease, requireChecksum, downloadVerified, DEFAULT_REPO } from '../update-source.mjs';
import { installUpdate } from '../update-install.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SHARED_SERVER } from '../../agent/p2p-node.mjs';
import { AUTHORITY_CHOICES } from '../../agent/authority-choice.mjs';
import { findProfileDir, resolveCurrentVersion } from '../auto-update.mjs';
// v0.6.1: the session's chosen target machine, and the two browser routes the composer control
// reads it through. Imported rather than inlined because the control and `w2m_run` must agree on
// what "selected" means, and a second copy of that rule is a second chance to disagree.
import { defaultSelectionStore, isSelectableDevice, readFleet, TARGET_ROUTE_PATH } from '../fleet-target.mjs';
// v3.5.0: the fleet minimum-version gate and its dashboard data. One module owns the comparator and
// the decision, so the dispatch refusal, the `w2m_devices`/`/api/w2m/target` drift block and the
// tests can never disagree about what "below the minimum" means.
import { summarizeVersionDashboard } from '../version-gate.mjs';
import { fingerprintOf } from '../operator-token.mjs';
import { describeSharedConfig } from '../shared-config.mjs';

import { AGENT_STATE_FILES, devicePathFor, inProcessAgentStatus, PROTOCOL_VERSION, readDevice, relayFailoverStatus, request, requestFleetJoin, requireRabbit, resolvedFleetKey, resolveGitAnchors, resolveToken, round, throwIfAborted, W2MError } from './shared.mjs';

/** How long `w2m_status`'s reachability probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Fleet version summary for `w2m_devices`: one version map plus the machines that differ from
 * the running plugin. Pure so the drift rule is testable without a relay or a live fleet.
 */
export function summarizeFleetVersions(records, currentVersion = null) {
  const versions = {};
  const behind = [];
  for (const record of Array.isArray(records) ? records : []) {
    const version = record?.caps?.plugin_version;
    if (typeof version !== 'string' || version.trim() === '') continue;
    const key = version.trim();
    versions[key] = (versions[key] ?? 0) + 1;
    if (currentVersion !== null && key !== currentVersion) behind.push({ machine_id: record?.machine_id ?? null, name: record?.machine_name ?? record?.name ?? null, version: key });
  }
  return { current: currentVersion, versions, behind_count: behind.length, behind };
}

/**
 * Count the stored result frames.
 *
 * Depth is read from the directory rather than tracked in memory, so it answers the question that
 * actually matters  - "is there anything here I have not consumed"  - across a plugin reload. A
 * missing directory is depth 0, not an error: the inbox exists only once something has arrived.
 *
 * @param {string|null} dir
 * @returns {Promise<number>}
 */
async function countInbox(dir) {
  if (dir === null) return 0;
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * The `p2p` block `w2m_status` reports.
 *
 * Every field is present on every call, including when the direct path is off: a reader must be able
 * to tell "relay mode" from "p2p was requested and could not start" without comparing two calls.
 * `null` is used for "never measured", never 0  - the same rule the rest of this file follows for RTT.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} runtime
 * @param {number|null} peersAnnounced Live announcements the relay holds, read from the `/healthz`
 *   answer this tool already fetched. Passed in rather than probed here: a second probe of the same
 *   endpoint for one line of a diagnostic block would double the tool's traffic and could report a
 *   different number than the block above it.
 * @returns {Promise<object>}
 */
async function readP2PStatus(cfg, runtime, peersAnnounced = null) {
  const status = runtime.node === null ? null : runtime.node.status;
  const inboxDepth = runtime.inboxDir === null ? 0 : await countInbox(runtime.inboxDir);

  return {
    mode: status?.mode ?? cfg.p2pMode,
    // "Requested and possible": the mode is not `relay` and a node exists to be asked about.
    enabled: status !== null,
    running: status?.running === true,
    machine_id: runtime.machineId,
    device_json: runtime.devicePath,
    device_error: runtime.identityError,
    local: status?.local ?? null,
    rabbit_url: status?.rabbit_url ?? cfg.rabbitUrl,
      bootstrap: cfg.bootstrap ?? null,
      // v1.6.6: which relay is in use and why it last moved.
      failover: relayFailoverStatus,
    // How many machines the relay holds a live announcement for. `w2m_devices` says which machines
    // paired; this says which of them can be punched at, and the two differ constantly.
    peers_announced: peersAnnounced,
    mapping: status?.mapping ?? null,
    reflexive: status?.reflexive ?? null,
    candidates: Array.isArray(status?.candidates) ? status.candidates : [],
    candidate_count: Array.isArray(status?.candidates) ? status.candidates.length : 0,
    announced_at: status?.announced_at ?? null,
    announce_ok: status?.announce_ok ?? false,
    announce_failures: status?.announce_failures ?? 0,
    last_announce_error: status?.last_announce_error ?? null,
    punches_out: status?.punches_out ?? 0,
    punches_in: status?.punches_in ?? 0,
    dial_failures: status?.dial_failures ?? 0,
    transport: p2pTransportFacts(runtime.node),
    // v0.6.0: the crypto facts, named one by one rather than mirrored wholesale. `enabled` is about
    // *this* machine's key; `encrypted_channels` and `plaintext_channels` are about the channels it
    // has actually made, and they can both be non-zero on a mixed fleet. `error` is the reason there
    // is no key when there is none  - a reader has to be able to tell "this build has no crypto" from
    // "the key file is unreadable" without reading a log.
    encryption: {
      enabled: runtime.encryption?.enabled === true,
      public_key: runtime.encryption?.public_key ?? null,
      error: runtime.encryption?.error ?? null,
      peers_known: status?.encryption?.peers_known ?? 0,
      handshakes: status?.encryption?.handshakes ?? 0,
      encrypted_channels: status?.encryption?.encrypted_channels ?? 0,
      plaintext_channels: status?.encryption?.plaintext_channels ?? 0,
      refused: status?.encryption?.refused ?? 0,
      refusals: Array.isArray(status?.encryption?.refusals) ? status.encryption.refusals : [],
    },
    inbox: {
      dir: runtime.inboxDir,
      depth: inboxDepth,
      received: runtime.events.results,
      frames: runtime.events.frames,
      refused: runtime.events.refused.slice(-8),
      last_at: runtime.events.last_at ?? null,
      last_path: runtime.events.inbox_path,
      mode_honoured: runtime.events.mode_honoured,
    },
    last_error: runtime.error ?? runtime.events.last_error ?? status?.last_error ?? null,
    reason: runtime.reason,
    // Whether the node has been started in this process yet. `running` alone cannot say: a node that
    // has not been asked to start and a node that failed to start both report `false`.
    started: runtime.start !== null,
  };
}

/**
 * Type facts about the direct path: whether the UDP socket is actually held.
 *
 * Stated as a fact rather than inferred from `running`, because binding a socket and *keeping* one
 * are different claims: this reads the live socket object, so "no socket" cannot be reported as
 * "fine, no UDP port was taken" by accident.
 *
 * @param {P2PNode|null} node
 * @returns {object}
 */
function p2pTransportFacts(node) {
  const socket = node?.socket ?? null;
  if (socket === null) return { socket_bound: false, family: null, address: null };
  let bound = null;
  try {
    bound = socket.address();
  } catch {
    bound = null;
  }
  return {
    socket_bound: true,
    family: bound?.family ?? null,
    address: bound === null ? null : { address: bound.address, port: bound.port },
  };
}

/**
 * Normalise whatever the agent published into `{last, avg, samples}`.
 *
 * Tolerant on purpose: this is a cross-process, cross-version boundary, and a reader that demanded
 * one exact spelling would report "no RTT" for a perfectly healthy agent. Field aliases cover the
 * obvious spellings; an array is read as the rolling samples; a bare number is read as the last.
 *
 * @param {unknown} rtt
 * @returns {{last: number|null, avg: number|null, samples: number[]}|null}
 */
function normaliseRtt(rtt) {
  if (rtt === null || rtt === undefined) return null;

  if (typeof rtt === 'number' && Number.isFinite(rtt)) {
    return { last: rtt, avg: rtt, samples: [rtt] };
  }

  if (Array.isArray(rtt)) {
    const samples = rtt.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (samples.length === 0) return null;
    return { last: samples[samples.length - 1], avg: round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
  }

  if (typeof rtt !== 'object') return null;

  const pick = (...keys) => {
    for (const key of keys) {
      const value = rtt[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const rawSamples = Array.isArray(rtt.samples)
    ? rtt.samples.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : [];

  const last = pick('last', 'lastMs', 'last_ms', 'current');
  const avg = pick('avg', 'average', 'mean');
  if (last === null && avg === null && rawSamples.length === 0) return null;

  const samples = rawSamples.length > 0 ? rawSamples : [last ?? avg];
  return { last: last ?? samples[samples.length - 1], avg: avg ?? round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
}

/**
 * Read the local agent's round-trip time, or explain why it is unavailable (§8.2).
 *
 * §8.2 puts `rttMs` on the agent's in-memory state. When the plugin started the agent inside this
 * process, that state is reachable directly. When the agent is its own proces - the normal
 * deploymen - it is not, so this also looks for a state file under `stateDir`. Neither source
 * being present is reported as `available: false` with a reason, never as an error: cross-region
 * diagnosis fails loudly, but this tool must still answer when the agent has not been started.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {Promise<{available: boolean, source: string|null, last: number|null, avg: number|null,
 *                    samples: number[], ms: number|null, reason: string|null, path: string|null}>}
 */
async function readRtt(cfg) {
  const empty = {
    available: false,
    source: null,
    last: null,
    avg: null,
    samples: [],
    ms: null,
    reason: null,
    path: null,
  };

  if (inProcessAgentStatus) {
    try {
      const status = inProcessAgentStatus();
      const rtt = normaliseRtt(status?.rttMs ?? status?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'in-process-agent' };
      return { ...empty, source: 'in-process-agent', reason: 'the in-process agent has not recorded a round trip yet' };
    } catch (error) {
      return {
        ...empty,
        source: 'in-process-agent',
        reason: `the in-process agent status getter threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!cfg.stateDir) {
    return { ...empty, reason: 'stateDir is not set, so no agent state could be located' };
  }

  for (const name of AGENT_STATE_FILES) {
    const file = path.join(cfg.stateDir, name);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const rtt = normaliseRtt(parsed?.rttMs ?? parsed?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'state-file', path: file };
    } catch {
      continue;
    }
  }

  return {
    ...empty,
    reason:
      'no agent round-trip time is available: the agent is not running in this process and no ' +
      `agent state file was found under ${cfg.stateDir}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------------------------

/**
 * Build the short cross-region hints `w2m_status` returns alongside its data.
 *
 * These are the three questions §4 says an operator asks firs - is the relay there, has it
 * restarted, do I have the credential it want - answered in one place so a model does not have to
 * compare fields itself. v0.4.0 adds the fourth: **which** relay this machine is talking to, and
 * which path it expects a task to take.
 *
 * @param {object} relay The relay block built by `w2m_status`.
 * @param {object} rtt The block from {@link readRtt}.
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} p2p The block from {@link readP2PStatus}.
 * @returns {string[]}
 */
function statusNotes(relay, rtt, cfg, p2p, approvalsNote = null) {
  const notes = [];

  /**
   * v0.26.0: blocked work announces itself.
   *
   * The whole reason the count is in `w2m_status` at all. A note is what a caller reads without asking a
   * further question, and "three dispatches are waiting for an approver" is the single most actionable
   * sentence this tool can emit: the fleet is not idle, it is stopped, and it is stopped on a person.
   *
   * It is placed first because ordering is the only emphasis a list of notes has.
   */
  if (approvalsNote !== null && Number.isFinite(approvalsNote.pending) && approvalsNote.pending > 0) {
    notes.push(
      `${approvalsNote.pending} dispatch(es) are WAITING FOR AN APPROVER and will not run until one answers; ` +
        `read them with \`w2m_approvals\`${approvalsNote.overdue > 0 ? ` (${approvalsNote.overdue} past their deadline)` : ''}` +
        `${Number.isFinite(approvalsNote.oldest_waiting_ms) ? `; the oldest has been waiting ${Math.round(approvalsNote.oldest_waiting_ms / 1000)}s` : ''}`,
    );
  }

  /**
   * §7's one-line note, and the reason it exists at all: the shared server is a *default*, and a
   * default that an operator cannot see is a machine quietly talking to somebody else's host. The
   * note names the address in use, where it came from and the exact way to override it.
   */
  if (cfg.rabbitSource === 'shared-default') {
    notes.push(
      `\`rabbitUrl\` is not set, so this machine is using the shared W2M server at ${SHARED_SERVER.rabbitUrl} ` +
        '(rabbit_source: "shared-default"); set `rabbitUrl` in this plugin\'s profile patch, or `W2M_RABBIT_URL` ' +
        'in the environment, to point at your own relay',
    );
  } else if (cfg.rabbitSource === 'env') {
    notes.push(`\`rabbitUrl\` came from the environment (\`W2M_RABBIT_URL\`), not from the profile patch, so a profile setting would be ignored`);
  } else if (cfg.rabbitUrlOverride !== null && cfg.rabbitSource === 'config') {
    notes.push(
      '`rabbitUrl` is set in the profile patch, so it wins over `device.json`\'s own `rabbit_url` ' +
        '(the v0.3.9 fallback, which is no longer consulted)',
    );
  }

  if (p2p.mode === 'relay') {
    notes.push('p2pMode is "relay": no UDP socket is bound on this machine and every task travels through the relay, exactly as in v0.3.9');
  } else if (p2p.running) {
    notes.push(
      `p2pMode is "${p2p.mode}" and the direct path is up on ${p2p.local ? `${p2p.local.address}:${p2p.local.port}` : '(unknown local address)'}` +
        `; ${p2p.reflexive ? `reflexive ${p2p.reflexive.address}:${p2p.reflexive.port}, NAT mapping ${p2p.mapping ?? 'unknown'}` : 'no reflexive address was measured (a LAN punch still works; a punch across the internet will fall back to the relay)'}` +
        '. A punch between two machines on this same host proves the code path, not NAT traversal.',
    );
  } else if (p2p.enabled) {
    notes.push(
      `p2pMode is "${p2p.mode}" but the direct path is not running (${p2p.last_error ?? p2p.reason ?? 'no reason recorded'}), ` +
        'so every task is dispatched over the relay; the relay\'s offer path is unaffected',
    );
  }

  if (p2p.enabled && p2p.inbox.depth > 0) {
    notes.push(
      `${p2p.inbox.depth} result(s) received over a direct channel are waiting in ${p2p.inbox.dir}; ` +
        'the relay\'s copy of each result is the ledger, these are the fast-path copies',
    );
  }

  if (relay.reachable === true && relay.relay_id) {
    notes.push(
      `relay_id \`${relay.relay_id}\` has been up ${Math.round((relay.uptime_ms ?? 0) / 1000)} - ` +
        'record this id: a different one on a later call means the relay restarted and every machine reconnected to a new process',
    );
  } else if (relay.reachable === true && relay.relay_id === null) {
    notes.push('the relay answered /healthz but sent no relay_id, so it predates v0.1.2 and a restart cannot be detected from here');
  }

  if (relay.reachable === true && relay.base_path !== null && cfg.rabbitUrl) {
    notes.push(`the relay reports base_path \`${relay.base_path}\`; \`rabbitUrl\` in use is \`${cfg.rabbitUrl}\``);
  }

  if (relay.operator_token_required === true && cfg.operatorToken === null) {
    notes.push(
      'this relay requires an operator token for POST /v1/task and none is configured, so w2m_run will refuse before sending anythin - set `operatorToken` or `W2M_OPERATOR_TOKEN`',
    );
  } else if (relay.operator_token_required === false) {
    notes.push('this relay does not require an operator token (an explicit escape hatch, not the default), so an unauthenticated dispatch can succeed');
  }

  if (rtt.available) {
    notes.push(`round trip to the relay: last ${rtt.last} ms, average ${rtt.avg} ms over ${rtt.samples.length} sample(s) (source: ${rtt.source})`);
  } else if (rtt.reason) {
    notes.push(`round-trip time unavailable - ${rtt.reason}`);
  }

  return notes;
}

export function registerDevices(ctx, deps) {
  const { cfg, defineTool, discovery, jsonOutput, localIdentity, pluginVersion: PLUGIN_VERSION } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_devices',
    description:
      'List the machines the Rabbit currently holds leases for: machine_id, name, platform, ' +
      'capabilities, and when each was last seen. Read-only. Answers "who is online" without ' +
      'running anything; a machine that is listed may still refuse the next command for a reason ' +
      'the capability gate will report. With include_discovered it also reports what mDNS sees on ' +
      'the LAN in `discovery.candidates` - unverified hints, each marked with whether the relay ' +
      'lists it, and never a dispatch target on their own.',
    parameters: {
      include_stale: {
        type: 'boolean',
        description: 'Include machines whose lease looks expired rather than only the live ones. Defaults to false.',
      },
      include_discovered: {
        type: 'boolean',
        default: false,
        description:
          'Also scan the LAN over mDNS for about 1.5 s and report discovered candidates under ' +
          '`discovery`. Each candidate is marked unverified and carries `known_to_relay`; only a ' +
          'candidate the relay also lists (by machine_id) may be dispatched to. Defaults to false.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      /**
       * v0.8.12: a tool call is proof the account profile exists.
       *
       * The session cannot answer a model request without it, so by the time any tool runs, the lazy
       * cache the fleet key is derived from is warm. Asking here is what turns "joined at mount, when
       * the profile was still cold" into "joined as soon as joining was possible". Memoised, so it
       * cannot become a second pairing on a relay that allows five a minute.
       */
      await requestFleetJoin();
      const base = requireRabbit(cfg);
      const token = await resolveToken(cfg);

      // The read itself, the liveness rule, and "this machine has no identity yet" all come from
      // the same helper the composer control uses, so the list a model reads and the list an
      // operator clicks can never disagree about who is online.
      const identity = await localIdentity();
      const fleet = await readFleet({
        rabbitUrl: base,
        token,
        localMachineId: identity.machine_id,
        signal: exec?.signal,
        request,
      });
      if (!fleet.ok) {
        // The typed error is rebuilt here, from the helper's report, so the code, message and hint a
        // caller sees are the same three it saw before this read moved into `fleet-target.mjs`: the
        // remediation travels in `hint`, never in the message.
        const unauthorized = fleet.status === 401;
        throw new W2MError(
          unauthorized ? 'W2M_RABBIT_REFUSED' : 'W2M_UNREACHABLE',
          fleet.status === 0
            ? `${fleet.error}`
            : `${fleet.error}; ${unauthorized ? 'this machine is not paired, or its device_token is stale - pair the agent again' : 'check the Rabbit log for the reason it gave'}`,
          {
            hint: fleet.hint ?? (unauthorized
              ? 'this machine is not paired, or its device_token is stale; pair the agent again'
              : 'check the Rabbit log for the reason it gave'),
          },
        );
      }

      // `GET /v1/devices` answers `{protocol_version, rabbit_time, devices:[...]}`. Each entry is a
      // device recor - the Rabbit's own lease bookkeeping is on the task, not her - so a device
      // is described by identity and capabilities, and the relay's own `state` is the honest
      // default for a device it still lists.
      const includeStale = args?.include_stale === true;
      // v3.3.16: the target control already treats `online` as authoritative; this tool read only
      // `state`, so a device with online:false and no state was reported "online" here while the
      // composer listed it as offline (the two-count defect). One predicate now feeds both.
      const listed = fleet.records.filter((machine) => includeStale || isSelectableDevice(machine));

      // The LAN hint layer. `include_discovered` runs one bounded scan; without it the block reports
      // the *last* scan's candidates against this call's roster, so a model that already paid for a
      // scan does not have to pay for it twice. Either way the candidates are described by
      // `mdns-discover.mjs`, which is where "discovered but not relay-listed is not a target" lives.
      const discoveryRequested = args?.include_discovered === true;
      const discoveryBlock = discoveryRequested
        ? await discovery.scan({
            signal: exec?.signal,
            relayRecords: fleet.records,
            localMachineId: identity.machine_id,
          })
        : discovery.describe({ relayRecords: fleet.records, localMachineId: identity.machine_id });
      // A cancel during the scan window is a cancel, not a partial answer: the signal is our caller's
      // withdrawal, and the same typed abort every other wait in this file produces is owed to them.
      if (discoveryRequested) throwIfAborted(exec?.signal);

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: fleet.rabbit_time,
          count: listed.length,
          devices: listed.map((machine) => ({
            machine_id: machine?.machine_id ?? null,
            name: machine?.machine_name ?? machine?.name ?? null,
            os: machine?.platform?.os ?? machine?.os ?? null,
            os_version: machine?.platform?.os_version ?? machine?.os_version ?? null,
            arch: machine?.platform?.arch ?? machine?.arch ?? null,
            shell: machine?.platform?.shell ?? machine?.shell ?? null,
            caps: machine?.caps ?? null,
            last_seen: machine?.last_seen ?? machine?.last_seen_at ?? null,
            online: isSelectableDevice(machine),
            state: isSelectableDevice(machine) ? 'online' : (String(machine?.state ?? '') || 'offline'),
          })),
          excluded_stale: includeStale ? 0 : fleet.records.length - listed.length,
          version_drift: summarizeFleetVersions(fleet.records, resolveCurrentVersion(PLUGIN_VERSION, process.env)),
          /**
           * v3.5.0: the drift dashboard's data, additive beside `version_drift`.
           *
           * `distribution` counts every machine the relay lists by the version it advertises;
           * `outdated`/`unknown` are the machines behind the fleet minimum or unable to say their
           * version. `all_current` is the one boolean a panel header wants. Computed from the same
           * roster read this tool already made, so the dashboard cannot show a different fleet than
           * the list above it.
           */
          versions: summarizeVersionDashboard(fleet.records),
          discovery: discoveryBlock,
          note:
            'a listed device has paired and is being tracked; it can still refuse the next command ' +
            'at the capability gate, which w2m_wait reports per machine as `refused`',
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m devices', kind: 'read', rawInput: {} }),
  }));
}

  // -------------------------------------------------------------------------------------------
  // 5. w2m_statu - read-only, and the only tool that works without rabbitUrl
  // -------------------------------------------------------------------------------------------
export function registerStatus(ctx, deps) {
  const { currentApprovals, cfg, config, defineTool, jsonOutput, p2p, targetRoutes } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_status',
    description:
      'Report this plugin\'s view of itself: the machine identity on disk, which relay it is ' +
      'talking to and where that address came from (rabbit_source; "shared-default" means nobody ' +
      'configured one), whether the Rabbit answers, the paired token presence, the relay\'s ' +
      'cross-region diagnostics (relay_id, uptime, deployment base_path, effective_scheme, whether ' +
      'it demands an operator token), the direct P2P path (mode, whether a UDP socket is bound, ' +
      'the measured reflexive address and NAT mapping, punches in and out, and how many results ' +
      'are waiting in the local inbox), this machine\'s round-trip time to the relay, and the ' +
      'project\'s base_commit/base_tree. Read-only, degrades field by field, and deliberately ' +
      'usable while the configuration is still broken, because it is the tool you reach for when ' +
      'w2m_devices says rabbitUrl is unset.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      throwIfAborted(exec?.signal);
      // v0.8.12: the tool an operator reaches for when the machine is in no fleet is the right place
      // to try joining again -- see `requestFleetJoin`. Memoised, and a no-op once paired.
      await requestFleetJoin();
      // Read, not required: this tool exists to describe a half-configured machine, so an absent or
      // unpaired device.json is part of the answer rather than a reason to refuse. `/healthz` needs
      // no bearer token, so nothing here depends on the token being present.
      /**
       * v2.2.0: use the same identity path every other tool uses.
       *
       * `readDevice(cfg)` returns an empty identity when `stateDir` is unset, while dispatch and
       * history fall back to `DSH_HOME/xclient/device.json`. `w2m_status` was the only reader that
       * skipped that fallback, so a working machine reported `paired: false` / `FLEET_UNPAIRED`
       * and sent the reader to fix a pairing that was already fine.
       */
      const statusDeviceFile = devicePathFor(cfg);
      const device = statusDeviceFile === null
        ? await readDevice(cfg)
        : await readDevice({ stateDir: path.dirname(statusDeviceFile) });

      // A cheap reachability probe of a documented endpoint. Without a configured URL there is
      // nothing to probe, and that is reported rather than guessed at.
      let relay = {
        configured_url: cfg.rabbitUrl,
        probed_url: null,
        reachable: null,
        http_status: null,
        protocol_version: null,
        error: null,
        // §4 cross-region diagnostics. Null until `/healthz` answers, and individually null when a
        // relay predates v0.1.2: a missing field is reported as missing, never invented.
        relay_id: null,
        uptime_ms: null,
        started_at: null,
        base_path: null,
        effective_scheme: null,
        operator_token_required: null,
        pair_rate_limit: null,
        persistence: null,
      };
      const probeBase = cfg.rabbitUrl ?? device.rabbit_url ?? null;
      if (probeBase) {
        const target = `${probeBase.replace(/\/+$/, '')}`;
        try {
          const probe = await request({
            rabbitUrl: target,
            signal: exec?.signal,
            pathname: '/healthz',
            timeoutMs: PROBE_TIMEOUT_MS,
            maxBytes: 64 * 1024,
          });
          const health = probe.json ?? {};
          relay = {
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: probe.ok,
            http_status: probe.status,
            protocol_version: health.protocol_version ?? null,
            error: probe.ok ? null : (probe.error?.code ?? `HTTP ${probe.status}`),
            relay_id: health.relay_id ?? null,
            relay_version: health.relay_version ?? health.version ?? null,
            features: Array.isArray(health.features) ? health.features : null,
            uptime_ms: typeof health.uptime_ms === 'number' ? health.uptime_ms : null,
            started_at: health.started_at ?? null,
            base_path: health.base_path ?? null,
            effective_scheme: health.effective_scheme ?? null,
            operator_token_required:
              typeof health.operator_token_required === 'boolean' ? health.operator_token_required : null,
            pair_rate_limit: typeof health.pair_rate_limit === 'number' ? health.pair_rate_limit : null,
            persistence: health.persistence ?? null,
            // Which of the §4 fields this relay actually sent. A v1 relay sends none of them, and a
            // reader should be able to tell "field absent" from "field false".
            diagnostics_present: ['relay_id', 'uptime_ms', 'base_path', 'effective_scheme', 'operator_token_required', 'relay_version', 'features']
              .filter((key) => health[key] !== undefined && health[key] !== null),
          };
        } catch (error) {
          relay = {
            ...relay,
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: false,
            http_status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir });
      const rtt = await readRtt(cfg);
      // §7: this tool is one of the two places the direct path is asked about, so it is one of the
      // two places the node is started. Never throws, and reports `enabled: false`/`running: false`
      // rather than omitting itself  - a reader has to be able to tell "relay mode" from "p2p was
      // requested and did not start".
      await p2p.ensureStarted();
      const p2pStatus = await readP2PStatus(cfg, p2p, Number.isInteger(relay.peers_announced) ? relay.peers_announced : null);

      /**
      * v0.26.0: how much work is waiting for an approver.
      *
      * ## Why it belongs in `w2m_status` rather than only in `w2m_approvals`
      *
      * A queue that is only visible to someone who remembers to look at it is a queue that stays full,
      * and a fleet that is blocked on approval looks exactly like a fleet that is idle. This makes the
      * blocked state **report itself**, which is the difference between a tool an operator has and a
      * signal an operator receives.
      *
      * `constructed` distinguishes "nothing is waiting" from "nothing has ever asked". They are the same
      * number and very different facts, and a machine that never tripped the permission gate should not
      * be described as having an empty queue as though that were a measurement.
      */
      const approvalsBlock = (() => {
      if (currentApprovals() === null) {
      return {
      constructed: false,
      pending: null,
      detail: 'no approval has ever been requested on this machine, so no queue exists yet; this is not the same as an empty queue',
      };
      }
      const pendingRows = currentApprovals().all();
      const overdue = pendingRows.filter((r) => r.overdue === true).length;
      return {
      constructed: true,
      pending: pendingRows.length,
      overdue,
      // The oldest request is the one whose loss costs most, so it is reported rather than left for a
      // reader to sort out of the rows.
      oldest_waiting_ms: pendingRows.length === 0
      ? null
      : Math.max(...pendingRows.map((r) => r.waiting_ms ?? 0)),
      detail: pendingRows.length === 0
      ? 'the queue exists and nothing is waiting'
      : `${pendingRows.length} dispatch(es) waiting for an approver${overdue > 0 ? `, ${overdue} overdue` : ''}`,
      };
      })();

      /**
       * Compare against the key the stack actually resolved, not just `cfg.fleetKey`.
       * A machine joined by account has no configured key, and that is exactly the case
       * where a switched account used to look "bound" because only `fleet_id=null` was
       * treated as wrong.
       */
      let expectedFleetId = null;
      const statusFleetKey = resolvedFleetKey.value ?? cfg.fleetKey;
      try {
        const { planJoin } = await import('../chatops/fleet-join.mjs');
        const plan = planJoin({ fleetKeyEncoded: statusFleetKey });
        if (plan.ok === true) expectedFleetId = plan.fleetId;
      } catch { /* malformed key: report without an expectation */ }
      const fleetBinding = await diagnoseFleetBinding({
        relayUrl: cfg.rabbitUrl,
        token: device.device_token,
        machineId: device.machine_id,
        fleetKey: statusFleetKey,
        expectedFleetId,
      });

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          identity: {
            machine_id: device.machine_id,
            machine_name: cfg.machineName,
            device_json: device.path,
            device_json_present: device.present,
            paired: device.device_token !== null,
            device_error: device.error,
          },
          relay: { ...relay, healthz: '/healthz' },
          /**
           * §7: which relay this machine is actually talking to, and where that address came from.
           *
           * `rabbit_source` is the field an operator needs when two machines disagree about the
           * fleet, and `'shared-default'` is the one value that means "nobody chose this endpoint".
           * It is repeated at the top level rather than only under `config` because it is the answer
           * to a question asked about the *relay*, not about this plugin's settings.
           */
          rabbit_source: cfg.rabbitSource,
          rabbit_url: cfg.rabbitUrl,
          p2p: p2pStatus,
          fleet: {
            ...fleetBinding,
            key_source: resolvedFleetKey.source
              ?? (cfg.fleetKey !== null && cfg.fleetKeyPolicy === 'config' ? 'config' : null),
            home_file: resolvedFleetKey.homeFile ?? null,
          },
          rtt,
          config: {
            rabbitUrl: cfg.rabbitUrl,
            rabbit_source: cfg.rabbitSource,
            rabbit_url_override_ignored: cfg.rabbitUrlOverride,
            stateDir: cfg.stateDir,
            projectDir: cfg.projectDir,
            autoStartAgent: cfg.autoStartAgent,
            allowedCommands: cfg.allowedCommands,
            pairingCode_configured: cfg.pairingCode !== null,
            fleetKey_configured: cfg.fleetKey !== null,
            fleetKey_policy: cfg.fleetKeyPolicy,
            fleet_home_file: resolvedFleetKey.homeFile ?? null,
            fleet_config_file: cfg.fleetConfigFile ?? null,
            p2pMode: cfg.p2pMode,
            // The resolved list, shared server first, exactly as the node will query it.
            stunServers: cfg.stunServers,
            // §5: `validated` reports presence only. The plugin cannot tell a correct token from a
            // wrong one without spending a dispatch, and `required_by_relay` is what makes the two
            // halves of the mismatch (client has none / relay demands one) visible side by side.
            operatorToken_configured: cfg.operatorToken !== null,
    operatorToken_fingerprint: cfg.operatorToken === null ? null : fingerprintOf(cfg.operatorToken),
            operatorToken_source: cfg.operatorToken !== null
              ? (typeof config?.operatorToken === 'string' && config.operatorToken.trim() !== ''
                ? 'config'
                : 'environment')
              : null,
            operatorToken_required_by_relay: relay.operator_token_required ?? null,
          },
          /**
           * v0.3.3 shared config, with the source of every value.
           *
           * The sources are the point, not decoration: "the setting is there but something overrides
           * it" is the characteristic failure of layered configuration, and it must be answerable from
           * one call rather than by editing files and observing what changes.
           */
          shared_config: {
            files: cfg.sharedConfig.files,
            values: cfg.sharedConfig.values,
            sources: cfg.sharedConfig.sources,
            // Pre-rendered too, because the human reading this in a terminal is usually the one who
            // has to decide which file to edit.
            summary: describeSharedConfig(cfg.sharedConfig),
          },
          project: {
            base_commit: anchors.base_commit,
            base_tree: anchors.base_tree,
            head_commit: anchors.head_commit,
            branch: anchors.branch,
            dirty: anchors.dirty,
            fingerprint_algo: 'git-temp-index-tree/v1',
            error: anchors.error,
          },
          /**
           * v0.6.1: the composer's target control and the selections it holds.
           *
           * Reported here because "the control is not in my composer" has exactly two causes  - the
           * host has no fetch-route registry, or the browser half is not loaded  - and this is the
           * one call that can tell them apart from the host side. The selections themselves are
           * counts, not contents: which session picked which machine is the operator's business and
           * nothing the model needs.
           */
          target_selection: {
            route: TARGET_ROUTE_PATH,
            attached: targetRoutes.mounted,
            detail: targetRoutes.mounted
              ? 'the composer control reads and writes its selection through this route'
              : targetRoutes.reason,
            sessions_with_a_target: defaultSelectionStore.list().length,
          },
          /**
           * v0.33.0: how the authority level was resolved, and why it failed when it did.
           *
           * A misconfigured level used to degrade to `null` in silence, which reads exactly like a machine
           * that never chose one -- and those need opposite responses. This reports the difference, and
           * carries the four choices so a reader can fix it without being told what they are elsewhere.
           */
          actor_authority: {
            ...cfg.actorAuthorityChoice,
            ...(cfg.actorAuthorityChoice.ok ? {} : { choices: AUTHORITY_CHOICES.map((c) => ({ value: c.value, may: c.may, range: c.range })) }),
          },
          approvals: approvalsBlock,
          notes: statusNotes(relay, rtt, cfg, p2pStatus, approvalsBlock),
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m status', kind: 'read', rawInput: {} }),
  }));
}

  // ---------------------------------------------------------------------------------------------
  // 6. w2m_update -- read-only unless asked to act
  // ---------------------------------------------------------------------------------------------
export function registerUpdate(ctx, deps) {
  const { defineTool, jsonOutput, updater } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_update',
    description:
      'Inspect and drive this plugin\'s own updater. It checks the project\'s GitHub releases at ' +
      '00:00, 03:00 and 05:00 Beijing time by default and installs a newer release only after ' +
      'verifying the hash published with it. Action "status" reports the schedule, the installed ' +
      'version, the last check and whether a restart is still pending; "check" runs one ' +
      'check-and-install cycle now and does not throw -- a network failure comes back as a recorded ' +
      'error, which is exactly how it differs from "already up to date". A new version is installed ' +
      'for the *next* start: this tool never restarts the Harness and never hot-swaps running code.',
    parameters: {
      action: {
        type: 'string',
        description:
          'status (default) reports the updater; check runs one check-and-install cycle now and ' +
          'records the outcome. One of: status, check.',
      },
    },
    output: jsonOutput,
    execute: async (args) => {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'status';
      // A STRING, like every other tool here. Measured: the first version returned the plain object
      // and the host rejected the call outright -- `tool "w2m_update" returned invalid output:
      // "value" must be a string` -- so this tool could never be used at all, in v0.4.0 or v0.4.1.
      // `jsonOutput` is a renderer, not a serialiser; the tool still owns turning its value into
      // text.
      if (action === 'status') {
        const described = { ok: true, action, update: updater.describe() };
        // Opt-in on purpose: the plain status call is local and offline, and making it reach GitHub would slow every
        // w2m_status and fail behind a proxy. The three channels need two API calls, so they are asked for explicitly.
        if (args?.channels !== true) return JSON.stringify(described, null, 2);
        const repo = (typeof process.env.W2M_UPDATE_REPO === 'string' && process.env.W2M_UPDATE_REPO.trim() !== '')
          ? process.env.W2M_UPDATE_REPO.trim() : DEFAULT_REPO;
        const [stableRelease, betaRelease] = await Promise.all([fetchLatestRelease({ repo }), fetchPrereleaseRelease({ repo })]);
        const currentVersion = resolveCurrentVersion(null, process.env);
        return JSON.stringify({ ...described, ...resolveChannels({ stable: stableRelease?.ok === true ? stableRelease : null, beta: betaRelease?.ok === true ? betaRelease : null, currentVersion }), sources: { stable: stableRelease, beta: betaRelease } }, null, 2);
      }

      /**
       * v1.1.18: install a specific channel. The beta channel exists only as a GitHub prerelease, so it is verified here
       * rather than trusted: the tarball sha256 must match the SHA256SUMS shipped with the same release, and
       * downloadVerified removes its temp file on a mismatch, leaving the installed profile untouched.
       */
      if (action === 'apply') {
        const channel = typeof args?.channel === 'string' ? args.channel : 'stable';
        if (channel !== 'stable' && channel !== 'beta' && channel !== 'latest') {
          throw new W2MError('W2M_CHANNEL', 'W2M_CHANNEL: channel must be stable, beta or latest', { hint: 'call status with channels=true to see what each channel offers' });
        }
        const repo = (typeof process.env.W2M_UPDATE_REPO === 'string' && process.env.W2M_UPDATE_REPO.trim() !== '')
          ? process.env.W2M_UPDATE_REPO.trim() : DEFAULT_REPO;
        const [stableRelease, betaRelease] = await Promise.all([fetchLatestRelease({ repo }), fetchPrereleaseRelease({ repo })]);
        const currentVersion = resolveCurrentVersion(null, process.env);
        const resolved = resolveChannels({ stable: stableRelease?.ok === true ? stableRelease : null, beta: betaRelease?.ok === true ? betaRelease : null, currentVersion });
        const wanted = channel === 'latest' ? resolved.latest.channel : channel;
        const release = wanted === 'beta' ? betaRelease : stableRelease;
        if (release?.ok !== true) {
          throw new W2MError('W2M_NO_CHANNEL', 'W2M_NO_CHANNEL: nothing is available on the ' + channel + ' channel', { hint: release?.code ? release.code + ': ' + release.error : undefined });
        }
        const sumsAsset = release.assets?.sums;
        const tarballAsset = release.assets?.tarball;
        if (!sumsAsset || !tarballAsset) throw new W2MError('W2M_NO_ASSETS', 'W2M_NO_ASSETS: the release carries no tarball and SHA256SUMS');
        const sumsResponse = await fetch(sumsAsset.url, { headers: sumsAsset.headers ?? {} });
        if (sumsResponse?.ok !== true) throw new W2MError('W2M_SUMS', 'W2M_SUMS: could not download SHA256SUMS (HTTP ' + sumsResponse?.status + ')');
        const sha256 = requireChecksum(await sumsResponse.text(), tarballAsset.name);
        const profileDir = args?.profile_dir ?? findProfileDir({});
        const staged = await downloadVerified({ url: tarballAsset.url, sha256, destPath: (args?.staging_dir ?? profileDir) + '/.w2m-update/' + tarballAsset.name });
        if (staged?.ok !== true) {
          throw new W2MError('W2M_CHECKSUM', 'W2M_CHECKSUM: refusing to install; ' + (staged?.code ?? 'download-failed') + ' ' + (staged?.error ?? ''), { hint: 'a checksum mismatch is not retried: the asset and its SHA256SUMS disagree' });
        }
        const installed = await installUpdate({ tarballPath: staged.path, profileDir, expectedSha256: sha256, dryRun: args?.dry_run === true });
        return JSON.stringify({ ok: installed?.ok === true, action, channel, version: resolved.channels[wanted]?.available ?? null, sha256, install: installed }, null, 2);
      }
      const result = await updater.check('manual');
      // `ok:false` inside `result` means "the check could not complete", never "the tool failed".
      return JSON.stringify({ ok: true, action, result, update: updater.describe() }, null, 2);
    },
    // `kind: 'other'` for the actions that can install, never `'read'`. This tool mutates the profile
    // it runs in, and labelling that a read is a false claim in exactly the place a user looks to
    // decide whether a call is safe. `'other'` is the value the built-in plugin-manager tool in this
    // same runtime uses for its mutating actions (`dsh-plugin-manager/lib/types/tools.js`), so it is
    // the one vocabulary item here with a reference implementation behind it rather than a guess.
    presentCall: (args) => ({
      card: 'generic',
      title: 'w2m update',
      kind: args?.action === 'check' ? 'other' : 'read',
      rawInput: args ?? {},
    }),
  }));
}

  // -------------------------------------------------------------------------------------------
  // 8. w2m_stats -- the fleet at a glance, without reading any task
  // -------------------------------------------------------------------------------------------
export function registerStats(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_stats',
    description:
      'Summarise the fleet in one read-only call: how many machines the relay holds, how many are ' +
      'online, the round-trip time it has measured for each (null means never measured, which is ' +
      'not the same as 0ms), task and result counts, and whether the relay restarted since your ' +
      'last look. Cheaper than w2m_devices plus w2m_history when you only need the shape of things.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);

      // Two reads rather than one: `/healthz` is the only place the relay reports the aggregate RTT
      // view, and `/v1/devices` is the only place it reports per-machine state. Neither requires a
      // device token, so a machine that is not paired can still report on the fleet.
      const health = await request({ rabbitUrl: base, signal: exec?.signal, pathname: '/healthz' });
      if (!health.ok) {
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused GET /healthz with HTTP ${health.status}; ` +
            'the relay is the only source of fleet state, so there is nothing to summarise',
          { hint: 'check the relay is running and rabbitUrl points at it' },
        );
      }

      let devices = null;
      try {
        const token = await resolveToken(cfg);
        const res = await request({ rabbitUrl: base, token, signal: exec?.signal, pathname: '/v1/devices' });
        devices = res.ok ? res.json : null;
      } catch {
        // A machine that is not paired can still report the fleet from /healthz. Dropping the
        // per-machine half is better than failing a summary.
        devices = null;
      }

      const h = health.json ?? {};
      const rtt = h.rtt ?? null;
      const list = Array.isArray(devices?.devices) ? devices.devices : [];
      const online = list.filter((d) => d?.online === true).length;

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: h.rabbit_time ?? null,
          relay: {
            relay_id: h.relay_id ?? null,
            uptime_ms: h.uptime_ms ?? null,
            started_at: h.started_at ?? null,
            effective_scheme: h.effective_scheme ?? null,
            base_path: h.base_path ?? null,
            operator_token_required: h.operator_token_required ?? null,
          },
          counts: {
            devices: h.devices ?? list.length,
            online: devices === null ? null : online,
            tasks: h.tasks ?? null,
            results: h.results ?? null,
            pairing_codes: h.pairing_codes ?? null,
          },
          // `null` throughout means "the relay did not report it", never "zero". Collapsing those
          // two is how a broken relay reads as an idle one.
          rtt: rtt === null
            ? null
            : {
                machines_reporting: rtt.machines_reporting ?? null,
                min_ms: rtt.min_ms ?? null,
                max_ms: rtt.max_ms ?? null,
                avg_ms: rtt.avg_ms ?? null,
                machines_stale: rtt.machines_stale ?? null,
                machines_unknown: rtt.machines_unknown ?? null,
              },
          machines: devices === null
            ? null
            : list.map((d) => ({
                machine_id: d?.machine_id ?? null,
                machine_name: d?.machine_name ?? null,
                online: d?.online === true,
                /**
                 * v0.9.1: why a machine is not usable, when it is not.
                 *
                 * Passed through rather than summarised, because "offline" alone was the shape that
                 * hid the reported defect: a machine powered off for hours was listed `online` and
                 * selectable, and there was no field anywhere that would have said otherwise. A
                 * relay older than v0.9.1 sends no such field, so this reads `null` there rather than
                 * inventing a reason.
                 */
                offline_reason: d?.offline_reason ?? null,
                silent_ms: d?.silent_ms ?? null,
                rtt_ms: d?.rtt_ms ?? null,
                rtt_stale: d?.rtt_stale ?? null,
                last_heartbeat_at: d?.last_heartbeat_at ?? null,
              })),
          notes: devices === null
            ? ['per-machine detail is unavailable (this machine could not read /v1/devices); the fleet totals above still come from the relay']
            : [],
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m stats', kind: 'read', rawInput: {} }),
  }));
}
