/**
 * The plan's SEC-CMD cases, run against the real matcher.
 *
 * The test plan asserts that `node --test --test-reporter=tap` is **allowed when the entry names it
 * explicitly**, while `node --test-reporter=tap` (no `--test`) is refused. This file checks both, because
 * the two claims come from different mechanisms and only one of them was obvious from reading:
 *
 *   * the refusal is `COMMAND_REPARSING_ARGUMENT`, raised on **trailing** arguments of a matched entry, and
 *     its own detail says the remedy is an `entry of its own`;
 *   * so a second entry whose prefix *includes* the flag should permit exactly that flag, while the
 *     `node --test` entry keeps refusing arbitrary reporters.
 *
 * It also probes `COMMAND_EXECUTABLE_RELATIVE_PATH`, which `grep` found **zero** coverage for across all
 * 81 suites — an error code with no test is an error code nobody has seen fire.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MATCH_REFUSAL, matchAllowedCommand, parseAllowedCommands } from '../src/agent/allowed-commands.mjs';

/** The entry the project uses for its own suites. */
const NODE_TEST = () => parseAllowedCommands([['node', '--test']]);

describe('SEC-CMD-001/002: the entry, and the entry of its own', () => {
  it('SEC-CMD-001: `node --test` matches its entry', () => {
    const r = matchAllowedCommand(['node', '--test'], NODE_TEST());
    assert.equal(r.allowed, true, r.detail ?? '');
  });

  it('SEC-CMD-002: a flag named by its OWN entry is allowed, while the bare entry still refuses it', () => {
    // The two halves are the whole point: naming `--test-reporter=tap` in its own entry must permit exactly
    // that, and must NOT become a general permission for `--test-reporter`.
    const entries = parseAllowedCommands([['node', '--test'], ['node', '--test', '--test-reporter=tap']]);

    const named = matchAllowedCommand(['node', '--test', '--test-reporter=tap', 'test/x.test.mjs'], entries);
    assert.equal(named.allowed, true, `named flag should be allowed: ${named.detail ?? ''}`);

    // A file-path reporter is still refused: the specific entry covers `=tap` and nothing else.
    const other = matchAllowedCommand(['node', '--test', '--test-reporter=file:///tmp/evil.mjs'], entries);
    assert.equal(other.allowed, false, 'a different reporter must not ride in on the named entry');
    assert.equal(other.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT);

    // And the bare entry alone does not permit it, which is what makes the first assertion meaningful.
    const bare = matchAllowedCommand(['node', '--test', '--test-reporter=tap'], NODE_TEST());
    assert.equal(bare.allowed, false, 'without the entry of its own, the flag is refused');
  });

  it('SEC-CMD-003: `node --test-reporter=tap` with no `--test` is refused', () => {
    // No entry matches at all here, so the refusal is a different one from the reparse refusal.
    const r = matchAllowedCommand(['node', '--test-reporter=tap'], NODE_TEST());
    assert.equal(r.allowed, false);
    assert.ok(r.reason_code, 'a refusal carries a code');
  });
});

describe('SEC-CMD-004/005: code-loading flags, across interpreters', () => {
  it('refuses the flags that make node load code, and says which one', () => {
    for (const argv of [
      ['node', '--test', '-e', 'process.exit(0)'],
      ['node', '--test', '--eval', 'process.exit(0)'],
      ['node', '--test', '-p', '1+1'],
      ['node', '--test', '--import=file:///tmp/e.mjs'],
      ['node', '--test', '--require=/tmp/e.cjs'],
      ['node', '--test', '--experimental-loader=file:///tmp/e.mjs'],
      ['node', '--test', '-pe', '1+1'],
    ]) {
      const r = matchAllowedCommand(argv, NODE_TEST());
      assert.equal(r.allowed, false, argv.join(' '));
      assert.equal(r.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT, argv.join(' '));
    }
  });

  it('refuses `python -c` only when python is entered without it', () => {
    const bare = parseAllowedCommands([['python']]);
    const r = matchAllowedCommand(['python', '-c', 'import os'], bare);
    assert.equal(r.allowed, false, 'a bare python entry must not permit -c');
    assert.equal(r.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT);
  });
});

describe('SEC-CMD-006: a relative argv[0] is refused, and nothing tested that before', () => {
  it('refuses `./node` because it names a different file in every directory', () => {
    // `grep COMMAND_EXECUTABLE_RELATIVE_PATH test/` returned 0 hits across 81 suites before this file. The
    // code path existed, and no test had ever watched it run.
    const entries = parseAllowedCommands([['node', '--test']]);
    for (const exe of ['./node', '../node', '.\\node.exe', 'bin/node', 'sub/dir/node']) {
      const r = matchAllowedCommand([exe, '--test', 'test/x.test.mjs'], entries);
      assert.equal(r.allowed, false, `argv[0] = ${exe} must be refused`);
      assert.ok(
        r.reason_code === MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH || r.reason_code === MATCH_REFUSAL.NOT_ALLOWED,
        `${exe} answered ${r.reason_code}, which is neither the relative-path refusal nor "no entry matched"`,
      );
    }
  });

  it('does NOT refuse a bare `node.exe`, because on Windows that IS `node`', () => {
    // My first version listed `node.exe` among the paths that must be refused, and it was allowed. **The code
    // was right and the test was wrong**: the entry is normalised so `node` and `node.exe` name the same
    // executable, which is what makes a Windows allow-list writable by hand. **This is SEC-CMD-008's
    // "allowed" case**, pinned here so the distinction between a bare name and a path is not lost.
    const entries = parseAllowedCommands([['node', '--test']]);
    const r = matchAllowedCommand(['node.exe', '--test', 'test/x.test.mjs'], entries);
    assert.equal(r.allowed, true, 'the extension is part of how Windows names the same file');
  });

  it('names the relative-path refusal for the case that is specifically about it', () => {
    const entries = parseAllowedCommands([['./node', '--test']]);
    const r = matchAllowedCommand(['./node', '--test', 'test/x.test.mjs'], entries);
    assert.equal(r.allowed, false);
    assert.equal(
      r.reason_code,
      MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH,
      'an entry that itself names a relative path must be refused as such, not merely as unmatched',
    );
  });
});

describe('SEC-CMD-007/008: the executable identity check', () => {
  it('refuses a different file with the same basename', () => {
    const entries = parseAllowedCommands([['node', '--test']]);
    const r = matchAllowedCommand(['E:\\Temp\\evil\\node.exe', '--test', 'x.mjs'], entries);
    assert.equal(r.allowed, false);
    assert.ok(r.reason_code, 'and it carries a code');
  });

  it('allows the bare name, which is the documented form', () => {
    const r = matchAllowedCommand(['node', '--test', 'x.mjs'], parseAllowedCommands([['node', '--test']]));
    assert.equal(r.allowed, true, r.detail ?? '');
  });
});
