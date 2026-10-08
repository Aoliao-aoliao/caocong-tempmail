import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../../server/http/api.mjs';
import {consumeAuthRateLimit} from '../../../../../server/auth/request-security.mjs';
import {guestRequestIp} from '../../../../../server/guest/http.mjs';
import {paymentView,createOrder,continueOrder,queryOrder} from '../../../../../server/payment/nodeloc-service.mjs';
export const GET:APIRoute=async context=>{try{const {user}=await requireApiUser(context,{jsonBody:false});return json({ok:true,...await paymentView(user.id,Number(context.url.searchParams.get('page')||1))});}catch(e){return apiError(e,'支付订单读取失败。')}};
export const POST:APIRoute=async context=>{try{
 const {user}=await requireApiUser(context);const rate=await consumeAuthRateLimit({action:'NODELOC_PAYMENT',identifier:String(user.id),limit:20,windowSeconds:300});if(!rate.allowed)throw Object.assign(new Error('操作频繁，请稍后再试。'),{status:429});
 const body=await readJsonBody(context.request,4096);let result;
 const options={clientIp:guestRequestIp(context.request,context.clientAddress)};
 if(body.action==='create')result=await createOrder({...body,userId:user.id},options);
 else if(body.action==='continue')result=await continueOrder({id:body.id,userId:user.id},options);
 else if(body.action==='query')result=await queryOrder({id:body.id,userId:user.id});
 else throw Object.assign(new Error('支付操作无效。'),{status:400});
 return json({ok:true,result});
}catch(e){return apiError(e,'支付操作失败，请在原订单查询结果。')}};
