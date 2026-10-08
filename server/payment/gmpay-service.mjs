import {randomBytes,randomUUID} from 'node:crypto';
import {openDatabase} from '../db/database.mjs';
import {fail,checkoutExpiration,numericText,signature,gateway,paymentUrl,units,assertCounter,assertNotification} from './gmpay-protocol.mjs';
import {resolvedConfig,notificationConfig} from './gmpay-config.mjs';
import QRCode from 'qrcode';
const idValid=id=>/^GP-[0-9a-f]{28}$/.test(String(id));
const serialize=async o=>({id:o.id,status:o.status,paymentUrl:o.payment_url,points:Number(o.points),amountUsdCents:Number(o.amount_usd_cents),actualAmount:o.actual_amount==null?null:numericText(o.actual_amount),expiresAt:new Date(o.expires_at).toISOString(),createState:o.create_state,receiveAddress:o.receive_address,qrCodeDataUrl:o.status==='PENDING'&&o.create_state==='BOUND'&&/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(o.receive_address)?await QRCode.toDataURL(o.receive_address,{width:240,margin:2,errorCorrectionLevel:'M'}):null});
async function load(id,userId){if(!idValid(id))throw fail('支付订单不存在。',404);const c=await openDatabase();try{const [[o]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=?'+(userId==null?'':' AND user_id=?'),userId==null?[id]:[id,userId]);if(!o)throw fail('支付订单不存在。',404);return o;}finally{c.release();}}
export async function createOrder({userId,requestId,planCode,expectedAmountUsdCents,expectedPoints,replacesOrderId},options={}){
 const cfg=await resolvedConfig(options,true);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(requestId)))throw fail('请求标识无效。',400);
 let replacement;
 if(replacesOrderId!=null){
  if(!idValid(replacesOrderId))throw fail('支付订单不存在。',404);
  // A lost replacement response must resume its own request before checking the
  // predecessor again. A late payment of the old order must not hide a new one.
  const check=await openDatabase();let existing;
  try{[[existing]]=await check.execute('SELECT * FROM gmpay_payment_orders WHERE user_id=? AND request_id=?',[userId,requestId]);}finally{check.release();}
  if(!existing){
   replacement=await load(replacesOrderId,userId);
   if(replacement.plan_code!==planCode||Number(replacement.points)!==expectedPoints||Number(replacement.amount_usd_cents)!==expectedAmountUsdCents)throw fail('重新生成时请保留原充值档位。',409);
   const checked=await queryOrder({userId,id:replacesOrderId},options);
   if(checked.status!=='PAID'&&!checked.canReplace)throw fail('原订单尚未确认过期，请查询到账；已转账请勿重新生成。',409);
  }
 }
 const c=await openDatabase();let order,replacementPaid;
 try{
  await c.beginTransaction();
  if(replacement){
   // Match the settlement lock order (order, then user), and recheck callbacks
   // which arrived after the gateway read. Old orders remain queryable/payable.
   const [[locked]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=? AND user_id=? FOR UPDATE',[replacement.id,userId]);
   if(!locked)throw fail('支付订单不存在。',404);
   if(locked.status==='PAID')replacementPaid=locked;
   else if(!['PENDING','EXPIRED'].includes(locked.status)||locked.create_state!=='BOUND'||locked.trade_id!==replacement.trade_id||new Date(locked.expires_at)>new Date())throw fail('原订单状态已变化，请查询到账后重试。',409);
  }
  const [[user]]=await c.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);if(!user)throw fail('账户不存在。',404);
  const [[old]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE user_id=? AND request_id=?',[userId,requestId]);
  if(old){if(old.plan_code!==planCode||Number(old.amount_usd_cents)!==expectedAmountUsdCents||Number(old.points)!==expectedPoints||old.merchant_pid!==cfg.pid)throw fail('该请求已用于其他订单或商户。',409);order=old;}
  else{
   // A concurrent retry may already have created the replacement while this
   // request waited for the predecessor lock. Prefer that idempotent result.
   if(replacementPaid){await c.commit();return serialize(replacementPaid);}
   const [[plan]]=await c.execute('SELECT code,points,amount_usd_cents FROM recharge_plans WHERE code=? AND enabled=1',[String(planCode)]);
   if(!plan||Number(plan.amount_usd_cents)<=1||Number(plan.amount_usd_cents)!==expectedAmountUsdCents||Number(plan.points)!==expectedPoints)throw fail('充值价格或档位已变化，请刷新后确认。',409);
   const [[setting]]=await c.execute("SELECT value FROM system_settings WHERE `key`='pending_order_limit'");const limit=Math.min(10,Math.max(1,Number(setting?.value)||3));
   const [[pending]]=await c.execute("SELECT COUNT(*) n FROM gmpay_payment_orders WHERE user_id=? AND status='PENDING' AND expires_at>UTC_TIMESTAMP(3)",[userId]);if(Number(pending.n)>=limit)throw fail(`最多保留 ${limit} 笔待支付 USDT 订单。`,409);
   const id=`GP-${randomBytes(14).toString('hex')}`;
   await c.execute('INSERT INTO gmpay_payment_orders(id,user_id,request_id,plan_code,merchant_pid,points,amount_usd_cents,expires_at) VALUES (?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))',[id,userId,requestId,planCode,cfg.pid,plan.points,plan.amount_usd_cents]);
   const [[row]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=?',[id]);order=row;
  }
  await c.commit();
 }catch(e){await c.rollback();throw e;}finally{c.release();}
 return continueOrder({userId,id:order.id},options);
}
export async function continueOrder({userId,id},options={}){
 const cfg=await resolvedConfig(options,true);let order=await load(id,userId);
 if(order.status==='PAID')return serialize(order);
 if(new Date(order.expires_at)<=new Date())throw fail('支付订单已过期；已转账请等待回调核实，不要重复转账。',409);
 if(order.payment_url)return {...await serialize(order),paymentUrl:paymentUrl(order.payment_url,order.trade_id)};
 if(order.merchant_pid!==cfg.pid)throw fail('支付商户已变更，请联系管理员核对原订单。',409);
 const c=await openDatabase();try{const [r]=await c.execute("UPDATE gmpay_payment_orders SET create_state='REQUESTED' WHERE id=? AND create_state='NEW' AND status='PENDING'",[id]);if(r.affectedRows!==1)throw fail('支付下单结果待核实，请查看原订单；不要重复转账。',409);}finally{c.release();}
 // v2 rejects duplicate order_id. Do not POST again after an uncertain response.
 try{
  const payload={pid:cfg.pid,order_id:id,currency:'usd',token:'usdt',network:'tron',amount:Number(order.amount_usd_cents)/100,notify_url:`${cfg.site}/api/payment/gmpay-notify`,redirect_url:`${cfg.site}/api/payment/gmpay-return`,name:`NodeMail ${order.points} 积分`};payload.signature=signature(payload,cfg.secret);
  const data=await gateway('/payments/gmpay/v1/order/create-transaction',{...options,payload});
  if(data.order_id!==id||!/^[\w-]{1,128}$/.test(data.trade_id)||String(data.currency).toUpperCase()!=='USD'||String(data.token).toUpperCase()!=='USDT'||units(data.amount,2)!==BigInt(order.amount_usd_cents)||units(data.actual_amount)<=0n||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(data.receive_address)||data.status!==1)throw fail();
  const url=paymentUrl(data.payment_url,data.trade_id),counter=await gateway(`/pay/checkout-counter-resp/${data.trade_id}`,options);
  assertCounter(counter,{...order,trade_id:data.trade_id,actual_amount:data.actual_amount,receive_address:data.receive_address});
  if(counter.status===2){const current=await load(id,userId);if(current.status==='PAID')return serialize(current);throw fail('支付网关已收款，尚待验签回调核实。',409);}
  if(counter.status!==1)throw fail();
  const expiresAt=checkoutExpiration(counter.expiration_time);
  const conn=await openDatabase();try{
   await conn.beginTransaction();const [[locked]]=await conn.execute('SELECT * FROM gmpay_payment_orders WHERE id=? FOR UPDATE',[id]);
   if(locked.trade_id&&(locked.trade_id!==data.trade_id||units(locked.actual_amount)!==units(data.actual_amount)||locked.receive_address!==data.receive_address))throw fail();
   // Preserve a callback which raced the create response, including its PAID state.
   await conn.execute("UPDATE gmpay_payment_orders SET trade_id=?,actual_amount=?,receive_address=?,payment_url=?,create_state='BOUND',expires_at=? WHERE id=?",[data.trade_id,String(data.actual_amount),data.receive_address,url,expiresAt,id]);await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  return serialize(await load(id,userId));
 }catch(e){const conn=await openDatabase();try{await conn.execute("UPDATE gmpay_payment_orders SET create_state='UNKNOWN' WHERE id=? AND create_state='REQUESTED' AND status='PENDING'",[id]);}finally{conn.release();}throw fail();}
}
export async function queryOrder({userId,id},options={}){
 if(!Number.isSafeInteger(userId)||userId<=0)throw fail('账户不存在。',403);
 const order=await load(id,userId);
 if(order.status==='PAID')return {id:order.id,status:'PAID'};
 // Never discover an unbound trade by client input or repeat an uncertain POST.
 if(order.create_state!=='BOUND'||!order.trade_id)return {id:order.id,status:order.status,message:'下单结果尚待核实，等待支付通知；不要重复转账。'};
 const counter=await gateway(`/pay/checkout-counter-resp/${order.trade_id}`,options);
 assertCounter(counter,order);
 if(counter.status===2)return settleBoundPayment(order.id,counter);
 const current=await load(id,userId);
 if(current.status==='PAID')return {id:current.id,status:'PAID'};
 return {id:order.id,status:current.status,canReplace:counter.status===3&&['PENDING','EXPIRED'].includes(current.status)&&new Date(current.expires_at)<=new Date(),message:counter.status===3?'网关付款时限已过；已转账可继续查询，请勿再次转账。':'网关尚未确认到账，请等待网络确认；不要重复转账。'};
}

// Both authenticated gateway reconciliation and signed callbacks use this same
// row-locked commit. v2's HTTPS counter omits the chain hash: retain NULL, never
// invent a hash. A later signed notice binds it under the existing UNIQUE index
// without issuing a second credit. The original create binding and unique trade
// ID are mandatory for the counter-only path.
async function settleBoundPayment(id,counter,{notification,cfg}={}){
 const c=await openDatabase();try{
  await c.beginTransaction();const [[order]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=? FOR UPDATE',[id]);
  if(!order)throw fail('支付订单不存在。',404);
  if(notification)assertNotification(notification,order,cfg);
  else if(order.create_state!=='BOUND'||!order.trade_id)throw fail('支付交易尚未绑定。',409);
  const bound=notification?{...order,trade_id:notification.trade_id,actual_amount:notification.actual_amount,receive_address:notification.receive_address}:order;
  assertCounter(counter,{...bound,block_transaction_id:notification?.block_transaction_id||order.block_transaction_id});if(counter.status!==2)throw fail('支付订单尚未确认到账。',409);
  const chain=notification?.block_transaction_id?.toLowerCase()||counter.block_transaction_id?.toLowerCase()||order.block_transaction_id||null;
  if(order.block_transaction_id&&chain!==order.block_transaction_id)throw fail('支付链上交易不匹配。',400);
  if(order.status==='PAID'){
   if(!order.block_transaction_id&&chain)await c.execute('UPDATE gmpay_payment_orders SET block_transaction_id=? WHERE id=?',[chain,id]);
  }else{
   const [[user]]=await c.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[order.user_id]);if(!user)throw fail();
   const after=Number(user.points_balance)+Number(order.points);if(!Number.isSafeInteger(after)||after<0)throw fail();
   await c.execute("UPDATE gmpay_payment_orders SET status='PAID',trade_id=?,actual_amount=?,receive_address=?,block_transaction_id=?,create_state='BOUND',paid_at=UTC_TIMESTAMP(3) WHERE id=?",[bound.trade_id,String(bound.actual_amount),bound.receive_address,chain,order.id]);
   await c.execute('UPDATE users SET points_balance=? WHERE id=?',[after,order.user_id]);
   await c.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note) VALUES (?,?,'RECHARGE',?,?,'GMPAY_ORDER',?,'USDT TRC20 充值')",[`PT-${randomUUID()}`,order.user_id,order.points,after,order.id]);
  }
  await c.commit();return {id:order.id,status:'PAID'};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function settleNotification(data,options={}){
 const cfg=await notificationConfig(data,options),initial=await load(data.order_id);assertNotification(data,initial,cfg);
 if(initial.create_state==='NEW')throw fail('支付订单尚未提交网关。',409);
 // A reconciled PAID row may still lack its chain hash. It must pass through
 // the transaction to attach the signed hash (including uniqueness checks).
 if(initial.status==='PAID'&&initial.block_transaction_id)return {id:initial.id,status:'PAID'};
 if(initial.status==='PAID')return settleBoundPayment(initial.id,{...initial,amount:Number(initial.amount_usd_cents)/100,currency:'USD',token:'USDT',network:'tron',status:2},{notification:data,cfg});
 // v2 JSON notifications have no network/currency. Independently read the fixed
 // gateway over verified HTTPS, then bind the signed notification to that target.
 const counter=await gateway(`/pay/checkout-counter-resp/${data.trade_id}`,options);
 const bound={...initial,trade_id:data.trade_id,actual_amount:data.actual_amount,receive_address:data.receive_address};
 assertCounter(counter,bound);if(counter.status!==2)throw fail('支付订单尚未确认到账。',409);
 return settleBoundPayment(initial.id,counter,{notification:data,cfg});
}
