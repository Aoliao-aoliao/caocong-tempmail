import type { APIRoute } from 'astro';
import { consumeGuestReadLimit } from '../../../../../server/guest/read-limit.mjs';
import { apiError, json } from '../../../../../server/http/api.mjs';
import { getGuestMessage, guestCookieName } from '../../../../../server/guest/service.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, clientAddress, params }) => {
  try {
    const cookieValue = cookies.get(guestCookieName)?.value;
    const requestIp = guestRequestIp(request, clientAddress);
    const rate = await consumeGuestReadLimit({ kind:'detail', ipAddress:requestIp, cookieValue });
    if (!rate.allowed) return new Response(JSON.stringify({ ok:false, message:'读取过于频繁，请稍后再试。' }), {
      status:429,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'retry-after':String(rate.retryAfter) },
    });
    const message = await getGuestMessage({
      cookieValue,
      userAgent:request.headers.get('user-agent') || '',
      messageId:params.id,
    });
    return json({ ok:true, message });
  } catch (error) {
    return apiError(error, '邮件读取失败。');
  }
};
