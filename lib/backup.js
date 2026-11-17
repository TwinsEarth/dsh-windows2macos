/**
 * Package-facing entry for W2M's backup subplugin: `@twinsearth/w2m-dsh-plugin/dsh-backup`.
 *
 * The documented subpath a profile row names to mount scheduled session backups. A seam, not a second
 * implementation: the composition root is `src/plugin/backup.mjs` and the engine is `src/backup/`, which has no
 * Cordis dependency and is tested without one. The offline CLI is `bin/w2m-backup.mjs`
 * (`run` / `status` / `scan` / `list` / `gc` / `selftest`).
 *
 * Deliberately **not** re-exported from `lib/index.js`: the package root installs by default, and a timer that
 * writes to disk must not arrive because someone installed a fleet tool. The `cordis.patch.yml` row is absent
 * unless an operator adds it.
 */
export { apply, inject, name, normalizeConfig, BACKUP_RUN_ROUTE_PATH, RUN_CONFIRM_TOKEN, resolveDshHome, defaultBackupDir } from '../src/plugin/backup.mjs';
export { runBackup, SCOPES } from '../src/backup/engine.mjs';
export { gc } from '../src/backup/gc.mjs';
export { openRepo } from '../src/backup/repo.mjs';
export { openRepoKey } from '../src/backup/keystore.mjs';
export { normalizeBackupSchedule, describeBackupSchedule, nextBackupAt } from '../src/backup/schedule.mjs';
