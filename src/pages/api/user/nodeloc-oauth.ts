import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../server/auth/request-security.mjs';
import {nodelocOAuth} from '../../../../server/auth/nodeloc-oauth.mjs';
import {sessionCookieName} from '../../../../server/auth/service.mjs';
export const GET:APIRoute=async context=>{
  try{const {user}=await requireApiUser(context,{jsonBody:false});return json({ok:true,...await nodelocOAuth.binding(user.id,context.url.origin)});}catch(e){return apiError(e);}
};
export const POST:APIRoute=async context=>{
  try{const {user}=await requireApiUser(context);const rate=await consumeAuthRateLimit({action:'NODELOC_OAUTH_UNLINK',identifier:String(user.id),limit:5,windowSeconds:900});if(!rate.allowed)throw Object.assign(new Error('尝试次数过多，请稍后重试。'),{status:429});
    const body=await readJsonBody(context.request,2048);if(body.action!=='unlink')throw Object.assign(new Error('未知操作。'),{status:400});
    await nodelocOAuth.unlink(user.id,body.password);context.cookies.delete(sessionCookieName,{path:'/'});return json({ok:true});
  }catch(e){return apiError(e,'解除 NodeLoc 绑定失败。');}
};
