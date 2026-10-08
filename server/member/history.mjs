import {rechargeOrderHistorySql} from '../payment/order-history.mjs';
import { openDatabase } from '../db/database.mjs';
import { normalizePage, normalizeQuery } from '../http/pagination.mjs';

const number = value => Number(value || 0);
const iso = value => value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
const pageSize = 10;
const transactionLabel = `CASE t.type WHEN 'REGISTER_BONUS' THEN '注册赠送' WHEN 'RECHARGE' THEN '积分充值'
  WHEN 'MAILBOX_PURCHASE' THEN '邮箱消费' WHEN 'MEMBERSHIP_PURCHASE' THEN '会员消费'
  WHEN 'REFUND' THEN '退款' WHEN 'ADMIN_ADJUSTMENT' THEN '管理员调整' ELSE t.type END`;
const domainLabel = "CASE d.status WHEN 'PENDING' THEN '待审核' WHEN 'ACTIVE' THEN '已启用' WHEN 'DISABLED' THEN '已停用' WHEN 'REJECTED' THEN '已拒绝' ELSE d.status END";
import {orderStatusSql as orderStatus} from './order-status.mjs';
const orderLabel = `CASE (${orderStatus}) WHEN 'PENDING' THEN '待支付' WHEN 'PAID' THEN '已支付' WHEN 'CANCELLED' THEN '已取消' WHEN 'EXPIRED' THEN '已过期' WHEN 'FAILED' THEN '支付失败' END`;
const serializeOrder = row => ({ ...row, points:number(row.points), amount_usd_cents:row.amount_usd_cents==null?null:number(row.amount_usd_cents), energy:row.energy==null?null:number(row.energy), expires_at:iso(row.expires_at), created_at:iso(row.created_at) });

// Every table/join/column is server-owned. User input is only used as bound values.
const legacyOrders = {
 select:`o.public_id AS id,o.points,o.amount_usd_cents,${orderStatus} AS status,o.expires_at,o.created_at,pc.label AS channel`,
 from:'FROM recharge_orders o JOIN payment_channels pc ON pc.id=o.payment_channel_id WHERE o.user_id=?',
};
const sections = {
  transactions: {
    select:'t.public_id AS id,t.type,t.amount,t.balance_after,t.note,t.created_at',
    from:'FROM point_transactions t WHERE t.user_id=?',
    fields:['t.public_id','t.type',transactionLabel,"COALESCE(t.note,'')",'CAST(t.amount AS CHAR)'],
    order:'t.id DESC',
    serialize:row => ({ ...row, amount:number(row.amount), balance_after:number(row.balance_after), created_at:iso(row.created_at) }),
  },
  domains: {
    select:'d.domain,d.mx_status,d.status,d.mailbox_count,d.created_at',
    from:"FROM domains d WHERE d.owner_user_id=? AND d.kind='PRIVATE'",
    fields:['d.domain','d.status',domainLabel],
    order:'d.id DESC',
    serialize:row => ({ ...row, mailbox_count:number(row.mailbox_count), created_at:iso(row.created_at) }),
  },
  orders: {
    select:'o.id,o.points,o.amount_usd_cents,o.energy,o.actual_amount,o.order_type,o.status,o.expires_at,o.created_at,o.channel',
    from:`FROM (${rechargeOrderHistorySql}) o WHERE o.user_id=?`,
    fields:['o.id','o.channel','o.status',orderLabel,'CAST(o.points AS CHAR)'],
    order:'o.created_at DESC,o.id DESC',
    serialize:serializeOrder,
  },
};

export async function queryMemberHistoryPage(connection,{ userId,section,query='',page=1,status='' }) {
  if (!Object.hasOwn(sections,section)) throw Object.assign(new Error('请求的历史类型不正确。'),{ status:400 });
  if(status&&(section!=='orders'||status!=='PENDING'))throw Object.assign(new Error('请求的订单状态不正确。'),{status:400});
  const definition = sections[section];
  query = normalizeQuery(query);
  page = normalizePage(page);
  const params = [userId];
  const search = query ? `AND (${definition.fields.map(field => `LOCATE(?,${field})>0`).join(' OR ')})` : '';
  if (query) params.push(...definition.fields.map(() => query));
  if(status)params.push(status);
  const from = `${definition.from} ${search}${status?' AND o.status=?':''}`;
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total ${from}`,params);
  const total = number(count.total), pages = Math.max(1,Math.ceil(total/pageSize));
  page = Math.min(page,pages);
  const [rows] = await connection.execute(`SELECT ${definition.select} ${from} ORDER BY ${definition.order} LIMIT ? OFFSET ?`,[...params,pageSize,(page-1)*pageSize]);
  return { items:rows.map(definition.serialize),pagination:{ page,pages,total,pageSize } };
}

export async function getMemberHistoryPage(options) {
  const connection = await openDatabase();
  try { return await queryMemberHistoryPage(connection,options); }
  finally { connection.release(); }
}

// Pending orders are a separate view: a still-payable order must not disappear
// just because many newer completed/cancelled orders exist in the history.
export async function queryMemberPendingOrders(connection,userId) {
  const definition = legacyOrders;
  const [rows] = await connection.execute(`SELECT ${definition.select} ${definition.from}
    AND o.status='PENDING' AND o.expires_at>UTC_TIMESTAMP(3) ORDER BY o.id DESC`,[userId]);
  return rows.map(serializeOrder);
}
