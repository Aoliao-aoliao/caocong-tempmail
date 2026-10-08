import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CLAIM_VERSION = 2;
const DEFAULT_LIFETIME_SECONDS = 5 * 60;
const localPartPattern = /^[a-z0-9][a-z0-9._-]{4,31}$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const claimIdPattern = /^[A-Za-z0-9_-]{22}$/;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function signingSecret() {
  const configured = process.env.GUEST_SESSION_SECRET
    || process.env.SESSION_SECRET
    || process.env.MYSQL_PASSWORD
    || '';
  if (configured.length >= 16) return configured;
  if (process.env.NODE_ENV !== 'production') return 'nodemail-development-guest-session-secret';
  throw new Error('生产环境必须设置长度不少于 16 位的 GUEST_SESSION_SECRET。');
}

function signature(payload) {
  return createHmac('sha256', signingSecret())
    .update(`guest-mailbox-claim:${payload}`)
    .digest('base64url');
}

function safeEqual(left, right) {
  try {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function normalizeMailboxTarget(localPartValue, domainValue) {
  const localPart = String(localPartValue || '').trim().toLowerCase();
  const domain = String(domainValue || '').trim().toLowerCase();
  if (!localPartPattern.test(localPart) || !domainPattern.test(domain) || domain.length > 253) {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  return { localPart, domain };
}

function normalizeClaimId(value) {
  const claimId = String(value || '');
  if (!claimIdPattern.test(claimId)) {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  return claimId;
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').toLowerCase();
  if (!sessionIdPattern.test(sessionId)) {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  return sessionId;
}

export function issueGuestMailboxClaim({ localPart, domain, sessionId, claimId = randomBytes(16).toString('base64url'), now = Date.now(), lifetimeSeconds = DEFAULT_LIFETIME_SECONDS }) {
  const target = normalizeMailboxTarget(localPart, domain);
  const normalizedClaimId = normalizeClaimId(claimId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  const seconds = Number(lifetimeSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 15 * 60) {
    throw new TypeError('邮箱凭证有效期不合法。');
  }
  const payload = Buffer.from(JSON.stringify({
    v:CLAIM_VERSION,
    claimId:normalizedClaimId,
    sessionId:normalizedSessionId,
    localPart:target.localPart,
    domain:target.domain,
    exp:Math.floor(Number(now) / 1000) + seconds,
  }), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyGuestMailboxClaim(value, { now = Date.now() } = {}) {
  const [payload, suppliedSignature, ...rest] = String(value || '').split('.');
  if (rest.length || !payload || !suppliedSignature || !safeEqual(suppliedSignature, signature(payload))) {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  if (!decoded || decoded.v !== CLAIM_VERSION || !Number.isSafeInteger(decoded.exp)) {
    throw httpError('临时邮箱凭证无效，请重新生成资料。');
  }
  if (decoded.exp < Math.floor(Number(now) / 1000)) {
    throw httpError('临时邮箱凭证已过期，请重新生成资料。', 410);
  }
  return {
    ...normalizeMailboxTarget(decoded.localPart, decoded.domain),
    claimId:normalizeClaimId(decoded.claimId),
    sessionId:normalizeSessionId(decoded.sessionId),
  };
}
