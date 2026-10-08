import { normalizePage, normalizeQuery } from '../http/pagination.mjs';
import { openDatabase } from '../db/database.mjs';
import { ensureUserApiKey } from './api-key.mjs';
import { queryMemberHistoryPage, queryMemberPendingOrders } from './history.mjs';

const number = (value) => Number(value || 0);
const iso = (value) => value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
const MEMBER_MAILBOX_PAGE_SIZE = 10;

function normalizeMemberMailboxPage(value) {
  const raw = String(value ?? '1');
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw Object.assign(new Error('页码必须是大于 0 的整数。'), { status:400 });
  }
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page > 100000) {
    throw Object.assign(new Error('页码超出允许范围。'), { status:400 });
  }
  return page;
}

function normalizeMemberMailboxQuery(value) {
  const query = String(value ?? '').trim();
  if (query.length > 100) {
    throw Object.assign(new Error('搜索内容不能超过 100 个字符。'), { status:400 });
  }
  if (/\p{Cc}/u.test(query)) {
    throw Object.assign(new Error('搜索内容包含无效字符。'), { status:400 });
  }
  return query;
}

function serializeMemberMailbox(row) {
  return {
    id:row.public_id,
    address:row.address,
    duration_minutes:number(row.duration_minutes),
    status:row.status,
    received_count:number(row.received_count),
    expires_at:iso(row.expires_at),
    created_at:iso(row.created_at),
  };
}

async function queryMemberMailboxPage(connection, { userId, query:rawQuery='', page:rawPage=1 }) {
  const query = normalizeMemberMailboxQuery(rawQuery);
  const requestedPage = normalizeMemberMailboxPage(rawPage);
  const searchSql = query ? 'AND LOCATE(?,mb.address)>0' : '';
  const searchParams = query ? [query] : [];
  const [[countRow]] = await connection.execute(`
    SELECT COUNT(*) AS total
    FROM mailboxes mb
    WHERE mb.user_id=? AND mb.status<>'DELETED' ${searchSql}
  `, [userId,...searchParams]);
  const total = number(countRow?.total);
  const pages = Math.max(1,Math.ceil(total/MEMBER_MAILBOX_PAGE_SIZE));
  const page = Math.min(requestedPage,pages);
  const offset = (page-1)*MEMBER_MAILBOX_PAGE_SIZE;
  const [rows] = await connection.execute(`
    SELECT mb.public_id,mb.address,mb.duration_minutes,mb.status,
           mb.received_count,mb.expires_at,mb.created_at
    FROM mailboxes mb
    WHERE mb.user_id=? AND mb.status<>'DELETED' ${searchSql}
    ORDER BY mb.id DESC
    LIMIT ? OFFSET ?
  `, [userId,...searchParams,MEMBER_MAILBOX_PAGE_SIZE,offset]);
  return {
    mailboxes:rows.map(serializeMemberMailbox),
    pagination:{ page,pages,total,pageSize:MEMBER_MAILBOX_PAGE_SIZE },
  };
}

export async function getMemberMailboxPage({ userId, query='', page=1 }) {
  const connection = await openDatabase();
  try {
    return await queryMemberMailboxPage(connection,{ userId,query,page });
  } finally {
    connection.release();
  }
}

export async function getPublicToolData() {
  const connection = await openDatabase();
  try {
    const [publicDomains] = await connection.execute(`
      SELECT domain, kind FROM domains
      WHERE kind IN ('PUBLIC','LOGIN','MEMBER') AND status='ACTIVE' AND mx_status='ACTIVE'
      ORDER BY kind, id
    `);
    const [settings] = await connection.execute('SELECT `key`,value FROM system_settings WHERE `key` NOT IN (\'password_reset_smtp\',\'gmpay_payment_config\',\'telegram_bot_config\',\'audit_retention\',\'audit_retention_ready\') AND `key` NOT LIKE \'microsoft_relay_%\' AND `key` NOT LIKE \'relay_junk_cursor_%\' AND `key` NOT LIKE \'relay_inbox_progress_%\' AND `key` NOT LIKE \'nodeloc_oauth_%\'');
    const [[membershipPricing]] = await connection.execute(`
      SELECT mailbox_discount_percent
      FROM membership_plans
      WHERE enabled=1
      ORDER BY sort_order,id
      LIMIT 1
    `);
    return {
      publicDomains,
      settings: Object.fromEntries(settings.map(row => [row.key,row.value])),
      memberDiscountPercent: number(membershipPricing?.mailbox_discount_percent || 70),
    };
  } finally {
    connection.release();
  }
}

async function queryMemberMessagePage(connection,{userId,query='',page=1,mailboxId=''}) {
  query=normalizeQuery(query);page=normalizePage(page);
  let mailbox=null;
  if(mailboxId){
    if(!/^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(mailboxId)))throw Object.assign(new Error('邮箱标识无效。'),{status:400});
    const [[row]]=await connection.execute("SELECT public_id,address,status,expires_at,created_at,duration_minutes,received_count FROM mailboxes WHERE public_id=? AND user_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))",[mailboxId,userId]);
    if(!row)throw Object.assign(new Error('邮箱不存在、已过期或无权访问。'),{status:404});
    mailbox=serializeMemberMailbox(row);
  }
  const params=[userId];
  const mailboxFilter=mailboxId?'AND mb.public_id=?':'';
  if(mailboxId)params.push(mailboxId);
  const search=query?"AND (LOCATE(?,m.from_address)>0 OR LOCATE(?,COALESCE(m.subject,''))>0 OR LOCATE(?,mb.address)>0)":'';
  if(query)params.push(query,query,query);
  const from=`FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id
    WHERE mb.user_id=? AND mb.status='ACTIVE'
      AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
      AND m.risk_status='SAFE' ${mailboxFilter} ${search}`;
  const [[count]]=await connection.execute(`SELECT COUNT(*) AS total ${from}`,params);
  const total=Number(count.total),pages=Math.max(1,Math.ceil(total/10));page=Math.min(page,pages);
  const [messages]=await connection.execute(`
    SELECT m.public_id AS id,mb.address AS recipient,m.from_address AS sender,m.subject,
      m.size_bytes,m.is_read,m.received_at ${from}
    ORDER BY m.received_at DESC,m.id DESC LIMIT ? OFFSET ?
  `,[...params,10,(page-1)*10]);
  return {mailbox,messages:messages.map(row=>({...row,size_bytes:number(row.size_bytes),is_read:Boolean(row.is_read),received_at:iso(row.received_at)})),pagination:{page,pages,total,pageSize:10}};
}
export async function getMemberMessagePage(options) {
  const connection=await openDatabase();
  try{return await queryMemberMessagePage(connection,options);}finally{connection.release();}
}

export async function getMemberData(userId, { includeApiKeySecret = false } = {}) {
  // Ensure overview/API pages have a displayable account key before borrowing the
  // read-model connection. Keeping this transaction outside the read connection
  // avoids holding one pool slot while waiting for another under load.
  const provisionedApiKey = includeApiKeySecret
    ? await ensureUserApiKey(userId)
    : null;
  const connection = await openDatabase();
  try {
    const [[user]] = await connection.execute(`
      SELECT public_id, email, role, status, points_balance, locale, created_at, updated_at
      FROM users WHERE id=? LIMIT 1
    `, [userId]);
    if (!user) throw new Error('账户不存在。');

    const [[membership]] = await connection.execute(`
      SELECT mp.code, mp.name, mp.duration_days, mp.mailbox_discount_percent,
             mp.message_retention_days, mp.api_limit_multiplier, ms.starts_at, ms.expires_at
      FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id
      WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
      ORDER BY ms.expires_at DESC LIMIT 1
    `, [userId]);
    const initialMailboxPage = await queryMemberMailboxPage(connection,{ userId,page:1 });
    const mailboxes = initialMailboxPage.mailboxes;
    const [[mailboxTotals]] = await connection.execute(`
      SELECT COALESCE(SUM(mb.received_count),0) AS received
      FROM mailboxes mb
      WHERE mb.user_id=? AND mb.status<>'DELETED'
    `, [userId]);
    const initialMessagePage=await queryMemberMessagePage(connection,{userId});
    const messages=initialMessagePage.messages;
    const [[messageTotals]] = await connection.execute(`
      SELECT COUNT(*) AS total
      FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE mb.user_id=? AND mb.status='ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
        AND m.risk_status='SAFE'
    `, [userId]);
    const transactionPage = await queryMemberHistoryPage(connection,{ userId,section:'transactions' });
    const domainPage = await queryMemberHistoryPage(connection,{ userId,section:'domains' });
    const [publicDomains] = await connection.execute(`
      SELECT domain, kind FROM domains
      WHERE kind IN ('PUBLIC','LOGIN','MEMBER') AND status='ACTIVE' AND mx_status='ACTIVE'
      ORDER BY kind, id
    `);
    const [plans] = await connection.execute(`
      SELECT code, name, duration_days, price_points, mailbox_discount_percent,
             message_retention_days, api_limit_multiplier
      FROM membership_plans WHERE enabled=1 ORDER BY sort_order,id
    `);
    const [privateMailboxDomains] = await connection.execute(`
      SELECT domain,kind FROM domains
      WHERE owner_user_id=? AND kind='PRIVATE' AND status='ACTIVE' AND mx_status='ACTIVE'
      ORDER BY id
    `,[userId]);
    const apiKey = includeApiKeySecret
      ? provisionedApiKey
      : provisionedApiKey
        ? { ...provisionedApiKey, key:undefined }
        : null;
    const [rechargePlans] = await connection.execute(`
      SELECT code, points, amount_usd_cents FROM recharge_plans WHERE enabled=1 ORDER BY sort_order,id
    `);
    const [paymentChannels] = await connection.execute(`
      SELECT code, mode, token, network, label FROM payment_channels WHERE enabled=1 ORDER BY sort_order,id
    `);
    const orderPage = await queryMemberHistoryPage(connection,{ userId,section:'orders' });
    const pendingOrders = await queryMemberPendingOrders(connection,userId);
    const [settings] = await connection.execute('SELECT `key`,value FROM system_settings WHERE `key` NOT IN (\'password_reset_smtp\',\'gmpay_payment_config\',\'telegram_bot_config\',\'audit_retention\',\'audit_retention_ready\') AND `key` NOT LIKE \'microsoft_relay_%\' AND `key` NOT LIKE \'relay_junk_cursor_%\' AND `key` NOT LIKE \'relay_inbox_progress_%\' AND `key` NOT LIKE \'nodeloc_oauth_%\'');

    return {
      user: { ...user, points_balance:number(user.points_balance), created_at:iso(user.created_at), updated_at:iso(user.updated_at) },
      membership: membership ? { ...membership, starts_at:iso(membership.starts_at), expires_at:iso(membership.expires_at) } : null,
      mailboxes,
      mailboxPagination:initialMailboxPage.pagination,
      messagePagination:initialMessagePage.pagination,
      messages: messages.map(row => ({ ...row, size_bytes:number(row.size_bytes), is_read:Boolean(row.is_read), received_at:iso(row.received_at) })),
      transactions: transactionPage.items,
      transactionPagination:transactionPage.pagination,
      domains: domainPage.items,
      domainPagination:domainPage.pagination,
      publicDomains,
      mailboxDomains:[...publicDomains,...privateMailboxDomains],
      plans: plans.map(row => ({ ...row, duration_days:number(row.duration_days), price_points:number(row.price_points), mailbox_discount_percent:number(row.mailbox_discount_percent), message_retention_days:number(row.message_retention_days), api_limit_multiplier:number(row.api_limit_multiplier) })),
      apiKey,
      rechargePlans: rechargePlans.map(row => ({ ...row, points:number(row.points), amount_usd_cents:number(row.amount_usd_cents) })),
      paymentChannels,
      orders: orderPage.items,
      orderPagination:orderPage.pagination,
      pendingOrders,
      settings: Object.fromEntries(settings.map(row => [row.key,row.value])),
      counts: {
        mailboxes: initialMailboxPage.pagination.total,
        messages: number(messageTotals?.total),
        received: number(mailboxTotals?.received),
      },
    };
  } finally {
    connection.release();
  }
}

function normalizeInboxPage(value) {
  const parsed = Number.parseInt(String(value || '1'), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : 1;
}

function normalizeMailboxPublicId(value) {
  const mailboxId = String(value || '').trim();
  if (mailboxId && !/^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailboxId)) {
    throw Object.assign(new Error('邮箱标识无效。'), { status:400 });
  }
  return mailboxId;
}

function serializeMailbox(row) {
  return {
    available:row.domain_status==='ACTIVE' && row.mx_status==='ACTIVE' && (row.relay_account_id==null || row.relay_status==='ACTIVE'),
    isRelay:row.relay_account_id != null,
    id:row.public_id,
    address:row.address,
    duration_minutes:number(row.duration_minutes),
    received_count:number(row.received_count),
    status:row.status,
    expires_at:iso(row.expires_at),
    created_at:iso(row.created_at),
  };
}

/**
 * Return one active mailbox and only that mailbox's safe messages.
 * The user constraint is intentionally part of every lookup so a public mailbox id
 * can never be used to read another account's inbox.
 */
export async function getMailboxInbox({ userId, mailboxId:rawMailboxId='', query:rawQuery='', page:rawPage=1, kind='' }) {
  if (!['','ordinary','relay'].includes(kind)) throw Object.assign(new Error('邮箱类型无效。'), {status:400});
  const mailboxId = normalizeMailboxPublicId(rawMailboxId);
  const query = String(rawQuery || '').trim();
  if (query.length > 100) throw Object.assign(new Error('搜索内容不能超过 100 个字符。'), { status:400 });
  const requestedPage = normalizeInboxPage(rawPage);
  const connection = await openDatabase();
  try {
    const params = [userId];
    let mailboxFilter = kind === 'ordinary' ? 'AND mb.relay_account_id IS NULL' : kind === 'relay' ? 'AND mb.relay_account_id IS NOT NULL' : '';
    if (mailboxId) {
      mailboxFilter += ' AND mb.public_id=?';
      params.push(mailboxId);
    }
    const [[mailbox]] = await connection.execute(`
      SELECT mb.public_id, mb.address, mb.duration_minutes, mb.received_count,
             mb.status, mb.expires_at, mb.created_at, mb.relay_account_id, d.status AS domain_status,d.mx_status,ra.status AS relay_status
      FROM mailboxes mb
      JOIN domains d ON d.id=mb.domain_id
      LEFT JOIN relay_accounts ra ON ra.id=mb.relay_account_id
      WHERE mb.user_id=? ${mailboxFilter}
        AND mb.status='ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
      ORDER BY mb.id DESC
      LIMIT 1
    `, params);
    if (!mailbox) {
      if (mailboxId) throw Object.assign(new Error('邮箱不存在、已过期或无权访问。'), { status:404 });
      return { mailbox:null, messages:[], pagination:{ page:1, pages:1, total:0, pageSize:10 } };
    }

    const searchSql = query
      ? 'AND (LOCATE(?,m.from_address)>0 OR LOCATE(?,COALESCE(m.subject,\'\'))>0)'
      : '';
    const searchParams = query ? [query,query] : [];
    const [[countRow]] = await connection.execute(`
      SELECT COUNT(*) AS total
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE mb.user_id=? AND mb.public_id=?
        AND mb.status='ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
        AND m.risk_status='SAFE'
        ${searchSql}
    `, [userId,mailbox.public_id,...searchParams]);
    const total = number(countRow?.total);
    const pageSize = 10;
    const pages = Math.max(1,Math.ceil(total/pageSize));
    const page = Math.min(requestedPage,pages);
    const offset = (page-1)*pageSize;
    const [messages] = await connection.execute(`
      SELECT m.public_id AS id, mb.address AS recipient, m.from_address AS sender,
             m.subject, m.size_bytes, m.is_read, m.received_at
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE mb.user_id=? AND mb.public_id=?
        AND mb.status='ACTIVE'
        AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
        AND m.risk_status='SAFE'
        ${searchSql}
      ORDER BY m.received_at DESC,m.id DESC
      LIMIT ? OFFSET ?
    `, [userId,mailbox.public_id,...searchParams,pageSize,offset]);
    return {
      mailbox:serializeMailbox(mailbox),
      messages:messages.map(row=>({
        ...row,
        subject:String(row.subject || ''),
        size_bytes:number(row.size_bytes),
        is_read:Boolean(row.is_read),
        received_at:iso(row.received_at),
      })),
      pagination:{ page,pages,total,pageSize },
    };
  } finally {
    connection.release();
  }
}
