import type { APIRoute } from 'astro';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { updateMembershipPlan } from '../../../../../server/admin/mutations.mjs';
import { apiError, json, readJsonBody, requireApiUser } from '../../../../../server/http/api.mjs';

export const prerender = false;
export const POST:APIRoute = async (context) => {
  try {
    const { user:actor, ipAddress } = await requireApiUser(context, { admin:true });
    const rate = await consumeAuthRateLimit({ action:'ADMIN_MEMBERSHIP_PLAN', identifier:`${actor.id}:${ipAddress}`, limit:30, windowSeconds:300 });
    if (!rate.allowed) throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`), { status:429 });
    const body:any = await readJsonBody(context.request, 8192);
    const result = await updateMembershipPlan({code:body.code,values:body,actorUserId:actor.id,ipAddress});
    return json({ok:true,message:'会员套餐已保存。',result});
  } catch (error) {
    return apiError(error,'套餐保存失败。');
  }
};
