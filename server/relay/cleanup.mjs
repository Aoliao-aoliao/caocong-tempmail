import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { createRelayClient } from './connection.mjs';

const enabledValue = (value) => String(value || '').toLowerCase() === 'true';
const safeText = (error) => String(error?.message || 'IMAP 清理失败。').replace(/[\r\n]+/g, ' ').slice(0, 500);

export async function relayRemoteCleanupEnabled(connection = null) {
  const ownConnection = !connection;
  const db = connection || await openDatabase();
  try {
    const [[row]] = await db.execute("SELECT value FROM system_settings WHERE `key`='relay_remote_cleanup_enabled' LIMIT 1");
    return enabledValue(row?.value);
  } finally {
    if (ownConnection) db.release();
  }
}

export async function getRelayCleanupStatus() {
  const connection = await openDatabase();
  try {
    const enabled = await relayRemoteCleanupEnabled(connection);
    const [[counts]] = await connection.execute(`
      SELECT
        SUM(status IN ('PENDING','RETRY')) AS pending,
        SUM(status='DONE') AS completed,
        SUM(status='SKIPPED') AS skipped
      FROM relay_remote_cleanup_jobs
    `);
    return {
      enabled,
      pending: Number(counts?.pending || 0),
      completed: Number(counts?.completed || 0),
      skipped: Number(counts?.skipped || 0),
    };
  } finally {
    connection.release();
  }
}

export async function setRelayCleanupEnabled({ enabled, actorUserId, ipAddress }) {
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    await connection.execute(`
      INSERT INTO system_settings (\`key\`, value, value_type, description, updated_by_user_id)
      VALUES ('relay_remote_cleanup_enabled', ?, 'boolean', '中继邮箱到期后将已保存的上游原邮件移入垃圾箱', ?)
      ON DUPLICATE KEY UPDATE value=VALUES(value), updated_by_user_id=VALUES(updated_by_user_id)
    `, [enabled ? 'true' : 'false', actorUserId || null]);
    await connection.execute(`
      INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address)
      VALUES (?,?,'更新中继原邮件清理','SYSTEM_SETTING','relay_remote_cleanup_enabled',?,?)
    `, [`AL-${randomUUID()}`, actorUserId || null, JSON.stringify({ enabled: Boolean(enabled) }), String(ipAddress || '').slice(0, 45) || null]);
    await connection.commit();
    return getRelayCleanupStatus();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function finishJob(id, status, error = null) {
  const connection = await openDatabase();
  try {
    await connection.execute(`
      UPDATE relay_remote_cleanup_jobs
      SET status=?, last_error=?, completed_at=UTC_TIMESTAMP(3)
      WHERE id=? AND status IN ('PENDING','RETRY')
    `, [status, error, id]);
  } finally {
    connection.release();
  }
}

async function retryJob(id, attempts, error) {
  const connection = await openDatabase();
  try {
    const delayMinutes = Math.min(360, Math.max(1, 2 ** Math.min(8, attempts)));
    await connection.execute(`
      UPDATE relay_remote_cleanup_jobs
      SET status='RETRY', attempts=attempts+1,
          next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), last_error=?
      WHERE id=? AND status IN ('PENDING','RETRY')
    `, [delayMinutes, safeText(error), id]);
  } finally {
    connection.release();
  }
}

export async function hasProtectedRelayReference(job) {
  const connection = await openDatabase();
  try {
    const [[row]] = await connection.execute(`
      SELECT 1 AS protected
      FROM relay_message_links links
      JOIN mailboxes mb ON mb.id=links.mailbox_id
      WHERE links.relay_account_id=? AND links.uid_validity=? AND links.imap_uid=?
        AND mb.status<>'EXPIRED'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
      LIMIT 1
    `, [job.relay_account_id, job.uid_validity, job.imap_uid]);
    return Boolean(row);
  } finally {
    connection.release();
  }
}

async function deferProtectedJob(id) {
  const connection = await openDatabase();
  try {
    // A paused/hidden mailbox may be resumed before expiry. Keep this task pending so
    // its source is still cleaned once every surviving reference has expired.
    await connection.execute(`
      UPDATE relay_remote_cleanup_jobs
      SET status='RETRY', next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE),
          last_error='关联邮箱仍在有效期内，暂缓清理。'
      WHERE id=? AND status IN ('PENDING','RETRY')
    `, [id]);
  } finally {
    connection.release();
  }
}

export async function cleanupAccount(account, jobs, dependencies = {}) {
  const client = await (dependencies.createClient || createRelayClient)(account);
  const finish = dependencies.finishJob || finishJob;
  const retry = dependencies.retryJob || retryJob;
  const hasProtectedReference = dependencies.hasProtectedReference || hasProtectedRelayReference;
  const defer = dependencies.deferProtectedJob || deferProtectedJob;
  try {
    await client.connect();
    const folders = await client.list();
    const trash = folders.find((folder) => folder.specialUse === '\\Trash');
    if (!trash?.path) throw new Error('邮箱服务商未提供可识别的垃圾箱目录。');
    const lock = await client.getMailboxLock('INBOX');
    try {
      const currentValidity = Number(client.mailbox?.uidValidity || 0);
      for (const job of jobs) {
        if (Number(job.uid_validity) !== currentValidity) {
          await finish(job.id, 'SKIPPED', 'INBOX 唯一标识已变化，为防止误删已跳过。');
          continue;
        }
        try {
          const found = await client.search({ uid: String(job.imap_uid) }, { uid: true });
          if (!Array.isArray(found) || !found.includes(Number(job.imap_uid))) {
            await finish(job.id, 'DONE', '原邮件已不在收件箱，无需重复清理。');
            continue;
          }
          // Recheck just before the external operation, including tasks queued
          // by older versions or before another mailbox was resumed. This is
          // a fresh safety check, not an atomic DB/IMAP transaction.
          if (await hasProtectedReference(job)) {
            await defer(job.id);
            continue;
          }
          const moved = await client.messageMove(String(job.imap_uid), trash.path, { uid: true });
          if (moved === false) throw new Error('邮箱服务商未确认移动结果。');
          await finish(job.id, 'DONE');
        } catch (error) {
          await retry(job.id, Number(job.attempts || 0), error);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function runRelayRemoteCleanup({ batchSize = 50 } = {}, dependencies = {}) {
  if (!await relayRemoteCleanupEnabled()) return { processed: 0, disabled: true };
  const connection = await openDatabase();
  let rows;
  try {
    [rows] = await connection.query(`
      SELECT job.*, ra.provider, ra.public_id, ra.email,
             ra.imap_host, ra.imap_port, ra.imap_secure, ra.username,
             ra.credential_ciphertext, ra.credential_kdf_salt, ra.credential_iv, ra.credential_auth_tag
      FROM relay_remote_cleanup_jobs job
      JOIN relay_accounts ra ON ra.id=job.relay_account_id
      WHERE job.status IN ('PENDING','RETRY') AND job.next_attempt_at<=UTC_TIMESTAMP(3)
      ORDER BY job.id
      LIMIT ${Math.max(1, Math.min(200, Math.trunc(Number(batchSize) || 50)))}
    `);
  } finally {
    connection.release();
  }
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.relay_account_id)) groups.set(row.relay_account_id, []);
    groups.get(row.relay_account_id).push(row);
  }
  for (const jobs of groups.values()) {
    try {
      await cleanupAccount(jobs[0], jobs, dependencies);
    } catch (error) {
      for (const job of jobs) await retryJob(job.id, Number(job.attempts || 0), error);
    }
  }
  return { processed: rows.length, disabled: false };
}
