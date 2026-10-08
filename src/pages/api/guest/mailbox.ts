import { consumeGuestCreationLimit, guestCreationLimited } from '../../../../server/guest/creation-limit.mjs';
import { consumeGuestReadLimit } from '../../../../server/guest/read-limit.mjs';
import { readBoundedText } from '../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { consumeAuthRateLimit, isSameOriginRequest } from '../../../../server/auth/request-security.mjs';
import { json } from '../../../../server/http/api.mjs';
import {
  createOrRotateGuestMailbox,
  getGuestMailbox,
  guestCookieName,
} from '../../../../server/guest/service.mjs';
import { guestRequestIp } from '../../../../server/guest/http.mjs';
import { verifyGuestMailboxClaim } from '../../../../server/guest/mailbox-claim.mjs';
import { requireTurnstileToken } from '../../../../server/security/turnstile.mjs';

export const prerender = false;

const userAgent = (request: Request) => request.headers.get('user-agent') || '';
function safeApiError(error: unknown, fallback: string) {
  const status = Number((error as { status?:unknown } | null)?.status);
  if (error instanceof Error && Number.isInteger(status) && status >= 400 && status <= 599) {
    return json({ ok:false, message:error.message }, status);
  }
  console.error('[guest-mailbox] request failed', error);
  return json({ ok:false, message:fallback }, 500);
}

const tooMany = (retryAfter: number) => new Response(JSON.stringify({ ok:false, message:'操作过于频繁，请稍后再试。' }), {
  status:429,
  headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'retry-after':String(retryAfter) },
});

export const GET: APIRoute = async ({ request, cookies, clientAddress }) => {
  try {
    const requestIp = guestRequestIp(request, clientAddress);
    const rate = await consumeGuestReadLimit({
      kind:'mailbox', ipAddress:requestIp,
      cookieValue:cookies.get(guestCookieName)?.value,
    });
    if (!rate.allowed) return tooMany(rate.retryAfter);
    const mailbox = await getGuestMailbox({
      cookieValue:cookies.get(guestCookieName)?.value,
      userAgent:userAgent(request),
    });
    return json({ ok:true, mailbox });
  } catch (error) {
    return safeApiError(error, '临时邮箱读取失败。');
  }
};

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  try {
    const requestIp = guestRequestIp(request, clientAddress);
    if (!isSameOriginRequest(request, url.origin)) return json({ ok:false, message:'请求来源无效。' }, 403);
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return json({ ok:false, message:'请求格式不正确。' }, 415);
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) return json({ ok:false, message:'请求内容过大。' }, 413);
    const ipRate = await consumeGuestCreationLimit({ kind:'normal', ipAddress:requestIp });
    if (!ipRate.allowed) return guestCreationLimited(ipRate.retryAfter);
    const sessionRate = await consumeAuthRateLimit({
      action:'GUEST_MAILBOX_CREATE_SESSION',
      identifier:cookies.get(guestCookieName)?.value || requestIp,
      limit:4,
      windowSeconds:60,
    });
    if (!sessionRate.allowed) return tooMany(sessionRate.retryAfter);
    const rawBody = await readBoundedText(request, 4096);
    if (Buffer.byteLength(rawBody, 'utf8') > 4096) return json({ ok:false, message:'请求内容过大。' }, 413);
    const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok:false, message:'请求格式不正确。' }, 400);
    const claimedMailbox = body.mailboxClaim
      ? verifyGuestMailboxClaim(body.mailboxClaim)
      : null;
    await requireTurnstileToken({
      token:body.turnstileToken,
      remoteIp:requestIp,
      expectedAction:'guest_mailbox',
    });
    const result = await createOrRotateGuestMailbox({
      cookieValue:cookies.get(guestCookieName)?.value,
      domain:claimedMailbox?.domain || body.domain,
      localPart:claimedMailbox?.localPart,
      claimId:claimedMailbox?.claimId,
      requiredSessionId:claimedMailbox?.sessionId,
      ipAddress:requestIp,
      userAgent:userAgent(request),
    });
    if (result.issuedCookie) {
      cookies.set(guestCookieName, result.issuedCookie.cookieValue, {
        httpOnly:true,
        sameSite:'strict',
        secure:url.protocol === 'https:',
        path:'/',
        maxAge:result.issuedCookie.cookieMaxAge,
      });
    }
    return json({ ok:true, mailbox:result.mailbox }, 201);
  } catch (error) {
    return safeApiError(error, '临时邮箱创建失败。');
  }
};
