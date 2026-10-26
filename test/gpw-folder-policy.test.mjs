/**
 * v1.7.5-beta.1 — GPW v2: three folder classes, deny-wins, budget, and the tool-call path extraction.
 *
 * The classes are the user-visible contract:
 *   A blacklist -> deny    B whitelist -> allow (with budget)    C other -> pending operator approval
 * These cases pin each boundary including the trap that makes path rules dangerous: `C:\work` must not match
 * `C:\workshop`, and a trailing separator must not change the answer.
 */
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';

import { classifyPath, classifyToolCall, isInside, normalizeFolder, pathsOfToolCall } from '../src/plugin/folder-policy.mjs';
import { planGate, toolCallOf, validateFolderInput, folderForPath } from '../src/plugin/gpw.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtures = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'gpw-')); fixtures.push(dir); return dir; };
after(() => { for (const dir of fixtures) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } } });

describe('GPW folder policy (v1.7.5-beta.1)', () => {
  it('normalises separators, resolves .. and never confuses a prefix with a folder', () => {
    const platform = 'linux';
    assert.equal(normalizeFolder('/work/data/../shop/', { platform }), '/work/shop');
    assert.equal(isInside('/work/shop/a.txt', '/work/shop', { platform }), true);
    assert.equal(isInside('/work/shoplifting/a.txt', '/work/shop', { platform }), false, 'prefix must not be containment');
    assert.equal(isInside('/work/shop', '/work/shop', { platform }), true);
  });

  it('classifies the three classes, with deny winning over allow', () => {
    const base = { platform: 'linux', base: '/', workspace: '/repo' };
    assert.equal(classifyPath({ target: '/repo/src/a.js', ...base }).decision, 'allow', 'workspace');
    assert.equal(classifyPath({ target: '/data/secret/key', whitelist: ['/data'], blacklist: ['/data/secret'], ...base }).decision, 'deny', 'deny wins');
    assert.equal(classifyPath({ target: '/data/report.csv', whitelist: ['/data'], ...base }).decision, 'allow');
    assert.equal(classifyPath({ target: '/tmp/x', ...base }).decision, 'pass');
  });

  it('treats a listed folder as a root that covers every descendant (not just the parent folder itself)', () => {
    const base = { platform: 'linux', base: '/' };
    assert.equal(classifyPath({ target: '/work/a/b/c/d.txt', whitelist: ['/work'], ...base }).decision, 'allow');
    assert.equal(classifyPath({ target: '/work/a/b/c/d.txt', blacklist: ['/work/a'], ...base }).decision, 'deny', 'a nested blacklist root still wins');
    assert.equal(classifyPath({ target: '/worked/a.txt', whitelist: ['/work'], ...base }).decision, 'pass', 'a sibling with the same prefix is not inside');
  });

  it('resolves relative command paths against the workspace, so subfolders are classified too', () => {
    const call = { name: 'bash', arguments: { command: 'cat sub/dir/file.txt > out.txt' }, base: '/repo', workspace: '/repo', allowRelative: true, platform: 'linux' };
    const classified = classifyToolCall(call);
    assert.equal(classified.decision, 'allow');
    assert.ok(classified.paths.includes('sub/dir/file.txt'), 'the relative subfolder token is a candidate');
    assert.ok(classified.paths.includes('out.txt') === false, 'bare file names without a separator are not treated as paths');
  });

  it('classifies a relative command path that is outside the workspace as needing approval', () => {
    const call = { name: 'bash', arguments: { command: 'cat ../outside/file.txt' }, base: '/repo', workspace: '/repo/sub', allowRelative: true, platform: 'linux' };
    const classified = classifyToolCall(call);
    assert.notEqual(classified.decision, 'allow', 'a parent-relative path outside the workspace must not be auto-allowed');
  });

  it('classifies a whole call and keeps every candidate path', () => {
    const call = { name: 'write', arguments: { path: '/data/a.txt', newPath: '/data/b.txt' }, whitelist: ['/data'], platform: 'linux', base: '/' };
    const result = classifyToolCall(call);
    assert.equal(result.decision, 'allow');
    assert.equal(result.paths.length, 2);
  });

  it('extracts paths from structured fields and from a command line', () => {
    assert.deepEqual(pathsOfToolCall({ name: 'read', arguments: { file_path: '/etc/hosts' } }), ['/etc/hosts']);
    const command = pathsOfToolCall({ name: 'bash', arguments: { command: 'cat /data/a.txt > /data/b.txt' } });
    assert.ok(command.includes('/data/a.txt'));
    assert.ok(command.includes('/data/b.txt'));
  });

  it('maps a pre-execute exec object onto the policy call shape', () => {
    assert.deepEqual(toolCallOf({ name: 'edit', parameters: { path: '/x' } }), { name: 'edit', arguments: { path: '/x' } });
    assert.equal(toolCallOf({ toolName: 'read', input: { path: '/y' } }).arguments.path, '/y');
  });
});

describe('GPW gate decision (v1.7.5-beta.1)', () => {
  it('blacklist denies, whitelist allows only with budget, other paths wait', () => {
    assert.equal(planGate({ classification: { decision: 'deny', reason: 'blacklist' } }).kind, 'deny');
    assert.equal(planGate({ classification: { decision: 'allow', reason: 'whitelist' }, autoAllowBudgetRemaining: true }).kind, 'allow');
    assert.equal(planGate({ classification: { decision: 'allow', reason: 'whitelist' }, autoAllowBudgetRemaining: false }).kind, 'pending');
    assert.equal(planGate({ classification: { decision: 'pass', reason: 'no list' } }).kind, 'pending');
  });
});
describe('GPW typed-folder validation (v1.7.5-beta.1)', () => {
  it('accepts an existing directory and normalises it', () => {
    const dir = fixture();
    const result = validateFolderInput(dir + (dir.endsWith('/') ? '' : '/'));
    assert.equal(result.ok, true);
    assert.equal(result.path, dir);
  });

  it('refuses a missing folder, a file and a drive root', () => {
    const dir = fixture();
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    assert.equal(validateFolderInput(join(dir, 'nope')).ok, false);
    assert.equal(validateFolderInput(file).ok, false);
    assert.match(validateFolderInput('').error, /required/);
    if (process.platform === 'win32') assert.equal(validateFolderInput('C:').ok, false);
  });

  it('turns a file path into the nearest existing folder for one-click adding', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'sub'));
    assert.equal(folderForPath(join(dir, 'sub', 'missing', 'x.txt')), join(dir, 'sub'));
    assert.equal(folderForPath(join(dir, 'file.txt')), dir);
  });
});
