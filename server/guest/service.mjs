import { htmlToPlainText } from '../mail/body-text.mjs';
import { freeMailboxMinutes } from '../member/mailbox-policy.mjs';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { openDatabase } from '../db/database.mjs';

export const guestCookieName = 'nodemail_guest';

const GUEST_SESSION_SECONDS = 24 * 60 * 60;
const MESSAGE_PAGE_SIZE = 10;
const MAX_SEARCH_LENGTH = 100;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const claimIdPattern = /^[A-Za-z0-9_-]{22}$/;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const asIso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function guestSigningSecret() {
  const configured = process.env.GUEST_SESSION_SECRET
    || process.env.SESSION_SECRET
    || process.env.MYSQL_PASSWORD
    || '';
  if (configured.length >= 16) return configured;
  if (process.env.NODE_ENV !== 'production') return 'nodemail-development-guest-session-secret';
  throw new Error('生产环境必须设置长度不少于 16 位的 GUEST_SESSION_SECRET。');
}

function sign(value) {
  return createHmac('sha256', guestSigningSecret()).update(value).digest('base64url');
}

function metadataHash(value) {
  return createHmac('sha256', guestSigningSecret()).update(String(value || '')).digest('hex');
}

function sameString(left, right) {
  try {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function decodeSignedCookie(cookieValue) {
  if (typeof cookieValue !== 'string' || cookieValue.length > 512) return null;
  const [id, token, signature, ...rest] = String(cookieValue || '').split('.');
  if (rest.length || !/^[0-9a-f-]{36}$/i.test(id || '') || !/^[A-Za-z0-9_-]{32,}$/.test(token || '')) return null;
  const payload = `${id}.${token}`;
  if (!sameString(signature, sign(payload))) return null;
  return { id, tokenHash: sha256(token) };
}

// A signed identity is suitable for a bounded rate-limit bucket, not authorization.
// Mail access must still check the database expiry, token hash and user agent.
export function guestReadIdentity(cookieValue) {
  const parsed = decodeSignedCookie(cookieValue);
  return parsed ? `${parsed.id}:${parsed.tokenHash}` : null;
}

function createSignedCookie(id, token) {
  const payload = `${id}.${token}`;
  return `${payload}.${sign(payload)}`;
}

function normalizeDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!domainPattern.test(domain) || domain.length > 253) throw httpError('请选择有效的收信域名。');
  return domain;
}

function normalizeLocalPart(value) {
  const localPart = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(localPart)) {
    throw httpError('邮箱名称只能包含字母、数字、点、下划线和横线。');
  }
  return localPart;
}

function normalizeClaimId(value) {
  const claimId = String(value || '');
  if (!claimIdPattern.test(claimId)) throw httpError('临时邮箱凭证无效，请重新生成资料。');
  return claimId;
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').toLowerCase();
  if (!sessionIdPattern.test(sessionId)) throw httpError('临时邮箱凭证无效，请重新生成资料。');
  return sessionId;
}

function normalizeSearch(value) {
  const query = String(value || '').trim();
  if (query.length > MAX_SEARCH_LENGTH) throw httpError('搜索内容不能超过 100 个字符。');
  return query;
}

function normalizePage(value) {
  const page = Number(value || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw httpError('页码无效。');
  return page;
}


async function expirePreviousMailboxes(connection, guestSessionId) {
  await connection.execute(`
    UPDATE mailboxes
    SET status='EXPIRED', expires_at=LEAST(expires_at, UTC_TIMESTAMP(3))
    WHERE guest_session_id=? AND status='ACTIVE'
  `, [guestSessionId]);
}

async function lookupSession(connection, cookieValue, userAgent, { lock = false, touch = false } = {}) {
  const parsed = decodeSignedCookie(cookieValue);
  if (!parsed) return null;
  const [rows] = await connection.execute(`
    SELECT id, user_agent_hash, expires_at
    FROM guest_sessions
    WHERE id=? AND token_hash=? AND expires_at>UTC_TIMESTAMP(3)
    LIMIT 1${lock ? ' FOR UPDATE' : ''}
  `, [parsed.id, parsed.tokenHash]);
  const session = rows[0];
  if (!session) return null;
  const expectedAgent = session.user_agent_hash;
  if (expectedAgent && expectedAgent !== metadataHash(String(userAgent || '').slice(0, 500))) return null;
  if (touch) {
    await connection.execute(
      'UPDATE guest_sessions SET last_seen_at=UTC_TIMESTAMP(3) WHERE id=?',
      [session.id],
    );
  }
  return session;
}

async function createSession(connection, { ipAddress, userAgent }) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + GUEST_SESSION_SECONDS * 1000);
  await connection.execute(`
    INSERT INTO guest_sessions
      (id, token_hash, ip_hash, user_agent_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `, [
    id,
    sha256(token),
    metadataHash(String(ipAddress || '').slice(0, 45)),
    metadataHash(String(userAgent || '').slice(0, 500)),
    expiresAt,
  ]);
  return {
    id,
    expires_at: expiresAt,
    cookieValue: createSignedCookie(id, token),
    cookieMaxAge: GUEST_SESSION_SECONDS,
  };
}

async function renewSession(connection, session, cookieValue, minimumExpiresAt) {
  // Only successful creation/claim actions renew the session. Read polling does
  // not keep abandoned inboxes alive. Keep the token so concurrent tabs retain
  // the same ownership, and renew the browser cookie alongside the database.
  const now = Date.now();
  const expiresAt = new Date(Math.max(
    now + GUEST_SESSION_SECONDS * 1000,
    new Date(session.expires_at).getTime(),
    minimumExpiresAt ? new Date(minimumExpiresAt).getTime() : 0,
  ));
  await connection.execute(
    'UPDATE guest_sessions SET expires_at=?, last_seen_at=UTC_TIMESTAMP(3) WHERE id=?',
    [expiresAt, session.id],
  );
  return {
    id: session.id,
    cookieValue: session.cookieValue || cookieValue,
    cookieMaxAge: Math.ceil((expiresAt.getTime() - now) / 1000),
  };
}

export async function ensureGuestSession({ cookieValue, ipAddress, userAgent, connection: transaction = null, minimumExpiresAt = null }) {
  const connection = transaction || await openDatabase();
  try {
    if (!transaction) await connection.beginTransaction();
    let session = await lookupSession(connection, cookieValue, userAgent, { lock:true });
    if (!session) {
      session = await createSession(connection, { ipAddress, userAgent });
    }
    const issuedCookie = await renewSession(connection, session, cookieValue, minimumExpiresAt);
    if (!transaction) await connection.commit();
    return { id:session.id, issuedCookie };
  } catch (error) {
    if (!transaction) await connection.rollback();
    throw error;
  } finally {
    if (!transaction) connection.release();
  }
}

async function currentMailbox(connection, guestSessionId, { lock = false, relayOnly = false } = {}) {
  const [rows] = await connection.execute(`
    SELECT mb.id AS internal_id, mb.public_id AS id, mb.address,
           mb.duration_minutes, mb.received_count, mb.expires_at, mb.created_at,
           d.domain, (d.status='ACTIVE' AND d.mx_status='ACTIVE' AND (mb.relay_account_id IS NULL OR ra.status='ACTIVE')) AS available
    FROM mailboxes mb
    JOIN domains d ON d.id=mb.domain_id
    LEFT JOIN relay_accounts ra ON ra.id=mb.relay_account_id
    WHERE mb.guest_session_id=? AND mb.status='ACTIVE'
      AND mb.expires_at>UTC_TIMESTAMP(3)
      ${relayOnly ? 'AND mb.relay_account_id IS NOT NULL' : ''}
    ORDER BY mb.id DESC
    LIMIT 1${lock ? ' FOR UPDATE' : ''}
  `, [guestSessionId]);
  const mailbox = rows[0];
  if (!mailbox) return null;
  return {
    id: mailbox.id,
    address: mailbox.address,
    localPart: String(mailbox.address).slice(0, String(mailbox.address).lastIndexOf('@')),
    domain: mailbox.domain,
    durationMinutes: Number(mailbox.duration_minutes || 0),
    receivedCount: Number(mailbox.received_count || 0),
    expiresAt: asIso(mailbox.expires_at),
    createdAt: asIso(mailbox.created_at),
    available: Boolean(mailbox.available),
  };
}

export async function createOrRotateGuestMailbox({ cookieValue, domain: rawDomain, localPart: rawLocalPart, claimId: rawClaimId, requiredSessionId: rawRequiredSessionId, ipAddress, userAgent }) {
  const domain = normalizeDomain(rawDomain);
  const requestedLocalPart = rawLocalPart == null || rawLocalPart === ''
    ? ''
    : normalizeLocalPart(rawLocalPart);
  const requestedClaimId = requestedLocalPart ? normalizeClaimId(rawClaimId) : '';
  const requiredSessionId = requestedLocalPart ? normalizeSessionId(rawRequiredSessionId) : '';
  const connection = await openDatabase();
  let issuedCookie = null;
  try {
    await connection.beginTransaction();
    let session = await lookupSession(connection, cookieValue, userAgent, { lock: true });
    if (requiredSessionId && (!session || session.id !== requiredSessionId)) {
      throw httpError('临时邮箱凭证无效，请重新生成资料。', 401);
    }
    if (!session) {
      session = await createSession(connection, { ipAddress, userAgent });
      issuedCookie = session;
    }

    const [[domainRow]] = await connection.execute(`
      SELECT id, domain
      FROM domains
      WHERE domain=? AND kind='PUBLIC' AND status='ACTIVE' AND mx_status='ACTIVE'
      LIMIT 1
      FOR UPDATE
    `, [domain]);
    if (!domainRow) throw httpError('该免费收信域名当前不可用。', 409);

    const [[durationSetting]] = await connection.execute(
      "SELECT value FROM system_settings WHERE `key`='free_mailbox_minutes' LIMIT 1",
    );
    const durationMinutes = freeMailboxMinutes(durationSetting?.value);

    const expiresAt = new Date(Date.now() + durationMinutes * 60_000);
    if (requestedClaimId) {
      const publicId = `GMB-C-${requestedClaimId}`;
      const expectedAddress = `${requestedLocalPart}@${domainRow.domain}`;
      const [[existingClaimMailbox]] = await connection.execute(`
        SELECT mb.public_id, mb.address, mb.duration_minutes, mb.received_count,
               mb.expires_at, mb.created_at, d.domain
        FROM mailboxes mb
        JOIN domains d ON d.id=mb.domain_id
        WHERE mb.public_id=? AND mb.guest_session_id=? AND mb.user_id IS NULL
          AND mb.status='ACTIVE' AND mb.expires_at>UTC_TIMESTAMP(3)
        LIMIT 1
        FOR UPDATE
      `, [publicId, session.id]);
      if (existingClaimMailbox) {
        if (String(existingClaimMailbox.address).toLowerCase() !== expectedAddress.toLowerCase()
          || String(existingClaimMailbox.domain).toLowerCase() !== String(domainRow.domain).toLowerCase()) {
          throw httpError('临时邮箱凭证无效，请重新生成资料。', 409);
        }
        issuedCookie = await renewSession(connection, session, cookieValue, existingClaimMailbox.expires_at);
        await connection.commit();
        return {
          mailbox:{
            id:existingClaimMailbox.public_id,
            address:existingClaimMailbox.address,
            localPart:requestedLocalPart,
            domain:existingClaimMailbox.domain,
            durationMinutes:Number(existingClaimMailbox.duration_minutes || 0),
            receivedCount:Number(existingClaimMailbox.received_count || 0),
            expiresAt:asIso(existingClaimMailbox.expires_at),
            createdAt:asIso(existingClaimMailbox.created_at),
          },
          issuedCookie,
        };
      }
    }

    await expirePreviousMailboxes(connection, session.id);
    let mailbox;
    const maxAttempts = requestedLocalPart ? 1 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const localPart = requestedLocalPart || randomBytes(6).toString('hex');
      const address = `${localPart}@${domainRow.domain}`;
      const publicId = requestedClaimId ? `GMB-C-${requestedClaimId}` : `GMB-${randomUUID()}`;
      let inserted = false;
      try {
        await connection.execute(`
          INSERT INTO mailboxes
            (public_id, user_id, guest_session_id, domain_id, address, duration_minutes, status, expires_at)
          VALUES (?, NULL, ?, ?, ?, ?, 'ACTIVE', ?)
        `, [publicId, session.id, domainRow.id, address, durationMinutes, expiresAt]);
        inserted = true;
      } catch (error) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        if (!requestedClaimId) continue;
      }
      if (requestedClaimId) {
        if (!inserted) throw httpError('该邮箱地址已被使用，请重新生成资料。', 409);
        mailbox = {
          id:publicId,
          address,
          localPart,
          domain:domainRow.domain,
          durationMinutes,
          receivedCount:0,
          expiresAt:expiresAt.toISOString(),
          createdAt:new Date().toISOString(),
        };
        await connection.execute('UPDATE domains SET mailbox_count=mailbox_count+1 WHERE id=?', [domainRow.id]);
      } else {
        if (!inserted) continue;
        mailbox = {
          id:publicId,
          address,
          localPart,
          domain:domainRow.domain,
          durationMinutes,
          receivedCount:0,
          expiresAt:expiresAt.toISOString(),
          createdAt:new Date().toISOString(),
        };
        await connection.execute('UPDATE domains SET mailbox_count=mailbox_count+1 WHERE id=?', [domainRow.id]);
      }
      break;
    }
    if (!mailbox) throw httpError('暂时无法分配邮箱地址，请稍后重试。', 503);
    issuedCookie = await renewSession(connection, session, cookieValue, expiresAt);
    await connection.commit();
    return { mailbox, issuedCookie };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getGuestMailbox({ cookieValue, userAgent, relayOnly = false }) {
  const connection = await openDatabase();
  try {
    const session = await lookupSession(connection, cookieValue, userAgent, { touch: true });
    if (!session) return null;
    return currentMailbox(connection, session.id, { relayOnly });
  } finally {
    connection.release();
  }
}

export async function listGuestMessages({ cookieValue, userAgent, query: rawQuery, page: rawPage, relayOnly = false }) {
  const query = normalizeSearch(rawQuery);
  const page = normalizePage(rawPage);
  const connection = await openDatabase();
  try {
    const session = await lookupSession(connection, cookieValue, userAgent, { touch: true });
    if (!session) throw httpError('临时邮箱会话不存在或已经失效。', 401);
    const mailbox = await currentMailbox(connection, session.id, { relayOnly });
    if (!mailbox) throw httpError('临时邮箱已经过期，请重新生成。', 410);
    const searchSql = query ? ' AND (m.from_address LIKE ? OR COALESCE(m.subject,\'\') LIKE ?)' : '';
    const searchArgs = query ? [`%${query}%`, `%${query}%`] : [];
    const [[countRow]] = await connection.execute(`
      SELECT COUNT(*) AS total
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE mb.public_id=? AND mb.guest_session_id=? AND mb.status='ACTIVE'
        AND mb.expires_at>UTC_TIMESTAMP(3) AND m.risk_status='SAFE'${searchSql}
    `, [mailbox.id, session.id, ...searchArgs]);
    const total = Number(countRow?.total || 0);
    const pages = Math.max(1, Math.ceil(total / MESSAGE_PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const offset = (safePage - 1) * MESSAGE_PAGE_SIZE;
    const [rows] = await connection.execute(`
      SELECT m.public_id AS id, m.from_address AS sender, COALESCE(m.subject,'') AS subject,
             m.size_bytes, m.is_read, m.received_at
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE mb.public_id=? AND mb.guest_session_id=? AND mb.status='ACTIVE'
        AND mb.expires_at>UTC_TIMESTAMP(3) AND m.risk_status='SAFE'${searchSql}
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT ${MESSAGE_PAGE_SIZE} OFFSET ${offset}
    `, [mailbox.id, session.id, ...searchArgs]);
    return {
      mailbox,
      messages: rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        subject: row.subject || '（无主题）',
        sizeBytes: Number(row.size_bytes || 0),
        isRead: Boolean(row.is_read),
        receivedAt: asIso(row.received_at),
      })),
      pagination: { total, page: safePage, pages, pageSize: MESSAGE_PAGE_SIZE },
    };
  } finally {
    connection.release();
  }
}

export async function getGuestMessage({ cookieValue, userAgent, messageId }) {
  const id = String(messageId || '');
  if (!/^M-[0-9a-f-]{36}$/i.test(id) && !/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(id)) {
    throw httpError('邮件编号无效。');
  }
  const connection = await openDatabase();
  try {
    const session = await lookupSession(connection, cookieValue, userAgent, { touch: true });
    if (!session) throw httpError('临时邮箱会话不存在或已经失效。', 401);
    const [[message]] = await connection.execute(`
      SELECT m.public_id AS id, mb.address AS recipient, m.from_address AS sender,
             COALESCE(m.subject,'') AS subject, m.text_content, m.html_content,
             m.size_bytes, m.is_read, m.received_at
      FROM messages m
      JOIN mailboxes mb ON mb.id=m.mailbox_id
      WHERE m.public_id=? AND mb.guest_session_id=? AND mb.status='ACTIVE'
        AND mb.expires_at>UTC_TIMESTAMP(3) AND m.risk_status='SAFE'
      LIMIT 1
    `, [id, session.id]);
    if (!message) throw httpError('邮件不存在或临时邮箱已经过期。', 404);
    if (!message.is_read) {
      await connection.execute(`
        UPDATE messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        SET m.is_read=1
        WHERE m.public_id=? AND mb.guest_session_id=?
      `, [id, session.id]);
    }
    const text = String(message.text_content || '').trim();
    const bodyText = text || htmlToPlainText(message.html_content) || '（邮件正文为空）';
    return {
      id: message.id,
      recipient: message.recipient,
      sender: message.sender,
      subject: message.subject || '（无主题）',
      sizeBytes: Number(message.size_bytes || 0),
      isRead: true,
      receivedAt: asIso(message.received_at),
      contentType: text ? '纯文本邮件' : 'HTML 邮件（纯文本展示）',
      bodyText: bodyText.length > 1_000_000 ? `${bodyText.slice(0, 1_000_000)}\n\n[内容过长，已截断]` : bodyText,
    };
  } finally {
    connection.release();
  }
}
