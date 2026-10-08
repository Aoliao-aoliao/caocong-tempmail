import { rememberMemberInbox } from '../../../../../server/member/inbox-selection.mjs';
import { readBoundedText } from '../../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../../server/http/api.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { createMailbox, getMailboxByRequestId, isMailboxCaptchaRequired } from '../../../../../server/member/mutations.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { requireTurnstileToken } from '../../../../../server/security/turnstile.mjs';

export const POST:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context);
    const contentLength=Number(context.request.headers.get('content-length')||0);
    if(contentLength>4096)throw Object.assign(new Error('请求内容过大。'),{status:413});
    const rawBody=await readBoundedText(context.request, 4096);
    if(Buffer.byteLength(rawBody,'utf8')>4096)throw Object.assign(new Error('请求内容过大。'),{status:413});
    const body=(()=>{try{return JSON.parse(rawBody)}catch{return null}})();
    if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('请求格式不正确。'),{status:400});
    if(typeof body.requestId!=='string'||body.requestId.length>64)throw Object.assign(new Error('请求标识无效。'),{status:400});
    const existing=await getMailboxByRequestId({userId:user.id,requestId:body.requestId});
    if(existing){rememberMemberInbox(context,user.id,'ordinary',existing.id);return json({ok:true,result:existing});}
    const requestIp=guestRequestIp(context.request,context.clientAddress);
    const rate=await consumeAuthRateLimit({
      action:'MEMBER_MAILBOX_CREATE',
      identifier:`${user.id}:${requestIp}`,
      limit:6,
      windowSeconds:60,
    });
    if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`),{status:429});
    if(!Number.isSafeInteger(body.expectedPrice)||body.expectedPrice<0)throw Object.assign(new Error('预期价格无效，请刷新页面后重试。'),{status:400});
    const captchaRequired=await isMailboxCaptchaRequired();
    let captchaVerified=false;
    if(captchaRequired){
      await requireTurnstileToken({
        token:body.turnstileToken,
        remoteIp:requestIp,
        expectedAction:'member_mailbox',
      });
      captchaVerified=true;
    }
    const result=await createMailbox({
      userId:user.id,
      localPart:body.localPart,
      domain:body.domain,
      durationMinutes:body.durationMinutes,
      requestId:body.requestId,
      expectedPrice:body.expectedPrice,
      captchaVerified,
    });
    rememberMemberInbox(context,user.id,'ordinary',result.id);
    return json({ok:true,result});
  }catch(error){
    return apiError(error,'邮箱创建失败。');
  }
};
