import {createHmac,timingSafeEqual} from 'node:crypto';
import {readBoundedText} from '../http/request-body.mjs';
import {gmpayOrigin,siteOrigin} from '../config/deployment.mjs';
export const ORIGIN=gmpayOrigin();
export const fail=(message='支付服务暂不可用，请查询原订单；请勿重复转账。',status=503)=>Object.assign(new Error(message),{status});
// Go uses FormatFloat(..., 'f', -1, 64), including for small JSON numbers.
export function numericText(value){
 if(typeof value!=='number')return String(value);
 if(!Number.isFinite(value))throw fail('支付数值无效。',400);
 const s=String(value);if(!/[eE]/.test(s))return s;
 const [coefficient,exp]=s.toLowerCase().split('e'),negative=coefficient.startsWith('-');
 const unsigned=negative?coefficient.slice(1):coefficient,[whole,fraction='']=unsigned.split('.'),digits=whole+fraction,position=whole.length+Number(exp);
 return (negative?'-':'')+(position<=0?'0.'+'0'.repeat(-position)+digits:position>=digits.length?digits+'0'.repeat(position-digits.length):digits.slice(0,position)+'.'+digits.slice(position));
}
export function canonical(params){
 if(!params||typeof params!=='object'||Array.isArray(params))throw fail('支付参数无效。',400);
 return Object.keys(params).filter(k=>k!=='signature'&&params[k]!=null&&params[k]!=='').sort().map(k=>{
  const value=params[k];if(!/^\w+$/.test(k)||!['string','number'].includes(typeof value)||/[\r\n\0]/.test(String(value)))throw fail('支付参数无效。',400);
  return `${k}=${numericText(value)}`;
 }).join('&');
}
export const signature=(data,key)=>createHmac('sha256',key).update(canonical(data),'utf8').digest('hex');
export function verified(data,key){try{return typeof data.signature==='string'&&/^[0-9a-f]{64}$/.test(data.signature)&&timingSafeEqual(Buffer.from(data.signature,'hex'),Buffer.from(signature(data,key),'hex'));}catch{return false;}}
export function units(value,scale=6){
 const s=numericText(value);if(!/^\d{1,12}(?:\.\d{1,12})?$/.test(s))throw fail('支付金额无效。',400);
 const [a,b='']=s.split('.');if(b.slice(scale).replace(/0/g,''))throw fail('支付金额精度不匹配。',400);
 return BigInt(a)*10n**BigInt(scale)+BigInt(b.slice(0,scale).padEnd(scale,'0')||'0');
}
export function config(env=process.env,{requireEnabled=false}={}){
 const pid=env.GMPAY_PID||'',secret=env.GMPAY_SECRET_KEY||'';
 if(!ORIGIN||(env.GMPAY_BASE_URL||ORIGIN)!==ORIGIN||!/^\w{1,64}$/.test(pid)||secret.length<16||secret.length>1024||/[\r\n\0]/.test(secret))throw fail('支付商户 PID 或密钥尚未正确配置。',503);
 let site;try{site=new URL(env.GMPAY_SITE_ORIGIN||siteOrigin());if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error();}catch{throw fail('支付回调站点配置无效。',503);}
 const enabled=env.GMPAY_ENABLED==='true';if(requireEnabled&&!enabled)throw fail('支付渠道尚未启用。',409);
 return {pid,secret,site:site.origin,enabled};
}
export function publicConfig(env=process.env){try{const c=config(env);return {enabled:c.enabled,configured:true,origin:ORIGIN,token:'USDT',network:'TRON'};}catch{return {enabled:false,configured:false,origin:ORIGIN,token:'USDT',network:'TRON'};}}
export function paymentUrl(value,trade){try{const u=new URL(value);if(u.origin!==ORIGIN||u.username||u.password||u.search||u.hash||u.pathname!==`/pay/checkout-counter/${trade}`||value.length>512)throw Error();return u.href;}catch{throw fail('支付收银台地址无效。',503);}}
export async function gateway(path,{payload,fetchImpl=fetch}={}){
 try{
  if(path!=='/payments/gmpay/v1/order/create-transaction'&&!/^\/pay\/checkout-counter-resp\/[\w-]{1,128}$/.test(path))throw Error();
  const r=await fetchImpl(ORIGIN+path,{method:payload?'POST':'GET',headers:{'content-type':'application/json',accept:'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});
  const data=JSON.parse(await readBoundedText(r,32768));
  if(!r.ok||data.status_code!==200||!data.data||typeof data.data!=='object')throw Error();return data.data;
 }catch{throw fail();}
}
// EPUSDT v2.0.0 creates orders with Unix seconds, but its checkout response
// uses TimestampMilli(). Accept either unit only within a bounded live window.
export function checkoutExpiration(value,now=Date.now()){
 if(!Number.isSafeInteger(value)||value<=0)throw fail();
 const milliseconds=value<100000000000?value*1000:value;
 if(!Number.isSafeInteger(milliseconds)||milliseconds<=now||milliseconds>now+24*3600000)throw fail();
 return new Date(milliseconds);
}
export function assertCounter(counter,order){
 // v2 omits order_id: the trade_id was bound to our order only after the
 // create response checked its order_id. Reject a conflicting ID if supplied.
 if((counter.order_id!=null&&counter.order_id!==order.id)||counter.trade_id!==order.trade_id||String(counter.currency).toUpperCase()!=='USD'||String(counter.token).toUpperCase()!=='USDT'||counter.network!=='tron'||units(counter.amount,2)!==BigInt(order.amount_usd_cents)||units(counter.actual_amount)!==units(order.actual_amount)||counter.receive_address!==order.receive_address||![1,2,3].includes(counter.status))throw fail('支付订单、金额、币种或网络不匹配。',400);
 if(counter.block_transaction_id!=null&&(!/^[a-fA-F0-9]{64}$/.test(counter.block_transaction_id)||(order.block_transaction_id&&order.block_transaction_id!==counter.block_transaction_id.toLowerCase())))throw fail('支付链上交易不匹配。',400);
}
export function assertNotification(data,order,cfg){
 if(!verified(data,cfg.secret)||data.pid!==cfg.pid||data.pid!==order.merchant_pid||data.order_id!==order.id||data.status!==2||String(data.token).toUpperCase()!=='USDT'||units(data.amount,2)!==BigInt(order.amount_usd_cents)||!/^[\w-]{1,128}$/.test(data.trade_id)||!/^[a-fA-F0-9]{64}$/.test(data.block_transaction_id)||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(data.receive_address)||units(data.actual_amount)<=0n)throw fail('支付通知签名或订单校验失败。',400);
 if((data.network!=null&&data.network!=='tron')||(data.currency!=null&&String(data.currency).toUpperCase()!=='USD'))throw fail('支付币种或网络不匹配。',400);
 if(order.trade_id&&(data.trade_id!==order.trade_id||units(data.actual_amount)!==units(order.actual_amount)||data.receive_address!==order.receive_address))throw fail('支付交易绑定不匹配。',400);
 if(order.block_transaction_id&&order.block_transaction_id!==data.block_transaction_id.toLowerCase())throw fail('支付链上交易不匹配。',400);
}
