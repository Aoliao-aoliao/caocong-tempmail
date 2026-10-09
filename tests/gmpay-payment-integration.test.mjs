import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
test('GMPay isolated payment lifecycle',{timeout:60000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const {createOrder,continueOrder,queryOrder,settleNotification}=await import('../server/payment/gmpay-service.mjs');
 const {signature,verified}=await import('../server/payment/gmpay-protocol.mjs');
 const {queryMemberHistoryPage}=await import('../server/member/history.mjs');const {getAdminData}=await import('../server/admin/read-model.mjs');
 const c=await openDatabase(),users=[],planCode=`GPTEST-${randomUUID()}`,env={GMPAY_ENABLED:'true',GMPAY_PID:'synthetic',GMPAY_SECRET_KEY:'synthetic-key-not-a-secret',GMPAY_SITE_ORIGIN:'https://example.test'},address='T'+'A'.repeat(33),trades=new Map();let creates=0,serial=0;
 const fake={env,fetchImpl:async(url,options)=>{
  if(url.endsWith('/create-transaction')){const p=JSON.parse(options.body);assert.ok(verified(p,env.GMPAY_SECRET_KEY));assert.equal(p.currency,'usd');assert.equal(p.token,'usdt');assert.equal(p.network,'tron');assert.ok(p.order_id.length<=32);assert.equal(p.notify_url,`${env.GMPAY_SITE_ORIGIN}/api/payment/gmpay-notify`);assert.equal(options.redirect,'error');creates++;
   const trade=`trade_${++serial}`,data={trade_id:trade,order_id:p.order_id,amount:p.amount,currency:'USD',token:'USDT',network:'tron',actual_amount:1.234567,receive_address:address,status:1,expiration_time:Math.floor(Date.now()/1000)+600,payment_url:`https://pay.example.test/pay/checkout-counter/${trade}`};trades.set(trade,data);return Response.json({status_code:200,data});
  }
  const data=trades.get(url.split('/').at(-1));assert.ok(data);return Response.json({status_code:200,data:{...data,expiration_time:data.expiration_time*1000,created_at:Date.now(),server_time:Date.now()}});
 }};
 const request=userId=>({userId,requestId:randomUUID(),planCode,expectedAmountUsdCents:123,expectedPoints:50});
 const notify=(o,hash='a'.repeat(64))=>{const data={pid:env.GMPAY_PID,trade_id:o.trade_id,order_id:o.id,amount:1.23,actual_amount:Number(o.actual_amount),receive_address:o.receive_address,token:'USDT',block_transaction_id:hash,status:2};return {...data,signature:signature(data,env.GMPAY_SECRET_KEY)};};
 const row=async id=>(await c.execute('SELECT * FROM gmpay_payment_orders WHERE id=?',[id]))[0][0];
 let first;
 try{
  for(let i=0;i<2;i++){const [r]=await c.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic',10)",[`U-${randomUUID()}`,`${randomUUID()}@example.test`]);users.push(r.insertId);}
  await c.execute('INSERT INTO recharge_plans(code,points,amount_usd_cents) VALUES (?,50,123)',[planCode]);
  await t.test('create snapshots price, reuses request, isolates users and does not expose credentials',async()=>{
   const input=request(users[0]);await assert.rejects(createOrder({...input,expectedPoints:999},fake));first=await createOrder(input,fake);assert.match(first.id,/^GP-[a-f0-9]{28}$/);assert.equal(first.points,50);assert.equal(new Date(first.expiresAt).getTime(),trades.get((await row(first.id)).trade_id).expiration_time*1000);assert.equal(first.createState,'BOUND');assert.equal(first.status,'PENDING');assert.equal(first.receiveAddress,address);assert.match(first.qrCodeDataUrl,/^data:image\/png;base64,/);
   assert.equal((await createOrder(input,fake)).id,first.id);assert.equal(creates,1);await assert.rejects(continueOrder({userId:users[1],id:first.id},fake));await assert.rejects(queryOrder({userId:users[1],id:first.id}));assert.ok(!JSON.stringify(first).includes(env.GMPAY_SECRET_KEY));
  });
  await t.test('untrusted client status and unsigned callbacks cannot credit an order',async()=>{
   const o=await row(first.id);assert.equal((await queryOrder({userId:users[0],id:first.id,status:'PAID'},fake)).status,'PENDING');assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[0]]))[0][0].points_balance,10);trades.get(o.trade_id).status=2;
   const {updateRechargeOrder}=await import('../server/admin/commerce.mjs');await assert.rejects(updateRechargeOrder({publicId:o.id,status:'PAID',actorUserId:users[0]}));
   const data=notify(o);await assert.rejects(settleNotification({...data,signature:'0'.repeat(64)},fake));
  });
  await t.test('currency/network and binding failures reject even valid signed notices',async()=>{
   const o=await row(first.id),data=notify(o),counter=trades.get(o.trade_id);counter.network='ethereum';await assert.rejects(settleNotification(data,fake));counter.network='tron';counter.currency='CNY';await assert.rejects(settleNotification(data,fake));counter.currency='USD';
   for(const change of [{amount:1.22},{token:'TRX'},{actual_amount:1.23},{pid:'other'}]){const p={...data,...change};p.signature=signature(p,env.GMPAY_SECRET_KEY);await assert.rejects(settleNotification(p,fake));}
  });
  await t.test('duplicate/concurrent callbacks credit once using original plan snapshot even while disabled',async()=>{
   await c.execute('UPDATE recharge_plans SET points=999,amount_usd_cents=999 WHERE code=?',[planCode]);const o=await row(first.id),data=notify(o),disabled={...fake,env:{...env,GMPAY_ENABLED:'false'}};
   await Promise.all([settleNotification(data,disabled),settleNotification(data,disabled),settleNotification(data,disabled)]);assert.equal((await row(first.id)).status,'PAID');assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[0]]))[0][0].points_balance,60);assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[first.id]))[0][0].n,1);
   await settleNotification(data,{...fake,fetchImpl:async()=>{throw Error('gateway down');}}); // Already committed duplicate acknowledgement needs no remote read.
   await c.execute('UPDATE recharge_plans SET points=50,amount_usd_cents=123 WHERE code=?',[planCode]);
  });
  await t.test('member/admin unified history includes precise USDT and retains ownership isolation',async()=>{
   const member=await queryMemberHistoryPage(c,{userId:users[0],section:'orders',query:first.id});assert.equal(member.items[0].order_type,'GMPAY');assert.equal(String(member.items[0].actual_amount),'1.234567');assert.equal(member.items[0].status,'PAID');assert.equal((await queryMemberHistoryPage(c,{userId:users[1],section:'orders',query:first.id})).items.length,0);
   const admin=await getAdminData({section:'orders',query:first.id});assert.equal(admin.orders[0].order_type,'GMPAY');assert.equal(String(admin.orders[0].actual_amount),'1.234567');
  });
  await t.test('lost create response never repeats upstream POST and later signed callback recovers',async()=>{
   const input=request(users[0]),before=creates;
   await assert.rejects(createOrder(input,{...fake,fetchImpl:async(u,o)=>{const r=await fake.fetchImpl(u,o);if(u.endsWith('create-transaction'))throw Error('lost response');return r;}}));
   await assert.rejects(createOrder(input,fake));assert.equal(creates,before+1);const [[order]]=await c.execute('SELECT * FROM gmpay_payment_orders WHERE request_id=?',[input.requestId]);assert.equal(order.create_state,'UNKNOWN');assert.equal(order.trade_id,null);
   const counter=[...trades.values()].find(x=>x.order_id===order.id);counter.status=2;const data=notify({...order,trade_id:counter.trade_id,actual_amount:counter.actual_amount,receive_address:counter.receive_address},'b'.repeat(64));await settleNotification(data,fake);assert.equal((await row(order.id)).status,'PAID');
  });
  await t.test('one chain transaction cannot fund two orders and failure rolls back balance',async()=>{
   const result=await createOrder(request(users[1]),fake),o=await row(result.id);trades.get(o.trade_id).status=2;await assert.rejects(settleNotification(notify(o),fake));assert.equal((await row(o.id)).status,'PENDING');assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance,10);
  });
  await t.test('pending cap and expiry are enforced but a valid late signed payment is honored once',async()=>{
   const pending=[];for(let i=0;i<3;i++)pending.push(await createOrder(request(users[0]),fake));await assert.rejects(createOrder(request(users[0]),fake));const o=await row(pending[0].id);await c.execute('UPDATE gmpay_payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[o.id]);await assert.rejects(continueOrder({userId:users[0],id:o.id},fake));trades.get(o.trade_id).status=2;await settleNotification(notify(o,'c'.repeat(64)),fake);assert.equal((await row(o.id)).status,'PAID');
  });
  await t.test('lost callback is reconciled over pinned HTTPS; later signed hash binds without another credit',async()=>{
   const result=await createOrder(request(users[1]),fake),o=await row(result.id),counter=trades.get(o.trade_id);
   const before=(await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance;
   counter.status=2;delete counter.order_id; // Real v2 counter omits order ID and chain hash.
   assert.equal((await queryOrder({userId:users[1],id:o.id},fake)).status,'PAID');
   assert.equal((await row(o.id)).block_transaction_id,null);
   await settleNotification(notify(o,'e'.repeat(64)),{...fake,fetchImpl:async()=>{throw Error('gateway down');}});
   await settleNotification(notify(o,'e'.repeat(64)),fake);
   assert.equal((await row(o.id)).block_transaction_id,'e'.repeat(64));
   assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance,before+50);
   assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[o.id]))[0][0].n,1);
   await assert.rejects(settleNotification(notify(o,'f'.repeat(64)),fake));
  });
  await t.test('reconciliation races callbacks and repeated queries but credits once',async()=>{
   const result=await createOrder(request(users[1]),fake),o=await row(result.id);trades.get(o.trade_id).status=2;
   const before=(await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance;
   await Promise.all([queryOrder({userId:users[1],id:o.id},fake),settleNotification(notify(o,'f'.repeat(64)),fake),queryOrder({userId:users[1],id:o.id},fake)]);
   assert.equal((await row(o.id)).block_transaction_id,'f'.repeat(64));
   assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance,before+50);
   assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[o.id]))[0][0].n,1);
  });
  await t.test('reconciliation rejects mismatches, other owners and preserves uncertain/unbound orders',async()=>{
   const result=await createOrder(request(users[1]),fake),o=await row(result.id),counter=trades.get(o.trade_id);counter.status=2;
   const before=(await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance;
   for(const change of [{order_id:'other'},{trade_id:'other'},{amount:1.22},{actual_amount:1.000001},{receive_address:'T'+'B'.repeat(33)},{currency:'CNY'},{token:'TRX'},{network:'ethereum'},{block_transaction_id:'bad'}]){
    await assert.rejects(queryOrder({userId:users[1],id:o.id},{...fake,fetchImpl:async()=>Response.json({status_code:200,data:{...counter,...change}})}));
   }
   let called=false;await assert.rejects(queryOrder({userId:users[0],id:o.id},{...fake,fetchImpl:async()=>{called=true;throw Error();}}),e=>e.status===404);assert.equal(called,false);
   await assert.rejects(queryOrder({userId:users[1],id:o.id},{...fake,fetchImpl:async()=>{throw Error('unavailable');}}));
   assert.equal((await row(o.id)).status,'PENDING');assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[1]]))[0][0].points_balance,before);
   await c.execute("UPDATE gmpay_payment_orders SET trade_id=NULL,create_state='UNKNOWN' WHERE id=?",[o.id]);
   assert.equal((await queryOrder({userId:users[1],id:o.id},{fetchImpl:async()=>{throw Error('must not call');}})).status,'PENDING');
   await c.execute('UPDATE gmpay_payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[o.id]);
  });
  await t.test('late hash attachment retains chain uniqueness without extra ledger credit',async()=>{
   const result=await createOrder(request(users[1]),fake),o=await row(result.id);trades.get(o.trade_id).status=2;
   await queryOrder({userId:users[1],id:o.id},fake);
   await assert.rejects(settleNotification(notify(o,'e'.repeat(64)),fake));
   assert.equal((await row(o.id)).block_transaction_id,null);
   assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[o.id]))[0][0].n,1);
  });
  await t.test('superadmin encrypted config, preserved old keys, read-model redaction and legacy rejection',async()=>{
   const {saveConfig,SETTING,publicConfig,notificationConfig}=await import('../server/payment/gmpay-config.mjs');
   const {getMemberData,getPublicToolData}=await import('../server/member/read-model.mjs');const {updateSystemSettings}=await import('../server/admin/mutations.mjs');const {createRechargeOrder}=await import('../server/member/mutations.mjs');
   await assert.rejects(saveConfig({pid:'newmerchant',secretKey:'synthetic-new-key-only',enabled:true},users[0]),e=>e.status===403);
   await c.execute("UPDATE users SET role='SUPER_ADMIN' WHERE id=?",[users[0]]);
   try{
    const saved=await saveConfig({pid:'newmerchant',secretKey:'synthetic-new-key-only',enabled:true},users[0]);assert.equal(saved.enabled,true);assert.equal(saved.canEdit,true);assert.ok(!JSON.stringify(saved).includes('synthetic-new-key-only'));
    const [[storage]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[SETTING]);assert.ok(!storage.value.includes('synthetic-new-key-only'));
    assert.equal((await publicConfig()).enabled,true);assert.ok(!JSON.stringify(await publicConfig()).includes('newmerchant'));
    for(const view of [await getMemberData(users[0]),await getPublicToolData(),await getAdminData({section:'settings'})])assert.ok(!Object.hasOwn(view.settings,SETTING));
    await assert.rejects(updateSystemSettings({values:{[SETTING]:'tampered'},actorUserId:users[0]}));
    await assert.rejects(createRechargeOrder({userId:users[0],planCode,channelCode:'USDT_TRC20'}),e=>e.status===409);
    await assert.rejects(saveConfig({pid:'changed',enabled:true},users[0]),/同时填写/);
    env.GMPAY_PID='newmerchant';env.GMPAY_SECRET_KEY='synthetic-new-key-only';env.GMPAY_SITE_ORIGIN='https://app.example.test';
    const liveOptions={fetchImpl:fake.fetchImpl};const oldOrder=await createOrder(request(users[1]),liveOptions);const oldRow=await row(oldOrder.id);trades.get(oldRow.trade_id).status=2;const data=notify(oldRow,'d'.repeat(64));
    await saveConfig({pid:'changed',secretKey:'synthetic-rotated-key-only',enabled:false},users[0]);assert.equal((await publicConfig()).enabled,false);assert.equal((await notificationConfig(data)).secret,'synthetic-new-key-only');
    await assert.rejects(notificationConfig({...data,signature:'0'.repeat(64)}));
    await saveConfig({pid:'changed',enabled:true},users[0]);assert.equal((await publicConfig()).enabled,true);
    assert.equal((await continueOrder({id:oldOrder.id,userId:users[1]},liveOptions)).paymentUrl,oldOrder.paymentUrl);
    await settleNotification(data,liveOptions);await settleNotification(data,liveOptions);assert.equal((await row(oldOrder.id)).status,'PAID');assert.equal((await c.execute('SELECT COUNT(*) n FROM point_transactions WHERE reference_id=?',[oldOrder.id]))[0][0].n,1);
   }finally{await c.execute('DELETE FROM system_settings WHERE `key`=?',[SETTING]);await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[users[0]]);}
  });
 }finally{
  for(const user of users){await c.execute('DELETE FROM point_transactions WHERE user_id=?',[user]);await c.execute('DELETE FROM gmpay_payment_orders WHERE user_id=?',[user]);await c.execute('DELETE FROM users WHERE id=?',[user]);}await c.execute('DELETE FROM recharge_plans WHERE code=?',[planCode]);c.release();await closeDatabasePool();
 }
});
