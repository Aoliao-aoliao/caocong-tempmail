import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { apiError } from './service.mjs';

export const OPENAPI_PAGE_SIZE = 10;

export function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function pagedResult({ count, page, data, size = OPENAPI_PAGE_SIZE }) {
  const recordCount = Math.max(0, Number(count) || 0);
  return {
    count:recordCount,
    size,
    page,
    total:Math.max(1, Math.ceil(recordCount / size)),
    data,
  };
}

export function openApiDomainType(kind) {
  return { PUBLIC:0, LOGIN:1, MEMBER:2, PRIVATE:3 }[kind] ?? -1;
}

export function openApiUserState(status) {
  return { ACTIVE:0, RESTRICTED:1, DISABLED:2 }[status] ?? 2;
}

export function mailboxExpiry(expiresAt, status, now = Date.now()) {
  if (!expiresAt) return { expired:false, expiryText:'长期有效', expiryTone:'permanent' };
  const expires = new Date(expiresAt).getTime();
  const remaining = expires - now;
  const expired = status === 'EXPIRED' || status === 'DELETED' || !Number.isFinite(expires) || remaining <= 0;
  if (expired) return { expired:true, expiryText:'已过期', expiryTone:'expired' };
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
  const days = Math.ceil(hours / 24);
  return {
    expired:false,
    expiryText:hours <= 48 ? `${hours} 小时后到期` : `${days} 天后到期`,
    expiryTone:hours <= 24 ? 'warning' : 'healthy',
  };
}

export function extractMailKeyword(subject, textContent) {
  const source = `${String(subject || '')}\n${String(textContent || '')}`;
  const contextual = source.match(/(?:验证码|verification\s*code|otp|code)[^0-9a-z]{0,12}([0-9]{4,8})/i);
  if (contextual) return contextual[1];
  return source.match(/\b([0-9]{4,8})\b/)?.[1] || null;
}

export function normalizeMailboxPrefix(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return randomBytes(8).toString('hex').slice(0, 10);
  }
  const prefix = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{4,31}$/.test(prefix)) {
    throw apiError(-1408, undefined, 400);
  }
  return prefix;
}

export function normalizeDurationHours(value) {
  if (value === undefined || value === null || value === '') return 1;
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 365) {
    throw apiError(-1405, undefined, 400);
  }
  return hours;
}

function normalizeDomainId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw apiError(-1400, undefined, 400);
  return id;
}

export async function selectOpenApiDomain({ userId, domainId, legacyDomain }) {
  const id = normalizeDomainId(domainId);
  const domainName = String(legacyDomain || '').trim().toLowerCase();
  const connection = await openDatabase();
  try {
    let row;
    if (id) {
      [[row]] = await connection.execute(
        'SELECT id,domain,kind,owner_user_id,status,mx_status FROM domains WHERE id=? LIMIT 1',
        [id],
      );
    } else if (domainName) {
      [[row]] = await connection.execute(
        'SELECT id,domain,kind,owner_user_id,status,mx_status FROM domains WHERE domain=? LIMIT 1',
        [domainName],
      );
    } else {
      const [rows] = await connection.execute(`
        SELECT id,domain,kind,owner_user_id,status,mx_status
        FROM domains
        WHERE status='ACTIVE' AND mx_status='ACTIVE' AND kind IN ('PUBLIC','LOGIN')
        ORDER BY RAND()
        LIMIT 1
      `);
      row = rows[0];
    }
    if (!row) throw apiError(id || domainName ? -1401 : -1407, undefined, id || domainName ? 404 : 503);
    if (row.kind === 'RELAY') throw apiError(-1401, '中继域名只能通过中继邮箱功能使用。', 400);
    if (row.status !== 'ACTIVE' || row.mx_status !== 'ACTIVE') {
      throw apiError(-1401, undefined, 400);
    }
    if (row.kind === 'PRIVATE' && Number(row.owner_user_id) !== Number(userId)) {
      throw apiError(-1404, undefined, 403);
    }
    return { id:Number(row.id), domain:row.domain, kind:row.kind };
  } finally {
    connection.release();
  }
}

export async function getCreatedMailbox({ userId, publicId }) {
  const connection = await openDatabase();
  try {
    const [[row]] = await connection.execute(`
      SELECT id,public_id,domain_id,user_id,address,received_count,status,
             expires_at,created_at,updated_at
      FROM mailboxes
      WHERE user_id=? AND public_id=?
      LIMIT 1
    `, [userId, publicId]);
    if (!row) throw apiError(-1410, undefined, 500);
    return row;
  } finally {
    connection.release();
  }
}
