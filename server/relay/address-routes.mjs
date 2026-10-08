import { openDatabase } from "../db/database.mjs";
export const relayRoutesSql =
  "(SELECT id AS account_id,email AS address,suffix FROM relay_accounts UNION ALL SELECT relay_account_id,address,SUBSTRING_INDEX(address,'@',-1) FROM relay_account_addresses)";
const eligible =
  "ra.status='ACTIVE' AND (ra.provider<>'OUTLOOK' OR EXISTS (SELECT 1 FROM system_settings ms WHERE ms.`key`=CONCAT('microsoft_relay_token:',ra.public_id) AND JSON_EXTRACT(ms.value,'$.reauthRequired')=false AND JSON_UNQUOTE(JSON_EXTRACT(ms.value,'$.configRevision'))=(SELECT JSON_UNQUOTE(JSON_EXTRACT(mc.value,'$.revision')) FROM system_settings mc WHERE mc.`key`='microsoft_relay_config')))";
export async function relayPublicRoutes() {
  const c = await openDatabase();
  try {
    const [rows] = await c.query(
      "SELECT DISTINCT routes.suffix,ra.provider FROM relay_accounts ra JOIN " +
        relayRoutesSql +
        " routes ON routes.account_id=ra.id JOIN domains d ON d.domain=routes.suffix AND d.kind='RELAY' AND d.status='ACTIVE' WHERE " +
        eligible +
        " AND (SELECT COUNT(*) FROM mailboxes mb WHERE mb.relay_account_id=ra.id AND mb.status='ACTIVE' AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3)))<ra.max_aliases ORDER BY FIELD(ra.provider,'GMAIL','OUTLOOK','CUSTOM'),routes.suffix",
    );
    return rows.map((row) => ({ suffix: row.suffix, provider: row.provider }));
  } finally {
    c.release();
  }
}
export async function chooseRoutedAccount(c, suffix) {
  const requested = String(suffix || "")
    .trim()
    .toLowerCase();
  // Filter capacity before the bounded candidate list: ten full small accounts
  // must not hide a larger available one. This unlocked count is only a hint;
  // the account and current usage are still locked and rechecked below.
  const [candidates] = await c.execute(
    "SELECT DISTINCT ra.id,ra.max_aliases,(SELECT COUNT(*) FROM mailboxes mb WHERE mb.relay_account_id=ra.id AND mb.status='ACTIVE' AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))) AS active_aliases FROM relay_accounts ra JOIN " +
      relayRoutesSql +
      " routes ON routes.account_id=ra.id WHERE routes.suffix=? AND " +
      eligible +
      " HAVING active_aliases<ra.max_aliases ORDER BY active_aliases ASC,ra.id ASC LIMIT 10",
    [requested],
  );
  for (const candidate of candidates) {
    const [[row]] = await c.execute(
      "SELECT ra.* FROM relay_accounts ra WHERE ra.id=? AND " +
        eligible +
        " FOR UPDATE",
      [candidate.id],
    );
    if (!row) continue;
    let route = row.suffix === requested ? { address: row.email } : null;
    if (!route) {
      const [[mapped]] = await c.execute(
        "SELECT address FROM relay_account_addresses WHERE relay_account_id=? AND SUBSTRING_INDEX(address,'@',-1)=? ORDER BY address LIMIT 1 FOR UPDATE",
        [row.id, requested],
      );
      route = mapped;
    }
    if (!route) continue;
    const [[usage]] = await c.execute(
      "SELECT COUNT(*) AS count FROM mailboxes WHERE relay_account_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) FOR UPDATE",
      [row.id],
    );
    if (Number(usage.count) < Number(row.max_aliases))
      return {
        ...row,
        routing_email: route.address,
        suffix: requested,
        active_aliases: Number(usage.count),
      };
  }
  throw Object.assign(new Error("该中继后缀暂无可用账号，请稍后重试。"), {
    status: 409,
  });
}
export async function relayExtraAddresses() {
  const c = await openDatabase();
  try {
    const [rows] = await c.query(
      "SELECT ra.public_id,a.address FROM relay_account_addresses a JOIN relay_accounts ra ON ra.id=a.relay_account_id ORDER BY a.address",
    );
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.public_id)) map.set(row.public_id, []);
      map.get(row.public_id).push(row.address);
    }
    return map;
  } finally {
    c.release();
  }
}
