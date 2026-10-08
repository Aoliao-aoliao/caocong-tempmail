import {createHash,randomBytes} from 'node:crypto';
import {siteOrigin} from '../config/deployment.mjs';
import {openDatabase} from '../db/database.mjs';
import {encryptTelegramSecret,decryptTelegramSecret} from '../security/secret-box.mjs';
import {TELEGRAM_SETTING,WEBHOOK_PATH,fail,validateOrigin,validateBotToken,matchesWebhookSecret,parseBindingUpdate,telegramCall} from './protocol.mjs';

const hash = token => createHash('sha256').update(token).digest('hex');
const seal = value => Object.fromEntries(Object.entries(encryptTelegramSecret(JSON.stringify(value))).map(([k,v])=>[k,v.toString('base64')]));
function unseal(config) {
  if(!config?.secret) throw fail('管理员尚未配置 Telegram 机器人。',503);
  return JSON.parse(decryptTelegramSecret(Object.fromEntries(Object.entries(config.secret).map(([k,v])=>[k,Buffer.from(v,'base64')]))));
}
async function readConfig(c,lock=false) {
  const [[r]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?'+(lock?' FOR UPDATE':''),[TELEGRAM_SETTING]);
  return r?JSON.parse(r.value):null;
}
export function publicConfig(config) {
  return {enabled:config?.enabled===true,origin:config?.origin||siteOrigin(),botUsername:config?.botUsername||'',tokenConfigured:Boolean(config?.secret)};
}
export async function getTelegramConfig() {
  const c=await openDatabase();try{return publicConfig(await readConfig(c));}finally{c.release();}
}
export async function saveTelegramConfig(input,{actorUserId=null,call=telegramCall}={}) {
  if(typeof input.enabled!=='boolean')throw fail('启用状态格式无效。');
  const origin=validateOrigin(input.origin);
  const c=await openDatabase();let old,credentials,changedWebhook=false;
  try {
    await c.beginTransaction();
    old=await readConfig(c,true);
    const [[actor]]=await c.execute('SELECT role,status FROM users WHERE id=?',[actorUserId]);
    if(actor?.role!=='SUPER_ADMIN'||actor.status!=='ACTIVE')throw fail('只有超级管理员可以管理 Telegram 配置。',403);
    if(input.token && typeof input.token!=='string')throw fail('机器人 Token 格式无效。');
    credentials=input.token?{token:validateBotToken(input.token.trim()),webhookSecret:randomBytes(32).toString('hex')}:old?.secret?unseal(old):null;
    if(!credentials) {
      if(input.enabled)throw fail('请先填写机器人 Token。');
      await c.commit();return publicConfig(null);
    }
    const disabling=old && input.enabled===false && !input.token;
    const me=disabling?{id:Number(old.botId),username:old.botUsername,is_bot:true}:await call(credentials.token,'getMe');
    if(me?.is_bot!==true||!Number.isSafeInteger(me.id)||!/^\w{5,32}$/.test(me.username||''))throw fail('机器人信息无效，请核对 Token。');
    if(old?.enabled && old.botId!==String(me.id))throw fail('更换机器人前请先关闭当前绑定功能并保存。');
    // Local disable must remain available even when Telegram is unavailable.
    const webhook=disabling?await call(credentials.token,'getWebhookInfo').catch(()=>null):await call(credentials.token,'getWebhookInfo');
    const expected=origin+WEBHOOK_PATH;
    const previous=old?.botId===String(me.id)?old.origin+WEBHOOK_PATH:'';
    if(!disabling && webhook?.url && webhook.url!==expected && webhook.url!==previous)throw fail('该机器人已连接其他服务，请创建专用机器人再配置。',409);
    if(input.enabled) {
      await call(credentials.token,'setWebhook',{url:expected,secret_token:credentials.webhookSecret,allowed_updates:['message'],max_connections:10});
      changedWebhook=true;
    } else if(webhook?.url && (webhook.url===expected||webhook.url===previous)) {
      try {await call(credentials.token,'deleteWebhook',{drop_pending_updates:false});changedWebhook=true;}
      catch(error){if(!disabling)throw error;}
    }
    const config={enabled:input.enabled,origin,botId:String(me.id),botUsername:me.username,secret:seal(credentials)};
    await c.execute("INSERT INTO system_settings (`key`,value,value_type,updated_by_user_id) VALUES (?,?,'json',?) ON DUPLICATE KEY UPDATE value=VALUES(value),updated_by_user_id=VALUES(updated_by_user_id)",[TELEGRAM_SETTING,JSON.stringify(config),actorUserId]);
    await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (UUID(),?,'更新 Telegram 绑定配置','SYSTEM_SETTING',?,?)",[actorUserId,TELEGRAM_SETTING,JSON.stringify({enabled:config.enabled,botUsername:config.botUsername,tokenChanged:Boolean(input.token)})]);
    await c.commit();return publicConfig(config);
  } catch(error) {
    await c.rollback();
    // Registration and SQL are separate systems; restore the previous endpoint
    // if persistence fails after successful registration. No token in logs.
    if(changedWebhook) {
      try {
        if(old?.enabled) {const s=unseal(old);await call(s.token,'setWebhook',{url:old.origin+WEBHOOK_PATH,secret_token:s.webhookSecret,allowed_updates:['message'],max_connections:10});}
        else await call(credentials.token,'deleteWebhook',{drop_pending_updates:false});
      } catch {console.error('[telegram] webhook restore failed; administrator must re-save configuration');}
    }
    throw error;
  } finally {c.release();}
}
export async function testTelegramConfig({call=telegramCall}={}) {
  const c=await openDatabase();try {
    const config=await readConfig(c);const s=unseal(config);
    const me=await call(s.token,'getMe'),info=await call(s.token,'getWebhookInfo');
    return {...publicConfig(config),botValid:String(me.id)===config.botId,webhookReady:info.url===config.origin+WEBHOOK_PATH,pendingUpdates:Number(info.pending_update_count||0),deliveryError:Boolean(info.last_error_date)};
  }finally{c.release();}
}
function requireEnabled(config){if(!config?.enabled)throw fail('管理员尚未开启 Telegram 绑定。',503);}
async function memberState(c,userId,config) {
  const [[b]]=await c.execute('SELECT telegram_id,username FROM telegram_bindings WHERE user_id=? AND bot_id=?',[userId,config?.botId||'']);
  const [[p]]=await c.execute('SELECT token_hash,telegram_id,username,expires_at FROM telegram_binding_requests WHERE user_id=? AND bot_id=? AND expires_at>UTC_TIMESTAMP(3)',[userId,config?.botId||'']);
  return {enabled:config?.enabled===true,botUsername:config?.botUsername||'',bound:Boolean(b),username:b?.username||'',telegramId:b?.telegram_id||'',pending:p?{ready:Boolean(p.telegram_id),username:p.username,telegramId:p.telegram_id||'',requestId:p.token_hash,expiresAt:new Date(p.expires_at).toISOString()}:null};
}
export async function getTelegramState(userId) {
  const c=await openDatabase();try{return await memberState(c,userId,await readConfig(c));}finally{c.release();}
}
export async function beginTelegramBinding(userId) {
  const c=await openDatabase();try {
    await c.beginTransaction();const config=await readConfig(c,true);requireEnabled(config);
    const token=randomBytes(32).toString('base64url');
    await c.execute('DELETE FROM telegram_binding_requests WHERE expires_at<=UTC_TIMESTAMP(3)');
    await c.execute("INSERT INTO telegram_binding_requests(user_id,token_hash,bot_id,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)) ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash),bot_id=VALUES(bot_id),telegram_id=NULL,username='',expires_at=VALUES(expires_at)",[userId,hash(token),config.botId]);
    const state=await memberState(c,userId,config);await c.commit();
    return {...state,url:`https://t.me/${config.botUsername}?start=bind_${token}`};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
export async function receiveTelegramBinding(secret,update) {
  const c=await openDatabase();try {
    await c.beginTransaction();const config=await readConfig(c,true);
    if(!config?.enabled||!matchesWebhookSecret(secret,unseal(config).webhookSecret))throw fail('请求验证失败。',403);
    const message=parseBindingUpdate(update);
    let prepared=false;
    if(message) {
      const [result]=await c.execute('UPDATE telegram_binding_requests r JOIN users u ON u.id=r.user_id SET r.telegram_id=?,r.username=? WHERE r.token_hash=? AND r.bot_id=? AND r.expires_at>UTC_TIMESTAMP(3) AND r.telegram_id IS NULL AND u.status=\'ACTIVE\'',[message.telegramId,message.username,hash(message.token),config.botId]);
      prepared=Number(result.affectedRows)===1;
    }
    await c.commit();
    // Telegram supports a Bot API method as the webhook HTTP response. Reply
    // only to a valid user-initiated challenge, never send account/mail details.
    return prepared?{method:'sendMessage',chat_id:message.telegramId,text:'已收到绑定请求，请返回网站核对 Telegram 账号并点击“确认绑定”。请勿分享绑定链接。'}:{ok:true};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
export async function confirmTelegramBinding(userId,requestId) {
  if(typeof requestId!=='string'||!/^[0-9a-f]{64}$/.test(requestId))throw fail('绑定请求无效，请重新绑定。');
  const c=await openDatabase();try {
    await c.beginTransaction();const config=await readConfig(c,true);requireEnabled(config);
    const [[p]]=await c.execute('SELECT * FROM telegram_binding_requests WHERE user_id=? AND bot_id=? AND token_hash=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE',[userId,config.botId,requestId]);
    if(!p?.telegram_id)throw fail('绑定请求未完成或已过期，请先在机器人中点击 Start。',409);
    // A Telegram identity may belong to only one site account. Never use an
    // upsert here: the alternate unique key could update another user's row.
    const [[other]]=await c.execute('SELECT user_id FROM telegram_bindings WHERE bot_id=? AND telegram_id=? AND user_id<>?',[config.botId,p.telegram_id,userId]);
    if(other)throw fail('该 Telegram 已绑定其他账户，请先在原账户解绑。',409);
    await c.execute('DELETE FROM telegram_bindings WHERE user_id=?',[userId]);
    await c.execute('INSERT INTO telegram_bindings(user_id,bot_id,telegram_id,username) VALUES (?,?,?,?)',[userId,config.botId,p.telegram_id,p.username]);
    await c.execute('DELETE FROM telegram_binding_requests WHERE user_id=?',[userId]);
    await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id) VALUES (UUID(),?,'绑定 Telegram','USER',?)",[userId,String(userId)]);
    const state=await memberState(c,userId,config);await c.commit();return state;
  }catch(error){await c.rollback();if(error.code==='ER_DUP_ENTRY')throw fail('该 Telegram 已绑定其他账户。',409);throw error;}finally{c.release();}
}
export async function unlinkTelegram(userId) {
  const c=await openDatabase();try {
    await c.beginTransaction();const config=await readConfig(c,true);
    await c.execute('DELETE FROM telegram_bindings WHERE user_id=?',[userId]);
    await c.execute('DELETE FROM telegram_binding_requests WHERE user_id=?',[userId]);
    await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id) VALUES (UUID(),?,'解绑 Telegram','USER',?)",[userId,String(userId)]);
    const state=await memberState(c,userId,config);await c.commit();return state;
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
