import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {openDatabase} from '../db/database.mjs';
import {readConfig,parseJson,unpack} from './nodeloc-config.mjs';
import {fail,verified,moneyCents,paymentUrl,gatewayRequest} from './nodeloc-protocol.mjs';
const validId=id=>/^NL-[0-9a-f-]{36}$/.test(String(id));
const serialize=o=>({id:o.id,points:Number(o.points),energy:Number(o.energy),status:o.status,expired:new Date(o.expires_at)<=new Date(),paymentUrl:o.payment_url,createdAt:new Date(o.created_at).toISOString()});
export async function paymentView(userId,rawPage=1){
 const page=Number(rawPage);if(!Number.isSafeInteger(page)||page<1||page>100000)throw fail('请求页码无效。',400);
 const c=await openDatabase();try{
  const config=await readConfig(c);
  const [plans]=await c.execute('SELECT code,points FROM recharge_plans WHERE enabled=1 ORDER BY sort_order,id');
  const [orders]=await c.execute('SELECT id,points,energy,status,payment_url,expires_at,created_at FROM nodeloc_payment_orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 6 OFFSET ?',[userId,(page-1)*5]);
  return {enabled:config?.enabled===true,plans:config?.enabled?plans.filter(p=>config.prices[p.code]>0).map(p=>({code:p.code,points:Number(p.points),energy:config.prices[p.code]})):[],orders:orders.slice(0,5).map(serialize),page,hasNext:orders.length>5};
 }finally{c.release();}
}
export async function createOrder({userId,requestId,planCode,expectedEnergy,expectedPoints},options={}){
 if(!isIP(String(options.clientIp||'')))throw fail('无法确定付款请求的来源地址，请稍后重试。',400);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(requestId)))throw fail('请求标识无效，请刷新页面。',400);
 const c=await openDatabase();let order;
 try{
  await c.beginTransaction();
  const [[user]]=await c.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);if(!user)throw fail('账户不存在。',404);
  const [[existing]]=await c.execute('SELECT * FROM nodeloc_payment_orders WHERE user_id=? AND request_id=?',[userId,requestId]);
  if(existing){if(existing.plan_code!==planCode||Number(existing.energy)!==expectedEnergy||Number(existing.points)!==expectedPoints)throw fail('该请求已用于其他支付订单。',409);order=existing;}
  else{
   const config=await readConfig(c);if(!config?.enabled)throw fail('支付渠道尚未启用。',400);
   const [[plan]]=await c.execute('SELECT code,points FROM recharge_plans WHERE code=? AND enabled=1',[String(planCode)]);
   const energy=config.prices[planCode];
   if(!plan||!Number.isSafeInteger(energy)||energy<=0)throw fail('充值档位当前不可用。',400);
   if(expectedEnergy!==energy||expectedPoints!==Number(plan.points))throw fail('充值价格已变化，请刷新后确认。',409);
   const [[count]]=await c.execute("SELECT COUNT(*) n FROM nodeloc_payment_orders WHERE user_id=? AND status='PENDING' AND expires_at>UTC_TIMESTAMP(3)",[userId]);
   if(Number(count.n)>=3)throw fail('最多保留 3 笔待支付 NodeLoc 订单。',409);
   const id=`NL-${randomUUID()}`;
   // Snapshot both price and merchant credentials; later edits must not invalidate old payments.
   const snapshot={pid:config.pid,siteOrigin:config.siteOrigin,platformKey:config.platformKey,secret:config.secret};
   await c.execute('INSERT INTO nodeloc_payment_orders(id,user_id,request_id,plan_code,points,energy,config_json,expires_at) VALUES (?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))',[id,userId,requestId,planCode,plan.points,energy,JSON.stringify(snapshot)]);
   const [[row]]=await c.execute('SELECT * FROM nodeloc_payment_orders WHERE id=?',[id]);order=row;
  }
  await c.commit();
 }catch(e){await c.rollback();throw e;}finally{c.release();}
 return continueOrder({userId,id:order.id},options);
}
async function loadOrder(id,userId){
 if(!validId(id))throw fail('支付订单不存在。',404);
 const c=await openDatabase();try{const [[o]]=await c.execute('SELECT * FROM nodeloc_payment_orders WHERE id=?'+(userId==null?'':' AND user_id=?'),userId==null?[id]:[id,userId]);if(!o)throw fail('支付订单不存在。',404);return o;}finally{c.release();}
}
export async function continueOrder({userId,id},options={}){
 const order=await loadOrder(id,userId);if(order.status==='PAID')return serialize(order);
 if(new Date(order.expires_at)<=new Date())throw fail('支付链接已过期，请先查询是否已到账。',409);
 const c=await openDatabase();try{if(!(await readConfig(c))?.enabled)throw fail('支付渠道已暂停，仍可查询原订单到账情况。',409);}finally{c.release();}
 if(order.payment_url)return serialize(order);
 if(!isIP(String(options.clientIp||'')))throw fail('无法确定付款请求的来源地址，请稍后重试。',400);
 const config=unpack(parseJson(order.config_json));
 const result=await gatewayRequest('create',{method:'jump',type:'nodeloc',clientip:options.clientIp,out_trade_no:order.id,name:`NodeMail ${order.points} 积分`,money:`${order.energy}.00`,notify_url:`${config.siteOrigin}/api/payment/nodeloc-notify`,return_url:`${config.siteOrigin}/api/payment/nodeloc-return`},config,options);
 if(typeof result.trade_no!=='string'||!/^[\w-]{1,128}$/.test(result.trade_no))throw fail();
 if(result.out_trade_no!=null&&result.out_trade_no!==order.id)throw fail();
 if(result.money!=null&&moneyCents(result.money)!==Number(order.energy)*100)throw fail();
 if(!result.pay_info&&String(result.code)==='1')return queryOrder({userId,id:order.id},options);
 if(result.pay_type!=='jump')throw fail();
 const url=paymentUrl(result.pay_info);
 const conn=await openDatabase();try{
  // Same out_trade_no is idempotent upstream. Never overwrite a conflicting transaction mapping.
  const [r]=await conn.execute('UPDATE nodeloc_payment_orders SET trade_no=?,payment_url=? WHERE id=? AND (trade_no IS NULL OR trade_no=?)',[result.trade_no,url,order.id,result.trade_no]);
  if(!r.affectedRows)throw fail();
 }finally{conn.release();}
 return serialize(await loadOrder(order.id,userId));
}
export function assertPayment(data,order,{notification=false}={}){
 const config=parseJson(order.config_json);
 if(!verified(data,config.platformKey,{defaultRsa:!notification}))throw fail('支付签名校验失败。',400);
 if(notification&&String(data.pid)!==config.pid)throw fail('支付商户不匹配。',400);
 if(data.pid!=null&&String(data.pid)!==config.pid)throw fail('支付商户不匹配。',400);
 if(data.out_trade_no!==order.id||moneyCents(data.money)!==Number(order.energy)*100)throw fail('支付订单或金额不匹配。',400);
 if(typeof data.trade_no!=='string'||!/^[\w-]{1,128}$/.test(data.trade_no)||(order.trade_no&&order.trade_no!==data.trade_no))throw fail('支付交易号不匹配。',400);
 return notification?data.trade_status==='TRADE_SUCCESS':data.trade_status==='TRADE_SUCCESS'||String(data.status)==='1';
}
export async function settlePayment(data,{notification=false}={}){
 const o=await loadOrder(data.out_trade_no);if(!assertPayment(data,o,{notification}))return {id:o.id,status:o.status};
 const c=await openDatabase();try{
  await c.beginTransaction();
  const [[order]]=await c.execute('SELECT * FROM nodeloc_payment_orders WHERE id=? FOR UPDATE',[o.id]);
  assertPayment(data,order,{notification});
  if(order.status!=='PAID'){
   const [[user]]=await c.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[order.user_id]);
   const after=Number(user.points_balance)+Number(order.points);if(!Number.isSafeInteger(after))throw fail();
   // Late legitimate payment is honored once; local expiry must never consume payment without credit.
   await c.execute("UPDATE nodeloc_payment_orders SET status='PAID',trade_no=?,paid_at=UTC_TIMESTAMP(3) WHERE id=?",[data.trade_no,order.id]);
   await c.execute('UPDATE users SET points_balance=? WHERE id=?',[after,order.user_id]);
   await c.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note) VALUES (?,?,'RECHARGE',?,?,'NODELOC_ORDER',?,'NodeLoc 能量充值')",[`PT-${randomUUID()}`,order.user_id,order.points,after,order.id]);
  }
  await c.commit();return {id:order.id,status:'PAID'};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function queryOrder({userId,id},options={}){
 const order=await loadOrder(id,userId);if(order.status==='PAID')return {id:order.id,status:'PAID'};
 const config=unpack(parseJson(order.config_json));
 const data=await gatewayRequest('query',{out_trade_no:order.id},config,options);
 assertPayment(data,order);return settlePayment(data);
}
