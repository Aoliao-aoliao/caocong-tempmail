import { openDatabase } from '../db/database.mjs';
import { relayRemoteCleanupEnabled, runRelayRemoteCleanup } from '../relay/cleanup.mjs';

function placeholders(values) {
  return values.map(() => '?').join(',');
}

export async function runMailboxMaintenance({ attachmentStore, batchSize = 500 }) {
  const safeBatchSize = Math.max(10, Math.min(5000, Math.trunc(Number(batchSize) || 500)));
  const retriedCleanup = await attachmentStore.retryPendingCleanup();
  const connection = await openDatabase();
  let expiredCount = 0;
  let cleanedExpiredMailboxes = 0;
  let deletedExpiredMessages = 0;
  let deletedGuestMailboxes = 0;
  let deletedGuestSessions = 0;
  let storageKeys = [];

  try {
    await connection.beginTransaction();
    const [expiredResult] = await connection.execute(`
      UPDATE mailboxes
      SET status = 'EXPIRED'
      WHERE status = 'ACTIVE'
        AND expires_at IS NOT NULL
        AND expires_at <= UTC_TIMESTAMP(3)
    `);
    expiredCount = Number(expiredResult.affectedRows || 0);

    // Registered mailboxes remain as lightweight records so their address can
    // be recalled later. Their message contents do not: once the mailbox has
    // expired, destroy the inbox and attachments before a recall can reactivate
    // the address. Selecting already-expired rows as well makes cleanup
    // self-healing for data created before this rule existed.
    const [expiredMailboxRows] = await connection.query(`
      SELECT mb.id
      FROM mailboxes mb
      WHERE mb.user_id IS NOT NULL
        AND mb.guest_session_id IS NULL
        AND mb.expires_at IS NOT NULL
        AND mb.expires_at <= UTC_TIMESTAMP(3)
        AND (
          EXISTS (SELECT 1 FROM messages m WHERE m.mailbox_id = mb.id)
          OR EXISTS (SELECT 1 FROM relay_message_links rml WHERE rml.mailbox_id = mb.id)
        )
      ORDER BY mb.id
      LIMIT ${safeBatchSize}
      FOR UPDATE
    `);
    const expiredMailboxIds = expiredMailboxRows.map((row) => Number(row.id));
    if (expiredMailboxIds.length) {
      const [attachmentRows] = await connection.execute(`
        SELECT ma.storage_key
        FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
        WHERE m.mailbox_id IN (${placeholders(expiredMailboxIds)})
      `, expiredMailboxIds);
      storageKeys.push(...attachmentRows.map((row) => row.storage_key));

      const [messageResult] = await connection.execute(
        `DELETE FROM messages WHERE mailbox_id IN (${placeholders(expiredMailboxIds)})`,
        expiredMailboxIds,
      );
      cleanedExpiredMailboxes = expiredMailboxIds.length;
      deletedExpiredMessages = Number(messageResult.affectedRows || 0);
    }

    const [guestRows] = await connection.query(`
      SELECT mb.id, mb.domain_id
      FROM mailboxes mb
      JOIN guest_sessions gs ON gs.id = mb.guest_session_id
      WHERE mb.guest_session_id IS NOT NULL
        AND (
          mb.status = 'EXPIRED'
          OR (mb.expires_at IS NOT NULL AND mb.expires_at <= UTC_TIMESTAMP(3))
          OR gs.expires_at <= UTC_TIMESTAMP(3)
        )
      ORDER BY mb.id
      LIMIT ${safeBatchSize}
      FOR UPDATE
    `);

    const mailboxIds = guestRows.map((row) => Number(row.id));
    const relayCleanupMailboxIds = [...new Set([...expiredMailboxIds, ...mailboxIds])];
    if (relayCleanupMailboxIds.length) {
      if (await relayRemoteCleanupEnabled(connection)) {
        // Pausing/hiding does not end a mailbox's lifetime; it may be resumed
        // while its original source mail is still needed.
        await connection.execute(`
          INSERT INTO relay_remote_cleanup_jobs
            (relay_account_id, uid_validity, imap_uid, status, next_attempt_at)
          SELECT DISTINCT links.relay_account_id, links.uid_validity, links.imap_uid, 'PENDING', UTC_TIMESTAMP(3)
          FROM relay_message_links links
          WHERE links.mailbox_id IN (${placeholders(relayCleanupMailboxIds)})
            AND NOT EXISTS (
              SELECT 1
              FROM relay_message_links other_links
              JOIN mailboxes other_box ON other_box.id=other_links.mailbox_id
              WHERE other_links.relay_account_id=links.relay_account_id
                AND other_links.uid_validity=links.uid_validity
                AND other_links.imap_uid=links.imap_uid
                AND other_box.status<>'EXPIRED'
                AND (other_box.expires_at IS NULL OR other_box.expires_at>UTC_TIMESTAMP(3))
            )
          ON DUPLICATE KEY UPDATE
            status=IF(status IN ('DONE','SKIPPED'), status, 'PENDING'),
            next_attempt_at=IF(status IN ('DONE','SKIPPED'), next_attempt_at, UTC_TIMESTAMP(3))
        `, relayCleanupMailboxIds);
      }
      if (expiredMailboxIds.length) {
        await connection.execute(
          `DELETE FROM relay_message_links WHERE mailbox_id IN (${placeholders(expiredMailboxIds)})`,
          expiredMailboxIds,
        );
      }
    }
    if (mailboxIds.length) {
      const [attachmentRows] = await connection.execute(`
        SELECT ma.storage_key
        FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
        WHERE m.mailbox_id IN (${placeholders(mailboxIds)})
      `, mailboxIds);
      storageKeys.push(...attachmentRows.map((row) => row.storage_key));

      const domainCounts = new Map();
      guestRows.forEach((row) => {
        const domainId = Number(row.domain_id);
        domainCounts.set(domainId, (domainCounts.get(domainId) || 0) + 1);
      });
      await connection.execute(
        `DELETE FROM mailboxes WHERE id IN (${placeholders(mailboxIds)})`,
        mailboxIds,
      );
      for (const [domainId, count] of domainCounts) {
        await connection.execute(
          // Unsigned subtraction below zero is an SQL error, not a clamp.
          'UPDATE domains SET mailbox_count = IF(mailbox_count > ?, mailbox_count - ?, 0) WHERE id = ?',
          [count, count, domainId],
        );
      }
      deletedGuestMailboxes = mailboxIds.length;
    }

    const [sessionResult] = await connection.execute(`
      DELETE gs
      FROM guest_sessions gs
      LEFT JOIN mailboxes mb ON mb.guest_session_id = gs.id
      WHERE gs.expires_at <= UTC_TIMESTAMP(3)
        AND mb.id IS NULL
    `);
    deletedGuestSessions = Number(sessionResult.affectedRows || 0);
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('[mail-cleanup] database rollback failed', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }

  const attachmentCleanupFailures = await attachmentStore.removeStorageKeys(storageKeys);
  const remoteCleanup = await runRelayRemoteCleanup({ batchSize: Math.min(safeBatchSize, 100) });
  return {
    expiredCount,
    cleanedExpiredMailboxes,
    deletedExpiredMessages,
    deletedGuestMailboxes,
    deletedGuestSessions,
    attachmentCleanupFailures,
    retriedCleanup,
    remoteCleanup,
  };
}

export function startMailboxMaintenance({ config, attachmentStore }) {
  let stopped = false;
  let timer;
  let currentRun = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, config.cleanupIntervalMs);
    timer.unref();
  };
  const run = () => {
    if (stopped) return;
    currentRun = runMailboxMaintenance({
      attachmentStore,
      batchSize: config.cleanupBatchSize,
    }).then((result) => {
      if (
        result.expiredCount
        || result.cleanedExpiredMailboxes
        || result.deletedGuestMailboxes
        || result.deletedGuestSessions
      ) {
        console.info('[mail-cleanup] completed', result);
      }
    }).catch((error) => {
      console.error('[mail-cleanup] failed', {
        name: error?.name || 'Error',
        code: error?.code || undefined,
        message: error?.message || String(error),
      });
    }).finally(schedule);
  };

  run();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await currentRun;
    },
  };
}
