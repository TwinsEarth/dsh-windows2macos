/**
 * The Teams sub-plugin: package wiring, inert mount, and the two read-only tools.
 *
 * The central assertion is that a model can see the team but cannot join the command path. Every
 * status and room response is inspected for the device token, because a diagnostic surface that
 * leaks the credential on the reliable path is worse than no diagnostic surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  apply,
  buildTools,
  DEFAULT_STALE_AFTER_MS,
  describeConfig,
  normalizePluginConfig,
  TEAMS_ROW_ID,
  TOOL_NAMES,
} from '../src/plugin/teams-plugin.mjs';
import { TeamsService } from '../src/plugin/teams/service.mjs';
import { TOOL_NAMES as P2P_TOOL_NAMES } from '../src/plugin/p2p-webrtc-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const NOW = Date.parse('2026-11-23T10:00:00.000Z');

function patchRow(id) {
  const lines = patch.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`);
  assert.ok(start >= 0, `row ${id} is missing from cordis.patch.yml`);
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^ {4}- id:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function fakeContext() {
  const definitions = [];
  const registered = [];
  const effects = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition) {
        definitions.push(definition);
        registered.push(definition.name);
      },
    },
    inject(services, callback) {
      callback({ tools: { register: (definition) => ctx.tools.register(definition) } });
    },
    effect(setup) {
      effects.push(setup);
    },
  };
  return { ctx, definitions, registered, effects };
}

function json(value) {
  return JSON.parse(value);
}

function fakeRequest() {
  const calls = [];
  const impl = async (options) => {
    calls.push(options);
    if (options.pathname === '/v1/devices') {
      return {
        ok: true,
        status: 200,
        json: {
          protocol_version: '1.2',
          rabbit_time: nowIso(),
          devices: [
            {
              machine_id: 'machine-a',
              machine_name: 'DESKTOP-A',
              user: { id: 'u1', name: 'Fang' },
              role: 'owner',
              caps: { os: 'windows' },
              last_seen: new Date(NOW - 5_000).toISOString(),
            },
            {
              machine_id: 'machine-b',
              machine_name: 'TOFUTURE',
              last_seen_at: new Date(NOW - 120_000).toISOString(),
            },
          ],
        },
      };
    }
    if (options.pathname === '/v1/projects') {
      return {
        ok: true,
        status: 200,
        json: {
          protocol_version: '1.2',
          ok: true,
          projects: [
            { project_id: 'default', name: 'default', origin: null },
            { project_id: 'w2m-core', name: 'W2M core', origin: 'https://example.test/repo.git' },
          ],
        },
      };
    }
    if (options.pathname === '/v1/projects/w2m-core') {
      return {
        ok: true,
        status: 200,
        json: {
          protocol_version: '1.2',
          ok: true,
          project: { project_id: 'w2m-core', name: 'W2M core' },
          members: [{ kind: 'machine', id: 'machine-a', name: 'DESKTOP-A', role: 'owner' }],
          last_event_seq: 41,
        },
      };
    }
    if (options.pathname === '/v1/projects/w2m-core/events') {
      assert.equal(options.query.since_seq, 7);
      return {
        ok: true,
        status: 200,
        json: {
          protocol_version: '1.2',
          ok: true,
          events: [{ seq: 8, type: 'task.created', payload: { task_id: 'jd-abc' } }],
          next_seq: 8,
          latest_seq: 41,
          oldest_available_seq: 8,
          truncated: true,
          remaining: 33,
        },
      };
    }
    return { ok: false, status: 404, error: { code: 'NOT_FOUND', message: 'unknown route', detail: null } };
  };
  return { impl, calls };
}

const nowIso = () => new Date(NOW).toISOString();

function serviceConfig(overrides = {}) {
  return normalizePluginConfig({
    rabbitUrl: 'http://relay.test:8787',
    stateDir: 'C:/w2m-state',
    deviceFile: 'C:/w2m-state/xclient/device.json',
    projectId: 'default',
    ...overrides,
  });
}

describe('dsh-teams wiring', () => {
  it('declares the export, the lib seam, and the 25-tool package description', () => {
    assert.equal(pkg.exports['./dsh-teams'], './lib/teams-plugin.js');
    assert.ok(existsSync(join(ROOT, 'lib/teams-plugin.js')));
    assert.ok(existsSync(join(ROOT, 'src/plugin/teams-plugin.mjs')));
    assert.match(pkg.description, /25 tools/);
    assert.equal(
      pkg.scripts['test:teams'],
      'node --test --test-force-exit test/teams-data-plane.test.mjs test/teams-plugin.test.mjs test/teams-policy.test.mjs test/teams-presence.test.mjs',
    );
    assert.ok(pkg.files.includes('lib'));
  });

  it('ships the patch row disabled, with an empty relay and no guessed credential', () => {
    const row = patchRow(TEAMS_ROW_ID);
    assert.match(row, /name: '@twinsearth\/w2m-dsh-plugin\/dsh-teams'/);
    assert.match(row, /disabled: true/);
    assert.match(row, /rabbitUrl: ''/);
    assert.match(row, /projectId: 'default'/);
    assert.match(row, /staleAfterMs: 90000/);
    assert.match(row, /dataMaxAttempts: 33/);
    assert.equal(row.includes('token'), false);
    assert.equal(row.includes('deviceToken'), false);
  });

  it('mounts three tools and performs no I/O at mount time', async () => {
    const { ctx, definitions, registered, effects } = fakeContext();
    let requests = 0;
    const dispose = await apply(
      ctx,
      {
        rabbitUrl: 'http://relay.test:8787',
        projectId: 'default',
        stateDir: 'C:/w2m-state',
        dataRetryDelayMs: 0,
      },
      {
        defineTool: (definition) => definition,
        deviceToken: 'secret-token',
        device: { machine_id: 'machine-a' },
        now: () => NOW,
        requestImpl: async () => {
          requests += 1;
          throw new Error('mount must not call the relay');
        },
        listPlansImpl: () => ({ ok: true, plans: [], total: 0 }),
      },
    );
    assert.equal(typeof dispose, 'function');
    assert.deepEqual(registered, [...TOOL_NAMES]);
    assert.equal(definitions.length, 3);
    assert.equal(dispose.ok, true);
    assert.equal(requests, 0);
    assert.equal(effects.length, 1);
    assert.equal(JSON.stringify(dispose.config).includes('secret-token'), false);
    assert.equal(dispose.config.data_max_attempts, 33);
    assert.equal(dispose.config.control_channel, 'relay-tcp');
    assert.equal(dispose.config.data_channel, 'webrtc-v1');
  });

  it('never reuses a main-plugin tool name', () => {
    const existing = [
      'w2m_joint_plan',
      'w2m_joint_status',
      'w2m_run',
      'w2m_council',
      'w2m_tasks',
      'w2m_devices',
      'w2m_status',
      ...P2P_TOOL_NAMES,
    ];
    for (const name of TOOL_NAMES) {
      assert.equal(existing.includes(name), false, `${name} collides with the main plugin`);
      assert.match(name, /^w2m_team_/);
    }
  });

  it('reports policy, roster, rooms, joint summaries, and the tool index', async () => {
    const { impl, calls } = fakeRequest();
    const cfg = serviceConfig();
    const service = new TeamsService(cfg, {
      requestImpl: impl,
      deviceToken: 'secret-token',
      device: { machine_id: 'machine-a', machine_name: 'DESKTOP-A' },
      now: () => NOW,
      listPlansImpl: () => ({
        ok: true,
        total: 2,
        plans: [
          { plan_sha256: 'a'.repeat(64), saved_at_ms: NOW - 60_000 },
          { plan_sha256: 'b'.repeat(64), saved_at_ms: NOW - 120_000 },
        ],
      }),
    });
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    const statusTool = definitions.find((definition) => definition.name === 'w2m_team_status');
    const report = json(await statusTool.execute({}));

    assert.equal(report.ok, true);
    assert.equal(report.project_id, 'default');
    assert.equal(report.transport.control.channel, 'relay-tcp');
    assert.equal(report.transport.control.max_attempts, 1);
    assert.equal(report.transport.data.channel, 'webrtc-v1');
    assert.equal(report.transport.data.max_attempts, 33);
    assert.match(report.transport.data.on_exhausted, /never fall back to the relay/);
    assert.equal(report.relay.configured, true);
    assert.equal(report.relay.token_present, true);
    assert.equal(report.relay.devices.count, 2);
    assert.equal(report.relay.projects.count, 2);
    assert.equal(report.roster.count, 2);
    assert.equal(report.roster.online, 1);
    assert.equal(report.roster.stale, 1);
    const member = report.roster.members.find((entry) => entry.machine_id === 'machine-a');
    assert.equal(member.user.name, 'Fang');
    assert.equal(report.projects.projects[1].project_id, 'w2m-core');
    assert.equal(report.joint.total, 2);
    assert.equal(report.joint.latest_plan_sha256, 'a'.repeat(64));
    assert.deepEqual(report.surface.run_modes, ['replicate', 'split', 'pipeline', 'broadcast']);
    assert.equal(report.dispatch_gate.model_may_dispatch, false);
    assert.equal(report.dispatch_gate.model_may_approve, false);
    assert.equal(calls.length, 2);
    assert.equal(
      calls.every((call) => call.token === 'secret-token'),
      true,
    );
    assert.equal(JSON.stringify(report).includes('secret-token'), false);
    assert.equal(JSON.stringify(report).includes('authorization'), false);
  });

  it('resolves defineTool from the shared loader when no dependency injects one', async () => {
    const { ctx, registered } = fakeContext();
    const dispose = await apply(
      ctx,
      { rabbitUrl: 'http://relay.test:8787', projectId: 'default', stateDir: 'C:/w2m-state', dataRetryDelayMs: 0 },
      {
        env: {},
        device: { machine_id: 'machine-a' },
        deviceToken: 'secret-token',
        now: () => NOW,
        requestImpl: async () => {
          throw new Error('mount must not call the relay');
        },
        listPlansImpl: () => ({ ok: true, plans: [], total: 0 }),
      },
    );
    assert.equal(typeof dispose, 'function');
    assert.deepEqual(registered, [...TOOL_NAMES]);
  });

  it('degrades to a useful status when this machine is not paired', async () => {
    const { ctx, definitions } = fakeContext();
    await apply(
      ctx,
      {
        rabbitUrl: 'http://relay.test:8787',
        deviceFile: 'C:/definitely-not-here/device.json',
        stateDir: '',
      },
      {
        defineTool: (definition) => definition,
        env: {},
        device: {},
        now: () => NOW,
        requestImpl: async () => {
          throw new Error('must not call the relay without a token');
        },
      },
    );
    const status = json(
      await definitions.find((definition) => definition.name === 'w2m_team_status').execute({}),
    );
    assert.equal(status.ok, true);
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.token_present, false);
    assert.equal(status.roster.count, 0);
    assert.equal(status.relay.devices.code, 'TEAM_DEVICE_TOKEN_REQUIRED');
    assert.equal(
      status.notes.some((note) => note.includes('not paired')),
      true,
    );

    const room = json(
      await definitions.find((definition) => definition.name === 'w2m_team_room').execute({ action: 'list' }),
    );
    assert.equal(room.ok, false);
    assert.equal(room.code, 'TEAM_DEVICE_TOKEN_REQUIRED');
  });

  it('rooms are read-only reads: list, get, and incremental events', async () => {
    const { impl, calls } = fakeRequest();
    const cfg = serviceConfig();
    const service = new TeamsService(cfg, {
      requestImpl: impl,
      deviceToken: 'secret-token',
      device: { machine_id: 'machine-a' },
      now: () => NOW,
    });
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    const roomTool = definitions.find((definition) => definition.name === 'w2m_team_room');

    const listed = json(await roomTool.execute({}));
    assert.equal(listed.ok, true);
    assert.equal(listed.action, 'list');
    assert.equal(listed.projects.length, 2);

    const got = json(await roomTool.execute({ action: 'get', project_id: 'w2m-core' }));
    assert.equal(got.ok, true);
    assert.equal(got.project.project_id, 'w2m-core');
    assert.equal(got.members.length, 1);
    assert.equal(got.last_event_seq, 41);

    const events = json(await roomTool.execute({ action: 'events', project_id: 'w2m-core', since_seq: 7 }));
    assert.equal(events.ok, true);
    assert.equal(events.next_seq, 8);
    assert.equal(events.truncated, true);
    assert.equal(events.remaining, 33);
    assert.equal(
      calls.some((call) => call.pathname.endsWith('/events')),
      true,
    );
  });

  it('refuses invalid room requests with named codes instead of guessing', async () => {
    const { impl, calls } = fakeRequest();
    const cfg = serviceConfig();
    const service = new TeamsService(cfg, {
      requestImpl: impl,
      deviceToken: 'secret-token',
      device: { machine_id: 'machine-a' },
      now: () => NOW,
    });
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    const roomTool = definitions.find((definition) => definition.name === 'w2m_team_room');

    const badAction = json(await roomTool.execute({ action: 'create' }));
    assert.equal(badAction.code, 'TEAM_ROOM_ACTION_INVALID');
    const noProject = json(await roomTool.execute({ action: 'get' }));
    assert.equal(noProject.code, 'TEAM_PROJECT_ID_REQUIRED');
    const badProject = json(await roomTool.execute({ action: 'get', project_id: '__bad__' }));
    assert.equal(badProject.code, 'TEAM_PROJECT_ID_INVALID');
    const badSeq = json(await roomTool.execute({ action: 'events', project_id: 'w2m-core', since_seq: -1 }));
    assert.equal(badSeq.code, 'TEAM_SINCE_SEQ_INVALID');
    assert.equal(calls.length, 0);
  });

  it('keeps the relay token out of the config description and the default project stable', () => {
    const cfg = normalizePluginConfig({ projectId: '' });
    assert.equal(cfg.project_id, 'default');
    assert.equal(cfg.stale_after_ms, DEFAULT_STALE_AFTER_MS);
    assert.equal(cfg.data_retry_delay_ms, 1_000);
    const described = describeConfig(cfg);
    assert.equal('token' in described, false);
    assert.equal('device_token' in described, false);
    assert.equal(described.row, 'dsh-teams');
    assert.deepEqual(described.tools, [...TOOL_NAMES]);
  });

  it('returns a project id that cannot escape the URL path', () => {
    const cfg = normalizePluginConfig({ projectId: '../etc' });
    assert.equal(cfg.project_id, 'default');
  });

  it('strips URL credentials and query from the config description', () => {
    const described = describeConfig(
      normalizePluginConfig({ rabbitUrl: 'http://operator:super-secret@relay.test:8787/w2m?token=leak' }),
    );
    assert.equal(described.rabbit_url, 'http://relay.test:8787/w2m');
    assert.equal(JSON.stringify(described).includes('super-secret'), false);
    assert.equal(JSON.stringify(described).includes('leak'), false);
  });
});
