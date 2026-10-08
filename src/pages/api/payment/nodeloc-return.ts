import type {APIRoute} from 'astro';
import {queryParameters} from '../../../../server/payment/nodeloc-protocol.mjs';
import {settlePayment} from '../../../../server/payment/nodeloc-service.mjs';
export const GET:APIRoute=async ({url})=>{
 // Both paths lead to the member page. Only signed server-side verification credits points.
 try{await settlePayment(queryParameters(url),{notification:true});}catch{}
 return new Response(null,{status:303,headers:{location:'/user/recharge.cgi','cache-control':'no-store','referrer-policy':'no-referrer'}});
};
