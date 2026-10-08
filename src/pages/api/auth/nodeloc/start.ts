import type {APIRoute} from 'astro';
import {readJsonBody,json,apiError} from '../../../../../server/http/api.mjs';
import {isSameOriginRequest,consumeAuthRateLimit} from '../../../../../server/auth/request-security.mjs';
import {getSessionUser,sessionCookieName} from '../../../../../server/auth/service.mjs';
import {guestRequestIp} from '../../../../../server/guest/http.mjs';
import {nodelocOAuth} from '../../../../../server/auth/nodeloc-oauth.mjs';
import {NODELOC_COOKIE} from '../../../../../server/auth/nodeloc-protocol.mjs';
import {requestLocale} from '../../../../lib/locale';
export const POST:APIRoute=async context=>{
  try{
    if(!isSameOriginRequest(context.request,context.url.origin))throw Object.assign(new Error('请求来源无效。'),{status:403});
    const rate=await consumeAuthRateLimit({action:'NODELOC_OAUTH_START',identifier:guestRequestIp(context.request,context.clientAddress),limit:10,windowSeconds:900});if(!rate.allowed)throw Object.assign(new Error('尝试次数过多，请稍后重试。'),{status:429});
    const body=await readJsonBody(context.request,1024),rawToken=context.cookies.get(sessionCookieName)?.value||'',user=await getSessionUser(rawToken);
    if(['bind','refresh'].includes(body.mode)&&!user)throw Object.assign(new Error('请先登录后绑定 NodeLoc。'),{status:401});
    if(!user&&rawToken)context.cookies.delete(sessionCookieName,{path:'/'});
    const result=await nodelocOAuth.begin({origin:context.url.origin,sessionToken:user?rawToken:'',userId:user?.id,mode:body.mode,locale:requestLocale(context)});
    context.cookies.set(NODELOC_COOKIE,result.nonce,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/auth/nodeloc',maxAge:600});
    return json({ok:true,url:result.url});
  }catch(e){return apiError(e,'发起 NodeLoc 授权失败，请稍后重试。');}
};
