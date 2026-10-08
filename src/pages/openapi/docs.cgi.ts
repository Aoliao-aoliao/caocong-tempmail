import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getSessionUser, sessionCookieName } from '../../../server/auth/service.mjs';
import { openDatabase } from '../../../server/db/database.mjs';
import { ensureUserApiKey } from '../../../server/member/api-key.mjs';
import { site } from '../../config/site';

export const prerender = false;

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function maskEmail(value: unknown) {
  const email = String(value ?? '');
  const at = email.indexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}****${email.slice(at)}`;
}

async function hasActiveMembership(userId: number) {
  const connection = await openDatabase();
  try {
    const [[membership]] = await connection.execute(`
      SELECT 1
      FROM memberships
      WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > UTC_TIMESTAMP(3)
      LIMIT 1
    `, [userId]);
    return Boolean(membership);
  } finally {
    connection.release();
  }
}

export const GET: APIRoute = async ({ cookies }) => {
  const user = await getSessionUser(cookies.get(sessionCookieName)?.value);
  if (!user) {
    return new Response(null, {
      status: 302,
      headers: {
        ...privateHeaders,
        Location: '/user/login.cgi?next=%2Fopenapi%2Fdocs.cgi',
      },
    });
  }

  const [apiKey, activeMembership] = await Promise.all([
    ensureUserApiKey(user.id),
    hasActiveMembership(user.id),
  ]);
  const source = resolve(process.cwd(), 'openapi-docs/index.html');
  const accountEmail = String(user.email || '');
  const apiKeyDisabled = apiKey?.status === 'DISABLED';
  const visibleApiKey = apiKeyDisabled
    ? 'API Key 已被管理员停用'
    : apiKey?.key || 'API Key 暂不可显示，请在个人空间重置';
  const replacements = new Map([
    ['__NODEMAIL_PUBLIC_ORIGIN__', escapeHtml(site.publicOrigin)],
    ['__NODEMAIL_ACCOUNT_INITIAL__', escapeHtml(accountEmail.trim().charAt(0).toUpperCase() || 'U')],
    ['__NODEMAIL_ACCOUNT_MASKED_EMAIL__', escapeHtml(maskEmail(accountEmail))],
    ['__NODEMAIL_ACCOUNT_EMAIL__', escapeHtml(accountEmail)],
    ['__NODEMAIL_API_KEY__', escapeHtml(visibleApiKey)],
    ['__NODEMAIL_API_KEY_COPY_DISABLED__', apiKeyDisabled || !apiKey?.key ? 'disabled aria-disabled="true"' : ''],
    ['__NODEMAIL_MEMBERSHIP_CLASS__', activeMembership ? '' : 'regular'],
    ['__NODEMAIL_MEMBERSHIP_LABEL__', activeMembership ? 'VIP 会员' : '开通会员'],
  ]);
  let html = await readFile(source, 'utf8');
  for (const [placeholder, value] of replacements) html = html.replaceAll(placeholder, value);

  return new Response(html, {
    headers: {
      ...privateHeaders,
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
};
