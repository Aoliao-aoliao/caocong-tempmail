// Cross-table address ownership must be serialized for both account saves and
// alias changes. Account row locks alone cannot arbitrate a new physical account.
import { createHash } from "node:crypto";
const nameFor = (database) =>
  "nodemail:routes:" +
  createHash("sha256").update(database).digest("hex").slice(0, 40);
const held = new WeakMap();
export async function lockRelayRouting(connection) {
  const [[row]] = await connection.query("SELECT DATABASE() AS name");
  const name = nameFor(String(row.name));
  const [[lock]] = await connection.execute(
    "SELECT GET_LOCK(?,10) AS acquired",
    [name],
  );
  if (Number(lock.acquired) !== 1)
    throw Object.assign(new Error("中继地址配置繁忙，请重试。"), {
      status: 409,
    });
  held.set(connection, name);
}
export async function unlockRelayRouting(connection) {
  const name = held.get(connection);
  if (!name) return;
  held.delete(connection);
  try {
    await connection.execute("SELECT RELEASE_LOCK(?)", [name]);
  } catch (error) {
    connection.destroy();
    throw error;
  }
}
