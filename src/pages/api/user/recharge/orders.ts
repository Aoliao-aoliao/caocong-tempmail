import type { APIRoute } from 'astro';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { requireApiUser, json, apiError, readJsonBody } from '../../../../../server/http/api.mjs';
import { createRechargeOrder } from '../../../../../server/member/mutations.mjs';
export const POST:APIRoute=async context=>{try{const {user}=await requireApiUser(context);const ip=guestRequestIp(context.request,context.clientAddress);const rate=await consumeAuthRateLimit({action:'USER_RECHARGE_ORDER',identifier:`${user.id}:${ip}`,limit:10,windowSeconds:300});if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`),{status:429});const body=await readJsonBody(context.request,4096);return json({ok:true,result:await createRechargeOrder({userId:user.id,planCode:body.planCode,channelCode:body.channelCode})});}catch(error){return apiError(error,'订单创建失败。')}};
