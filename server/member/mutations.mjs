import {readReceipt,saveReceipt} from './business-receipts.mjs';
import { htmlToPlainText } from '../mail/body-text.mjs';
import { normalizeMailboxRecallRequestId } from './mailbox-recall-policy.mjs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { defaultApiRateLimit, insertApiKey } from './api-key.mjs';
import { activeMailboxLimit, assertExpectedMailboxPrice, isValidMailboxDuration, discountedMailboxPrice } from './mailbox-policy.mjs';

const cleanDomain = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function assertApiKeyRotationAllowed(latestStatus) {
  if (latestStatus === 'DISABLED') {
    throw Object.assign(new Error('API Key 已被管理员停用，暂时不能重置。'),{status:403});
  }
}

export async function purchaseMembership({ userId, code, expectedPrice, requestId }) {
  requestId = normalizeMailboxRecallRequestId(requestId);
  code = String(code || '');
  if (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0) throw Object.assign(new Error('请刷新页面确认会员价格后重试。'), {status:400});
  const operationId = `MP-${userId}-${requestId}`;
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[userId]);
    const receipt = await readReceipt(connection,operationId,userId,'用户购买会员');
    if (receipt) {
      const record = typeof receipt.detail_json === 'string' ? JSON.parse(receipt.detail_json) : receipt.detail_json;
      if (record.code !== code || record.expectedPrice !== expectedPrice) throw Object.assign(new Error('该请求标识已用于其他会员购买。'), {status:409});
      await connection.commit();
      return {...record.result, pointsBalance:Number(user.points_balance)};
    }
    const [[plan]] = await connection.execute('SELECT * FROM membership_plans WHERE code=? AND enabled=1 FOR UPDATE',[String(code || '')]);
    if (!user) throw new Error('账户不存在。');
    if (!plan) throw new Error('会员套餐不存在或已停止销售。');
    const balance = Number(user.points_balance);
    const price = Number(plan.price_points);
    if(expectedPrice!==price)throw Object.assign(new Error('会员价格已更新，请刷新页面后重新确认。'),{status:409});
    if (balance < price) throw new Error('当前积分不足，请先充值。');
    const [[current]] = await connection.execute("SELECT id,expires_at FROM memberships WHERE user_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP(3) ORDER BY expires_at DESC LIMIT 1 FOR UPDATE",[userId]);
    const startsAt = current?.expires_at && new Date(current.expires_at) > new Date() ? new Date(current.expires_at) : new Date();
    const expiresAt = new Date(startsAt.getTime() + Number(plan.duration_days) * 86400000);
    await connection.execute("UPDATE memberships SET status='EXPIRED' WHERE user_id=? AND status='ACTIVE'",[userId]);
    const [result] = await connection.execute("INSERT INTO memberships(user_id,plan_id,status,starts_at,expires_at) VALUES (?,?,'ACTIVE',?,?)",[userId,plan.id,new Date(),expiresAt]);
    const after = balance - price;
    await connection.execute('UPDATE users SET points_balance=? WHERE id=?',[after,userId]);
    await connection.execute(`INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note)
      VALUES (?,?,'MEMBERSHIP_PURCHASE',?,?,'MEMBERSHIP',?,'开通会员')`,[`PT-${randomUUID()}`,userId,-price,after,String(result.insertId)]);
    const response = { pointsBalance:after, expiresAt:expiresAt.toISOString(), plan:{ code:plan.code,name:plan.name,durationDays:Number(plan.duration_days) } };
    await saveReceipt(connection,{publicId:operationId,userId,action:'用户购买会员',entityType:'MEMBERSHIP',entityId:String(result.insertId),detail:{code,expectedPrice,result:response}});
    // Temporary audit copy also permits rollback to the pre-receipt application.
    await connection.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'用户购买会员','MEMBERSHIP',?,?)", [operationId,userId,String(result.insertId),JSON.stringify({code,expectedPrice,result:response})]);
    await connection.commit();
    return response;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function createPrivateDomain({ userId, domain:rawDomain }) {
  const domain = cleanDomain(rawDomain);
  if (!domainPattern.test(domain) || domain.length > 253) throw new Error('请输入有效的根域名。');
  const connection = await openDatabase();
  try {
    const [[member]] = await connection.execute("SELECT 1 FROM memberships WHERE user_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP(3) LIMIT 1",[userId]);
    if (!member) throw new Error('有效会员才可以添加私有域名。');
    await connection.execute("INSERT INTO domains(domain,kind,owner_user_id,mx_status,status) VALUES (?,'PRIVATE',?,'PENDING','PENDING')",[domain,userId]);
    return { domain, mx_status:'PENDING', status:'PENDING', mailbox_count:0, created_at:new Date().toISOString() };
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw new Error('该域名已经存在。');
    throw error;
  } finally { connection.release(); }
}

export async function rotateApiKey({ userId, ipAddress }) {
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);
    if (!user) throw Object.assign(new Error('账户不存在。'),{status:404});
    const [[latestKey]] = await connection.execute("SELECT status FROM api_keys WHERE user_id=? AND status IN ('ACTIVE','DISABLED') ORDER BY id DESC LIMIT 1 FOR UPDATE",[userId]);
    assertApiKeyRotationAllowed(latestKey?.status);
    const [[member]] = await connection.execute("SELECT mp.api_limit_multiplier FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) ORDER BY ms.expires_at DESC LIMIT 1",[userId]);
    const [revoked] = await connection.execute("UPDATE api_keys SET status='REVOKED' WHERE user_id=? AND status<>'REVOKED'",[userId]);
    const result = await insertApiKey(connection, {
      userId,
      rateLimit:defaultApiRateLimit * Number(member?.api_limit_multiplier || 1),
    });
    await connection.execute(`
      INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address)
      VALUES (?,?,?, 'API_KEY', ?, ?, ?)
    `, [
      `AL-${randomUUID()}`,
      userId,
      '用户重置 API Key',
      result.id,
      JSON.stringify({ revokedCount:Number(revoked.affectedRows || 0) }),
      String(ipAddress || '').slice(0,45) || null,
    ]);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function createRechargeOrder(_input) {
  throw Object.assign(new Error('人工支付渠道未接通，请使用 NodeLoc 或在线 USDT / TRC20 支付。'),{status:409});
}

export async function isMailboxCaptchaRequired() {
  const connection = await openDatabase();
  try {
    const [[setting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='captcha_before_mailbox_create'");
    return setting?.value === 'true';
  } finally {
    connection.release();
  }
}

function normalizeMailboxRequestId(value, { required=false }={}) {
  const requestId=String(value || '').trim().toLowerCase();
  if (!requestId && !required) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw Object.assign(new Error('请求标识无效。'), { status:400, code:'INVALID_MAILBOX_REQUEST_ID' });
  }
  return requestId;
}

const mailboxMutationResult = (row) => ({
  id:row.public_id,
  address:row.address,
  received_count:Number(row.received_count || 0),
  status:row.status,
  duration_minutes:Number(row.duration_minutes || 0),
  expires_at:row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString(),
  created_at:row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  pointsBalance:Number(row.points_balance || 0),
  price:Number(row.price || 0),
});

export async function getMailboxByRequestId({ userId, requestId }) {
  const normalizedRequestId=normalizeMailboxRequestId(requestId,{required:true});
  const connection=await openDatabase();
  try {
    const [[mailbox]]=await connection.execute(`
      SELECT mb.public_id,mb.address,mb.received_count,mb.status,mb.duration_minutes,
             mb.expires_at,mb.created_at,u.points_balance,
             COALESCE(-pt.amount,0) AS price
      FROM mailboxes mb
      JOIN users u ON u.id=mb.user_id
      LEFT JOIN point_transactions pt
        ON pt.user_id=mb.user_id AND pt.reference_type='MAILBOX'
       AND CAST(pt.reference_id AS UNSIGNED)=mb.id AND pt.type='MAILBOX_PURCHASE'
      WHERE mb.user_id=? AND mb.request_id=?
      LIMIT 1
    `,[userId,normalizedRequestId]);
    return mailbox ? mailboxMutationResult(mailbox) : null;
  } finally {
    connection.release();
  }
}

export async function createMailbox({
  userId,
  localPart,
  domain,
  durationMinutes,
  requestId = null,
  expectedPrice = null,
  captchaVerified = false,
  captchaExempt = false,
}) {
  const normalizedRequestId=normalizeMailboxRequestId(requestId);
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[userId]);
    if (!user) throw Object.assign(new Error('账户不存在。'), { status:404 });

    // A completed idempotent request always wins over later policy, price,
    // captcha, or rate-limit changes. This also serializes concurrent creates
    // for the same user through the user row lock.
    if (normalizedRequestId) {
      const [[existing]]=await connection.execute(`
        SELECT mb.public_id,mb.address,mb.received_count,mb.status,mb.duration_minutes,
               mb.expires_at,mb.created_at,? AS points_balance,
               COALESCE(-pt.amount,0) AS price
        FROM mailboxes mb
        LEFT JOIN point_transactions pt
          ON pt.user_id=mb.user_id AND pt.reference_type='MAILBOX'
         AND CAST(pt.reference_id AS UNSIGNED)=mb.id AND pt.type='MAILBOX_PURCHASE'
        WHERE mb.user_id=? AND mb.request_id=?
        LIMIT 1
      `,[user.points_balance,userId,normalizedRequestId]);
      if (existing) {
        await connection.commit();
        return mailboxMutationResult(existing);
      }
    }

    const local = String(localPart || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(local)) throw new Error('邮箱名称只能包含字母、数字、点、下划线和横线。');
    const minutes = Number(durationMinutes);
    if (!isValidMailboxDuration(minutes)) throw new Error('邮箱有效时长不合法或超出支持范围。');
    const [settingRows] = await connection.execute(`
      SELECT \`key\`,value FROM system_settings
      WHERE \`key\` IN ('mailbox_duration_plans','captcha_before_mailbox_create','active_mailbox_limit_per_user')
    `);
    const settings=Object.fromEntries(settingRows.map((row)=>[row.key,row.value]));
    if (settings.captcha_before_mailbox_create === 'true' && !captchaVerified && !captchaExempt) {
      throw Object.assign(new Error('请先完成人机验证。'), { status:403 });
    }
    let plans=[];try{plans=JSON.parse(settings.mailbox_duration_plans||'[]')}catch{}
    const configuredPlan=Array.isArray(plans)?plans.find(item=>item.enabled!==false && Number(item.minutes)===minutes):null;
    if (!configuredPlan) throw new Error('邮箱有效时长不合法或已停用。');
    const [[domainRow]] = await connection.execute("SELECT id,kind,owner_user_id FROM domains WHERE domain=? AND status='ACTIVE' AND mx_status='ACTIVE' AND kind<>'RELAY' AND (kind<>'PRIVATE' OR owner_user_id=?) FOR UPDATE",[String(domain || '').toLowerCase(),userId]);
    if (!domainRow) throw new Error('该收信域名当前不可用。');
    const [[membership]] = await connection.execute("SELECT mp.mailbox_discount_percent FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) ORDER BY ms.expires_at DESC LIMIT 1",[userId]);
    if (domainRow.kind === 'MEMBER' && !membership) throw new Error('该域名仅限会员使用。');
    const basePrice = Number(configuredPlan.points);
    if (!Number.isSafeInteger(basePrice) || basePrice < 0) throw new Error('邮箱价格配置不合法。');
    const price = discountedMailboxPrice(basePrice, membership ? Number(membership.mailbox_discount_percent) : 100);
    assertExpectedMailboxPrice(expectedPrice,price);
    const limit=activeMailboxLimit(settings.active_mailbox_limit_per_user);
    const [[activeCount]]=await connection.execute(`
      SELECT COUNT(*) AS count FROM mailboxes
      WHERE user_id=? AND status='ACTIVE'
        AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))
    `,[userId]);
    if (Number(activeCount.count)>=limit) {
      throw Object.assign(new Error(`当前活动邮箱已达上限（${limit} 个）。`), { status:409 });
    }
    const before = Number(user.points_balance);
    if (before < price) throw new Error('当前积分不足，请先充值。');
    const address = `${local}@${String(domain).toLowerCase()}`;
    const publicId = `MB-${randomUUID()}`;
    const expiresAt = new Date(Date.now()+minutes*60000);
    const [result] = await connection.execute("INSERT INTO mailboxes(public_id,request_id,user_id,domain_id,address,duration_minutes,status,expires_at) VALUES (?,?,?,?,?,?,'ACTIVE',?)",[publicId,normalizedRequestId,userId,domainRow.id,address,minutes,expiresAt]);
    await connection.execute('UPDATE domains SET mailbox_count=mailbox_count+1 WHERE id=?',[domainRow.id]);
    if (price>0) {
      const after = before-price;
      await connection.execute('UPDATE users SET points_balance=? WHERE id=?',[after,userId]);
      await connection.execute(`INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note)
        VALUES (?,?,'MAILBOX_PURCHASE',?,?,'MAILBOX',?,'创建邮箱')`,[`PT-${randomUUID()}`,userId,-price,after,String(result.insertId)]);
    }
    await connection.commit();
    return { id:publicId,address,received_count:0,status:'ACTIVE',duration_minutes:minutes,expires_at:expiresAt.toISOString(),created_at:new Date().toISOString(),pointsBalance:before-price,price };
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') throw new Error('该邮箱地址已被使用。');
    throw error;
  } finally { connection.release(); }
}



export async function readMessage({ userId, messageId }) {
  const connection = await openDatabase();
  try {
    const [[message]] = await connection.execute(`
      SELECT m.public_id AS id, mb.address AS recipient, m.from_address AS sender,
             m.subject, m.text_content, m.html_content, m.size_bytes, m.is_read, m.received_at
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE m.public_id=? AND mb.user_id=? AND mb.status='ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
        AND m.risk_status='SAFE'
      LIMIT 1
    `, [String(messageId || ''), userId]);
    if (!message) throw Object.assign(new Error('邮件不存在或已被清理。'), { status:404 });
    if (!message.is_read) {
      await connection.execute(`
        UPDATE messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        SET m.is_read=1
        WHERE m.public_id=? AND mb.user_id=? AND mb.status='ACTIVE'
          AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
      `, [String(messageId || ''), userId]);
    }
    const hasText = Boolean(String(message.text_content || '').trim());
    return {
      id:message.id,
      recipient:message.recipient,
      sender:message.sender,
      subject:message.subject,
      size_bytes:Number(message.size_bytes || 0),
      is_read:true,
      received_at:message.received_at instanceof Date ? message.received_at.toISOString() : new Date(message.received_at).toISOString(),
      content_type:hasText ? '纯文本邮件' : 'HTML 邮件（纯文本展示）',
      body_text:hasText ? String(message.text_content) : htmlToPlainText(message.html_content),
    };
  } finally { connection.release(); }
}
