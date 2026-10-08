import type {APIRoute} from 'astro';
import {consumeAuthRateLimit} from '../../../../../server/auth/request-security.mjs';
import {sessionCookieName} from '../../../../../server/auth/service.mjs';
import {guestRequestIp} from '../../../../../server/guest/http.mjs';
import {nodelocOAuth} from '../../../../../server/auth/nodeloc-oauth.mjs';
import {NODELOC_COOKIE} from '../../../../../server/auth/nodeloc-protocol.mjs';
export const GET:APIRoute=async context=>{
  const sessionToken=context.cookies.get(sessionCookieName)?.value||'';
  const redirect=(location:string)=>new Response(null,{status:303,headers:{location,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  try{
    const rate=await consumeAuthRateLimit({action:'NODELOC_OAUTH_CALLBACK',identifier:guestRequestIp(context.request,context.clientAddress),limit:20,windowSeconds:900});if(!rate.allowed)throw new Error('limited');
    const p=context.url.searchParams;
    for(const key of ['state','code','error'])if(p.getAll(key).length>1)throw new Error('duplicate');
    const result=await nodelocOAuth.complete({state:p.get('state'),nonce:context.cookies.get(NODELOC_COOKIE)?.value,code:p.get('code'),error:p.get('error'),origin:context.url.origin,sessionToken,ipAddress:guestRequestIp(context.request,context.clientAddress),userAgent:context.request.headers.get('user-agent')});
    if(result.token)context.cookies.set(sessionCookieName,result.token,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:result.maxAge});
    return redirect('/user/center.cgi'+(result.mode==='refresh'?'?nodeloc=refreshed':result.mode==='bind'?'?nodeloc=bound':''));
  }catch(e){const status=Number((e as {status?:number})?.status);return redirect((sessionToken?'/user/center.cgi':'/user/login.cgi')+'?nodeloc='+(status===409?'conflict':status===503?'unavailable':'failed'));}
  finally{context.cookies.delete(NODELOC_COOKIE,{path:'/api/auth/nodeloc'});}
};
