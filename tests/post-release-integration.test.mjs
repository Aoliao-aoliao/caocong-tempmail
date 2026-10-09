import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('post-release boundaries in isolated MySQL',{timeout:60000},async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {purchaseMembership}=await import('../server/member/mutations.mjs');
  const {getRelayMailboxByRequestId,createMemberRelayMailbox}=await import('../server/relay/service.mjs');
  const {getMailboxInbox}=await import('../server/member/read-model.mjs');
  const {renewMailbox,getMailboxRenewByRequestId}=await import('../server/member/mailbox-renew.mjs');
  const {getMemberHistoryPage}=await import('../server/member/history.mjs');
  const {getAdminData}=await import('../server/admin/read-model.mjs');
  const {saveDelivery}=await import('../server/mail/repository.mjs');
  const {encryptRelayCredential}=await import('../server/security/secret-box.mjs');
  const c=await openDatabase(),users=[],domains=[];let accountId,planId;
  const suffix=`${randomUUID()}.example.test`,planCode=`TEST_${randomUUID().slice(0,8)}`;
  try {
    for(let i=0;i<2;i++){const [r]=await c.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic',10000)",[`U-${randomUUID()}`,`${randomUUID()}@example.test`]);users.push(r.insertId);}
    const [userId,other]=users;
    const [plan]=await c.execute("INSERT INTO membership_plans(code,name,duration_days,price_points,mailbox_discount_percent) VALUES (?,'synthetic',30,100,100)",[planCode]);planId=plan.insertId;
    const balance=async()=>Number((await c.execute('SELECT points_balance FROM users WHERE id=?',[userId]))[0][0].points_balance);
    await t.test('membership rejects missing/stale quote and concurrent retries charge exactly once',async()=>{
      const input={userId,code:planCode,expectedPrice:100,requestId:randomUUID()};const before=await balance();
      await c.execute('UPDATE membership_plans SET price_points=200 WHERE id=?',[planId]);
      await assert.rejects(purchaseMembership(input),e=>e.status===409);
      await assert.rejects(purchaseMembership({...input,requestId:undefined}),e=>e.status===400);
      assert.equal(await balance(),before);
      const confirmed={...input,expectedPrice:200};const results=await Promise.all([purchaseMembership(confirmed),purchaseMembership(confirmed)]);
      assert.deepEqual(results[0],results[1]);assert.equal(await balance(),before-200);
      await assert.rejects(purchaseMembership({...confirmed,expectedPrice:201}),e=>e.status===409);
      await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[userId]);
      await Promise.all([purchaseMembership(confirmed),purchaseMembership(confirmed)]);
      assert.equal(await balance(),before-200,'audit deletion cannot repeat a charge');
      await c.execute('UPDATE membership_plans SET enabled=0 WHERE id=?',[planId]);
      await purchaseMembership(confirmed);assert.equal(await balance(),before-200,'lost response remains replayable even after plan is disabled');
      await purchaseMembership({...confirmed,userId:other}).then(()=>assert.fail('disabled plan'),()=>{});
      assert.equal(Number((await c.execute('SELECT COUNT(*) AS n FROM point_transactions WHERE user_id=? AND type=\'MEMBERSHIP_PURCHASE\'',[userId]))[0][0].n),1);
    });
    for(const kind of ['PUBLIC','RELAY']){const [r]=await c.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,?,'ACTIVE','ACTIVE')",[kind==='RELAY'?suffix:`${randomUUID()}.example.test`,kind]);domains.push(r.insertId);}
    const secret=encryptRelayCredential('synthetic-never-connect');
    const [ra]=await c.execute("INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases) VALUES (?,?,?,'127.0.0.1','synthetic',?,?,?,?,'ACTIVE',20)",[`RA-${randomUUID()}`,`base@${suffix}`,suffix,secret.ciphertext,secret.kdfSalt,secret.iv,secret.authTag]);accountId=ra.insertId;
    const request={userId,suffix,durationMinutes:60,expectedPrice:0,requestId:randomUUID()};
    const relay=await createMemberRelayMailbox(request);
    await t.test('relay request binds original parameters on both early and transactional replay',async()=>{
      for(const changed of [{durationMinutes:1440},{suffix:'other.example.test'},{expectedPrice:1}]){
        await assert.rejects(getRelayMailboxByRequestId({...request,...changed}),e=>e.status===409);
        await assert.rejects(createMemberRelayMailbox({...request,...changed}),e=>e.status===409);
      }
      await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[userId]);
      assert.equal((await getRelayMailboxByRequestId(request)).id,relay.id);
      await assert.rejects(createMemberRelayMailbox({...request,expectedPrice:1}),e=>e.status===409);
      await c.execute('UPDATE mailboxes SET duration_minutes=1500 WHERE public_id=?',[relay.id]);
      assert.equal((await getRelayMailboxByRequestId(request)).duration_minutes,1500,'renewal does not invalidate original receipt');
    });
    const ordinaryId=`MB-${randomUUID()}`;
    await c.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,address,duration_minutes,status,expires_at) VALUES (?,?,?, ?,60,'ACTIVE',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[ordinaryId,userId,domains[0],`${randomUUID()}@example.test`]);
    await t.test('receiving availability follows domain and relay status without removing old inbox',async()=>{
      for(const status of ['DISABLED','ACTIVE']){
        await c.execute('UPDATE domains SET status=? WHERE id=?',[status,domains[0]]);
        assert.equal((await getMailboxInbox({userId,mailboxId:ordinaryId})).mailbox.available,status==='ACTIVE');
        await c.execute('UPDATE relay_accounts SET status=? WHERE id=?',[status,accountId]);
        assert.equal((await getMailboxInbox({userId,mailboxId:relay.id})).mailbox.available,status==='ACTIVE');
      }
      await c.execute("UPDATE domains SET mx_status='MISMATCH' WHERE id=?",[domains[0]]);
      assert.equal((await getMailboxInbox({userId,mailboxId:ordinaryId})).mailbox.available,false);
      await c.execute("UPDATE domains SET mx_status='ACTIVE' WHERE id=?",[domains[0]]);
      await assert.rejects(getMailboxInbox({userId:other,mailboxId:ordinaryId}),e=>e.status===404);
    });
    await t.test('disabled account blocks in-flight relay delivery before attachment write',async()=>{
      const [[mb]]=await c.execute('SELECT id FROM mailboxes WHERE public_id=?',[relay.id]);
      await c.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?",[accountId]);
      await assert.rejects(saveDelivery({recipients:[{id:mb.id}],message:{messageId:randomUUID()},attachments:[],attachmentStore:{write:()=>assert.fail('must not write')},mailboxQuota:{maxMessages:500,maxBytes:100000},relaySource:{accountId,uidValidity:1,uid:1}}),e=>e.responseCode===451);
      assert.equal(Number((await c.execute('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?',[mb.id]))[0][0].n),0);
      await c.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[accountId]);
    });
    await t.test('renewal replay returns current balance and expiry after a later renewal',async()=>{
      const input={userId,mailboxId:ordinaryId,durationHours:24,expectedPrice:3,requestId:randomUUID(),captchaVerified:true};
      const first=await renewMailbox(input);const second=await renewMailbox({...input,requestId:randomUUID()});
      await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[userId]);
      await Promise.all([renewMailbox(input),renewMailbox(input)]);
      const replay=await getMailboxRenewByRequestId(input);assert.deepEqual(replay.mailbox,second.mailbox);assert.equal(replay.pointsBalance,second.pointsBalance);assert.notEqual(replay.mailbox.expires_at,first.mailbox.expires_at);
      const repeat=await renewMailbox(input);assert.equal(repeat.pointsBalance,second.pointsBalance);
    });
    await t.test('real SMTP closes oversized and unfinished DATA without storing it',async()=>{
      const {startSmtpServer}=await import('../server/mail/smtp-service.mjs');
      const {loadSmtpConfig}=await import('../server/mail/config.mjs');
      const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
      const {default:net}=await import('node:net');const {once}=await import('node:events');
      const storageRoot=await mkdtemp(join(tmpdir(),'nodemail-smtp-boundary-'));
      const [[box]]=await c.execute('SELECT mb.id,mb.address,d.domain FROM mailboxes mb JOIN domains d ON d.id=mb.domain_id WHERE mb.public_id=?',[ordinaryId]);
      const address=`boundary@${box.domain}`;await c.execute('UPDATE mailboxes SET address=? WHERE id=?',[address,box.id]);
      const service=await startSmtpServer({config:{...loadSmtpConfig({}),host:'127.0.0.1',port:0,storageRoot,maxMessageBytes:128,dataTimeoutMs:250,connectionLifetimeMs:3000}});
      try {
        for(const oversized of [true,false]){
          const socket=net.connect(service.server.server.address().port,'127.0.0.1');socket.on('error',()=>{});
          try{
            assert.match(String((await once(socket,'data'))[0]),/^220/);
            const send=async(line,code)=>{const data=once(socket,'data');socket.write(line+'\r\n');assert.match(String((await data)[0]),new RegExp('^'+code));};
            await send('EHLO example.test',250);await send('MAIL FROM:<sender@example.test>',250);await send(`RCPT TO:<${address}>`,250);await send('DATA',354);
            const closed=once(socket,'close');socket.write(oversized?'X'.repeat(256)+'\r\n':'From: sender@example.test\r\n');
            await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('SMTP DATA did not close')),1500);timer.unref();})]);
          }finally{socket.destroy();}
        }
        assert.equal(Number((await c.execute('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?',[box.id]))[0][0].n),0);
      }finally{await service.close();await rm(storageRoot,{recursive:true,force:true});}
    });
    await t.test('expired orders agree in user/admin lists and admin filters',async()=>{
      const order={id:`RO-${randomUUID()}`};
      await c.execute("INSERT INTO recharge_orders(public_id,user_id,recharge_plan_id,payment_channel_id,amount_usd_cents,points,status,expires_at) SELECT ?,?,p.id,ch.id,p.amount_usd_cents,p.points,'PENDING',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) FROM recharge_plans p JOIN payment_channels ch ON ch.code='USD_ALIPAY' WHERE p.code='POINTS_100'",[order.id,userId]);
      await c.execute('UPDATE recharge_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE public_id=?',[order.id]);
      const member=await getMemberHistoryPage({userId,section:'orders'});
      const admin=await getAdminData({section:'orders',query:order.id,status:'已过期'});
      assert.equal(member.items.find(x=>x.id===order.id).status,'EXPIRED');assert.equal(admin.orders.find(x=>x.id===order.id).status,'EXPIRED');
      assert.equal((await getAdminData({section:'orders',query:order.id,status:'待确认'})).orders.length,0);
    });
  }finally {
    try {
    for(const id of users)await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);
    for(const id of users){await c.execute('DELETE FROM point_transactions WHERE user_id=?',[id]);await c.execute('DELETE FROM recharge_orders WHERE user_id=?',[id]);await c.execute('DELETE FROM users WHERE id=?',[id]);}
    if(accountId)await c.execute('DELETE FROM relay_accounts WHERE id=?',[accountId]);
    for(const id of domains)await c.execute('DELETE FROM domains WHERE id=?',[id]);
    if(planId)await c.execute('DELETE FROM membership_plans WHERE id=?',[planId]);
    }finally{c.release();await closeDatabasePool();}
  }
});
