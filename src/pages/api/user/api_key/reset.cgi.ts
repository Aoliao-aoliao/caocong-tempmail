import type { APIRoute } from 'astro';
import { requireApiUser, json } from '../../../../../server/http/api.mjs';
import { rotateApiKey } from '../../../../../server/member/mutations.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';

export const POST: APIRoute = async (context) => {
  try {
    const { user } = await requireApiUser(context);
    const ipAddress = guestRequestIp(context.request, context.clientAddress);
    const [userLimit, ipLimit] = await Promise.all([
      consumeAuthRateLimit({ action:'API_KEY_RESET_USER', identifier:user.public_id, limit:10, windowSeconds:3600 }),
      consumeAuthRateLimit({ action:'API_KEY_RESET_IP', identifier:ipAddress, limit:30, windowSeconds:3600 }),
    ]);
    if (!userLimit.allowed || !ipLimit.allowed) {
      throw Object.assign(new Error('操作频繁，请稍后再试。'), { status:429 });
    }
    const result = await rotateApiKey({ userId:user.id, ipAddress });
    return json({ code:0, msg:'操作成功', data:result.key });
  } catch (error) {
    const explicitStatus = Number((error as { status?:number })?.status);
    const status = [400,401,403,404,409,413,415,429].includes(explicitStatus)
      ? explicitStatus
      : 500;
    const message = status === 500
      ? 'API Key 重置失败，请稍后再试。'
      : error instanceof Error
        ? error.message
        : 'API Key 重置失败。';
    return json({ code:status === 429 ? -1006 : status === 401 ? -1200 : status === 403 ? -1201 : -1000, msg:message, data:null }, status);
  }
};
