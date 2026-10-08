import { readBoundedText } from '../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { authenticateUser, createSession, sessionCookieName } from '../../../../server/auth/service.mjs';
import { consumeAuthRateLimit, isSameOriginRequest } from '../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../server/guest/http.mjs';

export const prerender = false;

const reply = (body: object, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  if (!request.headers.get('content-type')?.includes('application/json')) return reply({ ok: false, message: '请求格式不正确。' }, 415);
  if (!isSameOriginRequest(request, url.origin)) return reply({ ok: false, message: '请求来源无效。' }, 403);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > 8192) return reply({ ok:false, message:'请求内容过大。' }, 413);
  const requestIp = guestRequestIp(request, clientAddress);
  const ipLimit = await consumeAuthRateLimit({ action: 'LOGIN_IP', identifier: requestIp, limit: 30, windowSeconds: 900 });
  if (!ipLimit.allowed) return new Response(JSON.stringify({ ok: false, message: '尝试次数过多，请稍后再试。' }), {
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
  const accountLimit = await consumeAuthRateLimit({ action: 'LOGIN_ACCOUNT', identifier: String(body.email || '').trim().toLowerCase(), limit: 10, windowSeconds: 900 });
  if (!accountLimit.allowed) return new Response(JSON.stringify({ ok: false, message: '尝试次数过多，请稍后再试。' }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(accountLimit.retryAfter) }
  });
  const result = await authenticateUser(body);
  if (!result.ok || !result.user) return reply({ ok: false, message: result.message }, result.status);
  let session;
  try {
    session = await createSession({
    userId: result.user.id,
    expectedPasswordHash: result.user.password_hash,
    ipAddress: requestIp,
    userAgent: request.headers.get('user-agent')
    });
  } catch (error) {
    if ((error as {status?:number})?.status === 401) return reply({ok:false,message:'账户状态已变化，请重新登录。'},401);
    throw error;
  }
  cookies.set(sessionCookieName, session.token, {
    httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: session.maxAge
  });
  return reply({ ok: true, message: '登录成功。', redirect: '/user/center.cgi' });
};
