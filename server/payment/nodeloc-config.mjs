import {randomUUID,createPublicKey} from 'node:crypto';
import {siteOrigin} from '../config/deployment.mjs';
import {openDatabase} from '../db/database.mjs';
import {encryptPayment,decryptPayment} from '../security/secret-box.mjs';
import {fail,rsaKey} from './nodeloc-protocol.mjs';
export const parseJson=value=>typeof value==='string'?JSON.parse(value):value;
export const unpack=config=>({...config,privateKey:decryptPayment(Object.fromEntries(Object.entries(config.secret).map(([k,v])=>[k,Buffer.from(v,'base64')])))});
export async function readConfig(c) {const [[row]]=await c.execute('SELECT config_json FROM nodeloc_payment_config WHERE id=1');return row?parseJson(row.config_json):null;}
export function publicConfig(config){return config?{enabled:config.enabled,pid:config.pid,siteOrigin:config.siteOrigin,platformKey:config.platformKey,prices:config.prices,keyConfigured:true,unitRateConfirmed:true}:{enabled:false,pid:'',siteOrigin:siteOrigin(),platformKey:'',prices:{},keyConfigured:false,unitRateConfirmed:false};}
export async function saveConfig(input,actorUserId){
  const c=await openDatabase();
  try{
    await c.beginTransaction();
    await c.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[actorUserId]);
    const old=await readConfig(c);
    const pid=String(input.pid||'').trim();
    if(!/^[1-9]\d{0,17}$/.test(pid))throw fail('支付商户 ID 必须为数字。',400);
    let origin;
    try{origin=new URL(input.siteOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error();}catch{throw fail('支付回调站点必须为 HTTPS 根地址。',400);}
    if(input.unitRateConfirmed!==true)throw fail('请先在 NodeLoc 应用中设置 1 单位货币 = 1 能量。',400);
    const platformKey=rsaKey(input.platformKey).export({type:'spki',format:'pem'}).toString();
    let secret=old?.secret;
    if(input.privateKey){rsaKey(input.privateKey,true);const pub=createPublicKey(input.privateKey).export({type:'spki',format:'pem'}).toString();if(pub===platformKey)throw fail('支付平台公钥不能填写成商户自己的公钥。',400);secret=Object.fromEntries(Object.entries(encryptPayment(input.privateKey)).map(([k,v])=>[k,v.toString('base64')]));}
    else if(old?.pid!==pid)throw fail('更换支付商户时请重新填写私钥。',400);
    if(!secret)throw fail('请填写商户 RSA 私钥。',400);
    const prices={};const [plans]=await c.execute('SELECT code FROM recharge_plans');
    for(const plan of plans){const n=Number(input.prices?.[plan.code]||0);if(!Number.isSafeInteger(n)||n<0||n>100000000)throw fail('支付能量价格必须为整数，0 表示不出售。',400);prices[plan.code]=n;}
    if(input.enabled===true&&!Object.values(prices).some(n=>n>0))throw fail('请至少设置一个能量价格。',400);
    const config={enabled:input.enabled===true,pid,siteOrigin:origin.origin,platformKey,secret,prices};
    await c.execute('INSERT INTO nodeloc_payment_config(id,config_json) VALUES (1,?) ON DUPLICATE KEY UPDATE config_json=VALUES(config_json)',[JSON.stringify(config)]);
    await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'更新 NodeLoc 支付配置','PAYMENT_CONFIG','NODELOC',?)",[`AL-${randomUUID()}`,actorUserId,JSON.stringify({enabled:config.enabled,keyChanged:Boolean(input.privateKey)})]);
    await c.commit();return publicConfig(config);
  }catch(e){await c.rollback();throw e;}finally{c.release();}
}
