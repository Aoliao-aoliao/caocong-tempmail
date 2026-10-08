import type {APIRoute} from 'astro';
import {apiError,json,readJsonBody,requireApiUser} from '../../../../server/http/api.mjs';
import {sessionCookieName} from '../../../../server/auth/service.mjs';
import {consumeAuthRateLimit} from '../../../../server/auth/request-security.mjs';
import {microsoftOAuth} from '../../../../server/relay/microsoft-oauth.mjs';
export const GET:APIRoute=async context=>{try{await requireApiUser(context,{admin:true,jsonBody:false});return json({ok:true,config:await microsoftOAuth.config(context.url.origin)});}catch(e){return apiError(e,'无法读取微软应用配置。');}};
export const POST:APIRoute=async context=>{try{
  const {user,ipAddress}=await requireApiUser(context,{admin:true});
  const rate=await consumeAuthRateLimit({action:'ADMIN_MICROSOFT_OAUTH',identifier:`${user.id}:${ipAddress}`,limit:20,windowSeconds:300});
  if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后重试。`),{status:429});
  const body=await readJsonBody(context.request,8192);
  if(body.action==='save')return json({ok:true,config:await microsoftOAuth.saveConfig(body,{actor:user,origin:context.url.origin})});
  if(body.action==='authorize')return json({ok:true,result:await microsoftOAuth.begin({id:String(body.id||''),actor:user,session:context.cookies.get(sessionCookieName)?.value,origin:context.url.origin})});
  throw Object.assign(new Error('未知微软授权操作。'),{status:400});
}catch(e){return apiError(e,'微软授权操作失败。');}};
