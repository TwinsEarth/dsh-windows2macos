/**
 * A readable view over memory records.
 *
 * The memory log is JSONL rows of mixed kinds (finished task, conclusion, accepted block). Reading it as a model means
 * reading what it will answer with; reading it as a person means reading what happened, in order, with the counts that
 * answer "have we done this before". Both are here, and the view never invents a field a record does not carry: an unknown
 * row shape is shown as itself rather than dropped, because a memory that silently hides rows is worse than a noisy one.
 */

/** The fields that make one row readable, in the order a person scans them. */
const SUMMARY_FIELDS = ['status', 'exit_code', 'command', 'conclusion', 'kind'];

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** One line per record: time, machine, then the first informative field. */
function lineOf(record, index) {
  const at = typeof record?.at === 'string' ? record.at : (Number.isFinite(record?.at_ms) ? new Date(record.at_ms).toISOString() : null);
  const machine = typeof record?.machine_name === 'string' && record.machine_name !== ''
    ? record.machine_name
    : (typeof record?.machine_id === 'string' ? record.machine_id.slice(0, 8) : 'unknown');
  const field = SUMMARY_FIELDS.find((name) => record?.[name] !== undefined && record[name] !== null) ?? null;
  const detail = field === null ? '' : ' ' + field + '=' + textOf(record[field]);
  const command = typeof record?.command === 'string' ? ' ' + record.command : '';
  const head = at === null ? '(no time)' : at.replace('T', ' ').slice(0, 19);
  const raw = head + '  ' + machine + detail + command;
  return { index, text: raw.length > 160 ? raw.slice(0, 157) + '...' : raw, machine, at };
}

/**
 * @param {Array<object>} records newest first, as the memory reader returns them
 * @param {{limit?: number}} [options]
 * @returns {{count: number, shown: number, truncated: boolean, by_machine: object, by_status: object, lines: object[]}}
 */
export function renderMemoryView(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  const byMachine = {};
  const byStatus = {};
  for (const record of list) {
    const machine = typeof record?.machine_name === 'string' && record.machine_name !== ''
      ? record.machine_name
      : (typeof record?.machine_id === 'string' ? record.machine_id.slice(0, 8) : 'unknown');
    byMachine[machine] = (byMachine[machine] ?? 0) + 1;
    const status = typeof record?.status === 'string' ? record.status : (typeof record?.kind === 'string' ? record.kind : 'unknown');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const shown = list.slice(0, limit);
  return {
    count: list.length,
    shown: shown.length,
    truncated: list.length > shown.length,
    by_machine: byMachine,
    by_status: byStatus,
    lines: shown.map(lineOf),
  };
}
