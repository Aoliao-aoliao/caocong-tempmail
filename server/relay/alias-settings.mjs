import { lockRelayRouting, unlockRelayRouting } from "./routing-lock.mjs";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.mjs";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function validateAlias(account, input) {
  const address = String(input.address || "")
    .trim()
    .toLowerCase();
  const [name, suffix] = address.split("@");
  if (
    !/^[a-z0-9._-]+@(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com)$/.test(
      address,
    ) ||
    address.length > 320 ||
    address === account.email
  )
    throw fail("请输入有效的独立收信别名，不能填写主账号地址。");
  if (account.provider === "GMAIL") {
    const [primary, domain] = account.email.toLowerCase().split("@");
    if (
      !["gmail.com", "googlemail.com"].includes(domain) ||
      name !== primary ||
      suffix !== (domain === "gmail.com" ? "googlemail.com" : "gmail.com")
    )
      throw fail("Gmail 别名必须是相同用户名的 Gmail / Googlemail 地址。");
  } else if (account.provider === "OUTLOOK") {
    if (!["hotmail.com", "outlook.com", "live.com"].includes(suffix))
      throw fail("微软别名后缀无效。");
    if (input.enabled === true && input.confirmed !== true)
      throw fail("请先确认该地址已添加到这个 Microsoft 账号的别名列表。");
  } else throw fail("此处仅支持 Gmail 和个人 Microsoft 邮箱别名。");
  if (typeof input.enabled !== "boolean") throw fail("别名开关无效。");
  return address;
}
export async function setRelayAlias(
  input,
  { actorUserId, ipAddress } = {},
  dependencies = {},
) {
  const c = await (dependencies.openDatabase || openDatabase)();
  try {
    await lockRelayRouting(c);
    await c.beginTransaction();
    const [[a]] = await c.execute(
      "SELECT id,public_id,email,provider FROM relay_accounts WHERE public_id=? FOR UPDATE",
      [String(input.id || "")],
    );
    if (!a) throw fail("中继账号不存在。", 404);
    const address = validateAlias(a, input);
    const suffix = address.split("@")[1];
    if (input.enabled) {
      const [[conflict]] = await c.execute(
        "SELECT id FROM relay_accounts WHERE email=? AND id<>? LIMIT 1",
        [address, a.id],
      );
      if (conflict) throw fail("该地址已属于另一个中继账号。", 409);
      const [[mapped]] = await c.execute(
        "SELECT relay_account_id FROM relay_account_addresses WHERE address=? FOR UPDATE",
        [address],
      );
      if (mapped && Number(mapped.relay_account_id) !== Number(a.id))
        throw fail("该别名已关联其他账号。", 409);
      const [[domain]] = await c.execute(
        "SELECT kind FROM domains WHERE domain=? FOR UPDATE",
        [suffix],
      );
      if (domain && domain.kind !== "RELAY")
        throw fail("该后缀已用于其他邮箱服务。", 409);
      await c.execute(
        "INSERT IGNORE INTO relay_account_addresses(relay_account_id,address) VALUES (?,?)",
        [a.id, address],
      );
      await c.execute(
        "INSERT INTO domains(domain,kind,mx_status,status) VALUES (?,'RELAY','ACTIVE','ACTIVE') ON DUPLICATE KEY UPDATE status='ACTIVE',mx_status='ACTIVE'",
        [suffix],
      );
    } else
      await c.execute(
        "DELETE FROM relay_account_addresses WHERE relay_account_id=? AND address=?",
        [a.id, address],
      );
    await c.execute(
      "INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address) VALUES (?,?,?,'RELAY_ACCOUNT',?,?,?)",
      [
        "AL-" + randomUUID(),
        actorUserId || null,
        input.enabled ? "启用中继收信别名" : "停止中继别名新分配",
        a.public_id,
        JSON.stringify({ address, enabled: input.enabled }),
        String(ipAddress || "").slice(0, 45) || null,
      ],
    );
    await c.commit();
    return { address, enabled: input.enabled };
  } catch (e) {
    await c.rollback();
    if (e.code === "ER_DUP_ENTRY") throw fail("该别名已关联其他账号。", 409);
    throw e;
  } finally {
    try {
      await unlockRelayRouting(c);
    } finally {
      c.release();
    }
  }
}
