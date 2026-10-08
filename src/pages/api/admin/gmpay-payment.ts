import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {adminConfig,saveConfig} from '../../../../server/payment/gmpay-config.mjs';
export const GET:APIRoute=async context=>{try{const {user}=await requireApiUser(context,{admin:true,jsonBody:false});return json({ok:true,config:await adminConfig(user.role==='SUPER_ADMIN')});}catch(e){return apiError(e,'支付配置读取失败。');}};
export const POST:APIRoute=async context=>{try{const {user}=await requireApiUser(context,{admin:true});if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以配置支付。'),{status:403});return json({ok:true,config:await saveConfig(await readJsonBody(context.request,4096),user.id)});}catch(e){return apiError(e,'支付配置保存失败。');}};
