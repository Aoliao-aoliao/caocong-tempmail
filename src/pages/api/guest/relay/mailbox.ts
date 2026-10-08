import { consumeGuestCreationLimit, guestCreationLimited } from '../../../../../server/guest/creation-limit.mjs';
import type { APIRoute } from 'astro';
import { consumeAuthRateLimit,isSameOriginRequest } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { guestCookieName } from '../../../../../server/guest/service.mjs';
import { apiError,json,readJsonBody } from '../../../../../server/http/api.mjs';
import { createGuestRelayMailbox,getRelayPublicData } from '../../../../../server/relay/service.mjs';
import { requireTurnstileToken } from '../../../../../server/security/turnstile.mjs';

export const GET:APIRoute=async context=>{try{const ip=guestRequestIp(context.request,context.clientAddress);const rate=await consumeAuthRateLimit({action:'GUEST_RELAY_LIST',identifier:ip,limit:120,windowSeconds:60});if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`),{status:429});return json({ok:true,suffixes:await getRelayPublicData()});}catch(error){return apiError(error,'中继邮箱读取失败。');}};
export const POST: APIRoute = async context => {
  try {
    if (!isSameOriginRequest(context.request, context.url.origin)) {
      throw Object.assign(new Error('请求来源无效。'), { status:403 });
    }
    const ip = guestRequestIp(context.request, context.clientAddress);
    const ipRate = await consumeGuestCreationLimit({ kind:'relay', ipAddress:ip });
    if (!ipRate.allowed) return guestCreationLimited(ipRate.retryAfter);
    const rate = await consumeAuthRateLimit({
      action:'GUEST_RELAY_CREATE',
      identifier:`${ip}:${context.cookies.get(guestCookieName)?.value || 'new'}`,
      limit:4,
      windowSeconds:60,
    });
    if (!rate.allowed) return guestCreationLimited(rate.retryAfter);
    const body = await readJsonBody(context.request,4096);
    await requireTurnstileToken({ token:body.turnstileToken, remoteIp:ip, expectedAction:'guest_relay_mailbox' });
    const result = await createGuestRelayMailbox({
      cookieValue:context.cookies.get(guestCookieName)?.value,
      ipAddress:ip,
      userAgent:context.request.headers.get('user-agent') || '',
      suffix:body.suffix,
    });
    if (result.issuedCookie) {
      context.cookies.set(guestCookieName, result.issuedCookie.cookieValue, {
        httpOnly:true, sameSite:'strict', secure:context.url.protocol==='https:', path:'/',
        maxAge:result.issuedCookie.cookieMaxAge,
      });
    }
    return json({ ok:true, mailbox:result.mailbox },201);
  } catch (error) { return apiError(error,'中继邮箱创建失败。'); }
};
