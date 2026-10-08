import { readBoundedText } from '../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { createSession, registerUser, sessionCookieName } from '../../../../server/auth/service.mjs';
import { consumeAuthRateLimit, isSameOriginRequest } from '../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../server/guest/http.mjs';
import { requireTurnstileToken } from '../../../../server/security/turnstile.mjs';

export const prerender = false;

const reply = (body: object, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  if (!request.headers.get('content-type')?.includes('application/json')) return reply({ ok: false, message: '请求格式不正确。' }, 415);
  if (!isSameOriginRequest(request, url.origin)) return reply({ ok: false, message: '请求来源无效。' }, 403);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 8192) return reply({ ok:false, message:'请求内容过大。' }, 413);
  const requestIp = guestRequestIp(request, clientAddress);
  const ipLimit = await consumeAuthRateLimit({ action: 'REGISTER_IP', identifier: requestIp, limit: 10, windowSeconds: 3600 });
  if (!ipLimit.allowed) return new Response(JSON.stringify({ ok: false, message: '注册请求过多，请稍后再试。' }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(ipLimit.retryAfter) }
  });
  let rawBody: string;
  try { rawBody = await readBoundedText(request, 8192); } catch (error) {
    if ((error as { status?:number })?.status === 413) return reply({ ok:false, message:'请求内容过大。' }, 413);
    throw error;
  }
  if (Buffer.byteLength(rawBody, 'utf8') > 8192) return reply({ ok:false, message:'请求内容过大。' }, 413);
  const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ ok: false, message: '请求格式不正确。' }, 400);
  try {
    await requireTurnstileToken({
      token:body.turnstileToken,
      remoteIp:requestIp,
      expectedAction:'register',
    });
  } catch (error) {
    return reply(
      { ok:false, message:error instanceof Error ? error.message : '人机验证失败。' },
      Number((error as { status?:number } | null)?.status) || 403,
    );
  }
  const result = await registerUser(body);
  if (!result.ok) return reply({ ok: false, message: result.message }, result.status);
  const session = await createSession({
    userId: result.userId,
    ipAddress: requestIp,
    userAgent: request.headers.get('user-agent')
  });
  cookies.set(sessionCookieName, session.token, {
    httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: session.maxAge
  });
  return reply({ ok: true, message: '注册成功。', redirect: '/user/center.cgi' }, 201);
};
