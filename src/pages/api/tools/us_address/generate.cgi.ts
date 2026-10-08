import { readBoundedText } from '../../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { getSessionUser, sessionCookieName } from '../../../../../server/auth/service.mjs';
import { randomInt } from 'node:crypto';
import { consumeAuthRateLimit, isSameOriginRequest } from '../../../../../server/auth/request-security.mjs';
import { openDatabase } from '../../../../../server/db/database.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { issueGuestMailboxClaim } from '../../../../../server/guest/mailbox-claim.mjs';
import { ensureGuestSession, guestCookieName } from '../../../../../server/guest/service.mjs';
import {
  createAddressMailboxLocalPart,
  createUsAddressProfile,
  normalizeUsStateCode,
} from '../../../../../server/tools/us-address.mjs';
import { json } from '../../../../../server/http/api.mjs';

export const prerender = false;

const MAX_BODY_BYTES = 4096;

function safeApiError(error: unknown) {
  const status = Number((error as { status?:unknown } | null)?.status);
  if (error instanceof Error && Number.isInteger(status) && status >= 400 && status <= 599) {
    return json({ ok:false, message:error.message }, status);
  }
  console.error('[guest-us-address] generation failed', error);
  return json({ ok:false, message:'地址资料生成失败。' }, 500);
}

const tooMany = (retryAfter: number) => new Response(JSON.stringify({
  ok:false,
  message:'操作频繁，请稍后再试',
}), {
  status:429,
  headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'retry-after':String(retryAfter),
  },
});

export const POST: APIRoute = async ({ request, clientAddress, cookies, url }) => {
  try {
    if (!isSameOriginRequest(request, url.origin)) {
      return json({ ok:false, message:'请求来源无效。' }, 403);
    }
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return json({ ok:false, message:'请求格式不正确。' }, 415);
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ ok:false, message:'请求内容过大。' }, 413);

    const rawBody = await readBoundedText(request, MAX_BODY_BYTES);
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return json({ ok:false, message:'请求内容过大。' }, 413);
    }
    const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ ok:false, message:'请求格式不正确。' }, 400);
    }
    const stateCode = normalizeUsStateCode(body.stateCode);
    const taxFreeOnly = body.taxFreeOnly ?? false;
    if (typeof taxFreeOnly !== 'boolean') return json({ok:false,message:'请求筛选条件无效。'},400);
    const member = await getSessionUser(cookies.get(sessionCookieName)?.value);
    const requestIp = guestRequestIp(request, clientAddress);
    const rate = await consumeAuthRateLimit({
      action:'GUEST_US_ADDRESS_GENERATE_IP',
      identifier:requestIp,
      limit:5,
      windowSeconds:10,
    });
    if (!rate.allowed) return tooMany(rate.retryAfter);

    const connection = await openDatabase();
    let profile: ReturnType<typeof createUsAddressProfile> | null = null;
    let mailboxDomainId = 0;
    let mailboxDomain = '';
    let localPart = '';
    try {
      const [domainRows]: any = await connection.execute(`
        SELECT id, domain
        FROM domains
        WHERE kind='PUBLIC' AND status='ACTIVE' AND mx_status='ACTIVE'
        ORDER BY id
        LIMIT 100
      `);
      if (!Array.isArray(domainRows) || !domainRows.length) {
        throw Object.assign(new Error('当前没有可用收信域名。'), { status:503 });
      }

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const domainRow = domainRows[randomInt(0, domainRows.length)];
        const candidateLocalPart = createAddressMailboxLocalPart();
        const candidateAddress = `${candidateLocalPart}@${String(domainRow.domain).toLowerCase()}`;
        const [existingRows]: any = await connection.execute(
          'SELECT 1 FROM mailboxes WHERE address=? LIMIT 1',
          [candidateAddress],
        );
        if (Array.isArray(existingRows) && existingRows.length) continue;
        mailboxDomainId = Number(domainRow.id);
        mailboxDomain = String(domainRow.domain).toLowerCase();
        localPart = candidateLocalPart;
        profile = createUsAddressProfile({ stateCode, domain:mailboxDomain, localPart, taxFreeOnly });
        break;
      }
    } finally {
      connection.release();
    }

    if (!profile || !mailboxDomainId || !mailboxDomain || !localPart) {
      throw Object.assign(new Error('邮箱地址正在补充，请稍后重试。'), { status:503 });
    }
    if (member) return json({ok:true,address:{...profile,mailboxDomain,mailboxId:null,requiresActivation:true}});
    const guestSession = await ensureGuestSession({
      cookieValue:cookies.get(guestCookieName)?.value,
      ipAddress:requestIp,
      userAgent:request.headers.get('user-agent') || '',
    });
    if (guestSession.issuedCookie) {
      cookies.set(guestCookieName, guestSession.issuedCookie.cookieValue, {
        httpOnly:true,
        sameSite:'strict',
        secure:url.protocol === 'https:',
        path:'/',
        maxAge:guestSession.issuedCookie.cookieMaxAge,
      });
    }
    return json({
      ok:true,
      address:{
        ...profile,
        mailboxDomainId,
        mailboxDomain,
        mailboxId:null,
        mailboxClaim:issueGuestMailboxClaim({
          localPart,
          domain:mailboxDomain,
          sessionId:guestSession.id,
        }),
      },
    });
  } catch (error) {
    return safeApiError(error);
  }
};
