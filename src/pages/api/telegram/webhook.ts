import type {APIRoute} from 'astro';
import {readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {receiveTelegramBinding} from '../../../../server/telegram/service.mjs';
export const POST:APIRoute=async context=>{
  try {
    const secret=context.request.headers.get('x-telegram-bot-api-secret-token');
    if(!secret||!/^[a-f0-9]{64}$/.test(secret))return json({ok:false},403);
    return json(await receiveTelegramBinding(secret,await readJsonBody(context.request,32768)));
  }catch(error){return apiError(error,'机器人回调处理失败。');}
};
