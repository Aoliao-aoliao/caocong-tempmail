import {randomUUID,createHash} from 'node:crypto';
import {openDatabase,databaseConfig} from '../db/database.mjs';
import {encryptGmpay,decryptGmpay} from '../security/secret-box.mjs';
import {config,fail,verified,ORIGIN} from './gmpay-protocol.mjs';
import {siteOrigin} from '../config/deployment.mjs';
export const SETTING='gmpay_payment_config';
const encode=secret=>Object.fromEntries(Object.entries(encryptGmpay(secret)).map(([k,v])=>[k,v.toString('base64')]));
const decode=fields=>decryptGmpay(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,Buffer.from(v,'base64')])));
async function read(connection){const [[row]]=await connection.execute('SELECT value FROM system_settings WHERE `key`=?',[SETTING]);if(!row)return null;try{const saved=JSON.parse(row.value);if(saved.version!==1||!Array.isArray(saved.keys)||saved.keys.length>32)throw Error();return saved;}catch{throw fail('支付配置无法读取，请联系超级管理员。');}}
function current(saved){try{return config({GMPAY_PID:saved.pid,GMPAY_SECRET_KEY:decode(saved.secret),GMPAY_ENABLED:String(saved.enabled),GMPAY_SITE_ORIGIN:saved.site});}catch{throw fail('支付配置无法读取，请联系超级管理员。');}}
export async function resolvedConfig(options={},requireEnabled=false){
 if(options.env)return config(options.env,{requireEnabled});
 const c=await openDatabase();try{const saved=await read(c),cfg=saved?current(saved):config();if(requireEnabled&&!cfg.enabled)throw fail('支付渠道尚未启用。',409);return cfg;}finally{c.release();}
}
export async function notificationConfig(data,options={}){
 if(options.env)return config(options.env);
 const c=await openDatabase();try{const saved=await read(c);if(!saved)return config();
  const candidates=[{pid:saved.pid,secret:saved.secret},...saved.keys];
  for(const candidate of candidates){if(candidate.pid!==data.pid)continue;let secret;try{secret=decode(candidate.secret);}catch{throw fail('支付配置无法读取，请联系超级管理员。');}if(verified(data,secret))return {pid:candidate.pid,secret};}
  throw fail('支付通知签名或订单校验失败。',400);
 }finally{c.release();}
}
export async function publicConfig(){try{const cfg=await resolvedConfig();return {enabled:cfg.enabled,configured:true,origin:ORIGIN,token:'USDT',network:'TRON'};}catch{return {enabled:false,configured:false,origin:ORIGIN,token:'USDT',network:'TRON'};}}
export async function adminConfig(canEdit=false){const publicState=await publicConfig();let cfg;try{cfg=await resolvedConfig();}catch{}return {...publicState,canEdit,pid:canEdit?(cfg?.pid||''):undefined,keyConfigured:publicState.configured,notifyUrl:`${cfg?.site||siteOrigin()}/api/payment/gmpay-notify`,returnUrl:`${cfg?.site||siteOrigin()}/api/payment/gmpay-return`};}
export async function saveConfig(input,actorUserId){
 if(typeof input.enabled!=='boolean'||typeof input.pid!=='string'||(input.secretKey!=null&&typeof input.secretKey!=='string'))throw fail('支付配置字段无效。',400);
 const c=await openDatabase(),lockName='nodemail:gmpay:'+createHash('sha256').update(databaseConfig.database).digest('hex').slice(0,32);let locked=false;
 try{
  const [[lock]]=await c.execute('SELECT GET_LOCK(?,10) acquired',[lockName]);locked=Number(lock.acquired)===1;if(!locked)throw fail('配置正在保存，请稍后重试。',409);
  await c.beginTransaction();const [[actor]]=await c.execute('SELECT role,status FROM users WHERE id=? FOR UPDATE',[actorUserId]);if(actor?.role!=='SUPER_ADMIN'||actor.status!=='ACTIVE')throw fail('只有超级管理员可以配置支付。',403);
  const saved=await read(c);let old;try{old=saved?current(saved):config();}catch(e){if(saved)throw e;}
  const pid=input.pid.trim(),secret=input.secretKey||old?.secret;
  if(pid!==old?.pid&&!input.secretKey)throw fail('更换商户 PID 时请同时填写对应密钥。',400);
  const cfg=config({GMPAY_PID:pid,GMPAY_SECRET_KEY:secret,GMPAY_ENABLED:String(input.enabled),GMPAY_SITE_ORIGIN:old?.site||process.env.GMPAY_SITE_ORIGIN});
  const keys=saved?.keys||[];
  if(old&&(old.pid!==cfg.pid||old.secret!==cfg.secret)&&!keys.some(k=>k.pid===old.pid&&decode(k.secret)===old.secret))keys.push({pid:old.pid,secret:encode(old.secret)});
  if(keys.length>32)throw fail('历史凭证数量已达上限，请先核对未结算订单。',409);
  const value=JSON.stringify({version:1,pid:cfg.pid,enabled:cfg.enabled,site:cfg.site,secret:encode(cfg.secret),keys});if(Buffer.byteLength(value)>60000)throw fail('历史凭证存储已达上限，请联系维护人员。',409);
  await c.execute("INSERT INTO system_settings(`key`,value,value_type,updated_by_user_id) VALUES (?,?,'json',?) ON DUPLICATE KEY UPDATE value=VALUES(value),updated_by_user_id=VALUES(updated_by_user_id)",[SETTING,value,actorUserId]);
  await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'更新USDT支付配置','SYSTEM',?,?)",[`AL-${randomUUID()}`,actorUserId,SETTING,JSON.stringify({enabled:cfg.enabled,credentialChanged:old?.pid!==cfg.pid||old?.secret!==cfg.secret})]);
  await c.commit();
 }catch(e){await c.rollback();throw e;}finally{if(locked)await c.execute('SELECT RELEASE_LOCK(?)',[lockName]).catch(()=>{});c.release();}
 return adminConfig(true);
}
