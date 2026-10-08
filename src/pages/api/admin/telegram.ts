import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../server/auth/request-security.mjs';
import {getTelegramConfig,saveTelegramConfig,testTelegramConfig} from '../../../../server/telegram/service.mjs';
export const GET:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context,{admin:true,jsonBody:false});
    if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以管理 Telegram 配置。'),{status:403});
    return json({ok:true,config:await getTelegramConfig()});
  }catch(error){return apiError(error,'读取 Telegram 配置失败。');}
};
export const POST:APIRoute=async context=>{
  try {
    const {user}=await requireApiUser(context,{admin:true});
    if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以管理 Telegram 配置。'),{status:403});
    const rate=await consumeAuthRateLimit({action:'TELEGRAM_ADMIN',identifier:String(user.id),limit:12,windowSeconds:300});
    if(!rate.allowed)throw Object.assign(new Error('操作过于频繁，请稍后重试。'),{status:429});
    const body=await readJsonBody(context.request,4096);
    if(!['save','test'].includes(body.action))throw Object.assign(new Error('未知管理操作。'),{status:400});
    const config=body.action==='test'?await testTelegramConfig():await saveTelegramConfig(body,{actorUserId:user.id});
    return json({ok:true,config});
  }catch(error){return apiError(error,'Telegram 配置操作失败，请稍后重试。');}
};
