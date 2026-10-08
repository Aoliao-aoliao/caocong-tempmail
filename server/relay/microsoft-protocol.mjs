import { createHash, createPublicKey, verify } from 'node:crypto';
import { readBoundedText } from '../http/request-body.mjs';

export const MICROSOFT_CALLBACK_PATH='/api/admin/microsoft/callback';
export const MICROSOFT_TENANT='9188040d-6c67-4c5b-b112-36a304b66dad';
export const MICROSOFT_AUTHORITY='https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const MICROSOFT_SCOPES='openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All';
export const oauthError=(message,code='MICROSOFT_OAUTH_INVALID')=>Object.assign(new Error(message),{status:409,code});
export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export function validateMicrosoftConfig(input,origin) {
  const clientId=String(input.clientId||'').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))throw oauthError('请输入微软应用 Client ID。');
  let url;try{url=new URL(input.redirectUri);}catch{throw oauthError('请输入有效的微软回调地址。');}
  if(url.origin!==new URL(origin).origin||url.pathname!==MICROSOFT_CALLBACK_PATH||url.search||url.hash||url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw oauthError('微软回调地址必须是当前站点的 '+MICROSOFT_CALLBACK_PATH+'，生产环境使用 HTTPS。');
  return {clientId:clientId.toLowerCase(),redirectUri:url.href};
}
export function authorizationUrl(config,{state,nonce,verifier,email}) {
  const url=new URL(MICROSOFT_AUTHORITY+'/authorize');
  url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',response_mode:'query',scope:MICROSOFT_SCOPES,state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account',login_hint:email}).toString();
  return url.href;
}
export async function microsoftJson(url,options={},fetcher=fetch,maximumBytes=65536) {
  let response,data;
  try{response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});data=JSON.parse(await readBoundedText(response,maximumBytes));}
  catch{throw oauthError('微软授权服务暂时不可用，请稍后重试。','MICROSOFT_OAUTH_UNAVAILABLE');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw oauthError('微软授权服务返回格式无效。');
  if(!response.ok||data.error){
    const revoked=['invalid_grant','interaction_required','consent_required'].includes(data.error);
    throw oauthError(revoked?'微软授权已失效，请重新授权。':'微软授权请求失败，请核对应用配置或稍后重试。',revoked?'MICROSOFT_REAUTH_REQUIRED':'MICROSOFT_OAUTH_UNAVAILABLE');
  }
  return data;
}
export async function requestMicrosoftToken(config,fields,fetcher=fetch) {
  return microsoftJson(MICROSOFT_AUTHORITY+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,scope:MICROSOFT_SCOPES,...fields})},fetcher);
}
export function checkedToken(data,previous={}) {
  const expires=Number(data.expires_in);
  if(typeof data.access_token!=='string'||!data.access_token||data.access_token.length>20000||!Number.isSafeInteger(expires)||expires<60||expires>86400||String(data.token_type).toLowerCase()!=='bearer')throw oauthError('微软返回的令牌格式无效。');
  const scope=data.scope||previous.scope;
  if(typeof scope!=='string'||!scope.split(/\s+/).some(s=>s==='IMAP.AccessAsUser.All'||s==='https://outlook.office.com/IMAP.AccessAsUser.All'))throw oauthError('微软授权缺少 IMAP 收信权限，请重新授权。','MICROSOFT_REAUTH_REQUIRED');
  const refresh=data.refresh_token||previous.refreshToken;
  if(typeof refresh!=='string'||!refresh||refresh.length>20000)throw oauthError('微软授权缺少离线刷新令牌，请重新授权。','MICROSOFT_REAUTH_REQUIRED');
  return {accessToken:data.access_token,refreshToken:refresh,scope,expiresAt:Date.now()+expires*1000};
}
export async function verifyMicrosoftIdentity(token,{clientId,nonce,email,subject},fetcher=fetch) {
  try {
    if(typeof token!=='string'||token.length>24000)throw new Error();
    const parts=token.split('.');if(parts.length!==3)throw new Error();
    const header=JSON.parse(Buffer.from(parts[0],'base64url'));
    const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
    if(header.alg!=='RS256'||typeof header.kid!=='string'||header.jku||header.jwk||header.x5u)throw new Error();
    const keys=await microsoftJson('https://login.microsoftonline.com/consumers/discovery/v2.0/keys',{},fetcher,262144);
    const key=keys.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));
    if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error();
    const now=Date.now()/1000;
    if(claims.iss!==`https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`||claims.tid!==MICROSOFT_TENANT||claims.aud!==clientId||claims.nonce!==nonce||!Number.isSafeInteger(claims.exp)||claims.exp<=now||!Number.isSafeInteger(claims.iat)||claims.iat>now+60||(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now+60))||typeof claims.sub!=='string'||!claims.sub)throw new Error();
    const identityEmail=String(claims.preferred_username||claims.email||'').toLowerCase();
    if(identityEmail!==String(email).toLowerCase()||(subject&&subject!==claims.sub))throw oauthError('微软登录邮箱与指定中继账号不一致，请选择正确账号重新授权。','MICROSOFT_ACCOUNT_MISMATCH');
    return {subject:claims.sub,email:identityEmail};
  } catch(error){if(error?.code==='MICROSOFT_ACCOUNT_MISMATCH'||error?.code==='MICROSOFT_OAUTH_UNAVAILABLE')throw error;throw oauthError('微软身份校验失败，请重新授权。');}
}
