/**
 * v1.6.5 — Windows background tasks must not create console windows.
 *
 * These cases pin the two things that were wrong in the field before the fix:
 *   * the scheduled command line was `node.exe script`, which Task Scheduler runs visibly;
 *   * nothing checked the VBScript escaping, the part that silently produces a broken wrapper.
 *
 * The helper is pure string construction, so every rule is testable without a scheduler.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildHiddenWrapper,
  hiddenTaskArgs,
  hiddenTaskCommandLine,
  vbsString,
} from '../src/util/windows-hidden-task.mjs';
import { parseHiddenTaskArgs } from '../bin/w2m-hidden-task.mjs';

describe('windows hidden background tasks (v1.6.5)', () => {
  it('schedules wscript in batch mode, never the command directly', () => {
    assert.equal(hiddenTaskCommandLine('C:\\x\\wrap.vbs'), 'wscript.exe //B "C:\\x\\wrap.vbs"');
    assert.throws(() => hiddenTaskCommandLine(''), /vbsPath/);
    const args = hiddenTaskArgs({ taskName: 'w2m-keeper', everyMinutes: 2, vbsPath: 'C:\\x\\wrap.vbs' });
    assert.deepEqual(args, [
      '/Create', '/F', '/SC', 'MINUTE', '/MO', '2', '/TN', 'w2m-keeper',
      '/TR', 'wscript.exe //B "C:\\x\\wrap.vbs"',
    ]);
    assert.throws(() => hiddenTaskArgs({ taskName: 't', everyMinutes: 0, vbsPath: 'x' }), /positive integer/);
  });

  it('builds a wrapper that runs the command with window style 0 (hidden)', () => {
    const vbs = buildHiddenWrapper({ command: 'C:\\node\\node.exe', args: ['C:\\a b\\x.mjs', '--flag'] });
    assert.match(vbs, /WScript\.Shell/);
    assert.match(vbs, /sh\.Run /);
    assert.match(vbs, /, 0, False/);
    assert.match(vbs, /node\.exe/);
    assert.ok(vbs.includes('C:\\a b\\x.mjs'), 'a path with a space keeps its quotes');
  });

  it('escapes VBScript double quotes by doubling them', () => {
    assert.equal(vbsString('a"b'), '"a""b"');
    // An argument with a space is quoted on the real command line, then the whole line is
    // VBScript-escaped once — so the wrapper shows doubled quotes around `echo hi`.
    const vbs = buildHiddenWrapper({ command: 'cmd.exe', args: ['/c', 'echo hi'] });
    assert.ok(vbs.includes('""echo hi""'), vbs);
  });

  it('sets the working directory when asked, and omits the line otherwise', () => {
    assert.match(buildHiddenWrapper({ command: 'x.exe', workingDirectory: 'C:\\work' }), /CurrentDirectory = "C:\\work"/);
    assert.doesNotMatch(buildHiddenWrapper({ command: 'x.exe' }), /CurrentDirectory/);
  });

  it('parses the CLI flags and refuses incomplete or unknown input', () => {
    const parsed = parseHiddenTaskArgs(['--name', 'k', '--every-minutes', '2', '--command', 'node.exe', '--arg', 'a.mjs', '--arg', 'b']);
    assert.equal(parsed.name, 'k');
    assert.equal(parsed.everyMinutes, 2);
    assert.equal(parsed.command, 'node.exe');
    assert.deepEqual(parsed.args, ['a.mjs', 'b']);
    assert.throws(() => parseHiddenTaskArgs(['--name', 'k']), /required/);
    assert.throws(() => parseHiddenTaskArgs(['--delete', '--name', '']), /--name/);
    assert.throws(() => parseHiddenTaskArgs(['--nope', '1']), /unknown flag/);
  });
});
