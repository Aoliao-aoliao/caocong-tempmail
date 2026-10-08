import nodemailer from 'nodemailer';
import { resolve4 } from 'node:dns/promises';
import { BlockList } from 'node:net';
import { openDatabase } from '../db/database.mjs';
import { encryptPasswordMail, decryptPasswordMail } from '../security/secret-box.mjs';

export const MAIL_SETTING = 'password_reset_smtp';
const fail = message => Object.assign(new Error(message), {status:400});
export function validateMailConfig(input) {
  const host = String(input.host || '').trim().toLowerCase();
  const port = Number(input.port);
  const from = String(input.from || '').trim().toLowerCase();
  if (/[\r\n\0]/.test(String(input.username || '') + String(input.from || '') + String(input.host || ''))) throw fail('SMTP 配置不能包含换行或控制字符。');
  const username = String(input.username || '').trim();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.length > 253) throw fail('请输入有效的 SMTP 公网主机名。');
  if (![465,587].includes(port)) throw fail('SMTP 端口仅支持 465 或 587，并强制 TLS。');
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || from.length>254) throw fail('请输入有效的发件邮箱。');
  if (!username || username.length>254 || /[\r\n\0]/.test(username)) throw fail('请输入有效的 SMTP 登录账号。');
  return {host,port,from,username,enabled:input.enabled === true};
}
export async function readMailConfig() {
  const c=await openDatabase();
  try {const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[MAIL_SETTING]);return row ? JSON.parse(row.value) : null;}
  finally {c.release();}
}
export function publicMailConfig(config) {
  return config ? {...validateMailConfig(config),passwordConfigured:Boolean(config.secret)} : {host:'',port:465,from:'',username:'',enabled:false,passwordConfigured:false};
}
export async function saveMailConfig(input, {actorUserId=null}={}) {
  const value=validateMailConfig(input);
  const c=await openDatabase();
  try {
    await c.beginTransaction();
    const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=? FOR UPDATE',[MAIL_SETTING]);
    const old=row ? JSON.parse(row.value) : null;
    let secret=old?.secret;
    if (input.password) {
      if(typeof input.password!=='string'||input.password.length>1024)throw fail('SMTP 密码格式无效。');
      secret=Object.fromEntries(Object.entries(encryptPasswordMail(input.password)).map(([key,bytes])=>[key,bytes.toString('base64')]));
    } else if (old && (old.host!==value.host || old.port!==value.port || old.username!==value.username)) {
      // Never send an existing credential to a newly selected endpoint.
      throw fail('更换 SMTP 主机、端口或账号时请重新输入密码。');
    }
    if(!secret)throw fail('请配置 SMTP 密码或应用密码。');
    const config={...value,secret};
    await c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)",[MAIL_SETTING,JSON.stringify(config)]);
    if(actorUserId)await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (UUID(),?,'更新密码找回发信配置','SYSTEM_SETTING',? ,?)",[actorUserId,MAIL_SETTING,JSON.stringify({enabled:config.enabled,passwordChanged:Boolean(input.password)})]);
    await c.commit();return publicMailConfig(config);
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
const blocked=new BlockList();
for(const [network,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(network,bits);
export function isPublicMailAddress(address){return !blocked.check(address,'ipv4') && /^\d+\.\d+\.\d+\.\d+$/.test(address);}
export async function sendResetCode({config,to,code}, {resolve=resolve4,createTransport=nodemailer.createTransport}={}) {
  const addresses=await resolve(config.host);
  if(!addresses.length || addresses.some(address=>!isPublicMailAddress(address)))throw new Error('SMTP destination unavailable');
  const fields=Object.fromEntries(Object.entries(config.secret).map(([key,value])=>[key,Buffer.from(value,'base64')]));
  const transporter=createTransport({
    host:addresses[0],port:config.port,secure:config.port===465,requireTLS:true,
    tls:{servername:config.host,minVersion:'TLSv1.2',rejectUnauthorized:true},
    auth:{user:config.username,pass:decryptPasswordMail(fields)},
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
    logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
  });
  try {await transporter.sendMail({from:config.from,to,subject:'NodeMail 密码重置验证码',text:`您的密码重置验证码：${code}\n10 分钟内有效，只能使用一次。请勿向他人透露。\n如非本人操作，请忽略此邮件。`});}
  finally{transporter.close();}
}
