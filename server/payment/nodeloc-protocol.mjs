import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {readBoundedText} from '../http/request-body.mjs';
export const fail=(message='支付服务暂不可用，请稍后查询原订单。',status=503)=>Object.assign(new Error(message),{status});
export const ORIGIN='https://www.nodeloc.com';
export function canonical(params) {
  if(!params || Array.isArray(params) || typeof params!=='object')throw fail('支付参数无效。',400);
  return Object.keys(params).filter(k=>!['sign','sign_type'].includes(k)&&params[k]!==''&&params[k]!=null).sort().map(k=>{
    const v=params[k];
    if(!['string','number'].includes(typeof v)||!/^\w+$/.test(k)|| /[\r\n\0]/.test(String(v)))throw fail('支付参数无效。',400);
    return `${k}=${v}`;
  }).join('&');
}
export function rsaKey(pem,privateKey=false) {
  try {const key=privateKey?createPrivateKey(pem):createPublicKey(pem);if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error();return key;}
  catch{throw fail('支付 RSA 密钥格式无效，至少需要 2048 位。',400);}
}
export const signature=(params,key)=>sign('RSA-SHA256',Buffer.from(canonical(params)),rsaKey(key,true)).toString('base64');
export function verified(params,key,{defaultRsa=false}={}) {
  // V2 API replies default to RSA in the official SDK. Never infer a different
  // algorithm, accept missing signatures, or relax the notification contract.
  try{return (params.sign_type==='RSA'||(defaultRsa&&!Object.hasOwn(params,'sign_type'))) && typeof params.sign==='string' && params.sign.length<=2048 && verify('RSA-SHA256',Buffer.from(canonical(params)),rsaKey(key),Buffer.from(params.sign,'base64'));}catch{return false;}
}
export function paymentUrl(value) {
  try{const u=new URL(value);if(u.origin!==ORIGIN||u.username||u.password||!u.pathname.startsWith('/payment/')||value.length>512)throw Error();return u.href;}catch{throw fail();}
}
export function moneyCents(value) {
  if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value)))throw fail('支付金额不匹配。',400);
  const [a,b='']=String(value).split('.');return Number(a)*100+Number(b.padEnd(2,'0'));
}
export function queryParameters(url) {
  if(url.search.length>12000)throw fail('支付通知过大。',400);
  const params=Object.create(null);
  for(const [k,v] of url.searchParams){if(Object.hasOwn(params,k))throw fail('支付通知包含重复参数。',400);params[k]=v;}
  return params;
}
// Only fixed, non-sensitive messages are exposed. Never log the response, request,
// signature or credentials. Unsigned rejection text is diagnostic only: it cannot
// authorize a payment link or change an order/balance.
const rejections=new Map([
  ['商户不存在',['MERCHANT_UNKNOWN','NodeLoc 未识别该商户，请管理员核对商户 ID。']],
  ['签名验证失败',['REQUEST_SIGNATURE','NodeLoc 拒绝了请求签名，请管理员核对商户私钥与 NodeLoc 商户公钥是否配对。']],
  ['时间戳无效或已过期',['REQUEST_TIMESTAMP','NodeLoc 拒绝了请求时间，请管理员检查服务器时间是否准确。']],
  ['订单不存在',['ORDER_UNKNOWN','NodeLoc 尚未找到该订单，请在原订单点击“继续付款”重试。']],
]);
export function safeRejectionReason(value){
  if(typeof value!=='string'||value.length>160)return '';
  // Admit short Chinese explanations only. ASCII credentials, encoded payloads,
  // URLs, signatures and arbitrary response text cannot reach the UI or logs.
  const labels={out_trade_no:'商户订单号',trade_no:'平台交易号',pid:'商户编号',notify_url:'付款通知地址',return_url:'付款返回地址',clientip:'客户端地址',money:'金额',timestamp:'请求时间',sign_type:'签名类型',RSA:'非对称签名',NodeLoc:'支付平台'};
  const text=value.trim().replace(/\b(out_trade_no|trade_no|pid|notify_url|return_url|clientip|money|timestamp|sign_type|RSA|NodeLoc)\b/g,key=>labels[key]);
  return /^[\p{Script=Han}，。！？：；、（）“”‘’\s]{1,160}$/u.test(text)?text:'';
}
function diagnostic(kind,message){
  console.warn(`[NodeLoc] ${kind}`);
  return Object.assign(fail(message),{paymentDiagnostic:true});
}
export async function gatewayRequest(path,params,config,{fetchImpl=fetch}={}) {
  if(!['create','query'].includes(path))throw fail();
  const payload={...params,pid:config.pid,timestamp:String(Math.floor(Date.now()/1000)),sign_type:'RSA'};
  payload.sign=signature(payload,config.privateKey);
  try {
    const response=await fetchImpl(`${ORIGIN}/payment/api/pay/${path}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(payload),redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw diagnostic(`HTTP_${response.status}`,'连接 NodeLoc 支付网关失败，请稍后重试原订单；若持续失败请联系管理员。');
    let data;
    try{data=JSON.parse(await readBoundedText(response,32768));}
    catch{throw diagnostic('RESPONSE_FORMAT','NodeLoc 返回了无法识别的支付响应，请联系管理员；不要重复付款。');}
    if(!data||Array.isArray(data)||typeof data!=='object')throw diagnostic('RESPONSE_FORMAT','NodeLoc 返回了无法识别的支付响应，请联系管理员；不要重复付款。');
    // Official V2 separates business rejections from signed successful replies.
    // NodeLoc additionally returns code=1 when repeating an already paid create.
    // That exception still requires RSA and is reconciled by a separate query.
    if(!/^-?\d+$/.test(String(data.code))||!Number.isSafeInteger(Number(data.code)))throw diagnostic('RESPONSE_FORMAT','NodeLoc 返回了无法识别的支付响应，请联系管理员；不要重复付款。');
    const paidRepeat=path==='create'&&String(data.code)==='1'&&typeof data.trade_no==='string'&&/^[\w-]{1,128}$/.test(data.trade_no)&&!data.pay_info&&!rejections.has(data.msg);
    if(Number(data.code)!==0&&!paidRepeat){
      const rejection=rejections.get(data.msg);
      const reason=safeRejectionReason(data.msg);
      throw rejection?diagnostic(...rejection):diagnostic('GATEWAY_REJECTED',reason?`NodeLoc 拒绝请求（返回码 ${Number(data.code)}）。平台说明：${reason}；本次未确认付款。`:'NodeLoc 拒绝了这次支付请求，请联系管理员检查支付应用状态和请求参数；本次未确认付款。');
    }
    if(!Object.hasOwn(data,'sign'))throw diagnostic('RESPONSE_UNSIGNED','NodeLoc 的成功响应缺少签名，已停止处理，请联系管理员；本次未确认付款。');
    if(!verified(data,config.platformKey,{defaultRsa:true}))throw diagnostic('RESPONSE_SIGNATURE','NodeLoc 响应签名未通过验证，请联系管理员检查返回格式及平台公钥；本次未确认付款。');
    if(data.pid!=null&&String(data.pid)!==config.pid)throw diagnostic('RESPONSE_MERCHANT','NodeLoc 返回的商户与订单不一致，请联系管理员；本次未确认付款。');
    return data;
  }catch(error){
    if(error?.paymentDiagnostic)throw error;
    if(error?.name==='TimeoutError'||error?.name==='AbortError')throw diagnostic('TIMEOUT','连接 NodeLoc 超时，请稍后重试原订单；不要重复付款。');
    throw diagnostic('NETWORK','服务器暂时无法连接 NodeLoc，请稍后重试原订单；若持续失败请联系管理员。');
  }
}
