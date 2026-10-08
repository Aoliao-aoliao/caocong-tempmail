import type {APIRoute} from 'astro';
// Browser navigation carries no payment authority. Only the signed callback credits points.
export const GET:APIRoute=async ()=>new Response(null,{status:303,headers:{location:'/user/recharge.cgi','cache-control':'no-store','referrer-policy':'no-referrer'}});
