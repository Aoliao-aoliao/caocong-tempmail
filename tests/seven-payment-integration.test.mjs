import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';

test('expired GMPay replacement with isolated MySQL and synthetic gateway',{timeout:60000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const {createOrder,queryOrder,settleNotification}=await import('../server/payment/gmpay-service.mjs');
 const {signature}=await import('../server/payment/gmpay-protocol.mjs');
 const c=await openDatabase(),users=[],trades=new Map(),planCode='REPLACE-'+randomUUID();let creates=0;
 const env={GMPAY_ENABLED:'true',GMPAY_PID:'synthetic',GMPAY_SECRET_KEY:'synthetic-only-replacement-key',GMPAY_SITE_ORIGIN:'https://fixture.example.test'},address='T'+'A'.repeat(33);
 const fake={env,fetchImpl:async(url,options)=>{
  if(url.endsWith('/create-transaction')){
   creates++;const p=JSON.parse(options.body),trade_id='fake_'+randomBytes(12).toString('hex');
   const data={order_id:p.order_id,trade_id,currency:'USD',token:'USDT',network:'tron',amount:1.23,actual_amount:1.234567,receive_address:address,status:1,expiration_time:Date.now()+600000,payment_url:'https://pay.example.test/pay/checkout-counter/'+trade_id};
   trades.set(trade_id,data);return Response.json({status_code:200,data});
  }
  assert.match(url,/^https:\/\/pay\.example\.test\/pay\/checkout-counter-resp\/fake_[a-f0-9]{24}$/);
  const data=trades.get(url.split('/').at(-1));assert.ok(data);return Response.json({status_code:200,data});
 }};
 const input=userId=>({userId,requestId:randomUUID(),planCode,expectedPoints:50,expectedAmountUsdCents:123});
 const row=async id=>(await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=?',[id]))[0][0];
 const count=async userId=>(await c.execute('SELECT COUNT(*) n FROM gmpay_payment_orders WHERE user_id=?',[userId]))[0][0].n;
 async function fixture(){
  const [u]=await c.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic',0)",['U-'+randomUUID(),randomUUID()+'@example.test']);users.push(u.insertId);
  const created=await createOrder(input(u.insertId),fake),original=await row(created.id);
  await c.execute('UPDATE gmpay_payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[original.id]);
  trades.get(original.trade_id).status=3;
  return {userId:u.insertId,original,request:{...input(u.insertId),replacesOrderId:original.id}};
 }
 function notification(o){const data={pid:env.GMPAY_PID,order_id:o.id,trade_id:o.trade_id,amount:1.23,actual_amount:1.234567,receive_address:address,token:'USDT',status:2,block_transaction_id:randomBytes(32).toString('hex')};return {...data,signature:signature(data,env.GMPAY_SECRET_KEY)};}
 try{
  await c.execute('INSERT INTO recharge_plans(code,points,amount_usd_cents) VALUES (?,50,123)',[planCode]);
  await t.test('expired BOUND can be replaced concurrently with one new request and old row retained',async()=>{
   const f=await fixture(),before=creates;
   const results=await Promise.allSettled([createOrder(f.request,fake),createOrder(f.request,fake)]);
   const success=results.find(r=>r.status==='fulfilled');assert.ok(success);for(const r of results)if(r.status==='rejected')assert.equal(r.reason.status,409);
   const fresh=await createOrder(f.request,fake);assert.equal(fresh.id,success.value.id);assert.notEqual(fresh.id,f.original.id);assert.equal(creates,before+1);assert.equal(await count(f.userId),2);
   assert.equal((await row(f.original.id)).status,'PENDING');
  });
  await t.test('local expiry alone, UNKNOWN and gateway failure never authorize a replacement',async()=>{
   const f=await fixture(),before=creates;
   trades.get(f.original.trade_id).status=1;await assert.rejects(createOrder(f.request,fake),e=>e.status===409);
   trades.get(f.original.trade_id).status=3;await assert.rejects(createOrder(f.request,{env,fetchImpl:async()=>{throw Error('synthetic timeout');}}));
   await c.execute("UPDATE gmpay_payment_orders SET create_state='UNKNOWN',trade_id=NULL WHERE id=?",[f.original.id]);
   await assert.rejects(createOrder(f.request,fake),e=>e.status===409);assert.equal(creates,before);assert.equal(await count(f.userId),1);
  });
  await t.test('ownership and plan checks happen before replacement; unexpired bound order is rejected',async()=>{
   const f=await fixture(),other=await fixture(),before=creates;
   await assert.rejects(createOrder({...f.request,userId:other.userId},fake),e=>e.status===404);
   await assert.rejects(createOrder({...f.request,expectedPoints:51},fake),e=>e.status===409);
   await c.execute('UPDATE gmpay_payment_orders SET expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[f.original.id]);
   await assert.rejects(createOrder(f.request,fake),e=>e.status===409);assert.equal(creates,before);
  });
  await t.test('gateway PAID or a callback racing expired query prevents creation',async()=>{
   for(const race of [false,true]){
    const f=await fixture(),before=creates;let triggered=false;
    if(!race)trades.get(f.original.trade_id).status=2;
    const options=race?{env,fetchImpl:async(url,o)=>{
     if(!triggered&&url.endsWith('/'+f.original.trade_id)){
      triggered=true;const stale={...trades.get(f.original.trade_id)};trades.get(f.original.trade_id).status=2;
      await settleNotification(notification(f.original),fake);return Response.json({status_code:200,data:stale});
     }
     return fake.fetchImpl(url,o);
    }}:fake;
    assert.equal((await createOrder(f.request,options)).status,'PAID');assert.equal(creates,before);assert.equal(await count(f.userId),1);
   }
  });
  await t.test('late original callback credits once; retry still opens the already-created replacement',async()=>{
   const f=await fixture(),fresh=await createOrder(f.request,fake),before=creates;
   trades.get(f.original.trade_id).status=2;const notice=notification(f.original);
   await Promise.all([settleNotification(notice,fake),queryOrder({userId:f.userId,id:f.original.id},fake)]);
   await settleNotification(notice,fake);
   assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[f.userId]))[0][0].points_balance,50);
   assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[f.original.id]))[0][0].n,1);
   assert.equal((await createOrder(f.request,fake)).id,fresh.id);assert.equal(creates,before);assert.equal(await count(f.userId),2);
  });
  await t.test('lost replacement create response never sends a second upstream POST',async()=>{
   const f=await fixture(),before=creates;
   await assert.rejects(createOrder(f.request,{env,fetchImpl:async(url,o)=>{const response=await fake.fetchImpl(url,o);if(url.endsWith('/create-transaction'))throw Error('lost response');return response;}}));
   const [[unknown]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE user_id=? AND request_id=?',[f.userId,f.request.requestId]);
   assert.equal(unknown.create_state,'UNKNOWN');assert.equal(unknown.trade_id,null);
   await assert.rejects(createOrder(f.request,fake),e=>e.status===409);assert.equal(creates,before+1);assert.equal(await count(f.userId),2);
  });
  await t.test('in-flight retry prefers an already-created replacement when old payment arrives',async()=>{
   const f=await fixture();let started,release;
   const inGateway=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});let held=false;
   const retry=createOrder(f.request,{env,fetchImpl:async(url,o)=>{
    if(!held&&url.endsWith('/'+f.original.trade_id)){held=true;const stale={...trades.get(f.original.trade_id)};started();await gate;return Response.json({status_code:200,data:stale});}
    return fake.fetchImpl(url,o);
   }});
   await inGateway;
   try{
    const fresh=await createOrder(f.request,fake);trades.get(f.original.trade_id).status=2;await settleNotification(notification(f.original),fake);
    release();assert.equal((await retry).id,fresh.id);assert.equal(await count(f.userId),2);
   }finally{release();await retry.catch(()=>{});}
  });
 }finally{
  for(const user of users){await c.execute('DELETE FROM point_transactions WHERE user_id=?',[user]);await c.execute('DELETE FROM gmpay_payment_orders WHERE user_id=?',[user]);await c.execute('DELETE FROM users WHERE id=?',[user]);}
  await c.execute('DELETE FROM recharge_plans WHERE code=?',[planCode]);c.release();await closeDatabasePool();
 }
});
