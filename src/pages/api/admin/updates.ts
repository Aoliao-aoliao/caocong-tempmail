import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../server/http/api.mjs';
import { checkForUpdates } from '../../../../server/updates/checker.mjs';

const handle = (force: boolean): APIRoute => async context => {
  try {
    await requireApiUser(context, { admin: true, jsonBody: force });
    return json({ ok: true, update: await checkForUpdates({ force }) });
  } catch (error) {
    return apiError(error, '版本检查失败，请稍后重试。');
  }
};
export const GET = handle(false);
export const POST = handle(true);
