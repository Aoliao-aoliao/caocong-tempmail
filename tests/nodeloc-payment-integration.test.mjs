import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
test('NodeLoc isolated payment lifecycle',{timeout:60000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const {saveConfig,readConfig,publicConfig}=await import('../server/payment/nodeloc-config.mjs');
 const {queryMemberHistoryPage}=await import('../server/member/history.mjs');
 const {getAdminData}=await import('../server/admin/read-model.mjs');
 const {signature,verified}=await import('../server/payment/nodeloc-protocol.mjs');
 const {createOrder,queryOrder,settlePayment,continueOrder,paymentView}=await import('../server/payment/nodeloc-service.mjs');
 const generate=()=>generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const merchant=generate(),platform=generate();const c=await openDatabase();const users=[],planCode=`NLTEST-${randomUUID()}`;
 const old=await readConfig(c);let orderId;const signed=p=>({...p,sign_type:'RSA',sign:signature(p,platform.privateKey)});
 try{
  for(let i=0;i<2;i++){const [r]=await c.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic',10)",[`U-${randomUUID()}`,`${randomUUID()}@example.test`]);users.push(r.insertId);}
  await c.execute('INSERT INTO recharge_plans(code,points,amount_usd_cents) VALUES (?,50,100)',[planCode]);
  const input={pid:'123',siteOrigin:'https://example.test',platformKey:platform.publicKey,privateKey:merchant.privateKey,prices:{[planCode]:25},enabled:true,unitRateConfirmed:true};
  await t.test('superadmin config helper encrypts secret and requires explicit rate',async()=>{
   await assert.rejects(saveConfig({...input,unitRateConfirmed:false},users[0]));
   const shown=await saveConfig(input,users[0]);assert.equal(shown.keyConfigured,true);assert.ok(!JSON.stringify(shown).includes('PRIVATE KEY'));assert.ok(!JSON.stringify(await readConfig(c)).includes(merchant.privateKey));
  });
  const request={userId:users[0],requestId:randomUUID(),planCode,expectedEnergy:25,expectedPoints:50};
  const fake={clientIp:'192.0.2.10',fetchImpl:async(url,options)=>{const p=Object.fromEntries(options.body);assert.ok(verified(p,merchant.publicKey));assert.equal(p.pid,'123');if(url.endsWith('/create')){assert.equal(p.method,'jump');assert.equal(p.clientip,'192.0.2.10');}const response=signed(url.endsWith('/create')?{code:0,trade_no:'N-test-1',pay_type:'jump',pay_info:'https://www.nodeloc.com/payment/pay/synthetic',out_trade_no:p.out_trade_no}:{code:0,trade_no:'N-test-1',out_trade_no:p.out_trade_no,money:'25.00',status:'1'});delete response.sign_type;return Response.json(response);}};
  await t.test('stale prices rejected, lost create response reuses same order and snapshots',async()=>{
   await assert.rejects(createOrder(request,{...fake,clientIp:'not-an-IP'}));await assert.rejects(createOrder({...request,expectedEnergy:1},fake));
   await assert.rejects(createOrder(request,{clientIp:'192.0.2.10',fetchImpl:async()=>{throw Error('timeout');}}));
   const [created]=await c.execute('SELECT * FROM nodeloc_payment_orders WHERE user_id=?',[users[0]]);assert.equal(created.length,1);orderId=created[0].id;
   const values=await Promise.all([createOrder(request,fake),createOrder(request,fake)]);assert.equal(values[0].id,orderId);assert.equal(values[1].id,orderId);
   await assert.rejects(continueOrder({userId:users[1],id:orderId},fake));
   assert.ok(!JSON.stringify(await paymentView(users[0])).includes('secret'));
  });
  await t.test('NodeLoc orders join member/admin history with energy currency and owner filtering',async()=>{
   const history=await queryMemberHistoryPage(c,{userId:users[0],section:'orders',query:orderId});
   assert.equal(history.items.length,1);assert.equal(history.items[0].order_type,'NODELOC');assert.equal(history.items[0].energy,25);assert.equal(history.items[0].amount_usd_cents,null);
   assert.equal((await queryMemberHistoryPage(c,{userId:users[1],section:'orders',query:orderId})).items.length,0);
   assert.ok((await getAdminData({section:'orders',query:'NodeLoc 能量'})).orders.some(o=>o.id===orderId));
   const admin=await getAdminData({section:'orders',query:orderId});assert.equal(admin.orders.length,1);assert.equal(admin.orders[0].energy,25);assert.equal(admin.orders[0].amount_usd_cents,null);
  });
  const callback={pid:'123',trade_no:'N-test-1',out_trade_no:orderId,money:'25.00',trade_status:'TRADE_SUCCESS'};
  await t.test('forged/underpaid notifications do not credit',async()=>{
   await assert.rejects(settlePayment({...signed(callback),money:'1.00'},{notification:true}));
   await assert.rejects(settlePayment(signed({...callback,money:'1.00'}),{notification:true}));
   assert.equal(Number((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[0]]))[0][0].points_balance),10);
  });
  await t.test('late callback/query races credit once after config disabled or rotated',async()=>{
   await saveConfig({...input,enabled:false,privateKey:'',platformKey:generate().publicKey,prices:{[planCode]:90}},users[0]);
   await c.execute('UPDATE nodeloc_payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[orderId]);
   await Promise.all([queryOrder({userId:users[0],id:orderId},fake),...Array.from({length:6},()=>settlePayment(signed(callback),{notification:true}))]);
   assert.equal(Number((await c.execute('SELECT points_balance FROM users WHERE id=?',[users[0]]))[0][0].points_balance),60);
   assert.equal((await queryMemberHistoryPage(c,{userId:users[0],section:'orders',query:orderId})).items[0].status,'PAID');
   assert.equal((await c.execute("SELECT * FROM point_transactions WHERE reference_type='NODELOC_ORDER' AND reference_id=?",[orderId]))[0].length,1);
  });
  await t.test('compact recent orders paginate five while complete history remains available',async()=>{
   for(let i=0;i<6;i++)await c.execute("INSERT INTO nodeloc_payment_orders(id,user_id,request_id,plan_code,points,energy,config_json,expires_at) SELECT ?,user_id,?,plan_code,points,energy,config_json,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) FROM nodeloc_payment_orders WHERE id=?",[`NL-${randomUUID()}`,randomUUID(),orderId]);
   const first=await paymentView(users[0],1),second=await paymentView(users[0],2);
   assert.equal(first.orders.length,5);assert.equal(first.hasNext,true);assert.equal(second.orders.length,2);assert.equal(second.hasNext,false);
   assert.equal(new Set([...first.orders,...second.orders].map(o=>o.id)).size,7);
   const all=await queryMemberHistoryPage(c,{userId:users[0],section:'orders',query:'NodeLoc'});assert.equal(all.pagination.total,7);
  });
 }finally{
  for(const id of users){await c.execute('DELETE FROM point_transactions WHERE user_id=?',[id]);await c.execute('DELETE FROM nodeloc_payment_orders WHERE user_id=?',[id]);await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);await c.execute('DELETE FROM users WHERE id=?',[id]);}
  await c.execute('DELETE FROM recharge_plans WHERE code=?',[planCode]);if(old)await c.execute('UPDATE nodeloc_payment_config SET config_json=? WHERE id=1',[JSON.stringify(old)]);else await c.execute('DELETE FROM nodeloc_payment_config WHERE id=1');c.release();await closeDatabasePool();
 }
});
