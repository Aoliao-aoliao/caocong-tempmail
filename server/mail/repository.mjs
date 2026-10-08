import { openDatabase } from '../db/database.mjs';
import { publicMessageId, smtpError } from './mail-utils.mjs';

export async function assertMailSchema() {
  const connection = await openDatabase();
  try {
    await connection.query('SELECT id FROM domains LIMIT 0');
    await connection.query('SELECT id FROM mailboxes LIMIT 0');
    await connection.query('SELECT id FROM messages LIMIT 0');
    await connection.query('SELECT id FROM message_attachments LIMIT 0');
  } finally {
    connection.release();
  }
}

export async function findActiveRecipient(address) {
  const connection = await openDatabase();
  try {
    const [[recipient]] = await connection.execute(`
      SELECT mb.id, mb.address,
             (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id) AS message_count,
             (SELECT COALESCE(SUM(m.size_bytes), 0) FROM messages m WHERE m.mailbox_id = mb.id) AS message_bytes
      FROM mailboxes mb
      JOIN domains d ON d.id = mb.domain_id
      WHERE mb.address = ?
        AND mb.status = 'ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at > UTC_TIMESTAMP(3))
        AND d.status = 'ACTIVE'
        AND d.mx_status = 'ACTIVE'
        AND d.kind <> 'RELAY' AND mb.relay_account_id IS NULL
      LIMIT 1
    `, [address]);
    return recipient || null;
  } finally {
    connection.release();
  }
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

export async function saveDelivery({ recipients, message, attachments, attachmentStore, mailboxQuota, relaySource = null }) {
  const recipientIds = [...new Set(recipients.map((item) => Number(item.id)))].sort((a, b) => a - b);
  if (!recipientIds.length || recipientIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw smtpError('No valid recipients', 554);
  }

  const connection = await openDatabase();
  const cleanupTasks = [];
  try {
    await connection.beginTransaction();
    if (relaySource) {
      const [[account]]=await connection.execute('SELECT status FROM relay_accounts WHERE id=? FOR UPDATE',[relaySource.accountId]);
      // ERROR is retryable: a successful poll must be able to store messages
      // before clearing the diagnostic. The account lock still serializes an
      // administrator's disable with delivery, which never re-enables accounts.
      if(!account || account.status==='DISABLED')throw smtpError('Relay account unavailable; retry after reactivation',451);
    }
    const [activeRows] = await connection.execute(`
      SELECT mb.id, mb.address, mb.created_at
      FROM mailboxes mb
      JOIN domains d ON d.id = mb.domain_id
      WHERE mb.id IN (${placeholders(recipientIds)})
        AND mb.status = 'ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at > UTC_TIMESTAMP(3))
        AND d.status = 'ACTIVE'
        AND d.mx_status = 'ACTIVE'
        AND ${relaySource ? 'mb.relay_account_id = ?' : "d.kind <> 'RELAY' AND mb.relay_account_id IS NULL"}
      ORDER BY mb.id
      FOR UPDATE
    `, relaySource ? [...recipientIds, relaySource.accountId] : recipientIds);

    if (activeRows.length !== recipientIds.length) {
      throw smtpError('Recipient state changed; please retry', 451);
    }

    if (relaySource && recipients.some(recipient => recipient.activated_at !== undefined || recipient.activation_id !== undefined)) {
      // Alias snapshots can outlive a slow IMAP fetch. Read the current recall
      // generation only after locking mailboxes, so a concurrent recall cannot
      // clear old mail and then have that old snapshot recreate it. Retrying
      // lets the poller reevaluate the source against the new activation time.
      const [recalls] = await connection.execute(`
        SELECT mailbox_id, MAX(created_at) AS recalled_at, MAX(id) AS activation_id
        FROM mailbox_recall_requests
        WHERE mailbox_id IN (${placeholders(recipientIds)})
        GROUP BY mailbox_id
      `, recipientIds);
      const recalledAt = new Map(recalls.map(row => [Number(row.mailbox_id), new Date(row.recalled_at).getTime()]));
      const generations = new Map(recalls.map(row => [Number(row.mailbox_id), String(row.activation_id)]));
      const expected = new Map(recipients.map(row => [Number(row.id), row.activated_at]));
      const expectedGenerations = new Map(recipients.map(row => [Number(row.id), row.activation_id]));
      for (const row of activeRows) {
        const generation = expectedGenerations.get(Number(row.id));
        if (generation !== undefined && String(generation) !== (generations.get(Number(row.id)) || '0')) {
          throw smtpError('Recipient activation changed; please retry', 451);
        }
        const snapshot = expected.get(Number(row.id));
        if (snapshot === undefined) continue;
        const current = Math.max(new Date(row.created_at).getTime(), recalledAt.get(Number(row.id)) || 0);
        if (new Date(snapshot).getTime() !== current) {
          throw smtpError('Recipient activation changed; please retry', 451);
        }
      }
    }

    const duplicateMailboxIds = new Set();
    if (message.messageId) {
      const [duplicates] = await connection.execute(`
        SELECT mailbox_id
        FROM messages
        WHERE message_id = ? AND mailbox_id IN (${placeholders(recipientIds)})
      `, [message.messageId, ...recipientIds]);
      duplicates.forEach((row) => duplicateMailboxIds.add(Number(row.mailbox_id)));
    }

    let inserted = 0;
    for (const recipient of activeRows) {
      const mailboxId = Number(recipient.id);
      if (relaySource) {
        const [[delivered]] = await connection.execute(`
          SELECT 1 FROM relay_message_links
          WHERE relay_account_id=? AND uid_validity=? AND imap_uid=? AND mailbox_id=?
          LIMIT 1
        `, [relaySource.accountId, relaySource.uidValidity, relaySource.uid, mailboxId]);
        if (delivered) continue;
        await connection.execute(`
          INSERT IGNORE INTO relay_message_links
            (relay_account_id, uid_validity, imap_uid, mailbox_id)
          VALUES (?, ?, ?, ?)
        `, [relaySource.accountId, relaySource.uidValidity, relaySource.uid, mailboxId]);
      }
      if (duplicateMailboxIds.has(mailboxId)) continue;

      const [[usage]] = await connection.execute(`
        SELECT COUNT(*) AS message_count, COALESCE(SUM(size_bytes), 0) AS message_bytes
        FROM messages
        WHERE mailbox_id = ?
      `, [mailboxId]);
      if (
        Number(usage.message_count) >= mailboxQuota.maxMessages
        || Number(usage.message_bytes) + message.sizeBytes > mailboxQuota.maxBytes
      ) {
        throw smtpError('Mailbox storage quota exceeded; please retry later', 452);
      }

      const publicId = publicMessageId();
      const stored = await attachmentStore.persist(publicId, attachments, message.receivedAt);
      cleanupTasks.push(stored.cleanup);

      const [result] = await connection.execute(`
        INSERT INTO messages
          (public_id, mailbox_id, message_id, from_address, subject, text_content, html_content,
           size_bytes, risk_status, is_read, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?)
      `, [
        publicId,
        mailboxId,
        message.messageId || null,
        message.fromAddress,
        message.subject || null,
        message.textContent || null,
        message.htmlContent || null,
        message.sizeBytes,
        message.riskStatus,
        message.receivedAt,
      ]);

      for (const attachment of stored.records) {
        await connection.execute(`
          INSERT INTO message_attachments
            (message_id, file_name, content_type, size_bytes, storage_key)
          VALUES (?, ?, ?, ?, ?)
        `, [
          result.insertId,
          attachment.fileName,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.storageKey,
        ]);
      }

      await connection.execute(
        'UPDATE mailboxes SET received_count = received_count + 1 WHERE id = ?',
        [mailboxId],
      );
      inserted += 1;
    }

    await connection.commit();
    cleanupTasks.length = 0;
    return { inserted, duplicates: recipientIds.length - inserted };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('[smtp] database rollback failed', rollbackError);
    }
    await Promise.allSettled(cleanupTasks.map((cleanup) => cleanup()));
    throw error;
  } finally {
    connection.release();
  }
}
