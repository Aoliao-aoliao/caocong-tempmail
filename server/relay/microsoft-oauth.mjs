import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { encryptMicrosoft, decryptMicrosoft } from '../security/secret-box.mjs';
import { MICROSOFT_CALLBACK_PATH, validateMicrosoftConfig, authorizationUrl, requestMicrosoftToken, checkedToken, verifyMicrosoftIdentity, oauthError, hash } from './microsoft-protocol.mjs';

export const MICROSOFT_CONFIG_KEY='microsoft_relay_config';
const tokenKey=id=>'microsoft_relay_token:'+id;
const stateKey=state=>'microsoft_relay_state:'+hash(state);
const seal=value=>Object.fromEntries(Object.entries(encryptMicrosoft(JSON.stringify(value))).map(([k,v])=>[k,v.toString('base64')]));
const unseal=value=>JSON.parse(decryptMicrosoft(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Buffer.from(v,'base64')]))));
function admin(actor){if(!Number.isSafeInteger(actor?.id)||!['ADMIN','SUPER_ADMIN'].includes(actor.role))throw oauthError('无权执行微软授权操作。','MICROSOFT_ADMIN_REQUIRED');}
function accountIdentity(row){return [row.public_id,row.provider,row.email,row.username,row.imap_host,Number(row.imap_port),Boolean(row.imap_secure)].join('|');}
function microsoftAccount(row){if(!row||row.provider!=='OUTLOOK'||row.imap_host!=='outlook.office365.com'||Number(row.imap_port)!==993||!row.imap_secure||row.username.toLowerCase()!==row.email.toLowerCase())throw oauthError('请先保存 Outlook 账号，使用 outlook.office365.com:993、TLS 及完整邮箱用户名。');}
async function read(c,key,locked=false){const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?'+(locked?' FOR UPDATE':''),[key]);return row?JSON.parse(row.value):null;}
async function write(c,key,value){await c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)",[key,JSON.stringify(value)]);}
async function audit(c,actor,action,id){await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,?,'RELAY_ACCOUNT',?,'{}')",[`AL-${randomUUID()}`,actor.id,action,id]);}
function resolved(config){if(!config?.secret)throw oauthError('请先由超级管理员配置微软应用 Client ID 和 Client Secret。');return {...config,clientSecret:unseal(config.secret).clientSecret};}
export function publicMicrosoftConfig(config,origin){return {clientId:config?.clientId||'',redirectUri:config?.redirectUri||new URL(MICROSOFT_CALLBACK_PATH,origin).href,secretConfigured:Boolean(config?.secret)};}

// Dependency injection permits isolated database and protocol regression tests.
export function createMicrosoftOAuthService({database=openDatabase,fetcher=fetch,verifyIdentity=verifyMicrosoftIdentity}={}) {
  return {
    async config(origin){const c=await database();try{return publicMicrosoftConfig(await read(c,MICROSOFT_CONFIG_KEY),origin);}finally{c.release();}},
    async saveConfig(input,{actor,origin}) {
      admin(actor);if(actor.role!=='SUPER_ADMIN')throw oauthError('只有超级管理员可以配置微软应用。');
      const value=validateMicrosoftConfig(input,origin);const c=await database();
      try{await c.beginTransaction();const old=await read(c,MICROSOFT_CONFIG_KEY,true);
        const supplied=String(input.clientSecret||'');if(supplied.length>4096||/[\r\n\0]/.test(supplied))throw oauthError('微软 Client Secret 格式无效。');
        if(!supplied&&old?.clientId!==value.clientId)throw oauthError('更换微软 Client ID 时必须填写对应的 Client Secret。');
        const secret=supplied?seal({clientSecret:supplied}):old?.secret;if(!secret)throw oauthError('请填写微软 Client Secret 的值，而不是 Secret ID。');
        const changed=!old||old.clientId!==value.clientId||old.redirectUri!==value.redirectUri||Boolean(supplied);
        const config={...value,secret,revision:changed?randomUUID():old.revision};await write(c,MICROSOFT_CONFIG_KEY,config);await audit(c,actor,'配置微软中继应用',MICROSOFT_CONFIG_KEY);await c.commit();return publicMicrosoftConfig(config,origin);
      }catch(e){await c.rollback();throw e;}finally{c.release();}
    },
    async begin({id,actor,session,origin}) {
      admin(actor);if(!session)throw oauthError('请先登录管理员账号。');const c=await database();
      try{await c.beginTransaction();const config=resolved(await read(c,MICROSOFT_CONFIG_KEY,true));
        if(new URL(config.redirectUri).origin!==origin)throw oauthError('请在微软回调地址所属站点的后台发起授权。');
        const [[row]]=await c.execute('SELECT * FROM relay_accounts WHERE public_id=? FOR UPDATE',[id]);microsoftAccount(row);
        const token=await read(c,tokenKey(id),true);
        const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
        // Fixed lifetime and cleanup only this feature's expired handshake rows.
        await c.execute("DELETE FROM system_settings WHERE `key` LIKE 'microsoft_relay_state:%' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(value,'$.expiresAt')) AS UNSIGNED) < ?",[Date.now()]);
        const payload={id,actorId:actor.id,sessionHash:hash(session),nonce,verifier,identity:accountIdentity(row),email:row.email,subject:token?.clientId===config.clientId?(token.subject||null):null,tokenRevision:token?.authorizationRevision||token?.revision||null,configRevision:config.revision,expiresAt:Date.now()+600000};
        await write(c,stateKey(state),{expiresAt:payload.expiresAt,secret:seal(payload)});await c.commit();
        return {url:authorizationUrl(config,{state,nonce,verifier,email:row.email})};
      }catch(e){await c.rollback();throw e;}finally{c.release();}
    },
    async complete({state,code,denied=false,actor,session,origin}) {
      admin(actor);if(!session||! /^[a-zA-Z0-9_-]{43}$/.test(String(state||'')))throw oauthError('微软授权 state 无效，请重新授权。');
      const c=await database();let pending,config;
      try{await c.beginTransaction();config=resolved(await read(c,MICROSOFT_CONFIG_KEY,true));const stored=await read(c,stateKey(state),true);
        if(!stored||stored.expiresAt<=Date.now())throw oauthError('微软授权已过期或已使用，请重新授权。');
        pending=unseal(stored.secret);
        if(!Number.isSafeInteger(pending.expiresAt)||pending.expiresAt<=Date.now())throw oauthError('微软授权已过期，请重新授权。');
        if(pending.actorId!==actor.id||pending.sessionHash!==hash(session)||new URL(config.redirectUri).origin!==origin||pending.configRevision!==config.revision)throw oauthError('微软授权会话或应用配置已变化，请重新授权。');
        await c.execute('DELETE FROM system_settings WHERE `key`=?',[stateKey(state)]);await c.commit();
      }catch(e){await c.rollback();throw e;}finally{c.release();}
      if(denied)throw oauthError('微软授权已取消，请重新授权。','MICROSOFT_ACCESS_DENIED');
      if(typeof code!=='string'||!code||code.length>4096)throw oauthError('微软授权码无效，请重新授权。');
      const data=await requestMicrosoftToken(config,{grant_type:'authorization_code',code,redirect_uri:config.redirectUri,code_verifier:pending.verifier},fetcher);
      const tokens=checkedToken(data);const identity=await verifyIdentity(data.id_token,{clientId:config.clientId,nonce:pending.nonce,email:pending.email,subject:pending.subject},fetcher);
      const connection=await database();
      try{await connection.beginTransaction();const currentConfig=await read(connection,MICROSOFT_CONFIG_KEY,true);
        const [[row]]=await connection.execute('SELECT * FROM relay_accounts WHERE public_id=? FOR UPDATE',[pending.id]);
        const current=await read(connection,tokenKey(pending.id),true);
        if(currentConfig?.revision!==pending.configRevision||!row||accountIdentity(row)!==pending.identity||(current?.authorizationRevision||current?.revision||null)!==pending.tokenRevision)throw oauthError('授权期间账号或应用已变化，请重新授权。');
        await write(connection,tokenKey(pending.id),{revision:randomUUID(),authorizationRevision:randomUUID(),clientId:config.clientId,configRevision:config.revision,subject:identity.subject,reauthRequired:false,secret:seal({...tokens,email:identity.email})});
        // Invalidate older in-flight checks without touching lifecycle/cursor/mail.
        await connection.execute("UPDATE relay_accounts SET updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at)) WHERE id=?",[row.id]);
        await audit(connection,actor,'授权微软中继账号',pending.id);await connection.commit();return {id:pending.id};
      }catch(e){await connection.rollback();throw e;}finally{connection.release();}
    },
    async accessToken(account) {
      microsoftAccount(account);const c=await database();let result,revoked=false;
      try{await c.beginTransaction();const config=resolved(await read(c,MICROSOFT_CONFIG_KEY,true));
        const [[current]]=await c.execute('SELECT * FROM relay_accounts WHERE public_id=? FOR UPDATE',[account.public_id]);
        if(!current||accountIdentity(current)!==accountIdentity(account))throw oauthError('中继账号配置已变化，请重新检测。');
        const key=tokenKey(account.public_id),token=await read(c,key,true);
        if(!token||token.reauthRequired||token.clientId!==config.clientId||token.configRevision!==config.revision)throw oauthError('微软账号尚未授权或授权已失效，请重新授权。','MICROSOFT_REAUTH_REQUIRED');
        const saved=unseal(token.secret);if(saved.email!==account.email.toLowerCase())throw oauthError('微软账号授权绑定不一致，请重新授权。','MICROSOFT_REAUTH_REQUIRED');
        if(saved.expiresAt>Date.now()+120000){result=saved.accessToken;}
        else{
          try{const data=await requestMicrosoftToken(config,{grant_type:'refresh_token',refresh_token:saved.refreshToken},fetcher);const next=checkedToken(data,saved);await write(c,key,{...token,revision:randomUUID(),secret:seal({...next,email:saved.email})});result=next.accessToken;}
          catch(e){if(e.code!=='MICROSOFT_REAUTH_REQUIRED')throw e;await write(c,key,{...token,reauthRequired:true});revoked=true;}
        }
        await c.commit();
      }catch(e){await c.rollback();throw e;}finally{c.release();}
      if(revoked)throw oauthError('微软授权已失效，请重新授权。','MICROSOFT_REAUTH_REQUIRED');return result;
    },
    async statuses(ids) {
      if(!ids.length)return new Map();const c=await database();try{const config=await read(c,MICROSOFT_CONFIG_KEY);const [rows]=await c.execute('SELECT `key`,value FROM system_settings WHERE `key` IN ('+ids.map(()=>'?').join(',')+')',ids.map(tokenKey));
        return new Map(rows.map(row=>{const value=JSON.parse(row.value);return [row.key.slice('microsoft_relay_token:'.length),value.reauthRequired||value.configRevision!==config?.revision?'REAUTH_REQUIRED':'AUTHORIZED'];}));
      }finally{c.release();}
    },
  };
}
export const microsoftOAuth=createMicrosoftOAuthService();
