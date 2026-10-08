import type { APIRoute } from 'astro';
import { consumeAuthRateLimit, consumeRefreshCooldown } from '../../../../../server/auth/request-security.mjs';
import { apiError, json, requireApiUser } from '../../../../../server/http/api.mjs';
import { getMailboxInbox } from '../../../../../server/member/read-model.mjs';

export const prerender = false;

export const GET:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context,{jsonBody:false});
    if(context.url.searchParams.get('manual')==='1'){
      const manualRate=await consumeRefreshCooldown({
        action:'MEMBER_INBOX_MANUAL_REFRESH',
        identifier:user.public_id,
        windowSeconds:10,
      });
      if(!manualRate.allowed){
        return new Response(JSON.stringify({ok:false,message:'请等待 10 秒后再刷新。'}),{
          status:429,
          headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','retry-after':String(manualRate.retryAfter)},
        });
      }
    }
    const rate=await consumeAuthRateLimit({
      action:'MEMBER_INBOX_LIST',
      identifier:user.public_id,
      limit:180,
      windowSeconds:60,
    });
    if(!rate.allowed){
      return new Response(JSON.stringify({ok:false,message:'刷新过于频繁，请稍后再试。'}),{
        status:429,
        headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','retry-after':String(rate.retryAfter)},
      });
    }
    const result=await getMailboxInbox({
      userId:user.id,
      mailboxId:context.url.searchParams.get('mailboxId')||'',
      query:context.url.searchParams.get('q')||'',
      page:Number(context.url.searchParams.get('page')||1),
    });
    return json({ok:true,...result});
  }catch(error){
    return apiError(error,'收件箱读取失败。');
  }
};
