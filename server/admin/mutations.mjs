import {preserveAuditDependencies} from '../member/business-receipts.mjs';
import { resolveApiRateLimit } from '../member/api-key.mjs';
import { isValidMailboxDuration } from '../member/mailbox-policy.mjs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { AttachmentStore } from '../mail/attachment-store.mjs';
import { loadSmtpConfig } from '../mail/config.mjs';
import { relayRemoteCleanupEnabled } from '../relay/cleanup.mjs';
import { getResolvedTurnstilePublicConfig, requireTurnstileToken } from '../security/turnstile.mjs';
import {
  markTurnstileDatabaseVerified,
  readTurnstileDatabaseConfig,
  saveTurnstileDatabaseConfig,
} from '../security/turnstile-config-store.mjs';
import { assertProductionTurnstileCredentials } from '../security/turnstile-credentials.mjs';

function int(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}不合法。`);
  return parsed;
}

export function assertUserAccessPolicy({ actorRole, targetRole, targetId, actorUserId, status, role }) {
  if (actorRole !== 'SUPER_ADMIN' && targetRole === 'SUPER_ADMIN') {
    throw new Error('普通管理员不能修改超级管理员账户。');
  }
  if (actorRole !== 'SUPER_ADMIN' && role !== targetRole) {
    throw new Error('只有超级管理员可以修改账户角色。');
  }
  if (Number(targetId) === Number(actorUserId) && (status !== 'ACTIVE' || role !== 'SUPER_ADMIN')) {
    throw new Error('不能降低或停用当前超级管理员账户。');
  }
}

export function assertApiKeyStatusTransition(currentStatus, nextStatus) {
  if (currentStatus === 'REVOKED' && nextStatus !== 'REVOKED') {
    throw new Error('已撤销的密钥不能重新启用。');
  }
}

async function writeAudit(connection, { actorUserId, action, entityType, entityId, detail, ipAddress }) {
  await connection.execute(`
    INSERT INTO audit_logs (public_id, actor_user_id, action, entity_type, entity_id, detail_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [`AL-${randomUUID()}`, actorUserId, action, entityType, entityId, JSON.stringify(detail), String(ipAddress || '').slice(0,45) || null]);
}

async function requireSuperAdmin(connection, actorUserId, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [rows] = await connection.execute(`SELECT role,status FROM users WHERE id=?${suffix}`, [actorUserId]);
  const actor = rows[0];
  if (!actor || actor.status !== 'ACTIVE' || actor.role !== 'SUPER_ADMIN') {
    throw Object.assign(new Error('只有超级管理员可以修改人机验证配置。'), { status:403 });
  }
}

function hasTurnstileEnvironmentCredentials(env = process.env) {
  return Boolean(String(env.TURNSTILE_SITE_KEY || '').trim() || String(env.TURNSTILE_SECRET_KEY || '').trim());
}

function turnstileSecurityResult(metadata, {
  configured = Boolean(metadata?.verifiedAt),
  source = 'database',
  environmentOverride = false,
  readyForTest = Boolean(metadata?.siteKey && metadata?.secretConfigured && metadata?.allowedHostnames?.length),
} = {}) {
  return {
    turnstileCanManage:true,
    turnstileConfigured:Boolean(configured),
    turnstileSource:source,
    turnstileSiteKey:String(metadata?.siteKey || ''),
    turnstileAllowedHostnames:Array.isArray(metadata?.allowedHostnames) ? metadata.allowedHostnames : [],
    turnstileSecretConfigured:Boolean(metadata?.secretConfigured),
    turnstileTimeoutMs:Number(metadata?.timeoutMs || 6000),
    turnstileEnvironmentOverride:Boolean(environmentOverride),
    turnstileReadyForTest:Boolean(readyForTest),
    turnstileVerifiedAt:metadata?.verifiedAt || null,
  };
}

export async function adjustUserPoints({ publicId, amount, reason, actorUserId, ipAddress }) {
  const delta = int(amount, '积分数值', -1_000_000_000, 1_000_000_000);
  if (delta === 0) throw new Error('积分变动不能为 0。');
  const note = String(reason || '').trim();
  if (note.length < 2 || note.length > 500) throw new Error('请填写 2–500 个字符的调整原因。');
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT id, points_balance FROM users WHERE public_id=? FOR UPDATE', [String(publicId || '')]);
    const user = rows[0];
    if (!user) throw new Error('用户不存在。');
    const before = Number(user.points_balance);
    const after = before + delta;
    if (after < 0) throw new Error('扣除后积分不能小于 0。');
    await connection.execute('UPDATE users SET points_balance=? WHERE id=?', [after, user.id]);
    await connection.execute(`
      INSERT INTO point_transactions
        (public_id,user_id,type,amount,balance_after,reference_type,reference_id,note,operator_user_id)
      VALUES (?,?,'ADMIN_ADJUSTMENT',?,?,'ADMIN',?,?,?)
    `, [`PT-${randomUUID()}`, user.id, delta, after, String(actorUserId), note, actorUserId]);
    await writeAudit(connection, { actorUserId, action:'调整用户积分', entityType:'USER', entityId:publicId, detail:{ before, amount:delta, after, reason:note }, ipAddress });
    await connection.commit();
    return { publicId, pointsBalance:after };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateMembershipPlan({ code, values, actorUserId, ipAddress }) {
  const next = {
    duration_days:int(values.durationDays,'会员期限',1,3650),
    price_points:int(values.pricePoints,'套餐积分',1,1_000_000_000),
    mailbox_discount_percent:int(values.discountPercent,'邮箱折扣',1,100),
    message_retention_days:int(values.retentionDays,'邮件保留天数',1,3650),
    api_limit_multiplier:int(values.apiLimitMultiplier,'API 倍数',1,1000),
    enabled:Boolean(values.enabled),
  };
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM membership_plans WHERE code=? FOR UPDATE', [String(code || '')]);
    const current = rows[0];
    if (!current) throw new Error('会员套餐不存在。');
    await connection.execute(`
      UPDATE membership_plans SET duration_days=?,price_points=?,mailbox_discount_percent=?,
        message_retention_days=?,api_limit_multiplier=?,enabled=? WHERE id=?
    `, [next.duration_days,next.price_points,next.mailbox_discount_percent,next.message_retention_days,next.api_limit_multiplier,next.enabled?1:0,current.id]);
    await writeAudit(connection, { actorUserId, action:'更新会员套餐', entityType:'MEMBERSHIP_PLAN', entityId:code, detail:{ before:{ duration_days:Number(current.duration_days),price_points:Number(current.price_points),mailbox_discount_percent:Number(current.mailbox_discount_percent),message_retention_days:Number(current.message_retention_days),api_limit_multiplier:Number(current.api_limit_multiplier),enabled:Boolean(current.enabled) }, after:next }, ipAddress });
    await connection.commit();
    return { code, ...next };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateUserAccess({publicId,status,role,actorUserId,ipAddress}){
  if(!['ACTIVE','RESTRICTED','DISABLED'].includes(status))throw new Error('账户状态不合法。');
  if(!['USER','ADMIN','SUPER_ADMIN'].includes(role))throw new Error('账户角色不合法。');
  const connection=await openDatabase();try{await connection.beginTransaction();const [[actor]]=await connection.execute('SELECT role FROM users WHERE id=? FOR UPDATE',[actorUserId]);const [[target]]=await connection.execute('SELECT id,role,status FROM users WHERE public_id=? FOR UPDATE',[publicId]);if(!actor)throw new Error('当前管理员账户不存在。');if(!target)throw new Error('用户不存在。');assertUserAccessPolicy({actorRole:actor.role,targetRole:target.role,targetId:target.id,actorUserId,status,role});await connection.execute('UPDATE users SET status=?,role=? WHERE id=?',[status,role,target.id]);await writeAudit(connection,{actorUserId,action:'更新用户权限',entityType:'USER',entityId:publicId,detail:{before:{status:target.status,role:target.role},after:{status,role}},ipAddress});await connection.commit();return{publicId,status,role};}catch(error){await connection.rollback();throw error}finally{connection.release()}}

export async function updateDomain({domain,status,mxStatus,kind,ownershipVerified=false,actorUserId,ipAddress}){
  if (!['PENDING','ACTIVE','DISABLED','REJECTED'].includes(status)) throw new Error('域名状态不合法。');
  if (!['PENDING','ACTIVE','MISMATCH','NOT_FOUND','UNAVAILABLE'].includes(mxStatus)) throw new Error('MX 状态不合法。');
  if (!['PUBLIC','LOGIN','MEMBER','PRIVATE','RELAY'].includes(kind)) throw new Error('域名类型不合法。');
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[current]] = await connection.execute('SELECT id,status,mx_status,kind,owner_user_id FROM domains WHERE domain=? FOR UPDATE',[domain]);
    if (!current) throw new Error('域名不存在。');
    if (mxStatus !== current.mx_status) throw Object.assign(new Error('MX 状态由系统根据真实 DNS 自动检测，不能手动修改。'),{status:409});
    if (current.kind === 'RELAY' || kind === 'RELAY') {
      if (current.kind !== kind) throw Object.assign(new Error('中继域名类型只能在中继邮箱管理中维护。'),{status:409});
      if (status !== current.status) throw Object.assign(new Error('中继域名状态请在中继邮箱管理中维护。'),{status:409});
    }
    if ((current.kind === 'PRIVATE' || current.owner_user_id != null) && kind !== current.kind && kind !== 'PRIVATE') {
      throw Object.assign(new Error('用户私有域名不能在此改为平台公共域名，以免开放给其他用户。'),{status:409});
    }
    if (kind === 'PRIVATE' && current.owner_user_id == null && (current.kind !== kind || status === 'ACTIVE')) {
      throw Object.assign(new Error('私有域名必须属于一个用户。请由该用户在“私有域名”中绑定；不能将无主平台域名直接改为私有。'),{status:409});
    }
    if (kind === 'PRIVATE' && status === 'ACTIVE' && (current.status !== 'ACTIVE' || current.kind !== 'PRIVATE') && ownershipVerified !== true) {
      throw Object.assign(new Error('启用前请先核实该用户拥有域名，并确认归属审核；MX 正常不能证明域名归属。'),{status:409});
    }
    if (status === 'ACTIVE' && current.kind !== 'RELAY' && current.mx_status !== 'ACTIVE') {
      throw Object.assign(new Error('MX 检测正常后才能启用该域名。请先点击“立即检测”。'),{status:409});
    }
    await connection.execute('UPDATE domains SET status=?,kind=? WHERE id=?',[status,kind,current.id]);
    await writeAudit(connection,{actorUserId,action:'更新域名',entityType:'DOMAIN',entityId:domain,detail:{before:{status:current.status,kind:current.kind},after:{status,kind},ownershipVerified:ownershipVerified===true},ipAddress});
    await connection.commit();
    return {domain,status,mx_status:current.mx_status,kind};
  } catch(error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createPlatformDomain({domain,kind,actorUserId,ipAddress}){const value=String(domain||'').trim().toLowerCase();if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value))throw new Error('域名格式不正确。');if(!['PUBLIC','LOGIN','MEMBER'].includes(kind))throw new Error('平台域名类型不合法。');const connection=await openDatabase();try{await connection.beginTransaction();await connection.execute("INSERT INTO domains(domain,kind,mx_status,status) VALUES (?,?,'PENDING','PENDING')",[value,kind]);await writeAudit(connection,{actorUserId,action:'添加平台域名',entityType:'DOMAIN',entityId:value,detail:{kind},ipAddress});await connection.commit();return{domain:value,kind,mx_status:'PENDING',status:'PENDING',mailbox_count:0,owner:null};}catch(error){await connection.rollback();if(error?.code==='ER_DUP_ENTRY')throw new Error('该域名已经存在。');throw error}finally{connection.release()}}

export async function updateMailboxStatus({publicId,status,actorUserId,ipAddress}) {
  if (!['ACTIVE','PAUSED','EXPIRED','DELETED'].includes(status)) throw new Error('邮箱状态不合法。');
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[row]] = await connection.execute(`
      SELECT id,status,expires_at,
             (expires_at IS NOT NULL AND expires_at<=UTC_TIMESTAMP(3)) AS is_expired
      FROM mailboxes
      WHERE public_id=?
      FOR UPDATE
    `,[publicId]);
    if (!row) throw new Error('邮箱不存在。');
    if (status === 'ACTIVE' && (Boolean(row.is_expired) || row.status === 'EXPIRED')) {
      throw Object.assign(new Error('已到期邮箱不能直接恢复为收信中，请由用户通过召回功能续期。'), { status:409 });
    }
    // Manual expiration has the same lifetime/cleanup semantics as natural
    // expiration. Preserve an earlier deadline, including on legacy EXPIRED
    // rows, so changing through PAUSED/DELETED cannot bypass paid recall.
    const expire = status === 'EXPIRED' || row.status === 'EXPIRED';
    await connection.execute(`UPDATE mailboxes SET status=?,expires_at=IF(?,LEAST(COALESCE(expires_at,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3)),expires_at) WHERE id=?`,[status,expire,row.id]);
    const [[updated]] = await connection.execute('SELECT expires_at FROM mailboxes WHERE id=?',[row.id]);
    const expiresAt = updated.expires_at ? new Date(updated.expires_at).toISOString() : null;
    await writeAudit(connection,{actorUserId,action:'更新邮箱状态',entityType:'MAILBOX',entityId:publicId,detail:{before:row.status,after:status,expiresAt},ipAddress});
    await connection.commit();
    return {publicId,status,expires_at:expiresAt};
  } catch(error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function permanentlyDeleteMailbox({publicId,actorUserId,ipAddress}) {
  const mailboxPublicId = String(publicId || '').trim();
  // Address-generator guest mailboxes use the claim-backed GMB-C-<token>
  // form, while regular guest/member mailboxes use UUID-backed public ids.
  // Both are stored in mailboxes.public_id and are valid admin targets.
  const uuidMailboxId = /^(?:MB|GMB)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const claimMailboxId = /^GMB-C-[A-Za-z0-9_-]{22}$/;
  if (!uuidMailboxId.test(mailboxPublicId) && !claimMailboxId.test(mailboxPublicId)) {
    throw Object.assign(new Error('邮箱标识无效。'), { status:400 });
  }
  const attachmentStore = new AttachmentStore(loadSmtpConfig().storageRoot);
  await attachmentStore.initialize();
  const connection = await openDatabase();
  let storageKeys = [];
  try {
    await connection.beginTransaction();
    await requireSuperAdmin(connection, actorUserId, { lock:true });
    const [[mailbox]] = await connection.execute(`
      SELECT mb.id,mb.public_id,mb.address,mb.status,mb.domain_id,
             (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id=mb.id) AS message_count
      FROM mailboxes mb
      WHERE mb.public_id=?
      FOR UPDATE
    `,[mailboxPublicId]);
    if (!mailbox) throw Object.assign(new Error('邮箱不存在或已被永久删除。'), { status:404 });
    const [attachments] = await connection.execute(`
      SELECT ma.storage_key
      FROM message_attachments ma
      JOIN messages m ON m.id=ma.message_id
      WHERE m.mailbox_id=?
    `,[mailbox.id]);
    storageKeys = attachments.map((row) => row.storage_key);
    // Deleting the mailbox cascades its relay source links, so queue upstream
    // cleanup first, exactly as expiry does; shared live references are kept.
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
    await connection.execute('DELETE FROM mailboxes WHERE id=?',[mailbox.id]);
    await connection.execute('UPDATE domains SET mailbox_count=IF(mailbox_count>1,mailbox_count-1,0) WHERE id=?',[mailbox.domain_id]);
    await writeAudit(connection,{
      actorUserId,
      action:'永久删除邮箱',
      entityType:'MAILBOX',
      entityId:mailbox.public_id,
      detail:{address:mailbox.address,beforeStatus:mailbox.status,messageCount:Number(mailbox.message_count||0),attachmentCount:storageKeys.length},
      ipAddress,
    });
    await connection.commit();
  } catch(error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const pendingAttachmentDirectories = await attachmentStore.removeStorageKeys(storageKeys);
  return {publicId:mailboxPublicId,deleted:true,pendingAttachmentDirectories};
}

export async function updateMessageRisk({publicId,riskStatus,actorUserId,ipAddress}){if(!['SAFE','REVIEW','QUARANTINED'].includes(riskStatus))throw new Error('邮件风险状态不合法。');const connection=await openDatabase();try{const [result]=await connection.execute('UPDATE messages SET risk_status=? WHERE public_id=?',[riskStatus,publicId]);if(!result.affectedRows)throw new Error('邮件不存在。');await writeAudit(connection,{actorUserId,action:'更新邮件风险状态',entityType:'MESSAGE',entityId:publicId,detail:{riskStatus},ipAddress});return{publicId,risk_status:riskStatus};}finally{connection.release()}}

export async function updateApiKey({publicId,status,rateLimit,actorUserId,ipAddress}){if(!['ACTIVE','DISABLED','REVOKED'].includes(status))throw new Error('密钥状态不合法。');const limit=int(rateLimit,'请求限额',1,100000);const connection=await openDatabase();try{await connection.beginTransaction();const [[current]]=await connection.execute('SELECT status,user_id FROM api_keys WHERE public_id=? FOR UPDATE',[publicId]);if(!current)throw new Error('密钥不存在。');assertApiKeyStatusTransition(current.status,status);const effectiveLimit=await resolveApiRateLimit(connection,{publicId,userId:current.user_id});await connection.execute('UPDATE api_keys SET status=?,rate_limit_per_minute=? WHERE public_id=?',[status,limit,publicId]);await writeAudit(connection,{actorUserId,action:'更新 API 密钥',entityType:'API_KEY',entityId:publicId,detail:{before:{status:current.status},after:{status,...(limit!==effectiveLimit?{rateLimit:limit}:{})}},ipAddress});await preserveAuditDependencies(connection,[{action:'更新 API 密钥',entity_type:'API_KEY',entity_id:publicId}]);await connection.commit();return{publicId,status,rate_limit_per_minute:limit};}catch(error){await connection.rollback();throw error}finally{connection.release()}}

export async function updateTurnstileConfiguration({
  siteKey,
  secretKey,
  allowedHostnames,
  timeoutMs,
  actorUserId,
  ipAddress,
}) {
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    await requireSuperAdmin(connection, actorUserId, { lock:true });
    if (hasTurnstileEnvironmentCredentials()) {
      throw Object.assign(new Error('服务器环境变量正在覆盖后台配置，请先移除 TURNSTILE_SITE_KEY 和 TURNSTILE_SECRET_KEY。'), { status:409 });
    }
    const metadata = await saveTurnstileDatabaseConfig({
      siteKey,
      secretKey,
      allowedHostnames,
      timeoutMs,
      actorUserId,
      connection,
    });
    await writeAudit(connection, {
      actorUserId,
      action:'更新人机验证配置',
      entityType:'SECURITY',
      entityId:'turnstile',
      detail:{
        fields:['siteKey','allowedHostnames','timeoutMs'],
        allowedHostnameCount:metadata.allowedHostnames.length,
        timeoutMs:metadata.timeoutMs,
        secretReplaced:Boolean(String(secretKey || '').trim()),
        verificationRequired:true,
      },
      ipAddress,
    });
    await connection.commit();
    return turnstileSecurityResult(metadata, { configured:false, source:'database', readyForTest:true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function verifyTurnstileConfiguration({ turnstileToken, actorUserId, ipAddress }) {
  if (hasTurnstileEnvironmentCredentials()) {
    throw Object.assign(new Error('当前 Turnstile 由服务器环境变量管理，无需数据库验证。'), { status:409 });
  }

  let stored;
  const readConnection = await openDatabase();
  try {
    await requireSuperAdmin(readConnection, actorUserId);
    stored = await readTurnstileDatabaseConfig({ connection:readConnection });
  } finally {
    readConnection.release();
  }
  if (stored?.status !== 'configured' || !stored.config) {
    throw new Error('Turnstile 数据库配置不完整，请先重新保存。');
  }
  assertProductionTurnstileCredentials(stored.config);

  await requireTurnstileToken({
    token:turnstileToken,
    remoteIp:ipAddress,
    expectedAction:'turnstile_admin_test',
    config:stored.config,
  });

  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    await requireSuperAdmin(connection, actorUserId, { lock:true });
    if (hasTurnstileEnvironmentCredentials()) {
      throw Object.assign(new Error('服务器环境变量在验证期间发生变化，请先处理环境变量配置。'), { status:409 });
    }
    const verified = await markTurnstileDatabaseVerified({
      expectedUpdatedAt:stored.config.updatedAt,
      connection,
    });
    await writeAudit(connection, {
      actorUserId,
      action:'验证人机验证配置',
      entityType:'SECURITY',
      entityId:'turnstile',
      detail:{ verified:true },
      ipAddress,
    });
    await connection.commit();
    return turnstileSecurityResult({
      ...stored.metadata,
      verifiedAt:verified.verifiedAt,
      updatedAt:verified.updatedAt,
    }, { configured:true, source:'database', readyForTest:true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateSystemSettings({ values, actorUserId, ipAddress }) {
  const allowed = {
    free_mailbox_minutes:'integer',
    default_message_retention_days:'integer',
    member_message_retention_days:'integer',
    registration_bonus_points:'integer',
    pending_order_limit:'integer',
    active_mailbox_limit_per_user:'integer',
    captcha_before_mailbox_create:'boolean',
    openapi_rate_limit_enabled:'boolean',
    mailbox_duration_plans:'json',
  };
  const entries = Object.entries(values || {});
  if (!entries.length) throw new Error('没有需要保存的配置。');
  const enablesCaptcha = entries.some(([key, raw]) => key === 'captcha_before_mailbox_create' && (raw === true || raw === 'true'));
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    if (enablesCaptcha) {
      const turnstile = await getResolvedTurnstilePublicConfig({ connection });
      if (!turnstile.configured) throw new Error('Turnstile 尚未配置并验证，暂时不能开启人机验证。');
    }
    for (const [key, raw] of entries) {
      const type = allowed[key];
      if (!type) throw new Error(`不允许修改配置：${key}`);
      let value = String(raw);
      if (type === 'integer') {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000_000) throw new Error(`${key} 数值不合法。`);
        if (key === 'free_mailbox_minutes' && (number < 5 || number > 1440)) throw new Error('访客免费邮箱时长必须为 5–1440 分钟。');
        if (key === 'active_mailbox_limit_per_user' && (number < 1 || number > 10_000)) {
          throw new Error('单用户活动邮箱上限必须在 1 到 10000 之间。');
        }
        value = String(number);
      }
      if (type === 'boolean') value = raw === true || raw === 'true' ? 'true' : 'false';
      if (type === 'json') {
        let parsed;
        try { parsed = JSON.parse(value); } catch { throw new Error('邮箱价格配置不是有效 JSON。'); }
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('至少保留一个邮箱时长档位。');
        const planIds = new Set();
        const planMinutes = new Set();
        for (const item of parsed) {
          if (!item.id || !item.label || !isValidMailboxDuration(item.minutes) || !Number.isSafeInteger(Number(item.points)) || Number(item.points) < 0) throw new Error('邮箱时长档位字段不完整，或时长超出支持范围；积分必须为非负安全整数。');
          const normalizedId = String(item.id).trim().toLowerCase();
          const minutes = Number(item.minutes);
          if (!normalizedId || !String(item.label).trim()) throw new Error('邮箱时长档位字段不完整。');
          if (planIds.has(normalizedId)) throw new Error('邮箱时长档位标识不能重复。');
          if (planMinutes.has(minutes)) throw new Error('邮箱时长不能重复配置。');
          if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('邮箱时长档位启用状态不合法。');
          planIds.add(normalizedId);
          planMinutes.add(minutes);
        }
        value = JSON.stringify(parsed);
      }
      await connection.execute('UPDATE system_settings SET value=?,updated_by_user_id=? WHERE `key`=?', [value, actorUserId, key]);
    }
    await writeAudit(connection, { actorUserId, action:'更新系统配置', entityType:'SYSTEM', entityId:'settings', detail:{ keys:entries.map(([key]) => key) }, ipAddress });
    await connection.commit();
    return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
