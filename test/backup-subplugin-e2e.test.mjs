/**
 * End-to-end for the `dsh-backup-plugin` row: mount the real package entry, then drive the six `backup_*` tools
 * against a throwaway `$DSH_HOME`, a throwaway project and a throwaway archive root.
 *
 * ## What is measured, and why through the tools
 *
 * `test/backup-subplugin.test.mjs` measures shape and wiring. This file measures **behaviour**: that the definitions
 * the row registers actually create, verify, restore and import. Calling `src/backup/zip-archive.mjs` directly would
 * leave the tool layer -- argument coercion, confirmation, result text -- untested, which is where the six-tool
 * contract lives.
 *
 * ## The fixtures are deliberately small and deterministic
 *
 * Two project files, one stored session, one official-export ZIP. No network, no timers, no real profile:
 * `DSH_HOME` is a `mkdtempSync` home shaped by `test/helpers/backup-fixture.mjs`, the archive root is a temp
 * directory that **does not exist until the first `backup_create`**, and the official ZIP is written by the
 * independent stored-ZIP helper (`test/helpers/official-session-zip.mjs`), not by the production writer.
 *
 * ## The one ordering dependency
 *
 * The cases share one mounted fixture and run in declaration order (the node:test default for a single file). That
 * is stated here rather than hidden: the flow is create -> verify -> plan -> confirm -> apply -> overwrite-copy ->
 * import, and each step's output is the next step's input. A case that needs isolation should build its own
 * fixture instead of reordering these.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply, TOOL_NAMES } from '../src/plugin/backup-plugin.mjs';
import { projectKey, STORED_SESSION_FILE } from '../src/backup/session-zip.mjs';
import { attachmentId, event, header, makeHome, put, registryDocument, sessionLog, tempDir } from './helpers/backup-fixture.mjs';
import { plaintextSession, writeStoredZip } from './helpers/official-session-zip.mjs';

const SESSION_ID = 'session-e2e-0001';

/** Mount the row against a fake Cordis context that records the registered definitions. */
async function mountPlugin(config) {
  const definitions = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (definition) => definitions.push(definition) },
    inject: (_names, callback) => callback(ctx),
  };
  const mounted = await apply(ctx, config);
  return { mounted, tools: new Map(definitions.map((definition) => [definition.name, definition])) };
}

/** Execute one tool and parse its JSON text result (the shape every tool in this row returns). */
async function call(tools, name, args = {}) {
  const tool = tools.get(name);
  assert.ok(tool, `${name} was not mounted`);
  const text = await tool.execute(args);
  assert.equal(typeof text, 'string', `${name} returned no text`);
  return JSON.parse(text);
}

/** A registry document as the client writes it, for one workspace path. */
function registryFor(workspacePath, sessionIds) {
  return registryDocument({ workspace: workspacePath, workspaceId: 'w1', sessionIds });
}

/** The workspace record the client would have for `workspacePath` (or null). */
function workspaceRecord(home, workspacePath) {
  const file = join(home, 'storages', 'workspace.json');
  if (!existsSync(file)) return null;
  const document = JSON.parse(readFileSync(file, 'utf8'));
  return Object.values(document.tables?.workspaces ?? {}).find((record) => record?.path === workspacePath) ?? null;
}

describe('dsh-backup-plugin end to end: six tools against a temp home', () => {
  /** @type {object} */
  let fx;

  before(async () => {
    const project = tempDir('w2m-e2e-project-');
    const restoreTarget = tempDir('w2m-e2e-restore-');
    const archiveParent = tempDir('w2m-e2e-archives-');
    const home = makeHome({
      sessions: [{ workspace: '--w2m-e2e--', id: SESSION_ID }],
      registry: registryFor(project.dir, [SESSION_ID]),
    });
    // The fixture's default header cwd is `E:\GPT`; this session is bound to the temp project instead.
    put(home.files[SESSION_ID], sessionLog(SESSION_ID, [event(0), event(1)], { cwd: project.dir }));
    put(join(project.dir, 'README.md'), '# e2e fixture\n');
    put(join(project.dir, 'src', 'app.txt'), 'console.log("one")\n');
    put(join(project.dir, 'node_modules', 'junk.txt'), 'must not be archived\n');

    const backupRoot = join(archiveParent.dir, 'archives');
    const { mounted, tools } = await mountPlugin({
      dshHome: home.home,
      backupRoot,
      projectRoot: project.dir,
      workspace: project.dir,
      includeProject: true,
      includeSessions: true,
      includeProfile: false,
      keepBackups: 0,
      maxFileBytes: 1024 * 1024,
    });
    fx = {
      home: home.home,
      homeCleanup: home.cleanup,
      project: project.dir,
      projectCleanup: project.cleanup,
      restoreTarget: restoreTarget.dir,
      restoreTargetCleanup: restoreTarget.cleanup,
      archiveParent: archiveParent.dir,
      archiveParentCleanup: archiveParent.cleanup,
      backupRoot,
      mounted,
      tools,
      archive: null,
      restoredSessionId: null,
    };
  });

  after(() => {
    for (const cleanup of [
      fx?.homeCleanup,
      fx?.projectCleanup,
      fx?.restoreTargetCleanup,
      fx?.archiveParentCleanup,
    ]) {
      if (typeof cleanup === 'function') cleanup();
    }
  });

  it('mounts exactly the six contract tools', () => {
    assert.equal(fx.mounted.ok, true);
    assert.equal(fx.mounted.mounted, true);
    assert.deepEqual([...fx.tools.keys()].sort(), [...TOOL_NAMES].sort());
    assert.equal(fx.tools.size, 6);
  });

  it('backup_status is read-only: it reports resolved paths and creates no archive directory', async () => {
    const status = await call(fx.tools, 'backup_status');
    assert.equal(status.plugin, 'w2m-dsh-backup-plugin');
    assert.equal(status.config.backup_root, fx.backupRoot);
    assert.equal(status.config.project_root, fx.project);
    assert.equal(status.config.include_project, true);
    assert.equal(status.config.include_sessions, true);
    assert.equal(status.config.include_profile, false);
    assert.equal(status.archive_count, 0);
    assert.equal(status.latest, null);
    assert.deepEqual(status.tools, [...TOOL_NAMES]);
    assert.equal(existsSync(fx.backupRoot), false, 'backup_status must not create the archive root');
    assert.equal(existsSync(join(fx.home, '.w2m-restore-backups')), false, 'backup_status must not create recovery copies');
  });

  it('backup_list reports an empty, not-yet-created archive root as a state', async () => {
    const listed = await call(fx.tools, 'backup_list');
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.archives, []);
    assert.equal(existsSync(fx.backupRoot), false, 'backup_list must not create the archive root');
  });

  it('backup_create writes one archive carrying the project files and the bound session', async () => {
    const created = await call(fx.tools, 'backup_create', { label: 'e2e first' });
    assert.equal(created.ok, true, created.detail);
    assert.equal(created.files, 2, 'README.md and src/app.txt');
    assert.equal(created.sessions, 1);
    assert.equal(created.skipped, 0, 'node_modules is excluded, not skipped-and-counted');
    assert.match(created.archive, /backup-\d{8}-\d{6}-e2e-first\.zip$/u);
    assert.equal(existsSync(created.archive), true);
    assert.equal(created.project_root, fx.project);
    fx.archive = created.archive;
  });

  it('backup_verify recomputes every recorded digest from the archive bytes', async () => {
    const verified = await call(fx.tools, 'backup_verify', { archive: fx.archive });
    assert.equal(verified.ok, true, JSON.stringify(verified.missing));
    assert.equal(verified.checked, 3, 'two project files plus one session log');
    assert.deepEqual(verified.missing, []);
    assert.deepEqual(verified.mismatched, []);
    assert.deepEqual(verified.extras, []);
  });

  it('backup_restore plan writes nothing, and apply without confirm is refused by name', async () => {
    const plan = await call(fx.tools, 'backup_restore', {
      archive: fx.archive,
      mode: 'plan',
      targetProject: fx.restoreTarget,
    });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.mode, 'plan');
    assert.equal(plan.plan.project.create, 2);
    assert.deepEqual(plan.plan.project.conflicts, []);
    assert.equal(plan.plan.sessions.planned, 1);
    assert.deepEqual(plan.plan.pre_restore.files, [], 'nothing exists in the target yet, so there is nothing to copy');
    assert.deepEqual(readdirSync(fx.restoreTarget), [], 'plan must write no project file');

    const refused = await call(fx.tools, 'backup_restore', {
      archive: fx.archive,
      mode: 'apply',
      targetProject: fx.restoreTarget,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason_code, 'BACKUP_RESTORE_CONFIRM_REQUIRED');
    assert.deepEqual(readdirSync(fx.restoreTarget), [], 'a refused apply must write no project file');
    assert.equal(existsSync(join(fx.home, 'sessions', projectKey(fx.restoreTarget))), false, 'a refused apply must write no session');
    assert.equal(existsSync(join(fx.home, '.w2m-restore-backups')), false, 'a refused apply must make no recovery copy');
  });

  it('backup_restore apply (confirm:"restore") restores the project and registers the new session', async () => {
    const applied = await call(fx.tools, 'backup_restore', {
      archive: fx.archive,
      mode: 'apply',
      confirm: 'restore',
      targetProject: fx.restoreTarget,
    });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.restored.files, 2);
    assert.equal(applied.restored.sessions, 1);
    assert.equal(applied.restored.skipped_conflicts, 0);
    assert.equal(applied.pre_restore.dir, null, 'a fresh target has nothing to back up first');
    assert.equal(readFileSync(join(fx.restoreTarget, 'README.md'), 'utf8'), '# e2e fixture\n');
    assert.equal(readFileSync(join(fx.restoreTarget, 'src', 'app.txt'), 'utf8'), 'console.log("one")\n');

    const written = applied.sessions?.written ?? [];
    assert.equal(written.length, 1);
    assert.notEqual(written[0].session_id, SESSION_ID, 'a restore allocates a new session id by default');
    assert.equal(written[0].old_id, SESSION_ID);
    const sessionFile = join(fx.home, 'sessions', projectKey(fx.restoreTarget), written[0].session_id, STORED_SESSION_FILE);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(applied.sessions.attach.ok, true, JSON.stringify(applied.sessions.attach));
    fx.restoredSessionId = written[0].session_id;

    const record = workspaceRecord(fx.home, fx.restoreTarget);
    assert.ok(record, 'the restored session must be attached to a workspace record');
    assert.ok(record.sessionIds.includes(fx.restoredSessionId));
  });

  it('backup_restore copies every file it overwrites, before writing it', async () => {
    writeFileSync(join(fx.restoreTarget, 'README.md'), 'locally edited after the first restore\n');
    const plan = await call(fx.tools, 'backup_restore', {
      archive: fx.archive,
      mode: 'plan',
      targetProject: fx.restoreTarget,
      overwrite: true,
      includeSessions: false,
    });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.plan.project.create, 1, 'only the edited file differs');
    assert.equal(plan.plan.project.same, 1, 'the untouched file is already identical');
    assert.deepEqual(plan.plan.pre_restore.files, ['project/README.md']);
    assert.equal(plan.plan.pre_restore.dir, null, 'plan names the copy but creates none');

    const applied = await call(fx.tools, 'backup_restore', {
      archive: fx.archive,
      mode: 'apply',
      confirm: 'restore',
      targetProject: fx.restoreTarget,
      overwrite: true,
      includeSessions: false,
    });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.restored.files, 1);
    assert.equal(applied.restored.pre_restore_files, 1);
    assert.ok(applied.pre_restore.dir, 'apply reports where the way back lives');
    assert.equal(
      readFileSync(join(applied.pre_restore.dir, 'project', 'README.md'), 'utf8'),
      'locally edited after the first restore\n',
      'the pre-restore copy holds the pre-write bytes',
    );
    assert.equal(readFileSync(join(fx.restoreTarget, 'README.md'), 'utf8'), '# e2e fixture\n', 'the archive bytes were restored');
  });

  it('backup_import_session_zip imports an official export under a new id, with attachments', async () => {
    const exportedId = 'session-99999999-8888-7777-6666-555555555555';
    const digest = attachmentId(7);
    const zip = writeStoredZip([
      {
        name: 'session.v4.jsonl',
        data: plaintextSession(header(exportedId, { cwd: fx.project }), [event(0), event(1)]),
      },
      { name: `media/sha256:${digest}.png`, data: Buffer.from('png-bytes', 'utf8') },
      { name: `files/${digest.slice(0, 2)}/${digest}/note.txt`, data: 'attachment note\n' },
    ]);
    const zipFile = join(fx.archiveParent, 'dsh-session-e2e.zip');
    writeFileSync(zipFile, zip);

    const imported = await call(fx.tools, 'backup_import_session_zip', { zip: zipFile, workspace: fx.project });
    assert.equal(imported.ok, true, imported.detail);
    assert.equal(imported.written.length, 1);
    assert.equal(imported.written[0].old_id, exportedId);
    assert.match(imported.written[0].session_id, /^session-[0-9a-f-]{36}$/u);
    assert.notEqual(imported.written[0].session_id, exportedId, 'the import allocates a new session id');
    assert.equal(imported.roots, 1);
    assert.equal(imported.attachments.media, 1);
    assert.equal(imported.attachments.files, 1);
    assert.deepEqual(imported.attachments.skipped, []);
    assert.equal(imported.attach.ok, true, JSON.stringify(imported.attach));

    const sessionFile = join(fx.home, 'sessions', projectKey(fx.project), imported.written[0].session_id, STORED_SESSION_FILE);
    assert.equal(existsSync(sessionFile), true, 'the imported session is written in the stored zstd shape');
    assert.equal(
      existsSync(join(fx.home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)),
      true,
      'the media attachment landed in the content-addressed object store',
    );
    assert.equal(
      readFileSync(join(fx.home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest, 'note.txt'), 'utf8'),
      'attachment note\n',
      'the files/ attachment landed under its fan-out directory',
    );
    const record = workspaceRecord(fx.home, fx.project);
    assert.ok(record, 'the import target workspace must exist in the registry');
    assert.ok(record.sessionIds.includes(imported.written[0].session_id), 'the imported root session is registered');
  });
});
