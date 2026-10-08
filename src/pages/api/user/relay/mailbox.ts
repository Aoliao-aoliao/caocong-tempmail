import { rememberMemberInbox } from '../../../../../server/member/inbox-selection.mjs';
import type { APIRoute } from 'astro';
import { apiError,json,readJsonBody,requireApiUser } from '../../../../../server/http/api.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { createMemberRelayMailbox,getRelayMailboxByRequestId,getRelayPublicData } from '../../../../../server/relay/service.mjs';
import { isMailboxCaptchaRequired } from '../../../../../server/member/mutations.mjs';
import { requireTurnstileToken } from '../../../../../server/security/turnstile.mjs';

export const GET:APIRoute=async context=>{try{await requireApiUser(context,{jsonBody:false});return json({ok:true,suffixes:await getRelayPublicData()});}catch(error){return apiError(error,'中继邮箱读取失败。');}};
export const POST:APIRoute=async context=>{try{const {user}=await requireApiUser(context);const body=await readJsonBody(context.request,4096);const existing=await getRelayMailboxByRequestId({userId:user.id,requestId:body.requestId,suffix:body.suffix,durationMinutes:body.durationMinutes,expectedPrice:body.expectedPrice});if(existing){rememberMemberInbox(context,user.id,'relay',existing.id);return json({ok:true,result:existing});}const ip=guestRequestIp(context.request,context.clientAddress);const rate=await consumeAuthRateLimit({action:'MEMBER_RELAY_CREATE',identifier:`${user.id}:${ip}`,limit:4,windowSeconds:60});if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`),{status:429});if(await isMailboxCaptchaRequired())await requireTurnstileToken({token:body.turnstileToken,remoteIp:ip,expectedAction:'member_relay_mailbox'});const result=await createMemberRelayMailbox({userId:user.id,suffix:body.suffix,durationMinutes:Number(body.durationMinutes),requestId:body.requestId,expectedPrice:Number(body.expectedPrice)});rememberMemberInbox(context,user.id,'relay',result.id);return json({ok:true,result});}catch(error){return apiError(error,'中继邮箱创建失败。');}};
