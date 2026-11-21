/**
 * Package-facing entry for W2M's archive backup subplugin:
 * `@twinsearth/w2m-dsh-plugin/dsh-backup-plugin`.
 *
 * A seam, not a second implementation: the composition root is
 * `src/plugin/backup-plugin.mjs`, the archive engine is `src/backup/zip-archive.mjs`, the session/export
 * translation is `src/backup/session-zip.mjs`, and the container is `src/backup/zip.mjs`. The offline
 * repository CLI is a different product: `w2m-backup`, behind `bin/w2m-backup.mjs`.
 *
 * This row is deliberately **not** re-exported from `lib/index.js`: the package root installs by default,
 * and a tool surface that writes archives (or restores one over a project) must not arrive because someone
 * installed a fleet tool. `cordis.patch.yml` ships the row with `disabled: true`; enabling it is the
 * decision. `dsh-backup` is the sibling row (the scheduled repository engine), also `disabled: true`.
 */
export {
  apply,
  buildTools,
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_FILE_BYTES,
  engineConfig,
  inject,
  name,
  normalizePluginConfig,
  TOOL_NAMES,
} from '../src/plugin/backup-plugin.mjs';
export {
  attachRootSessions,
  decodePlaintextSession,
  decodeStoredSession,
  encodeStoredSession,
  importOfficialSessionZip,
  SESSION_CODES,
  STORED_SESSION_FILE,
  writeSessionSet,
} from '../src/backup/session-zip.mjs';
export {
  createZipBackup,
  listZipBackups,
  readZipArchive,
  RESTORE_CONFIRM_TOKEN,
  RESTORE_COPY_ROOT,
  restoreCopyDir,
  restoreZipBackup,
  summarizeZipArchive,
  verifyZipBackup,
  ZIP_ARCHIVE_CODES,
  ZIP_ARCHIVE_FORMAT,
  ZIP_ARCHIVE_TOOL,
  ZIP_ARCHIVE_VERSION,
} from '../src/backup/zip-archive.mjs';
export { readZip, writeZip, ZIP_CODES } from '../src/backup/zip.mjs';
