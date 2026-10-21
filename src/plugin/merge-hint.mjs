/**
 * The merge hint: what a reader of a shared memory document should do about a conflict.
 *
 * A 409 from the memory CAS already carries `behind_by`, `unread_records` and a sample. The reader still has to decide what
 * "behind by 3" means for the thing they are about to write. This turns those numbers into a named next step -- re-read, compare,
 * then append with the current revision -- and never merges automatically: an automatic merge would write records the caller has
 * not seen. Pure: it reads the refusal the relay already sent.
 */
export const MERGE_UP_TO_DATE = 'up-to-date';
export const MERGE_RE_READ = 're-read-then-append';

/**
 * @param {{conflict?: object|null}} input `conflict` is the 409 detail: { behind_by, unread_records, sample }.
 * @returns {{state: string, behind_by: number, unread: number, sample_count: number, next: string}}
 */
export function renderMergeHint(input = {}) {
  const conflict = input.conflict ?? null;
  if (conflict === null || typeof conflict !== 'object') {
    return { state: MERGE_UP_TO_DATE, behind_by: 0, unread: 0, sample_count: 0, next: 'append normally' };
  }
  const behindBy = Number.isInteger(conflict.behind_by) && conflict.behind_by > 0 ? conflict.behind_by : 0;
  const unread = Array.isArray(conflict.unread_records) ? conflict.unread_records.length
    : (Number.isInteger(conflict.unread) && conflict.unread > 0 ? conflict.unread : 0);
  const sample = Array.isArray(conflict.sample) ? conflict.sample : [];
  if (behindBy === 0 && unread === 0) {
    return { state: MERGE_UP_TO_DATE, behind_by: 0, unread: 0, sample_count: 0, next: 'append normally' };
  }
  return {
    state: MERGE_RE_READ,
    behind_by: behindBy,
    unread,
    sample_count: sample.length,
    next: 're-read the document, compare the records listed here, then append with the current revision -- do not merge unseen records',
  };
}
