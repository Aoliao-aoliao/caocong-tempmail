import type { APIRoute } from 'astro';
import { consumeRefreshCooldown } from '../../../../../server/auth/request-security.mjs';
import { consumeGuestReadLimit } from '../../../../../server/guest/read-limit.mjs';
import { apiError, json } from '../../../../../server/http/api.mjs';
import { guestCookieName, listGuestMessages } from '../../../../../server/guest/service.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  try {
    const cookieValue = cookies.get(guestCookieName)?.value;
    const requestIp = guestRequestIp(request, clientAddress);
    const rate = await consumeGuestReadLimit({ kind:'list', ipAddress:requestIp, cookieValue });
    if (!rate.allowed) return new Response(JSON.stringify({ ok:false, message:'刷新过于频繁，请稍后再试。' }), {
      status:429,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'retry-after':String(rate.retryAfter) },
    });
    if (url.searchParams.get('manual') === '1' && rate.sessionIdentifier) {
      const manualRate = await consumeRefreshCooldown({
        action:'GUEST_INBOX_MANUAL_REFRESH',
        identifier:rate.sessionIdentifier,
        windowSeconds:10,
      });
      if (!manualRate.allowed) return new Response(JSON.stringify({ ok:false, message:'请等待 10 秒后再刷新。' }), {
        status:429,
        headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'retry-after':String(manualRate.retryAfter) },
      });
    }
    const result = await listGuestMessages({
      cookieValue,
      userAgent:request.headers.get('user-agent') || '',
      query:url.searchParams.get('q') || '',
      page:url.searchParams.get('page') || '1',
      relayOnly:url.searchParams.get('scope') === 'relay',
    });
    return json({ ok:true, ...result });
  } catch (error) {
    return apiError(error, '收件箱读取失败。');
  }
};
