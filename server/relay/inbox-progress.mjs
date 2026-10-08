import { openDatabase } from '../db/database.mjs';

// One bounded row per physical account. Ranges represent fully handled UIDs
// beyond last_uid; gaps remain retryable. Never store addresses or message data.
export const MAX_COMPLETED_RANGES = 1024;
export function inboxProgressKey(id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw Error('Invalid relay account');
  return `relay_inbox_progress_${id}`;
}
export function mergeCompletedRanges(ranges, uids = [], floor = 0) {
  const result = [];
  for (const [start, end] of [...ranges, ...uids.map(uid => [uid, uid])].sort((a,b) => a[0]-b[0])) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 4294967295) throw Error('Invalid completed UID range');
    if (end <= floor) continue;
    const low = Math.max(start, floor + 1), last = result.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], end);
    else result.push([low, end]);
  }
  return result;
}
export function completedRangeContains(ranges, uid) {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, [start,end] = ranges[middle];
    if (uid < start) high = middle - 1;
    else if (uid > end) low = middle + 1;
    else return true;
  }
  return false;
}
export async function readInboxProgress(account, validity, dependencies = {}) {
  const c = await (dependencies.openDatabase || openDatabase)();
  try {
    // Read checkpoint and account version in one statement. An old poll must
    // not use progress belonging to a concurrent edit/activation/new namespace.
    const [[row]] = await c.execute(`SELECT r.last_uid,r.uid_validity,r.updated_at,s.value
      FROM relay_accounts r LEFT JOIN system_settings s ON s.\`key\`=?
      WHERE r.id=?`, [inboxProgressKey(account.id), account.id]);
    if (!row || Number(row.last_uid) !== Number(account.last_uid || 0)
      || Number(row.uid_validity) !== Number(account.uid_validity || 0)
      || new Date(row.updated_at).getTime() !== new Date(account.updated_at).getTime()) throw Error('Relay account changed during poll');
    const state = row.value ? JSON.parse(row.value) : null;
    if (state?.validity !== String(validity)) return [];
    if (!Array.isArray(state.ranges) || state.ranges.length > MAX_COMPLETED_RANGES) throw Error('Invalid INBOX progress');
    return mergeCompletedRanges(state.ranges, [], Number(account.last_uid || 0));
  } finally { c.release(); }
}
export async function writeInboxProgress(c, id, validity, ranges, floor) {
  const normalized = mergeCompletedRanges(ranges, [], floor);
  if (normalized.length > MAX_COMPLETED_RANGES) throw Error('INBOX progress limit exceeded');
  const key = inboxProgressKey(id);
  if (!normalized.length) { await c.execute('DELETE FROM system_settings WHERE `key`=?', [key]); return; }
  await c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [key, JSON.stringify({validity:String(validity), ranges:normalized})]);
}
