import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {readMailConfig,publicMailConfig,saveMailConfig} from '../../../../server/auth/password-mail.mjs';
async function authorized(context:any,jsonBody:boolean){
  const {user}=await requireApiUser(context,{admin:true,jsonBody});
  if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以管理发信配置。'),{status:403});
  return user;
}
export const GET:APIRoute=async context=>{
  try{await authorized(context,false);return json({ok:true,config:publicMailConfig(await readMailConfig())});}
  catch(error){return apiError(error,'无法读取发信配置。');}
};
export const POST:APIRoute=async context=>{
  try{const user=await authorized(context,true);return json({ok:true,config:await saveMailConfig(await readJsonBody(context.request,8192),{actorUserId:user.id})});}
  catch(error){return apiError(error,'无法保存发信配置。');}
};
