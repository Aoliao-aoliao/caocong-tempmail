import { readBoundedText } from '../../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../../server/http/api.mjs';
import { readMessage } from '../../../../../server/member/mutations.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';

export const POST:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context);
    const rate=await consumeAuthRateLimit({
      action:'MEMBER_MESSAGE_READ',
      identifier:user.public_id,
      limit:120,
      windowSeconds:60,
    });
    if(!rate.allowed)throw Object.assign(new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`),{status:429});
    const contentLength=Number(context.request.headers.get('content-length')||0);
    if(contentLength>4096)throw Object.assign(new Error('请求内容过大。'),{status:413});
    const rawBody=await readBoundedText(context.request, 4096);
    if(Buffer.byteLength(rawBody,'utf8')>4096)throw Object.assign(new Error('请求内容过大。'),{status:413});
    const body=(()=>{try{return JSON.parse(rawBody)}catch{return null}})();
    if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('请求格式不正确。'),{status:400});
    const messageId=typeof body.id==='string'?body.id.trim():'';
    if(messageId.length>64||!/^MSG-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)){
      throw Object.assign(new Error('邮件标识无效。'),{status:400});
    }
    return json({ok:true,result:await readMessage({userId:user.id,messageId})});
  } catch(error) {
    return apiError(error,'邮件读取失败。');
  }
};
