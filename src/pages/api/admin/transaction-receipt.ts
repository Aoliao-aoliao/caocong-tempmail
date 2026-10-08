import type {APIRoute} from 'astro';
import {requireApiUser,json,apiError} from '../../../../server/http/api.mjs';
import {transactionReceipt} from '../../../../server/admin/transaction-receipt.mjs';
export const GET:APIRoute=async context=>{try{await requireApiUser(context,{admin:true,jsonBody:false});return json({ok:true,receipt:await transactionReceipt(context.url.searchParams.get('id'))});}catch(e){return apiError(e);}};
