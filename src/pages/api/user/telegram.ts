import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../server/auth/request-security.mjs';
import {getTelegramState,beginTelegramBinding,confirmTelegramBinding,unlinkTelegram} from '../../../../server/telegram/service.mjs';
export const GET:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context,{jsonBody:false});
    const rate=await consumeAuthRateLimit({action:'TELEGRAM_STATUS',identifier:String(user.id),limit:60,windowSeconds:300});
    if(!rate.allowed)throw Object.assign(new Error('操作过于频繁，请稍后重试。'),{status:429});
    return json({ok:true,result:await getTelegramState(user.id)});
  }catch(error){return apiError(error,'读取 Telegram 绑定状态失败。');}
};
export const POST:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context);
    const body=await readJsonBody(context.request,1024);
    const rate=await consumeAuthRateLimit({action:'TELEGRAM_BIND',identifier:String(user.id),limit:15,windowSeconds:300});
    if(!rate.allowed)throw Object.assign(new Error('操作过于频繁，请稍后重试。'),{status:429});
    let result;
    switch(body.action){
      case 'begin':result=await beginTelegramBinding(user.id);break;
      case 'confirm':result=await confirmTelegramBinding(user.id,body.requestId);break;
      case 'unlink':result=await unlinkTelegram(user.id);break;
      default:throw Object.assign(new Error('未知绑定操作。'),{status:400});
    }
    return json({ok:true,result});
  }catch(error){return apiError(error,'Telegram 绑定操作失败。');}
};
