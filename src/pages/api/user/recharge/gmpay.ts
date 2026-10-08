import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../../server/auth/request-security.mjs';
import {publicConfig} from '../../../../../server/payment/gmpay-config.mjs';
import {createOrder,continueOrder,queryOrder} from '../../../../../server/payment/gmpay-service.mjs';
export const GET:APIRoute=async context=>{try{await requireApiUser(context,{jsonBody:false});return json({ok:true,...await publicConfig()});}catch(e){return apiError(e,'支付配置读取失败。');}};
export const POST:APIRoute=async context=>{try{
 const {user}=await requireApiUser(context);const body=await readJsonBody(context.request,4096);const rate=await consumeAuthRateLimit({action:body.action==='query'?'GMPAY_QUERY':'GMPAY_PAYMENT',identifier:String(user.id),limit:body.action==='query'?60:20,windowSeconds:300});if(!rate.allowed)throw Object.assign(new Error('操作频繁，请稍后再试。'),{status:429});
 let result;
 if(body.action==='create')result=await createOrder({...body,userId:user.id});
 else if(body.action==='continue')result=await continueOrder({id:body.id,userId:user.id});
 else if(body.action==='query')result=await queryOrder({id:body.id,userId:user.id});
 else throw Object.assign(new Error('支付操作无效。'),{status:400});
 return json({ok:true,result});
}catch(e){return apiError(e,'支付操作失败，请核对原订单。');}};
