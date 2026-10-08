import { createHash } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';

const policies = {
  normal: { action: 'GUEST_NORMAL_ROLLING', legacy: 'GUEST_MAILBOX_CREATE_IP' },
  relay: { action: 'GUEST_RELAY_ROLLING', legacy: 'GUEST_RELAY_CREATE_IP' },
};
const hash = value => createHash('sha256').update(String(value)).digest('hex');

// Both windows reserve the same attempt, under one cross-worker/IP lock.
// No cookie-derived rows are written until this stable IP gate has allowed it.
export async function consumeGuestCreationLimit({ kind, ipAddress, connection: supplied = null }) {
  const policy = policies[kind];
  if (!policy) throw new Error('Unknown guest creation kind');
  const key = hash(ipAddress || 'unknown');
  const lockName = hash(`${policy.action}:${key}`);
  const db = supplied || await openDatabase();
  let locked = false;
  let destroyed = false;
  try {
    const [[lock]] = await db.execute('SELECT GET_LOCK(?, 1) AS acquired', [lockName]);
    locked = Number(lock.acquired) === 1;
    if (!locked) return { allowed: false, retryAfter: 1 };
    const [[clock]] = await db.query('SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))) AS now');
    const now = Number(clock.now);
    await db.execute('DELETE FROM auth_rate_limits WHERE action=? AND key_hash=? AND window_start<=?', [policy.action, key, now - 3600]);
    const [rows] = await db.execute('SELECT window_start, attempt_count FROM auth_rate_limits WHERE action=? AND key_hash=? AND window_start>? ORDER BY window_start', [policy.action, key, now - 3600]);
    // Old releases only stored fixed-hour buckets. Count them conservatively
    // through an hour after their end, so an upgrade cannot reset used quota.
    const [legacy] = await db.execute('SELECT window_start, attempt_count FROM auth_rate_limits WHERE action=? AND key_hash=? AND window_start>?', [policy.legacy, key, now - 7200]);
    const hour = rows.map(row => ({ time: Number(row.window_start), count: Number(row.attempt_count) }));
    const minute = hour.filter(row => row.time > now - 60);
    hour.push(...legacy.map(row => ({ time: Number(row.window_start) + 3600, count: Number(row.attempt_count) })));
    let retryAfter = 0;
    for (const [events, limit, seconds] of [[minute, 4, 60], [hour, 12, 3600]]) {
      let total = events.reduce((sum, event) => sum + event.count, 0);
      if (total < limit) continue;
      for (const event of [...events].sort((a, b) => a.time - b.time)) {
        total -= event.count;
        if (total < limit) { retryAfter = Math.max(retryAfter, event.time + seconds - now); break; }
      }
    }
    if (retryAfter > 0) return { allowed: false, retryAfter };
    await db.execute(`INSERT INTO auth_rate_limits(action,key_hash,window_start,attempt_count)
      VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE attempt_count=attempt_count+1`, [policy.action, key, now]);
    return { allowed: true, retryAfter: 0 };
  } finally {
    try {
      if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch (error) {
      destroyed = true; db.destroy(); throw error;
    } finally {
      if (!supplied && !destroyed) db.release();
    }
  }
}

export function guestCreationLimited(retryAfter) {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return new Response(JSON.stringify({ ok: false, message: `操作过于频繁，请 ${seconds} 秒后再试。` }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(seconds) },
  });
}
