import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {openDatabase} from '../../../../server/db/database.mjs';
import {readConfig,publicConfig,saveConfig} from '../../../../server/payment/nodeloc-config.mjs';
async function authorized(context:any,body=false){const {user}=await requireApiUser(context,{admin:true,jsonBody:body});if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以配置支付。'),{status:403});return user;}
export const GET:APIRoute=async context=>{try{await authorized(context);const c=await openDatabase();try{return json({ok:true,config:publicConfig(await readConfig(c))});}finally{c.release();}}catch(e){return apiError(e,'支付配置读取失败。')}};
export const POST:APIRoute=async context=>{try{const user=await authorized(context,true);return json({ok:true,config:await saveConfig(await readJsonBody(context.request,24576),user.id)});}catch(e){return apiError(e,'支付配置保存失败。')}};
