import {createHash} from 'node:crypto';
import {readBoundedText} from '../http/request-body.mjs';

export const NODELOC_CONFIG_KEY='nodeloc_oauth_config';
export const NODELOC_CALLBACK_PATH='/api/auth/nodeloc/callback';
export const NODELOC_COOKIE='nodemail_nodeloc_oauth';
export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export const oauthError=(message,status=400)=>Object.assign(new Error(message),{status});
export function validateConfig(input){
  if(typeof input.enabled!=='boolean')throw oauthError('请选择是否启用 NodeLoc 登录。');
  const clientId=String(input.clientId||'').trim();
  if(clientId.length>256||/[\s\x00-\x1f]/.test(clientId))throw oauthError('请输入有效的 Client ID。');
  let origin;
  try{const u=new URL(input.origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();origin=u.origin;}catch{throw oauthError('请输入公网 HTTPS 网站根地址。');}
  if(input.enabled&&!clientId)throw oauthError('请填写 NodeLoc Client ID。');
  return {enabled:input.enabled,clientId,origin};
}
export function authorizationUrl(config,state){
  const u=new URL('https://www.nodeloc.com/oauth-provider/authorize');
  u.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.origin+NODELOC_CALLBACK_PATH,response_type:'code',scope:'openid profile email',state}).toString();
  return u.href;
}
export function checkedIdentity(value){
  if(!value||!Number.isSafeInteger(value.id)||value.id<=0)throw oauthError('NodeLoc 返回的身份无效，请重新授权。',503);
  const email=typeof value.email==='string'?value.email.trim().toLowerCase():'';
  if(email.length>254||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email))throw oauthError('NodeLoc 未返回有效邮箱，请确认应用的 email 权限已通过审核。',503);
  const username=typeof value.username==='string'?value.username.slice(0,128):'';
  const trustLevel=Number.isInteger(value.trust_level)&&value.trust_level>=0&&value.trust_level<=4?value.trust_level:null;
  return {subject:String(value.id),email,username,trustLevel};
}
// Fixed official endpoints, no redirects, bounded bodies and generic errors.
export async function exchangeIdentity(config,code,{fetcher=fetch}={}){
  const request=async(url,options)=>{
    try{
      const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
      const value=JSON.parse(await readBoundedText(r,32768));
      if(!r.ok||!value||typeof value!=='object'||Array.isArray(value))throw Error();
      return value;
    }catch{throw oauthError('NodeLoc 授权服务暂时不可用，请稍后重试。',503);}
  };
  const token=await request('https://www.nodeloc.com/oauth-provider/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:config.origin+NODELOC_CALLBACK_PATH,client_id:config.clientId,client_secret:config.clientSecret}).toString()});
  if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||/[\s\x00-\x1f]/.test(token.access_token)||String(token.token_type).toLowerCase()!=='bearer')throw oauthError('NodeLoc 返回的令牌无效，请重新授权。',503);
  return checkedIdentity(await request('https://www.nodeloc.com/oauth-provider/userinfo',{method:'GET',headers:{authorization:'Bearer '+token.access_token,accept:'application/json'}}));
}
