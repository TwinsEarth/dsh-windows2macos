/**
 * Package-facing entry for W2M's queue journal: `@twinsearth/w2m-dsh-plugin/queue-journal`.
 *
 * The documented subpath a profile row names to enable draft/queue persistence. The host logic is
 * `src/queue-journal/index.mjs`; the composer UI ships in the package's one client bundle
 * (`lib/client.js`), the same shape GPW and the decision center use.
 */
export {
  apply,
  inject,
  name,
  QUEUE_JOURNAL_ROUTE_PREFIX,
  QUEUE_JOURNAL_SERVICE,
  QUEUE_RESTORE_ROUTE_PATH,
} from '../src/queue-journal/index.mjs';
