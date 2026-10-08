import type {APIRoute} from 'astro';
import {queryParameters} from '../../../../server/payment/nodeloc-protocol.mjs';
import {settlePayment} from '../../../../server/payment/nodeloc-service.mjs';
export const GET:APIRoute=async ({url})=>{
 try{const data=queryParameters(url);const result=await settlePayment(data,{notification:true});
  return new Response(result.status==='PAID'?'success':'fail',{status:result.status==='PAID'?200:400,headers:{'cache-control':'no-store','content-type':'text/plain'}});
 }catch{return new Response('fail',{status:400,headers:{'cache-control':'no-store'}});}
};
