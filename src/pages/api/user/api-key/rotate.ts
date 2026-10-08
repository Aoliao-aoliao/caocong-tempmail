import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../../server/http/api.mjs';
import { rotateApiKey } from '../../../../../server/member/mutations.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';

export const POST:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context);
    const ipAddress=guestRequestIp(context.request,context.clientAddress);
    const [userLimit,ipLimit]=await Promise.all([
      consumeAuthRateLimit({action:'API_KEY_RESET_USER',identifier:user.public_id,limit:10,windowSeconds:3600}),
      consumeAuthRateLimit({action:'API_KEY_RESET_IP',identifier:ipAddress,limit:30,windowSeconds:3600}),
    ]);
    if(!userLimit.allowed||!ipLimit.allowed)throw Object.assign(new Error('操作频繁，请稍后再试。'),{status:429});
    return json({ok:true,result:await rotateApiKey({userId:user.id,ipAddress})});
  }catch(error){return apiError(error,'密钥生成失败。')}
};
