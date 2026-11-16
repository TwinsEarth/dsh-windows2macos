/**
 * Package-facing entry for W2M's self-repair subplugin:
 * `@twinsearth/w2m-dsh-plugin/dsh-fix`.
 *
 * The documented subpath a profile row names to mount the attachment repair.
 * A seam, not a second implementation -- the code lives in `src/fix/index.mjs`,
 * which is where it is readable, and the offline CLI is
 * `src/fix/cli.mjs` (also exposed as `bin/w2m-fix.mjs`).
 *
 * Like GPW and the decision center, it is deliberately **not** re-exported from
 * `lib/index.js`: the package root installs by default, and a session-repair
 * listener must not arrive because someone installed a fleet tool.
 */
export {
  apply,
  findUnreadableImages,
  inject,
  name,
  resolveDshHome,
  resolveObjectsRoot,
  resolveStatePath,
} from '../src/fix/index.mjs';
