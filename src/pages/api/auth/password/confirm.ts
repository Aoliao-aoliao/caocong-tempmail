import type {APIRoute} from 'astro';
import {readJsonBody,json,apiError} from '../../../../../server/http/api.mjs';
import {consumeAuthRateLimit,isSameOriginRequest} from '../../../../../server/auth/request-security.mjs';
import {guestRequestIp} from '../../../../../server/guest/http.mjs';
import {confirmPasswordReset,resetEmail} from '../../../../../server/auth/password-reset.mjs';
import {sessionCookieName} from '../../../../../server/auth/service.mjs';
export const POST:APIRoute=async context=>{
  try{
    if(!isSameOriginRequest(context.request,context.url.origin))return json({ok:false,message:'请求来源无效。'},403);
    const body=await readJsonBody(context.request,4096);
    const email=resetEmail(body.email),ip=guestRequestIp(context.request,context.clientAddress);
    for(const rule of [
      {action:'RESET_CONFIRM_IP',identifier:ip,limit:30,windowSeconds:900},
      {action:'RESET_CONFIRM_CHALLENGE',identifier:`${email}:${body.requestId}`,limit:10,windowSeconds:900},
    ]){if(!(await consumeAuthRateLimit(rule)).allowed)return json({ok:false,message:'尝试次数过多，请稍后再试。'},429);}
    const result=await confirmPasswordReset({...body,email});
    context.cookies.delete(sessionCookieName,{path:'/'});
    return json({ok:true,...result});
  }catch(error){return apiError(error,'密码重置失败，请稍后再试。');}
};
