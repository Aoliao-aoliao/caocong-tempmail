import { defineMiddleware } from 'astro:middleware';
import { getSessionUser, sessionCookieName } from '../server/auth/service.mjs';

const publicUserPages = new Set([
  '/user/login.cgi',
  '/user/register.cgi',
  '/user/password/recover.cgi'
]);

function applySecurityHeaders(response: Response, pathname: string) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  if (!response.headers.has('Referrer-Policy')) response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (import.meta.env.PROD) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com"
    );
  }
  if (
    pathname.startsWith('/user/')
    || pathname.startsWith('/admin/')
    || pathname.startsWith('/tools/')
    || pathname === '/openapi/docs.cgi'
  ) {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

export const onRequest = defineMiddleware(async ({ url, cookies, redirect }, next) => {
  const sessionUser = await getSessionUser(cookies.get(sessionCookieName)?.value);
  const isLocalAdminPreview = import.meta.env.DEV && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');

  if (url.pathname.startsWith('/user/') && !publicUserPages.has(url.pathname)) {
    if (!sessionUser) {
      const loginUrl = new URL('/user/login.cgi', url);
      loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
      return applySecurityHeaders(redirect(`${loginUrl.pathname}${loginUrl.search}`, 302), url.pathname);
    }
  }

  if (url.pathname === '/openapi/docs.cgi' && !sessionUser) {
    const loginUrl = new URL('/user/login.cgi', url);
    loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
    return applySecurityHeaders(redirect(`${loginUrl.pathname}${loginUrl.search}`, 302), url.pathname);
  }

  if (url.pathname.startsWith('/admin/')) {
    if (isLocalAdminPreview) return applySecurityHeaders(await next(), url.pathname);
    if (!sessionUser) {
      const loginUrl = new URL('/user/login.cgi', url);
      loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
      return applySecurityHeaders(redirect(`${loginUrl.pathname}${loginUrl.search}`, 302), url.pathname);
    }
    if (sessionUser.role !== 'ADMIN' && sessionUser.role !== 'SUPER_ADMIN') {
      return applySecurityHeaders(new Response('无权访问管理员后台。', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      }), url.pathname);
    }
  }

  return applySecurityHeaders(await next(), url.pathname);
});
