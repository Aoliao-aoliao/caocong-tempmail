import { createHash } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';

// Poller metadata only: one row per physical account/folder, not per namespace.
// Do not use the general settings editor/cache for these internal checkpoints.
export function junkCursorKey(accountId, path) {
  if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) < 1) throw Error('Invalid relay account');
  return `relay_junk_cursor_${accountId}_${createHash('sha256').update(path).digest('hex')}`;
}
export async function readJunkCursor(key, validity, dependencies = {}) {
  const c = await (dependencies.openDatabase || openDatabase)();
  try {
    const [[row]] = await c.execute('SELECT value FROM system_settings WHERE `key`=?', [key]);
    const previous = row?.value ?? null;
    const state = previous === null ? null : JSON.parse(previous);
    const uid = state?.validity === validity && Number.isSafeInteger(state.uid) && state.uid >= 0 ? state.uid : 0;
    return { uid, previous };
  } finally { c.release(); }
}
export async function writeJunkCursor(key, validity, uid, previous, dependencies = {}) {
  const c = await (dependencies.openDatabase || openDatabase)();
  const value = JSON.stringify({ validity, uid });
  try {
    // Compare-and-swap prevents a stale overlapping poll from replacing a newer
    // checkpoint or UIDVALIDITY. No row lock is held across any IMAP request.
    if (previous === null) {
      await c.execute("INSERT IGNORE INTO system_settings (`key`,value,value_type) VALUES (?,?,'json')", [key, value]);
    } else {
      await c.execute('UPDATE system_settings SET value=? WHERE `key`=? AND value=?', [value, key, previous]);
    }
  } finally { c.release(); }
}
