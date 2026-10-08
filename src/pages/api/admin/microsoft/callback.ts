import type {APIRoute} from 'astro';
import {getSessionUser,sessionCookieName} from '../../../../../server/auth/service.mjs';
import {microsoftOAuth} from '../../../../../server/relay/microsoft-oauth.mjs';
export const GET:APIRoute=async context=>{
  // Microsoft returns a cross-site top-level GET. Same-origin POST validation
  // belongs at initiation; the callback uses state + exact administrator session.
  const session=context.cookies.get(sessionCookieName)?.value;
  const actor=await getSessionUser(session);
  if(!actor||!['ADMIN','SUPER_ADMIN'].includes(actor.role))return new Response('请使用发起授权的管理员账号登录后重新授权。',{status:403,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8','referrer-policy':'no-referrer'}});
  let result='success';
  try{
    if(context.url.searchParams.getAll('state').length!==1||context.url.searchParams.getAll('code').length>1)throw new Error();
    await microsoftOAuth.complete({state:context.url.searchParams.get('state'),code:context.url.searchParams.get('code'),denied:context.url.searchParams.has('error'),actor,session,origin:context.url.origin});
  }catch(error:any){result=error?.code==='MICROSOFT_ACCOUNT_MISMATCH'?'account-mismatch':error?.code==='MICROSOFT_ACCESS_DENIED'?'cancelled':'failed';}
  // Only fixed outcomes, never a code/token/upstream error in redirects or logs.
  return new Response(null,{status:303,headers:{location:'/admin/relays.cgi?microsoft='+result,'cache-control':'no-store','referrer-policy':'no-referrer'}});
};
