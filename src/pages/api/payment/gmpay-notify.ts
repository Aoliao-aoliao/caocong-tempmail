import type {APIRoute} from 'astro';
import {readJsonBody} from '../../../../server/http/api.mjs';
import {settleNotification} from '../../../../server/payment/gmpay-service.mjs';
export const POST:APIRoute=async ({request})=>{
 try{await settleNotification(await readJsonBody(request,8192));return new Response('ok',{status:200,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
 catch{return new Response('fail',{status:400,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
};
