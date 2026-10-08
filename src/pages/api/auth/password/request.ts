import type {APIRoute} from 'astro';
import {readJsonBody,json,apiError} from '../../../../../server/http/api.mjs';
import {consumeAuthRateLimit,isSameOriginRequest} from '../../../../../server/auth/request-security.mjs';
import {guestRequestIp} from '../../../../../server/guest/http.mjs';
import {requireTurnstileToken} from '../../../../../server/security/turnstile.mjs';
import {requestPasswordReset,resetEmail} from '../../../../../server/auth/password-reset.mjs';
export const POST:APIRoute=async context=>{
  try{
    if(!isSameOriginRequest(context.request,context.url.origin))return json({ok:false,message:'请求来源无效。'},403);
    const body=await readJsonBody(context.request,4096);
    const email=resetEmail(body.email),ip=guestRequestIp(context.request,context.clientAddress);
    const ipRate=await consumeAuthRateLimit({action:'RESET_SEND_IP',identifier:ip,limit:10,windowSeconds:3600});
    if(!ipRate.allowed)return json({ok:false,message:'操作频繁，请稍后再试。'},429);
    await requireTurnstileToken({token:body.turnstileToken,remoteIp:ip,expectedAction:'password_reset'});
    // Only verified requests can consume an account or global send allowance.
    for(const rule of [
      {action:'RESET_SEND_COOLDOWN',identifier:email,limit:1,windowSeconds:60},
      {action:'RESET_SEND_ACCOUNT',identifier:email,limit:3,windowSeconds:3600},
      {action:'RESET_SEND_GLOBAL',identifier:'password-reset',limit:100,windowSeconds:3600},
    ]){
      const rate=await consumeAuthRateLimit(rule);
      if(!rate.allowed)return new Response(JSON.stringify({ok:false,message:'操作频繁，请稍后再试。'}),{status:429,headers:{'content-type':'application/json','cache-control':'no-store','retry-after':String(rate.retryAfter)}});
    }
    return json({ok:true,...await requestPasswordReset({email})});
  }catch(error){return apiError(error,'密码找回暂时不可用，请稍后再试。');}
};
