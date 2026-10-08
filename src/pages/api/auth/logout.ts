import type { APIRoute } from 'astro';
import { deleteSession, sessionCookieName } from '../../../../server/auth/service.mjs';
import { isSameOriginRequest } from '../../../../server/auth/request-security.mjs';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, url }) => {
  if (!isSameOriginRequest(request, url.origin)) {
    return new Response(JSON.stringify({ ok: false, message: '请求来源无效。' }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  await deleteSession(cookies.get(sessionCookieName)?.value);
  cookies.delete(sessionCookieName, { path: '/' });
  return new Response(JSON.stringify({ ok: true, redirect: '/user/login.cgi' }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
};
