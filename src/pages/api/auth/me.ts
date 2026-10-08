import type { APIRoute } from 'astro';
import { getSessionUser, sessionCookieName } from '../../../../server/auth/service.mjs';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const user = await getSessionUser(cookies.get(sessionCookieName)?.value);
  return new Response(JSON.stringify(user ? {
    ok: true,
    user: { publicId: user.public_id, email: user.email, role: user.role, points: user.points_balance }
  } : { ok: false }), {
    status: user ? 200 : 401,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
};
