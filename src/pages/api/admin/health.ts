import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../server/http/api.mjs';
import { probeSmtp } from '../../../../server/admin/service-health.mjs';

export const GET: APIRoute = async context => {
  try {
    // Authentication reads the current session from MySQL; success verifies both web and database.
    await requireApiUser(context, { admin: true, jsonBody: false });
    return json({ ok: true, smtp: await probeSmtp(), checkedAt: new Date().toISOString() });
  } catch (error) {
    return apiError(error, '服务状态检测失败，请稍后重试。');
  }
};
