import { createHash } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';

function hashIdentifier(value) {
  return createHash('sha256').update(String(value || 'unknown')).digest('hex');
}

export function isSameOriginRequest(request, expectedOrigin) {
  const origin = request.headers.get('origin');
  if (origin) return origin === expectedOrigin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function consumeAuthRateLimit({ action, identifier, limit, windowSeconds, connection:providedConnection = null }) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const keyHash = hashIdentifier(identifier);
  const connection = providedConnection || await openDatabase();
  const ownsConnection = !providedConnection;

  try {
    await connection.execute('DELETE FROM auth_rate_limits WHERE window_start < ?', [now - 86400]);
    await connection.execute(`
      INSERT INTO auth_rate_limits (action, key_hash, window_start, attempt_count)
      VALUES (?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE attempt_count = attempt_count
    `, [action, keyHash, windowStart]);
    const [reservation] = await connection.execute(`
      UPDATE auth_rate_limits
      SET attempt_count = attempt_count + 1
      WHERE action = ? AND key_hash = ? AND window_start = ? AND attempt_count < ?
    `, [action, keyHash, windowStart, limit]);
    const allowed = Number(reservation.affectedRows) === 1;
    const [rows] = await connection.execute(`
      SELECT attempt_count FROM auth_rate_limits
      WHERE action = ? AND key_hash = ? AND window_start = ?
    `, [action, keyHash, windowStart]);
    const count = Number(rows[0]?.attempt_count || 0);
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      retryAfter: Math.max(1, windowStart + windowSeconds - now),
    };
  } finally {
    if (ownsConnection) connection.release();
  }
}

// Serialize a true cooldown across workers, using the existing expiring rate
// records. For these cooldown-only actions, window_start stores epoch seconds
// and attempt_count stores milliseconds within that second plus one (not a
// request count). This preserves existing expiry cleanup without rounding the
// cooldown up to 11 seconds. No process-local state or schema migration.
export async function consumeRefreshCooldown({ action, identifier, windowSeconds = 10 }) {
  const keyHash = hashIdentifier(identifier);
  const lockName = hashIdentifier(`cooldown:${action}:${keyHash}`);
  const connection = await openDatabase();
  let locked = false;
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 1) AS acquired', [lockName]);
    locked = Number(lock.acquired) === 1;
    if (!locked) return { allowed:false, retryAfter:windowSeconds };
    const [[clock]] = await connection.query('SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) AS seconds');
    const now = Math.round(Number(clock.seconds) * 1000);
    await connection.execute('DELETE FROM auth_rate_limits WHERE window_start < ?', [Math.floor(now / 1000) - 86400]);
    const [[last]] = await connection.execute(
      'SELECT MAX(window_start * 1000 + attempt_count - 1) AS reserved_at FROM auth_rate_limits WHERE action=? AND key_hash=?', [action, keyHash],
    );
    const remaining = Number(last.reserved_at || 0) + windowSeconds * 1000 - now;
    if (remaining > 0) return { allowed:false, retryAfter:Math.ceil(remaining / 1000) };
    await connection.execute(
      'INSERT INTO auth_rate_limits(action,key_hash,window_start,attempt_count) VALUES (?,?,?,?)', [action, keyHash, Math.floor(now / 1000), now % 1000 + 1],
    );
    return { allowed:true, retryAfter:windowSeconds };
  } finally {
    // Never return a connection to the pool with a named lock still held.
    if (locked) {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
      catch (error) { connection.destroy(); throw error; }
    }
    connection.release();
  }
}
