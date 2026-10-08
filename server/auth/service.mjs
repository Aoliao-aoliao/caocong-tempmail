import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { defaultApiRateLimit, insertApiKey } from '../member/api-key.mjs';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-password');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password, encodedHash) {
  // Reject malformed/truncated digests before choosing a scrypt output length.
  if (typeof encodedHash !== 'string' || !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(encodedHash)) return false;
  const [algorithm, salt, storedHex] = String(encodedHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !storedHex) return false;
  try {
    const stored = Buffer.from(storedHex, 'hex');
    const candidate = scryptSync(password, salt, stored.length, SCRYPT_OPTIONS);
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  } catch {
    return false;
  }
}

function validateCredentials(email, password) {
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return '请输入有效的账户邮箱。';
  if (typeof password !== 'string' || password.length < 8 || password.length > 255) return '密码长度需要为 8–255 个字符。';
  return null;
}

export async function registerUser({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  const validationError = validateCredentials(email, password);
  if (validationError) return { ok: false, status: 400, message: validationError };

  const connection = await openDatabase();
  try {
    const [existing] = await connection.execute('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing.length) return { ok: false, status: 409, message: '这个邮箱已经注册，请直接登录。' };

    const publicId = `U-${randomUUID()}`;
    const transactionId = `PT-${randomUUID()}`;
    await connection.beginTransaction();
    try {
      const [[bonusSetting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='registration_bonus_points'");
      const bonus = Math.max(0,Number(bonusSetting?.value || 0));
      const [result] = await connection.execute(`
        INSERT INTO users (public_id, email, password_hash, points_balance, locale)
        VALUES (?, ?, ?, ?, 'zh-CN')
      `, [publicId, email, hashPassword(password),bonus]);
      const userId = Number(result.insertId);
      await insertApiKey(connection, { userId, rateLimit:defaultApiRateLimit });
      if (bonus > 0) await connection.execute(`
        INSERT INTO point_transactions
          (public_id, user_id, type, amount, balance_after, note)
        VALUES (?, ?, 'REGISTER_BONUS', ?, ?, '新用户注册赠送')
      `, [transactionId, userId,bonus,bonus]);
      await connection.commit();
      return { ok: true, userId, email };
    } catch (error) {
      await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') return { ok: false, status: 409, message: '这个邮箱已经注册，请直接登录。' };
      throw error;
    }
  } finally {
    connection.release();
  }
}

export async function authenticateUser({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  const validationError = validateCredentials(email, password);
  if (validationError) return { ok: false, status: 400, message: '邮箱或密码不正确。' };

  const connection = await openDatabase();
  try {
    const [rows] = await connection.execute(`
      SELECT id, public_id, email, password_hash, role, status
      FROM users WHERE email = ? LIMIT 1
    `, [email]);
    const user = rows[0];
    const validPassword = verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !validPassword || user.status !== 'ACTIVE') return { ok: false, status: 401, message: '邮箱或密码不正确。' };
    return { ok: true, user };
  } finally {
    connection.release();
  }
}

export async function createSession({ userId, ipAddress, userAgent, expectedPasswordHash = undefined }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[current]] = await connection.execute('SELECT password_hash,status FROM users WHERE id=? FOR UPDATE',[userId]);
    if (!current || current.status !== 'ACTIVE' || (expectedPasswordHash && current.password_hash !== expectedPasswordHash)) throw Object.assign(new Error('账户状态已变化，请重新登录。'),{status:401});
    await connection.execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
    await connection.execute(`
      INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [randomUUID(), userId, hashToken(token), String(ipAddress || '').slice(0, 45) || null, String(userAgent || '').slice(0, 500) || null, expiresAt]);
    await connection.commit();
  } catch(error) {
    await connection.rollback();throw error;
  } finally {
    connection.release();
  }
  return { token, expiresAt: expiresAt.toISOString(), maxAge: SESSION_TTL_SECONDS };
}

export async function deleteSession(token) {
  if (!token) return;
  const connection = await openDatabase();
  try {
    await connection.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  } finally {
    connection.release();
  }
}

export async function getSessionUser(token) {
  if (!token) return null;
  const connection = await openDatabase();
  try {
    const [rows] = await connection.execute(`
      SELECT u.id, u.public_id, u.email, u.role, u.status, u.points_balance, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.id NOT LIKE 'pr:%' AND s.expires_at > UTC_TIMESTAMP(3) AND u.status = 'ACTIVE'
      LIMIT 1
    `, [hashToken(token)]);
    return rows[0] || null;
  } finally {
    connection.release();
  }
}

export const sessionCookieName = 'nodemail_session';
