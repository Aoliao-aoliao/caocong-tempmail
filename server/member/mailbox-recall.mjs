import { AttachmentStore } from '../mail/attachment-store.mjs';
import { loadSmtpConfig } from '../mail/config.mjs';
import { relayRemoteCleanupEnabled } from '../relay/cleanup.mjs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { activeMailboxLimit, assertExpectedMailboxPrice } from './mailbox-policy.mjs';
import { assertMailboxRecallCaptcha } from './mailbox-captcha.mjs';
import {
  assertMailboxRecallEligible,
  assertMailboxRecallReplayMatches,
  normalizeMailboxRecallRequestId,
  resolveMailboxRecallPlan,
} from './mailbox-recall-policy.mjs';

function normalizeMailboxId(value) {
  const mailboxId = String(value || '').trim();
  if (!/^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailboxId)) {
    throw Object.assign(new Error('邮箱标识无效。'), { status:400 });
  }
  return `MB-${mailboxId.slice(3).toLowerCase()}`;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function recallResult(row) {
  return {
    mailbox:{
      id:row.mailbox_id,
      address:row.address,
      received_count:Number(row.received_count || 0),
      status:row.current_mailbox_status || 'ACTIVE',
      duration_minutes:Number(row.current_duration_minutes ?? row.duration_minutes),
      expires_at:iso(row.current_mailbox_expires_at ?? row.recall_expires_at),
      created_at:iso(row.mailbox_created_at),
    },
    pointsBalance:Number(row.current_points_balance ?? row.points_balance_after),
    price:Number(row.price_points),
    durationHours:Number(row.duration_minutes) / 60,
  };
}

async function findRecallRequest(connection, { userId, requestId }) {
  const [[row]] = await connection.execute(`
    SELECT mb.public_id AS mailbox_id,mb.address,mb.received_count,mb.created_at AS mailbox_created_at,
           mb.status AS current_mailbox_status,mb.duration_minutes AS current_duration_minutes,
           mb.expires_at AS current_mailbox_expires_at,
           rr.duration_minutes,rr.price_points,rr.points_balance_after,
           u.points_balance AS current_points_balance,
           rr.expires_at AS recall_expires_at
    FROM mailbox_recall_requests rr
    JOIN mailboxes mb ON mb.id=rr.mailbox_id
    JOIN users u ON u.id=rr.user_id
    WHERE rr.user_id=? AND rr.request_id=?
    LIMIT 1
  `, [userId, requestId]);
  return row || null;
}

export async function getMailboxRecallByRequestId({
  userId,
  requestId:rawRequestId,
  mailboxId:rawMailboxId,
  durationHours,
  expectedPrice,
}) {
  const requestId = normalizeMailboxRecallRequestId(rawRequestId);
  const mailboxId = normalizeMailboxId(rawMailboxId);
  const connection = await openDatabase();
  try {
    const existing = await findRecallRequest(connection, { userId, requestId });
    if (!existing) return null;
    assertMailboxRecallReplayMatches(existing, { mailboxId, durationHours, expectedPrice });
    return recallResult(existing);
  } finally {
    connection.release();
  }
}

export async function recallMailbox({
  userId,
  mailboxId:rawMailboxId,
  durationHours,
  expectedPrice,
  requestId:rawRequestId,
  captchaVerified = false,
  ipAddress = '',
}) {
  await assertMailboxRecallCaptcha(captchaVerified);
  const mailboxId = normalizeMailboxId(rawMailboxId);
  const requestId = normalizeMailboxRecallRequestId(rawRequestId);
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute(
      'SELECT id,points_balance FROM users WHERE id=? FOR UPDATE',
      [userId],
    );
    if (!user) throw Object.assign(new Error('账户不存在。'), { status:404 });

    // Locking the user row serializes every balance-changing mailbox operation.
    // A completed request is returned before current price or mailbox state is
    // evaluated, while a reused id with different parameters is rejected.
    const existing = await findRecallRequest(connection, { userId, requestId });
    if (existing) {
      assertMailboxRecallReplayMatches(existing, { mailboxId, durationHours, expectedPrice });
      await connection.commit();
      return recallResult(existing);
    }

    const [settingRows] = await connection.execute(`
      SELECT \`key\`,value FROM system_settings
      WHERE \`key\` IN ('mailbox_duration_plans','active_mailbox_limit_per_user')
      FOR UPDATE
    `);
    const settings = Object.fromEntries(settingRows.map((row) => [row.key, row.value]));
    const [[membership]] = await connection.execute(`
      SELECT mp.mailbox_discount_percent
      FROM memberships ms
      JOIN membership_plans mp ON mp.id=ms.plan_id
      WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
      ORDER BY ms.expires_at DESC
      LIMIT 1
    `, [userId]);
    const plan = resolveMailboxRecallPlan({
      rawPlans:settings.mailbox_duration_plans,
      durationHours,
      discountPercent:membership ? Number(membership.mailbox_discount_percent) : 100,
    });
    assertExpectedMailboxPrice(expectedPrice, plan.price);

    // Serialize account allocation before locking its domain/mailbox, matching
    // the creation path. The user lock above prevents a concurrent own recall.
    const [[relayBinding]] = await connection.execute(
      'SELECT relay_account_id FROM mailboxes WHERE public_id=? AND user_id=?', [mailboxId, userId],
    );
    let relayAccount;
    if (relayBinding?.relay_account_id != null) {
      [[relayAccount]] = await connection.execute(
        'SELECT id,status,max_aliases FROM relay_accounts WHERE id=? FOR UPDATE', [relayBinding.relay_account_id],
      );
    }

    const [[mailbox]] = await connection.execute(`
      SELECT mb.id,mb.public_id,mb.address,mb.received_count,mb.duration_minutes,mb.relay_account_id,
             mb.status,mb.expires_at,mb.created_at,d.kind AS domain_kind,
             d.owner_user_id AS domain_owner_user_id,d.status AS domain_status,d.mx_status,
             (mb.expires_at IS NOT NULL AND mb.expires_at<=UTC_TIMESTAMP(3)) AS is_expired,
             UTC_TIMESTAMP(3) AS database_now
      FROM mailboxes mb
      JOIN domains d ON d.id=mb.domain_id
      WHERE mb.public_id=? AND mb.user_id=?
      LIMIT 1
      FOR UPDATE
    `, [mailboxId, userId]);
    if (!mailbox) {
      throw Object.assign(new Error('邮箱不存在或无权召回。'), { status:404 });
    }
    assertMailboxRecallEligible({
      status:mailbox.status,
      isExpired:mailbox.is_expired,
      expiresAt:mailbox.expires_at,
    });
    if (mailbox.domain_status !== 'ACTIVE' || mailbox.mx_status !== 'ACTIVE') {
      throw Object.assign(new Error('该邮箱所属域名当前不可用。'), { status:409 });
    }
    if (mailbox.domain_kind === 'PRIVATE' && Number(mailbox.domain_owner_user_id) !== Number(userId)) {
      throw Object.assign(new Error('该邮箱所属域名当前不可用。'), { status:409 });
    }
    if (mailbox.domain_kind === 'MEMBER' && !membership) {
      throw Object.assign(new Error('有效会员才可以召回该邮箱。'), { status:409 });
    }

    if (mailbox.domain_kind === 'RELAY' || mailbox.relay_account_id != null) {
      if (!relayAccount || Number(relayAccount.id) !== Number(mailbox.relay_account_id) || relayAccount.status !== 'ACTIVE') {
        throw Object.assign(new Error('中继账号当前不可用，未扣除积分，请稍后再试。'), { status:409 });
      }
      const [[usage]] = await connection.execute(
        "SELECT COUNT(*) AS count FROM mailboxes WHERE relay_account_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) FOR UPDATE", [relayAccount.id],
      );
      if (Number(usage.count) >= Number(relayAccount.max_aliases)) {
        throw Object.assign(new Error('中继账号容量已满，未扣除积分，请稍后再试。'), { status:409 });
      }
    }

    const limit = activeMailboxLimit(settings.active_mailbox_limit_per_user);
    const [[activeCount]] = await connection.execute(`
      SELECT COUNT(*) AS count
      FROM mailboxes
      WHERE user_id=? AND status='ACTIVE'
        AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))
    `, [userId]);
    if (Number(activeCount.count) >= limit) {
      throw Object.assign(new Error(`当前活动邮箱已达上限（${limit} 个）。`), { status:409 });
    }

    const before = Number(user.points_balance);
    if (before < plan.price) {
      throw Object.assign(new Error('当前积分不足，请先充值。'), { status:409 });
    }
    const after = before - plan.price;
    if (plan.price > 0) {
      const [deduction] = await connection.execute(`
        UPDATE users
        SET points_balance=points_balance-?
        WHERE id=? AND points_balance>=?
      `, [plan.price, userId, plan.price]);
      if (Number(deduction.affectedRows) !== 1) {
        throw Object.assign(new Error('当前积分不足，请先充值。'), { status:409 });
      }
    }

    // The mailbox row lock also serializes delivery and maintenance. Remove
    // expired contents before changing its lifetime; failed transactions leave
    // files untouched, and upstream cleanup retains shared unexpired references,
    // including paused/hidden mailboxes that can still be resumed.
    const [attachments] = await connection.execute(`
      SELECT ma.storage_key FROM message_attachments ma
      JOIN messages m ON m.id=ma.message_id WHERE m.mailbox_id=?
    `,[mailbox.id]);
    if (await relayRemoteCleanupEnabled(connection)) {
      await connection.execute(`
        INSERT INTO relay_remote_cleanup_jobs(relay_account_id,uid_validity,imap_uid,status,next_attempt_at)
        SELECT links.relay_account_id,links.uid_validity,links.imap_uid,'PENDING',UTC_TIMESTAMP(3)
        FROM relay_message_links links WHERE links.mailbox_id=?
          AND NOT EXISTS (
            SELECT 1 FROM relay_message_links other_links
            JOIN mailboxes other_box ON other_box.id=other_links.mailbox_id
            WHERE other_links.relay_account_id=links.relay_account_id
              AND other_links.uid_validity=links.uid_validity AND other_links.imap_uid=links.imap_uid
              AND other_box.id<>? AND other_box.status<>'EXPIRED'
              AND (other_box.expires_at IS NULL OR other_box.expires_at>UTC_TIMESTAMP(3))
          )
        ON DUPLICATE KEY UPDATE status=IF(status IN ('DONE','SKIPPED'),status,'PENDING')
      `,[mailbox.id,mailbox.id]);
    }
    await connection.execute('DELETE FROM messages WHERE mailbox_id=?',[mailbox.id]);
    await connection.execute('DELETE FROM relay_message_links WHERE mailbox_id=?',[mailbox.id]);
    const databaseNow = new Date(mailbox.database_now);
    const expiresAt = new Date(databaseNow.getTime() + plan.durationMinutes * 60000);
    await connection.execute(`
      UPDATE mailboxes
      SET status='ACTIVE',duration_minutes=?,expires_at=?
      WHERE id=?
    `, [plan.durationMinutes, expiresAt, mailbox.id]);

    const recallPublicId = `MR-${randomUUID()}`;
    await connection.execute(`
      INSERT INTO mailbox_recall_requests
        (public_id,request_id,user_id,mailbox_id,duration_minutes,price_points,points_balance_after,expires_at)
      VALUES (?,?,?,?,?,?,?,?)
    `, [
      recallPublicId,
      requestId,
      userId,
      mailbox.id,
      plan.durationMinutes,
      plan.price,
      after,
      expiresAt,
    ]);

    if (plan.price > 0) {
      await connection.execute(`
        INSERT INTO point_transactions
          (public_id,user_id,type,amount,balance_after,reference_type,reference_id,note)
        VALUES (?,?,'MAILBOX_PURCHASE',?,?,'MAILBOX_RECALL',?,'召回邮箱')
      `, [`PT-${randomUUID()}`, userId, -plan.price, after, recallPublicId]);
    }
    await connection.execute(`
      INSERT INTO audit_logs
        (public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address)
      VALUES (?,?,'用户召回邮箱','MAILBOX',?,?,?)
    `, [
      `AL-${randomUUID()}`,
      userId,
      mailbox.public_id,
      JSON.stringify({
        requestId,
        recallId:recallPublicId,
        durationMinutes:plan.durationMinutes,
        price:plan.price,
        pointsBalanceAfter:after,
        previousStatus:mailbox.status,
        previousExpiresAt:iso(mailbox.expires_at),
        expiresAt:expiresAt.toISOString(),
      }),
      String(ipAddress || '').slice(0, 45) || null,
    ]);

    await connection.commit();
    if (attachments.length) {
      try {
        const store = new AttachmentStore(loadSmtpConfig().storageRoot);
        await store.initialize();
        await store.removeStorageKeys(attachments.map(row=>row.storage_key));
      } catch {
        console.error('[mail-recall] attachment cleanup failed after commit');
      }
    }
    return recallResult({
      mailbox_id:mailbox.public_id,
      address:mailbox.address,
      received_count:mailbox.received_count,
      mailbox_created_at:mailbox.created_at,
      current_mailbox_status:'ACTIVE',
      current_duration_minutes:plan.durationMinutes,
      current_mailbox_expires_at:expiresAt,
      duration_minutes:plan.durationMinutes,
      price_points:plan.price,
      points_balance_after:after,
      current_points_balance:after,
      recall_expires_at:expiresAt,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
