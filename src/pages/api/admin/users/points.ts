import type { APIRoute } from 'astro';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { adjustUserPoints } from '../../../../../server/admin/mutations.mjs';
import { apiError, json, readJsonBody, requireApiUser } from '../../../../../server/http/api.mjs';

export const prerender = false;
export const POST:APIRoute = async (context) => {
  try {
    const { user:actor, ipAddress } = await requireApiUser(context, { admin:true });
    const rate = await consumeAuthRateLimit({ action:'ADMIN_USER_POINTS', identifier:`${actor.id}:${ipAddress}`, limit:30, windowSeconds:300 });
    if (!rate.allowed) throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`), { status:429 });
    const body:any = await readJsonBody(context.request, 4096);
    const result = await adjustUserPoints({publicId:body.publicId,amount:body.amount,reason:body.reason,actorUserId:actor.id,ipAddress});
    return json({ok:true,message:'用户积分已更新。',result});
  } catch (error) {
    return apiError(error,'积分调整失败。');
  }
};
