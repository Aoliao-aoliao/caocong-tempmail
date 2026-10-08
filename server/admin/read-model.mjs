import {rechargeOrderHistorySql} from '../payment/order-history.mjs';
import { normalizePage, normalizeQuery } from '../http/pagination.mjs';
import { resolveApiRateLimit } from '../member/api-key.mjs';
import {orderStatusSql} from '../member/order-status.mjs';
import { openDatabase } from '../db/database.mjs';
import { getResolvedTurnstilePublicConfig } from '../security/turnstile.mjs';
import { getDomainDnsConfiguration } from './domain-dns.mjs';

const number = (value) => Number(value || 0);
const iso = (value) => value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;

export const adminSections = ['users','mailboxes','messages','domains','orders','transactions','apiKeys','audit'];
const searchColumns = {
  users:['id','email','role','role_text'], mailboxes:['id','address','owner'],
  messages:['id','recipient','sender','subject'],domains:['domain','owner'],
  orders:['id','user','channel','points'],transactions:['id','user','type','type_text','reference_id','note','amount','created_at'],
  apiKeys:['id','owner','key_prefix'],audit:['id','actor','action','entity_type','entity_id'],
};
const statusFilters = {
  users:{field:'status',values:{'正常':'ACTIVE','限制':'RESTRICTED','停用':'DISABLED'}},
  mailboxes:{field:'status',values:{'收信中':'ACTIVE','已暂停':'PAUSED','已过期':'EXPIRED','已隐藏':'DELETED'}},
  messages:{field:'risk_status',values:{'安全':'SAFE','待检查':'REVIEW','已隔离':'QUARANTINED'}},
  orders:{field:'status',values:{'已完成':'PAID','待确认':'PENDING','失败':'FAILED','已过期':'EXPIRED','已关闭':'CANCELLED'}},
};
async function adminRows(connection, section, sql, options, pagination) {
  if(options.section && options.section!==section) return [[]];
  const selected=options.section===section;
  const query=selected?normalizeQuery(options.query):'';
  const status=selected?String(options.status||'全部'):'全部';
  const requested=selected?normalizePage(options.page ?? 1):1;
  const params=[];
  const clauses=[];
  if(query){clauses.push(`LOCATE(?,CONCAT_WS(' ',${searchColumns[section].map(c=>'records.`'+c+'`').join(',')}))>0`);params.push(query);}
  if(status!=='全部') {
    const filter=statusFilters[section];
    if(!filter || !filter.values[status]) throw Object.assign(new Error('筛选状态不正确。'),{status:400});
    clauses.push(`records.${filter.field}=?`);params.push(filter.values[status]);
  }
  const source=sql.replace(/ORDER BY[\s\S]*$/i,'').trim();
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  const [[count]]=await connection.execute(`SELECT COUNT(*) AS total FROM (${source}) records ${where}`,params);
  const total=Number(count.total),pages=Math.max(1,Math.ceil(total/20)),page=Math.min(requested,pages);
  const [rows]=await connection.execute(`SELECT * FROM (${source}) records ${where} ORDER BY ${section==='orders'?'records.created_at DESC,records.id DESC':'records.sort_id DESC'} LIMIT ? OFFSET ?`,[...params,20,(page-1)*20]);
  pagination[section]={page,pages,total,pageSize:20};
  return [rows];
}

export async function getAdminData(options={}) {
  /** @type {Record<string,{page:number,pages:number,total:number,pageSize:number}>} */
  const pagination={};
  const connection = await openDatabase();
  try {
    const [[counts]] = await connection.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users_total,
        (SELECT COUNT(*) FROM users WHERE created_at >= UTC_DATE()) AS users_today,
        (SELECT COALESCE(SUM(points_balance), 0) FROM users) AS points_total,
        (SELECT COUNT(*) FROM users WHERE status <> 'ACTIVE') AS users_restricted,
        (SELECT COUNT(DISTINCT user_id) FROM memberships WHERE status='ACTIVE' AND expires_at > UTC_TIMESTAMP(3)) AS members_active,
        (SELECT COUNT(*) FROM memberships WHERE status='ACTIVE' AND expires_at BETWEEN UTC_TIMESTAMP(3) AND DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY)) AS members_expiring,
        (SELECT COUNT(*) FROM mailboxes) AS mailboxes_total,
        (SELECT COUNT(*) FROM mailboxes WHERE status='ACTIVE' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))) AS mailboxes_active,
        (SELECT COUNT(*) FROM mailboxes WHERE status='ACTIVE' AND expires_at BETWEEN UTC_TIMESTAMP(3) AND DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 DAY)) AS mailboxes_expiring,
        (SELECT COUNT(*) FROM mailboxes WHERE status IN ('EXPIRED','DELETED') AND updated_at >= UTC_DATE()) AS mailboxes_closed_today,
        (SELECT COUNT(*) FROM messages WHERE received_at >= UTC_DATE()) AS messages_today,
        (SELECT COUNT(*) FROM messages WHERE risk_status IN ('REVIEW','QUARANTINED')) AS messages_risk,
        (SELECT COUNT(*) FROM messages WHERE received_at >= UTC_DATE() AND risk_status='SAFE') AS messages_safe_today,
        (SELECT COALESCE(SUM(size_bytes),0) FROM messages WHERE received_at >= UTC_DATE()) AS message_bytes_today,
        (SELECT COUNT(*) FROM domains WHERE kind='PUBLIC') AS domains_public,
        (SELECT COUNT(*) FROM domains WHERE kind='PRIVATE') AS domains_private,
        (SELECT COUNT(*) FROM domains WHERE kind='PRIVATE' AND status='PENDING') AS domains_pending,
        (SELECT COUNT(*) FROM domains WHERE mx_status NOT IN ('ACTIVE','PENDING')) AS domains_dns_error,
        (SELECT COUNT(*) FROM recharge_orders WHERE created_at >= UTC_DATE())+(SELECT COUNT(*) FROM nodeloc_payment_orders WHERE created_at>=UTC_DATE())+(SELECT COUNT(*) FROM gmpay_payment_orders WHERE created_at>=UTC_DATE()) AS orders_today,
        (SELECT COUNT(*) FROM recharge_orders WHERE status='PAID' AND paid_at >= UTC_DATE())+(SELECT COUNT(*) FROM nodeloc_payment_orders WHERE status='PAID' AND paid_at>=UTC_DATE())+(SELECT COUNT(*) FROM gmpay_payment_orders WHERE status='PAID' AND paid_at>=UTC_DATE()) AS orders_paid_today,
        (SELECT COUNT(*) FROM recharge_orders o WHERE (${orderStatusSql})='PENDING')+(SELECT COUNT(*) FROM nodeloc_payment_orders o WHERE (${orderStatusSql})='PENDING')+(SELECT COUNT(*) FROM gmpay_payment_orders o WHERE (${orderStatusSql})='PENDING') AS orders_pending,
        (SELECT COALESCE(SUM(energy),0) FROM nodeloc_payment_orders WHERE status='PAID' AND paid_at>=UTC_DATE()) AS nodeloc_energy_today,
        ((SELECT COALESCE(SUM(amount_usd_cents),0) FROM recharge_orders WHERE status='PAID' AND paid_at >= UTC_DATE())+(SELECT COALESCE(SUM(amount_usd_cents),0) FROM gmpay_payment_orders WHERE status='PAID' AND paid_at>=UTC_DATE())) AS revenue_cents_today,
        ((SELECT COALESCE(SUM(amount_usd_cents),0) FROM recharge_orders WHERE status='PAID')+(SELECT COALESCE(SUM(amount_usd_cents),0) FROM gmpay_payment_orders WHERE status='PAID')) AS revenue_cents_total,
        (SELECT COUNT(*) FROM api_keys WHERE status='ACTIVE') AS api_keys_active,
        (SELECT COUNT(*) FROM api_request_logs WHERE created_at>=UTC_DATE()) AS api_requests_today,
        (SELECT COUNT(*) FROM api_request_logs WHERE created_at>=UTC_DATE() AND status_code=429) AS api_limited_today
    `);

    const [users] = await adminRows(connection,'users',`
      SELECT u.id AS sort_id, u.public_id AS id, u.email, u.role, u.points_balance AS score, u.status,
             u.created_at, CASE WHEN u.role='SUPER_ADMIN' THEN '超级管理员' WHEN u.role='ADMIN' THEN '管理员' WHEN MAX(CASE WHEN ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) THEN 1 ELSE 0 END)=1 THEN 'VIP 会员' ELSE '普通用户' END AS role_text, COUNT(DISTINCT mb.id) AS mailboxes,
             MAX(CASE WHEN ms.status='ACTIVE' AND ms.expires_at > UTC_TIMESTAMP(3) THEN 1 ELSE 0 END) AS is_member
      FROM users u
      LEFT JOIN mailboxes mb ON mb.user_id=u.id AND mb.status <> 'DELETED'
      LEFT JOIN memberships ms ON ms.user_id=u.id
      GROUP BY u.id ORDER BY u.id DESC LIMIT 200
    `,options,pagination);
    const [mailboxes] = await adminRows(connection,'mailboxes',`
      SELECT mb.id AS sort_id, mb.public_id AS id, mb.address,
             COALESCE(u.email, CONCAT('访客会话 ', LEFT(COALESCE(mb.guest_session_id,''),8))) AS owner,
             mb.duration_minutes, mb.received_count AS received,
             mb.expires_at, mb.status, mb.created_at
      FROM mailboxes mb LEFT JOIN users u ON u.id=mb.user_id ORDER BY mb.id DESC LIMIT 200
    `,options,pagination);
    const [messages] = await adminRows(connection,'messages',`
      SELECT m.id AS sort_id, m.public_id AS id, mb.address AS recipient, m.from_address AS sender, m.subject,
             m.size_bytes, m.risk_status, m.received_at
      FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id ORDER BY m.received_at DESC LIMIT 200
    `,options,pagination);
    const [domains] = await adminRows(connection,'domains',`
      SELECT d.id AS sort_id, d.domain, d.kind, d.mx_status, d.mx_checked_at, d.mx_records_json, d.mx_error,
             d.mailbox_count, d.status, u.email AS owner
      FROM domains d LEFT JOIN users u ON u.id=d.owner_user_id ORDER BY d.id DESC LIMIT 200
    `,options,pagination);
    const [orders] = await adminRows(connection,'orders',`
      SELECT o.id AS sort_id,o.id,u.email AS user,o.amount_usd_cents,o.energy,o.actual_amount,o.order_type,o.points,o.channel,o.status,o.created_at
      FROM (${rechargeOrderHistorySql}) o JOIN users u ON u.id=o.user_id
    `,options,pagination);
    const [transactions] = await adminRows(connection,'transactions',`
      SELECT t.id AS sort_id, t.public_id AS id, u.email AS user, t.type, CASE t.type WHEN 'REGISTER_BONUS' THEN '注册赠送' WHEN 'RECHARGE' THEN '充值到账' WHEN 'MAILBOX_PURCHASE' THEN '购买邮箱' WHEN 'MEMBERSHIP_PURCHASE' THEN '购买会员' WHEN 'REFUND' THEN '退款' WHEN 'ADMIN_ADJUSTMENT' THEN '人工调整' END AS type_text, t.amount, t.reference_id, t.note, t.created_at
      FROM point_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 200
    `,options,pagination);
    const [plans] = await connection.query(`
      SELECT code, name, duration_days, price_points, mailbox_discount_percent,
             message_retention_days, api_limit_multiplier, enabled
      FROM membership_plans ORDER BY sort_order, id
    `);
    const [apiKeys] = await adminRows(connection,'apiKeys',`
      SELECT k.id AS sort_id, k.user_id, k.public_id AS id, u.email AS owner, k.key_prefix, k.rate_limit_per_minute,
             k.status, k.last_used_at, k.created_at
      FROM api_keys k JOIN users u ON u.id=k.user_id ORDER BY k.id DESC LIMIT 200
    `,options,pagination);
    const [rechargePlans] = await connection.query('SELECT code,points,amount_usd_cents,enabled,sort_order FROM recharge_plans ORDER BY sort_order,id');
    const [paymentChannels] = await connection.query('SELECT code,mode,token,network,label,enabled,sort_order FROM payment_channels ORDER BY sort_order,id');
    const [audit] = await adminRows(connection,'audit',`
      SELECT a.id AS sort_id, a.public_id AS id, COALESCE(u.email,'system') AS actor, a.action,
             a.entity_type, a.entity_id, a.status, a.created_at
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.action NOT IN ('用户购买会员','用户续期邮箱','用户创建中继邮箱','用户召回邮箱') ORDER BY a.id DESC LIMIT 200
    `,options,pagination);
    const [settings] = await connection.query('SELECT `key`, value, value_type FROM system_settings WHERE `key` NOT IN (\'password_reset_smtp\',\'gmpay_payment_config\',\'telegram_bot_config\',\'audit_retention\',\'audit_retention_ready\') AND `key` NOT LIKE \'microsoft_relay_%\' AND `key` NOT LIKE \'relay_junk_cursor_%\' AND `key` NOT LIKE \'relay_inbox_progress_%\' AND `key` NOT LIKE \'nodeloc_oauth_%\' ORDER BY `key`');
    const turnstile = await getResolvedTurnstilePublicConfig({ connection });

    for (const key of apiKeys) key.rate_limit_per_minute=await resolveApiRateLimit(connection,{publicId:key.id,userId:key.user_id});
    return {
      pagination,
      security: {
        turnstileCanManage:false,
        turnstileConfigured:turnstile.configured,
        turnstileSource:turnstile.source,
        turnstileSiteKey:turnstile.siteKey,
        turnstileAllowedHostnames:turnstile.allowedHostnames,
        turnstileSecretConfigured:turnstile.secretConfigured,
        turnstileTimeoutMs:turnstile.timeoutMs,
        turnstileEnvironmentOverride:turnstile.environmentOverride,
        turnstileReadyForTest:turnstile.readyForTest,
        turnstileVerifiedAt:turnstile.verifiedAt,
      },
      counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, number(value)])),
      users: users.map((row) => ({ ...row, score:number(row.score), mailboxes:number(row.mailboxes), is_member:Boolean(row.is_member), created_at:iso(row.created_at) })),
      mailboxes: mailboxes.map((row) => ({ ...row, duration_minutes:number(row.duration_minutes), received:number(row.received), expires_at:iso(row.expires_at), created_at:iso(row.created_at) })),
      messages: messages.map((row) => ({ ...row, size_bytes:number(row.size_bytes), received_at:iso(row.received_at) })),
      domainDns:getDomainDnsConfiguration(),
      domains: domains.map((row) => {
        let mxRecords=row.mx_records_json;
        if(typeof mxRecords==='string'){try{mxRecords=JSON.parse(mxRecords)}catch{mxRecords=[]}}
        return { ...row, mailbox_count:number(row.mailbox_count),mx_checked_at:iso(row.mx_checked_at),mx_records:Array.isArray(mxRecords)?mxRecords:[] };
      }),
      orders: orders.map((row) => ({ ...row, amount_usd_cents:row.amount_usd_cents==null?null:number(row.amount_usd_cents), energy:row.energy==null?null:number(row.energy), points:number(row.points), created_at:iso(row.created_at) })),
      transactions: transactions.map((row) => ({ ...row, amount:number(row.amount), created_at:iso(row.created_at) })),
      plans: plans.map((row) => ({ ...row, duration_days:number(row.duration_days), price_points:number(row.price_points), mailbox_discount_percent:number(row.mailbox_discount_percent), message_retention_days:number(row.message_retention_days), api_limit_multiplier:number(row.api_limit_multiplier), enabled:Boolean(row.enabled) })),
      apiKeys: apiKeys.map((row) => ({ ...row, rate_limit_per_minute:number(row.rate_limit_per_minute), last_used_at:iso(row.last_used_at), created_at:iso(row.created_at) })),
      rechargePlans: rechargePlans.map(row=>({...row,points:number(row.points),amount_usd_cents:number(row.amount_usd_cents),enabled:Boolean(row.enabled),sort_order:number(row.sort_order)})),
      paymentChannels: paymentChannels.map(row=>({...row,enabled:Boolean(row.enabled),sort_order:number(row.sort_order)})),
      audit: audit.map((row) => ({ ...row, created_at:iso(row.created_at) })),
      settings: Object.fromEntries(settings.map((row) => [row.key, row.value])),
    };
  } finally {
    connection.release();
  }
}
