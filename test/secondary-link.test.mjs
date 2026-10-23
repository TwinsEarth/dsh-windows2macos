/**
 * v1.5.0 — the secondary relay link supervisor.
 *
 * What is asserted here, and why it is worth a test rather than trusting the file:
 *
 *   * flags are parsed with one spelling and unknown flags are refused (a standby link quietly
 *     pointed at the wrong relay is worse than one that refuses to start);
 *   * the child argv is built from the same `w2m-localside.mjs` the primary link uses, so the
 *     two links cannot drift apart in protocol behaviour;
 *   * the supervisor restarts an exited child with backoff, because a link that is launched once
 *     and then silently dies is the "looks connected, is not" failure this project keeps finding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLocalsideArgs, makeLinkLogger, parseSecondaryArgs, runSupervisor } from '../bin/w2m-secondary-link.mjs';

describe('w2m-secondary-link (v1.5.0)', () => {
  it('parses the documented flags and normalizes the relay base URL', () => {
    const parsed = parseSecondaryArgs([
      '--relay', 'http://relay.example:8787/',
      '--fleet-key', 'KEY',
      '--name', 'box-standby',
      '--state', '/tmp/x',
      '--log', '/tmp/x/link.log',
      '--project', '/tmp/proj',
      '--operator-token', 'TOK',
      '--allowed-commands', '["node --version"]',
    ]);
    assert.equal(parsed.relay, 'http://relay.example:8787');
    assert.equal(parsed.fleetKey, 'KEY');
    assert.equal(parsed.name, 'box-standby');
    assert.equal(parsed.stateDir, '/tmp/x');
    assert.equal(parsed.logFile, '/tmp/x/link.log');
    assert.equal(parsed.project, '/tmp/proj');
    assert.equal(parsed.operatorToken, 'TOK');
    assert.equal(parsed.allowedCommands, '["node --version"]');
  });

  it('derives state/log paths from the name when only --relay and a key are given', () => {
    const parsed = parseSecondaryArgs(['--relay', 'http://relay.example:8787', '--fleet-key', 'KEY', '--name', 'box']);
    assert.match(parsed.stateDir, /\.w2m-secondary/);
    assert.match(parsed.logFile, /link\.log$/);
  });

  it('isolates the standby identity by default (v1.5.1) and honours an explicit --identity-home', () => {
    const derived = parseSecondaryArgs(['--relay', 'http://relay.example:8787', '--fleet-key', 'K', '--state', '/tmp/s']);
    assert.equal(derived.identityHome, path.join('/tmp/s', 'dsh-home'),
      'the child must never share the primary link\'s DSH_HOME');
    const explicit = parseSecondaryArgs([
      '--relay', 'http://relay.example:8787', '--fleet-key', 'K', '--identity-home', '/var/lib/w2m/standby-home',
    ]);
    assert.equal(explicit.identityHome, '/var/lib/w2m/standby-home');
  });

  it('refuses an unknown flag and a missing relay instead of starting a misdirected link', () => {
    assert.throws(() => parseSecondaryArgs(['--relay', 'http://x:1', '--fleet-key', 'K', '--nope']), /unknown flag/);
    assert.throws(() => parseSecondaryArgs(['--fleet-key', 'K']), /--relay/);
    assert.throws(() => parseSecondaryArgs(['--relay', 'ftp://x']), /http/);
    assert.throws(() => parseSecondaryArgs(['--relay', 'http://x:1']), /--fleet-key|--operator-token/);
  });

  it('builds a localside argv that carries the relay, identity and state flags', () => {
    const options = parseSecondaryArgs([
      '--relay', 'http://relay.example:8787',
      '--fleet-key', 'KEY',
      '--name', 'box-standby',
      '--state', '/tmp/state',
      '--project', '/tmp/proj',
      '--allowed-commands', '[]',
    ]);
    const args = buildLocalsideArgs(options);
    assert.equal(args[0].endsWith('w2m-localside.mjs'), true);
    const flagValue = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(flagValue('--rabbit'), 'http://relay.example:8787');
    assert.equal(flagValue('--fleet-key'), 'KEY');
    assert.equal(flagValue('--name'), 'box-standby');
    assert.equal(flagValue('--state'), '/tmp/state');
    assert.equal(flagValue('--project'), '/tmp/proj');
    assert.equal(flagValue('--allowed-commands'), '[]');
    assert.equal(args.includes('--pair'), false, 'a standby joins with the account key, never a one-shot code');
  });

  it('restarts an exited child with backoff until the supervisor is stopped', async () => {
    const logLines = [];
    const spawns = [];
    const seenEnv = [];
    const spawnFn = (_exec, _args, opts) => {
      const child = new EventEmitter();
      child.pid = 1000 + spawns.length;
      child.kill = () => {};
      spawns.push(child);
      seenEnv.push(opts?.env ?? {});
      // Exit on the next macrotask, after the supervisor has attached its listeners.
      setImmediate(() => child.emit('exit', 1, null));
      return child;
    };
    const stopSignal = { stopped: false };
    const states = [];
    const options = parseSecondaryArgs(['--relay', 'http://relay.example:8787', '--fleet-key', 'KEY', '--state', '/tmp/state', '--log', '/tmp/state/log']);
    await runSupervisor(
      options,
      {
        log: (line) => logLines.push(line),
        spawnFn,
        sleep: async () => { states.push(spawns.length); if (spawns.length >= 3) stopSignal.stopped = true; },
        stopSignal,
      },
    );
    assert.ok(spawns.length >= 3, `expected at least three spawn attempts, saw ${spawns.length}`);
    // v1.5.1: every child runs with an isolated identity home, never the primary's.
    assert.ok(seenEnv.length >= 3);
    for (const env of seenEnv) {
      assert.equal(env.DSH_HOME, options.identityHome);
      assert.equal(env.USERPROFILE, options.identityHome);
      assert.equal(env.HOME, options.identityHome);
    }
    const exitLines = logLines.filter((l) => /child exited/.test(l));
    assert.ok(exitLines.length >= 2, 'every child exit is logged');
    assert.ok(logLines.some((l) => /restart_in=/.test(l)), 'the restart delay is visible in the log');
    assert.ok(logLines.some((l) => /supervisor stopped/.test(l)), 'stopping is logged');
  });

  it('writes a timestamped line through the link logger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-link-log-'));
    const file = path.join(dir, 'link.log');
    try {
      const log = makeLinkLogger(file);
      log('hello');
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(text, /hello/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
