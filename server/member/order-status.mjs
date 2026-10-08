// Both consoles compute expiry without mutating reconciliation state.
export const orderStatusSql = "CASE WHEN o.status='PENDING' AND o.expires_at<=UTC_TIMESTAMP(3) THEN 'EXPIRED' ELSE o.status END";
