import {randomBytes,randomUUID} from 'node:crypto';
import {openDatabase} from '../db/database.mjs';
import {encryptNodelocOAuth,decryptNodelocOAuth} from '../security/secret-box.mjs';
import {defaultApiRateLimit,insertApiKey} from '../member/api-key.mjs';
import {hashPassword,verifyPassword} from './service.mjs';
import {NODELOC_CONFIG_KEY,NODELOC_CALLBACK_PATH,hash,oauthError,validateConfig,authorizationUrl,exchangeIdentity} from './nodeloc-protocol.mjs';

const seal=value=>Object.fromEntries(Object.entries(encryptNodelocOAuth(JSON.stringify(value))).map(([k,v])=>[k,v.toString('base64')]));
const unseal=value=>JSON.parse(decryptNodelocOAuth(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Buffer.from(v,'base64')]))));
const stateKey=s=>'nodeloc_oauth_state:'+hash(s);
const identityKey=s=>'nodeloc_oauth_identity:'+hash(s);
const userKey=id=>'nodeloc_oauth_user:'+id;
const invalid=()=>oauthError('授权已失效，请重新发起 NodeLoc 登录或绑定。');
async function read(c,key,lock=false){const [[r]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?'+(lock?' FOR UPDATE':''),[key]);return r?JSON.parse(r.value):null;}
async function write(c,key,value){await c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)",[key,JSON.stringify(value)]);}
async function remove(c,key){await c.execute('DELETE FROM system_settings WHERE `key`=?',[key]);}
async function lockedConfig(c){
  // A stable row serializes configuration, bindings and callbacks, including first save.
  await c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,'{}','json') ON DUPLICATE KEY UPDATE `key`=VALUES(`key`)",[NODELOC_CONFIG_KEY]);
  return await read(c,NODELOC_CONFIG_KEY,true);
}
async function actor(c,id,role){
  const [[u]]=await c.execute('SELECT * FROM users WHERE id=? FOR UPDATE',[id]);
  if(!u||u.status!=='ACTIVE'||(role&&u.role!==role))throw oauthError('无权执行此操作，请重新登录。',403);
  return u;
}
async function validSession(c,token,userId){
  const [[s]]=await c.execute("SELECT user_id FROM sessions WHERE token_hash=? AND id NOT LIKE 'pr:%' AND expires_at>UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE",[hash(token||'')]);
  if(!s||Number(s.user_id)!==Number(userId))throw invalid();
}
// Password reset proves mailbox control and must end every other way into the
// account. Callers lock the config row before the user row (callback order).
export const lockNodelocBindings=c=>lockedConfig(c);
export async function removeNodelocBinding(c,userId){
  const binding=await read(c,userKey(userId),true);if(!binding)return false;
  await remove(c,identityKey(unseal(binding).subject));await remove(c,userKey(userId));return true;
}
function ready(config,origin){if(!config?.enabled||!config.clientId||!config.secret||config.origin!==origin)throw oauthError('当前网站尚未启用 NodeLoc 登录，请联系管理员。',503);}
function publicConfig(v){return {enabled:Boolean(v?.enabled),clientId:v?.clientId||'',origin:v?.origin||'',secretConfigured:Boolean(v?.secret),callbackUrl:v?.origin?v.origin+NODELOC_CALLBACK_PATH:''};}

export function createNodelocOAuthService({database=openDatabase,exchange=exchangeIdentity}={}){
  return {
    async config(){const c=await database();try{return publicConfig(await read(c,NODELOC_CONFIG_KEY));}finally{c.release();}},
    async save(input,{actorUserId}){
      const value=validateConfig(input),c=await database();
      try{await c.beginTransaction();const old=await lockedConfig(c);await actor(c,actorUserId,'SUPER_ADMIN');
        const supplied=typeof input.clientSecret==='string'?input.clientSecret:'';
        if(supplied.length>4096||/[\s\x00-\x1f]/.test(supplied))throw oauthError('请输入有效的 Client Secret。');
        if(old.clientId&&value.clientId!==old.clientId&&!supplied)throw oauthError('更换 Client ID 时必须填写对应的 Client Secret。');
        const secret=supplied?seal({clientSecret:supplied}):old.secret;
        if(value.enabled&&!secret)throw oauthError('请填写 NodeLoc Client Secret。');
        const v={...value,secret,revision:randomUUID()};await write(c,NODELOC_CONFIG_KEY,v);
        await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?, 'NODELOC_OAUTH_CONFIG','SYSTEM_SETTING',?,'{}')",['AL-'+randomUUID(),actorUserId,NODELOC_CONFIG_KEY]);
        await c.commit();return publicConfig(v);
      }catch(e){await c.rollback();throw e;}finally{c.release();}
    },
    async begin({origin,sessionToken='',userId=null,mode='login',locale='zh-CN'}){
      if(!['login','bind','refresh'].includes(mode))throw invalid();
      const c=await database(),state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
      try{await c.beginTransaction();const config=await lockedConfig(c);ready(config,origin);
        if(mode!=='login'){await actor(c,userId);await validSession(c,sessionToken,userId);const existing=await read(c,userKey(userId));if(mode==='bind'&&existing)throw oauthError('当前账户已经绑定 NodeLoc。',409);if(mode==='refresh'&&!existing)throw invalid();}
        else if(sessionToken)throw oauthError('请在用户中心绑定 NodeLoc，或退出账户后再登录。',409);
        await c.execute("DELETE FROM system_settings WHERE `key` LIKE 'nodeloc_oauth_state:%' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(value,'$.expiresAt')) AS UNSIGNED) < ?",[Date.now()]);
        await write(c,stateKey(state),{expiresAt:Date.now()+600000,payload:seal({nonce:hash(nonce),session:hash(sessionToken),userId,mode,origin,locale,revision:config.revision})});
        await c.commit();return {url:authorizationUrl(config,state),nonce};
      }catch(e){await c.rollback();throw e;}finally{c.release();}
    },
    async complete({state,nonce,code,error,origin,sessionToken='',ipAddress,userAgent}){
      if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state)||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(nonce))throw invalid();
      let config,flow;let c=await database();
      try{await c.beginTransaction();config=await lockedConfig(c);ready(config,origin);const row=await read(c,stateKey(state),true);
        if(!row||row.expiresAt<=Date.now())throw invalid();flow=unseal(row.payload);
        if(flow.nonce!==hash(nonce)||flow.session!==hash(sessionToken)||flow.origin!==origin||flow.revision!==config.revision)throw invalid();
        await remove(c,stateKey(state));await c.commit();
      }catch(e){await c.rollback();throw e;}finally{c.release();}
      // Denials also consume the challenge. Provider messages are never echoed.
      if(error)throw oauthError('NodeLoc 授权未完成，请重新尝试。');
      if(typeof code!=='string'||!code||code.length>4096||/[\s\x00-\x1f]/.test(code))throw invalid();
      const identity=await exchange({...config,clientSecret:unseal(config.secret).clientSecret},code);
      const token=randomBytes(32).toString('base64url');const maxAge=604800;
      c=await database();
      try{await c.beginTransaction();const current=await lockedConfig(c);ready(current,origin);if(current.revision!==flow.revision)throw invalid();
        const mapping=await read(c,identityKey(identity.subject));let user;
        if(flow.mode==='refresh'){
          user=await actor(c,flow.userId);await validSession(c,sessionToken,user.id);
          const reverse=await read(c,userKey(user.id));
          if(!mapping||Number(unseal(mapping).userId)!==Number(user.id)||!reverse||unseal(reverse).subject!==identity.subject)throw oauthError('请使用当前已绑定的 NodeLoc 账号更新资料。',409);
        }else if(flow.mode==='bind'){
          user=await actor(c,flow.userId);await validSession(c,sessionToken,user.id);
          if(mapping||await read(c,userKey(user.id)))throw oauthError('该 NodeLoc 或本站账户已经绑定，请勿重复绑定。',409);
        }else if(mapping){const link=unseal(mapping);user=await actor(c,link.userId);
          const reverse=await read(c,userKey(user.id));if(!reverse||unseal(reverse).subject!==identity.subject)throw invalid();
        }else{
          // Email is registration data, NEVER evidence to log into an existing account.
          const [[existing]]=await c.execute('SELECT id FROM users WHERE email=? LIMIT 1',[identity.email]);
          if(existing)throw oauthError('该邮箱已有本站账户，请先用原方式登录，再到用户中心绑定 NodeLoc。',409);
          const [[bonusRow]]=await c.execute("SELECT value FROM system_settings WHERE `key`='registration_bonus_points'");
          const bonus=Math.max(0,Math.floor(Number(bonusRow?.value||0)));
          if(!Number.isSafeInteger(bonus))throw oauthError('注册配置无效，请联系管理员。',503);
          // Discard the random password; a normal scrypt hash preserves the local
          // login timing protection without introducing a known/default password.
          const [r]=await c.execute('INSERT INTO users(public_id,email,password_hash,points_balance,locale) VALUES (?,?,?,?,?)',['U-'+randomUUID(),identity.email,hashPassword(randomBytes(32).toString('base64url')),bonus,['en-US','zh-TW'].includes(flow.locale)?flow.locale:'zh-CN']);
          user={id:Number(r.insertId)};await insertApiKey(c,{userId:user.id,rateLimit:defaultApiRateLimit});
          if(bonus)await c.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,note) VALUES (?,?,'REGISTER_BONUS',?,?,'新用户注册赠送')",['PT-'+randomUUID(),user.id,bonus,bonus]);
        }
        if(!mapping)await write(c,identityKey(identity.subject),seal({userId:Number(user.id)}));
        // Only server-verified provider data updates the display snapshot; no local privileges depend on it.
        await write(c,userKey(user.id),seal({subject:identity.subject,username:identity.username,trustLevel:identity.trustLevel??null}));
        if(flow.mode==='login'){
          await c.execute('DELETE FROM sessions WHERE expires_at<=UTC_TIMESTAMP(3)');
          await c.execute('INSERT INTO sessions(id,user_id,token_hash,ip_address,user_agent,expires_at) VALUES (?,?,?,?,?,?)',[randomUUID(),user.id,hash(token),String(ipAddress||'').slice(0,45)||null,String(userAgent||'').slice(0,500)||null,new Date(Date.now()+maxAge*1000)]);
        }
        await c.commit();return {mode:flow.mode,token:flow.mode==='login'?token:null,maxAge};
      }catch(e){await c.rollback();if(e?.code==='ER_DUP_ENTRY')throw oauthError('该邮箱已有本站账户，请先用原方式登录，再到用户中心绑定 NodeLoc。',409);throw e;}finally{c.release();}
    },
    async binding(userId,origin){const c=await database();try{const config=await read(c,NODELOC_CONFIG_KEY),v=await read(c,userKey(userId)),profile=v?unseal(v):null;return {available:Boolean(config?.enabled&&config.secret&&config.origin===origin),bound:Boolean(v),username:profile?.username||'',trustLevel:profile?.trustLevel??null};}finally{c.release();}},
    async unlink(userId,password){const c=await database();try{await c.beginTransaction();await lockedConfig(c);const user=await actor(c,userId);
      if(typeof password!=='string'||password.length>255||!verifyPassword(password,user.password_hash))throw oauthError('请填写本站登录密码；未设置密码请先通过忘记密码完成设置。',403);
      await removeNodelocBinding(c,userId);
      await c.execute('DELETE FROM sessions WHERE user_id=?',[userId]);await c.commit();return {ok:true};
    }catch(e){await c.rollback();throw e;}finally{c.release();}}
  };
}
export const nodelocOAuth=createNodelocOAuthService();
