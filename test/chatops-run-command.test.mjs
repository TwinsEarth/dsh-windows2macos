/**
 * `/run` parsing and rendering (v0.7.12).
 *
 * The property that matters most is **sending a message is never an action**. Acting requires the
 * prefix, so a typo or an ordinary sentence cannot execute anything on a fleet — which is why the
 * first block below is about what must *not* dispatch.
 *
 * The second property is that a wrong guess is a **named refusal**, not a guess. Splitting
 * `/run node --version` on whitespace is right until a path contains a space; invoking a shell is
 * wrong always, because the fleet takes an argv array and a shell would turn every chat message into
 * arbitrary execution on every machine. So the parser refuses what it cannot be sure of, and the
 * tests pin the refusals as behaviour rather than as error strings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRun,
  parseRunFlags,
  parseInvocation,
  requiredCapability,
  RUN_FORM,
  describeDispatch,
  renderVerdict,
  renderDispatchFailure,
  RUN_REFUSAL,
  MAX_ARGS,
} from '../src/chatops/run-command.mjs';

describe('the prefix is what makes a message an action', () => {
  it('parses any non-empty text into an argv, because the prefix was already required', () => {
    /**
     * `parseRun` is only reached once the router has seen `/run`, so it must NOT try to guess
     * whether the text "looks like a command" — that judgement belongs to the router, which makes
     * it by requiring the prefix.
     *
     * A first version of this test asserted the opposite here and failed, which was the test being
     * wrong rather than the code: `hello` is a perfectly valid argv, and refusing it at this layer
     * would mean the parser refusing commands the operator can see are commands.
     */
    for (const text of ['hello', 'node --version', 'git status']) {
      const parsed = parseRun(text);
      assert.equal(parsed.ok, true, `${JSON.stringify(text)} is a valid argv`);
      assert.equal(parsed.argv.length >= 1, true);
    }
  });

  it('refuses only text that is empty after trimming', () => {
    for (const text of ['', '   ', '\t', null, undefined]) {
      assert.equal(parseRun(text).ok, false, `${JSON.stringify(text)} must not become a command`);
    }
  });
});

describe('the command becomes an argv array, never a shell string', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(parseRun('node --version').argv, ['node', '--version']);
  });

  it('keeps a quoted argument together, which a naive split does not', () => {
    assert.deepEqual(parseRun('cat "my file.txt"').argv, ['cat', 'my file.txt']);
    assert.deepEqual(parseRun("cat 'a b'").argv, ['cat', 'a b']);
  });

  it('treats a quoted empty string as a real argument', () => {
    // `started` exists for this: a length check would drop it and change the command.
    assert.deepEqual(parseRun('echo "" x').argv, ['echo', '', 'x']);
  });

  it('collapses runs of whitespace rather than emitting empty arguments', () => {
    assert.deepEqual(parseRun('  node    --version  ').argv, ['node', '--version']);
  });

  it('refuses a shell metacharacter instead of passing it through as a literal', () => {
    // Passing `|` through would arrive as a literal argument and quietly do something other than
    // what was typed — a command that runs and does the wrong thing, which is worse than a refusal.
    for (const text of ['ls | grep x', 'a && b', 'x > out.txt', 'echo `date`']) {
      const parsed = parseRun(text);
      assert.equal(parsed.ok, false, `${text} must be refused`);
      assert.equal(parsed.reason, RUN_REFUSAL.SHELL_METACHARACTER);
      assert.match(parsed.text, /argv/);
    }
  });

  it('refuses an unbalanced quote rather than guessing where it ended', () => {
    const parsed = parseRun('cat "unclosed');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, RUN_REFUSAL.UNBALANCED_QUOTE);
  });

  it('refuses something absurd before spending a dispatch on it', () => {
    const many = Array.from({ length: MAX_ARGS + 1 }, (_, i) => `a${i}`).join(' ');
    assert.equal(parseRun(many).reason, RUN_REFUSAL.TOO_LONG);
    assert.equal(parseRun(`node ${'x'.repeat(5000)}`).reason, RUN_REFUSAL.TOO_LONG);
  });

  it('accepts a normal command unchanged', () => {
    assert.deepEqual(parseRun('node --test').argv, ['node', '--test']);
    assert.deepEqual(parseRun('git status --porcelain').argv, ['git', 'status', '--porcelain']);
  });
});

describe('flags are read only before the command', () => {
  it('takes a mode and a machine list', () => {
    const { flags, command } = parseRunFlags(['--mode', 'broadcast', '--on', 'macmini,jp-shared', 'node', '--version']);
    assert.equal(flags.mode, 'broadcast');
    assert.deepEqual(flags.machines, ['macmini', 'jp-shared']);
    assert.equal(command, 'node --version');
  });

  it('leaves a flag that belongs to the command alone', () => {
    // `/run node --version` is a node invocation whose argument looks like a flag. Pulling it out
    // would run a different command than the one typed.
    const { flags, command } = parseRunFlags(['node', '--version']);
    assert.equal(flags.mode, 'replicate', 'the default, since nothing was given');
    assert.equal(command, 'node --version');
  });

  it('hands an unrecognised leading flag back to the command', () => {
    const { command } = parseRunFlags(['--weird', 'node', '--version']);
    assert.equal(command, '--weird node --version');
  });

  it('ignores a bad value rather than dispatching with it', () => {
    assert.equal(parseRunFlags(['--timeout', 'soon', 'node']).flags.timeoutMs, null);
    assert.equal(parseRunFlags(['--mode', 'nonsense', 'node']).flags.mode, 'replicate');
    assert.equal(parseRunFlags(['--timeout', '999999999', 'node']).flags.timeoutMs, 3_600_000, 'clamped');
  });

  it('describes what was dispatched in one line', () => {
    const line = describeDispatch({ argv: ['node', '--version'], mode: 'replicate', machines: ['macmini'] });
    assert.match(line, /node --version/);
    assert.match(line, /mode=replicate/);
    assert.match(line, /on=macmini/);
  });
});

describe('the two forms are two privilege levels, not two spellings', () => {
  it('A (expert) needs fleet.dispatch', () => {
    const r = parseInvocation('node --version');
    assert.equal(r.kind, 'dispatch');
    assert.equal(r.capability, 'fleet.dispatch');
  });

  it('C (beginner) needs only operate', () => {
    const r = parseInvocation('--ask 看看各机器的 node 版本');
    assert.equal(r.kind, 'ask');
    assert.equal(r.capability, 'operate');
  });

  it('gives the two forms different capabilities, which is the whole design', () => {
    // If these were equal, "beginner mode" would be a label rather than a boundary.
    const a = parseInvocation('node --version').capability;
    const c = parseInvocation('--ask 做点什么').capability;
    assert.notEqual(a, c);
  });

  it('names the capability instead of checking it, so the router still guards', () => {
    // "Authorisation is checked before the handler runs, never inside it" -- so this module reports
    // what a form needs and the router decides whether the window has it.
    assert.equal(requiredCapability(RUN_FORM.DISPATCH), 'fleet.dispatch');
    assert.equal(requiredCapability(RUN_FORM.ASK), 'operate');
    assert.equal(requiredCapability('nonsense'), null, 'an unknown form needs nothing it can claim');
  });

  it('does not let the beginner form reach execution by asking', () => {
    // The property that makes a low-privilege ask safe: it produces a *request*, never argv. A
    // window that may ask cannot thereby cause a fleet execution -- the session has to propose an
    // explicit command, which needs fleet.dispatch.
    for (const words of ['--ask 运行 rm -rf /', '--ask node --version', '--ask 帮我删掉所有文件']) {
      const r = parseInvocation(words);
      assert.equal(r.kind, 'ask', words + ' must stay a request');
      assert.equal(r.argv, undefined, 'an ask must carry no argv at all');
    }
  });
});

describe('both forms are supported, and the form is declared rather than guessed', () => {
  it('A: `/run <argv>` dispatches exactly those arguments', () => {
    const r = parseInvocation('node --version');
    assert.equal(r.kind, 'dispatch');
    assert.deepEqual(r.argv, ['node', '--version']);
  });

  it('C: `/run --ask <words>` is a request, not a command', () => {
    // The reason this exists: an operator holding a phone should be able to say what they want.
    const r = parseInvocation('--ask 看看各机器的 node 版本');
    assert.equal(r.kind, 'ask');
    assert.equal(r.text, '看看各机器的 node 版本');
  });

  it('does NOT infer the form from the text, in the dangerous direction', () => {
    // `/run hello` is a dispatch of a program called `hello`, not a request. Inferring here is how
    // a sentence gets run as if it were a program, so the form is declared with `--ask` instead.
    const r = parseInvocation('hello');
    assert.equal(r.kind, 'dispatch');
    assert.deepEqual(r.argv, ['hello']);
  });

  it('keeps a command that reads like a sentence a command', () => {
    const r = parseInvocation('git log --oneline');
    assert.equal(r.kind, 'dispatch');
    assert.deepEqual(r.argv, ['git', 'log', '--oneline']);
  });

  it('lets --ask carry flags too, since a request may name machines', () => {
    const r = parseInvocation('--on macmini --ask 报告一下磁盘占用');
    assert.equal(r.kind, 'ask');
    assert.equal(r.text, '报告一下磁盘占用');
    assert.deepEqual(r.flags.machines, ['macmini']);
  });

  it('refuses an empty request rather than asking the agent nothing', () => {
    const r = parseInvocation('--ask');
    assert.equal(r.kind, 'refused');
    assert.equal(r.reason, RUN_REFUSAL.EMPTY);
    assert.match(r.text, /--ask/);
  });

  it('still refuses a shell metacharacter in the dispatch form', () => {
    const r = parseInvocation('ls | grep x');
    assert.equal(r.kind, 'refused');
    assert.equal(r.reason, RUN_REFUSAL.SHELL_METACHARACTER);
  });

  it('allows shell-looking text in the REQUEST form, because it is not executed', () => {
    // The words are read by an agent, not a shell, so `|` is not a metacharacter here. Refusing it
    // would block the natural way to describe a pipeline.
    const r = parseInvocation('--ask 把 ls 的输出用 grep 过滤一下');
    assert.equal(r.kind, 'ask');
    assert.match(r.text, /grep/);
  });

  it('refuses an empty invocation outright', () => {
    for (const text of ['', '   ', null]) {
      assert.equal(parseInvocation(text).kind, 'refused', JSON.stringify(text));
    }
  });
});

describe('a verdict is rendered for a phone, and says when it is cut short', () => {
  it('leads with the verdict and the task id', () => {
    const { text } = renderVerdict({ taskId: 'T1', verdict: 'consistent', machines: [] });
    assert.match(text, /判定：consistent/);
    assert.match(text, /T1/);
  });

  it('caps the per-machine list and STATES the truncation', () => {
    // A list that silently stops at ten reads as "ten machines", not "ten shown".
    const machines = Array.from({ length: 25 }, (_, i) => ({ machine_name: `m${i}`, outcome: 'ok' }));
    const { text, truncated } = renderVerdict({ taskId: 'T', verdict: 'consistent', machines, maxMachines: 10 });
    assert.equal(truncated, 15);
    assert.match(text, /另有 15 台未显示/);
    assert.equal((text.match(/m\d+:/g) ?? []).length, 10);
  });

  it('includes the exit code and the refusal reason when present', () => {
    const { text } = renderVerdict({
      taskId: 'T',
      verdict: 'divergent',
      machines: [{ machine_name: 'a', outcome: 'ok', exit_code: 0 }, { machine_name: 'b', outcome: 'refused', refusal_reason: 'COMMAND_NOT_ALLOWED' }],
    });
    assert.match(text, /a: ok exit=0/);
    assert.match(text, /b: refused \(COMMAND_NOT_ALLOWED\)/);
  });

  it('says so plainly when there are no rows yet', () => {
    const { text } = renderVerdict({ taskId: 'T', verdict: 'pending', machines: null });
    assert.match(text, /还没有逐机结果/);
  });
});

describe('a dispatch that never became a task explains itself usefully', () => {
  it('separates "nothing paired" from "paired but silent"', () => {
    // Both arrive as NO_ONLINE_DEVICE and call for different actions from whoever holds the phone.
    const noFleet = renderDispatchFailure({ code: 'NO_ONLINE_DEVICE', reason: 'requester_has_no_fleet' });
    const silent = renderDispatchFailure({ code: 'NO_ONLINE_DEVICE' });
    assert.notEqual(noFleet, silent);
    assert.match(silent, /Localside/);
  });

  it('names a fleet-scope refusal as such', () => {
    assert.match(renderDispatchFailure({ code: 'NO_ONLINE_DEVICE', reason: 'target_outside_fleet' }), /不在这条舰队里/);
  });

  it('explains an allow-list refusal, which is the common one', () => {
    const text = renderDispatchFailure({ code: 'COMMAND_NOT_ALLOWED', detail: 'sh -lc is not in the allow-list' });
    assert.match(text, /allow-list/);
    assert.match(text, /sh -lc/);
  });

  it('falls back to the code rather than swallowing an unknown one', () => {
    const text = renderDispatchFailure({ code: 'SOMETHING_NEW', detail: 'x' });
    assert.match(text, /SOMETHING_NEW/);
    assert.match(text, /x/);
  });
});
