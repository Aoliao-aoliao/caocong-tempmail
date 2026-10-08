import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../server/auth/request-security.mjs';
import {nodelocOAuth} from '../../../../server/auth/nodeloc-oauth.mjs';
export const GET:APIRoute=async context=>{
  try{const {user}=await requireApiUser(context,{admin:true,jsonBody:false});if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以配置 NodeLoc 登录。'),{status:403});return json({ok:true,config:await nodelocOAuth.config()});}
  catch(e){return apiError(e,'读取 NodeLoc 登录配置失败。');}
};
export const POST:APIRoute=async context=>{
  try{const {user}=await requireApiUser(context,{admin:true});if(user.role!=='SUPER_ADMIN')throw Object.assign(new Error('只有超级管理员可以配置 NodeLoc 登录。'),{status:403});
    const rate=await consumeAuthRateLimit({action:'NODELOC_OAUTH_ADMIN',identifier:String(user.id),limit:12,windowSeconds:300});if(!rate.allowed)throw Object.assign(new Error('操作过于频繁，请稍后重试。'),{status:429});
    return json({ok:true,config:await nodelocOAuth.save(await readJsonBody(context.request,8192),{actorUserId:user.id})});
  }catch(e){return apiError(e,'保存 NodeLoc 登录配置失败。');}
};
