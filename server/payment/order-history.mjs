import {orderStatusSql} from '../member/order-status.mjs';
// Display both channels together without changing reconciliation or currency.
export const rechargeOrderHistorySql = `
 SELECT o.public_id AS id,o.user_id,o.points,o.amount_usd_cents,NULL AS energy,
        'LEGACY' AS order_type,${orderStatusSql} AS status,o.expires_at,o.created_at,pc.label AS channel,NULL AS actual_amount
 FROM recharge_orders o JOIN payment_channels pc ON pc.id=o.payment_channel_id
 UNION ALL
 SELECT o.id,o.user_id,o.points,NULL,o.energy,'NODELOC',${orderStatusSql},o.expires_at,o.created_at,'NodeLoc 能量',NULL
 FROM nodeloc_payment_orders o
 UNION ALL
 SELECT o.id,o.user_id,o.points,o.amount_usd_cents,NULL,'GMPAY',${orderStatusSql},o.expires_at,o.created_at,'USDT / TRC20',o.actual_amount
 FROM gmpay_payment_orders o
`;
