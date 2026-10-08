import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, openDatabase } from '../../server/db/database.mjs';
import { hashPassword } from '../../server/auth/service.mjs';
import { defaultApiRateLimit, insertApiKey } from '../../server/member/api-key.mjs';
import { installationLock, verifyInstallation } from './setup.mjs';

export function validateAdministrator(email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  if (normalized.length > 254 || !/^\S+@\S+\.\S+$/.test(normalized)) throw new Error('Enter a valid administrator email address.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 255 || /[\r\n\0]/.test(password)) throw new Error('Administrator password must be 12–255 characters without line breaks.');
  return normalized;
}

export async function bootstrapAdministrator(email, password) {
  email = validateAdministrator(email, password);
  const connection = await openDatabase(); let locked = false;
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [installationLock()]);
    if (Number(lock.acquired) !== 1) throw new Error('Another initialization is running.');
    locked = true;
    await verifyInstallation(connection);
    await connection.beginTransaction();
    const [[flag]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='distribution_admin_bootstrapped' FOR UPDATE");
    const [[count]] = await connection.execute('SELECT COUNT(*) AS count FROM users');
    if (flag || Number(count.count) !== 0) throw new Error('Administrator bootstrap is only allowed once on an empty account database. Existing accounts are never changed.');
    const [user] = await connection.execute("INSERT INTO users(public_id,email,password_hash,role,status,points_balance,locale) VALUES (?,?,?,'SUPER_ADMIN','ACTIVE',0,'zh-CN')", [`U-${randomUUID()}`, email, hashPassword(password)]);
    await insertApiKey(connection, { userId: Number(user.insertId), rateLimit: defaultApiRateLimit });
    await connection.execute("INSERT INTO system_settings(`key`,value,value_type) VALUES ('distribution_admin_bootstrapped','true','boolean')");
    await connection.commit();
    return Number(user.insertId);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [installationLock()]); }
    finally { connection.release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.stdin.isTTY) throw new Error('Supply the administrator password via standard input; never put it in command arguments.');
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024) throw new Error('Administrator password input is too long.');
      chunks.push(chunk);
    }
    await bootstrapAdministrator(process.argv[2], Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''));
    console.info('Administrator created. Log in and configure your own domain, Turnstile and integrations.');
  } catch (error) {
    console.error(error instanceof Error && !('sql' in error) ? error.message : 'Administrator creation failed. Existing accounts were not changed.');
    process.exitCode = 1;
  } finally { await closeDatabasePool(); }
}
