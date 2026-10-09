import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Explicit opt-in, loopback and disposable database guards BEFORE DB imports.
// Never invoke this against production or an existing user database.
test('review findings against disposable MySQL', {timeout:90000}, async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {registerUser}=await import('../server/auth/service.mjs');
  const {createRechargeOrder,createMailbox,purchaseMembership}=await import('../server/member/mutations.mjs');
  const {createMemberRelayMailbox}=await import('../server/relay/service.mjs');
  const {resolveApiRateLimit,ensureUserApiKey}=await import('../server/member/api-key.mjs');
  const {updateApiKey}=await import('../server/admin/mutations.mjs');
  const {recallMailbox}=await import('../server/member/mailbox-recall.mjs');
  const {getAdminData}=await import('../server/admin/read-model.mjs');
  const {getMemberMessagePage}=await import('../server/member/read-model.mjs');
  const {AttachmentStore}=await import('../server/mail/attachment-store.mjs');
  const {saveDelivery}=await import('../server/mail/repository.mjs');
  const connection=await openDatabase();
  const suffix=randomUUID();
  const root=await mkdtemp(join(tmpdir(),'nodemail-review-'));
  const originalStorage=process.env.MAIL_ATTACHMENT_DIR;
  process.env.MAIL_ATTACHMENT_DIR=root;
  const store=new AttachmentStore(root);await store.initialize();
  const users=[],domainNames=[],accounts=[];
  try {
    const owner=await registerUser({email:`review-${suffix}@example.com`,password:'isolated-test-password'});
    const other=await registerUser({email:`other-${suffix}@example.com`,password:'isolated-test-password'});
    users.push(owner.userId,other.userId);
    await connection.execute('UPDATE users SET points_balance=100000 WHERE id=?',[owner.userId]);
    const domain=`review-${suffix}.example.com`;domainNames.push(domain);
    const [domainResult]=await connection.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'PUBLIC','ACTIVE','ACTIVE')",[domain]);
    const {encryptRelayCredential}=await import('../server/security/secret-box.mjs');
    const encrypted=encryptRelayCredential('disposable-no-real-imap-credential');
    const [relay]=await connection.execute(`INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status)
      VALUES (?,?,?,?,?,?,?,?,?,'DISABLED')`,[`RA-${randomUUID()}`,`relay-${suffix}@example.com`,'example.com','imap.example.com','test-only',encrypted.ciphertext,encrypted.kdfSalt,encrypted.iv,encrypted.authTag]);
    accounts.push(relay.insertId);
    await connection.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[relay.insertId]);
    const mailbox=await createMailbox({userId:owner.userId,localPart:'owner',domain,durationMinutes:60});
    const [[box]]=await connection.execute('SELECT id FROM mailboxes WHERE public_id=?',[mailbox.id]);
    const otherMailbox=await createMailbox({userId:other.userId,localPart:'other',domain,durationMinutes:60});
    const [[otherBox]]=await connection.execute('SELECT id FROM mailboxes WHERE public_id=?',[otherMailbox.id]);
    const deliver=async(id,messageId,attachments=[])=>saveDelivery({recipients:[{id}],message:{messageId,fromAddress:'sender@example.com',subject:messageId,textContent:'synthetic',htmlContent:'',sizeBytes:10,riskStatus:'SAFE',receivedAt:new Date()},attachments,attachmentStore:store,mailboxQuota:{maxMessages:500,maxBytes:100000}});

    await t.test('disabled plans rejected for normal and relay purchase',async()=>{
      const [[previous]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
      try {
        await connection.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[JSON.stringify([{minutes:60,points:0,enabled:false}])]);
        await assert.rejects(createMailbox({userId:owner.userId,localPart:'disabled',domain,durationMinutes:60}),/已停用/);
        await assert.rejects(createMemberRelayMailbox({userId:owner.userId,suffix:'gmail.com',durationMinutes:60,requestId:randomUUID(),expectedPrice:0}),/已停用/);
      } finally {await connection.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[previous.value]);}
    });

    await t.test('unsupported manual channels cannot create orders, including concurrent bypass attempts',async()=>{
      const results=await Promise.allSettled(Array.from({length:6},()=>createRechargeOrder({userId:owner.userId,planCode:'POINTS_100',channelCode:'USD_ALIPAY'})));
      assert.equal(results.filter(result=>result.status==='fulfilled').length,0);
      assert.ok(results.every(result=>result.reason.status===409));
      const [[count]]=await connection.execute("SELECT COUNT(*) AS total FROM recharge_orders WHERE user_id=? AND status='PENDING'",[owner.userId]);
      assert.equal(Number(count.total),0);
    });

    await t.test('existing API key follows membership and preserves explicit admin limit',async()=>{
      const key=await ensureUserApiKey(owner.userId);
      assert.equal(key.rate_limit_per_minute,30);
      await purchaseMembership({userId:owner.userId,code:'VIP_30',requestId:randomUUID(),expectedPrice:Number((await connection.execute("SELECT price_points FROM membership_plans WHERE code='VIP_30'"))[0][0].price_points)});
      assert.equal(await resolveApiRateLimit(connection,{publicId:key.id,userId:owner.userId}),150);
      assert.equal((await ensureUserApiKey(owner.userId)).rate_limit_per_minute,150);
      // Status-only updates must not pin the current membership multiplier.
      await updateApiKey({publicId:key.id,status:'DISABLED',rateLimit:150,actorUserId:owner.userId});
      await connection.execute("UPDATE memberships SET status='EXPIRED' WHERE user_id=?",[owner.userId]);
      assert.equal(await resolveApiRateLimit(connection,{publicId:key.id,userId:owner.userId}),30);
      await updateApiKey({publicId:key.id,status:'ACTIVE',rateLimit:17,actorUserId:owner.userId});
      await purchaseMembership({userId:owner.userId,code:'VIP_30',requestId:randomUUID(),expectedPrice:Number((await connection.execute("SELECT price_points FROM membership_plans WHERE code='VIP_30'"))[0][0].price_points)});
      assert.equal(await resolveApiRateLimit(connection,{publicId:key.id,userId:owner.userId}),17);
    });

    await t.test('recall removes expired mail and attachments before reactivation; replay safe',async()=>{
      await deliver(box.id,'expired-attachment',[{filename:'synthetic.txt',contentType:'text/plain',size:4,content:Buffer.from('test')}]);
      const [[file]]=await connection.execute('SELECT ma.storage_key FROM message_attachments ma JOIN messages m ON m.id=ma.message_id WHERE m.mailbox_id=?',[box.id]);
      await access(join(root,file.storage_key));
      await deliver(otherBox.id,'shared-source-other');
      for(const id of [box.id,otherBox.id])await connection.execute('INSERT INTO relay_message_links(relay_account_id,uid_validity,imap_uid,mailbox_id) VALUES (?,1,10,?)',[relay.insertId,id]);
      await connection.execute('UPDATE mailboxes SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[box.id]);
      const params={userId:owner.userId,mailboxId:mailbox.id,durationHours:24,expectedPrice:2,requestId:randomUUID(),captchaVerified:true};
      await recallMailbox(params);
      const [[count]]=await connection.execute('SELECT COUNT(*) AS total FROM messages WHERE mailbox_id=?',[box.id]);
      assert.equal(Number(count.total),0);
      const [[jobs]]=await connection.execute('SELECT COUNT(*) AS total FROM relay_remote_cleanup_jobs WHERE relay_account_id=?',[relay.insertId]);
      assert.equal(Number(jobs.total),0,'shared upstream original must be protected while other recipient is active');
      const [[links]]=await connection.execute('SELECT COUNT(*) AS total FROM relay_message_links WHERE mailbox_id=?',[box.id]);
      assert.equal(Number(links.total),0);
      await assert.rejects(access(join(root,file.storage_key)));
      await deliver(box.id,'new-after-recall');
      await recallMailbox(params);
      const [[after]]=await connection.execute('SELECT COUNT(*) AS total FROM messages WHERE mailbox_id=?',[box.id]);
      assert.equal(Number(after.total),1,'idempotent replay must preserve newly received mail');
    });

    await t.test('relay delivery rolls back failed links and deduplicates completed UID',async()=>{
      const spare=await createMailbox({userId:owner.userId,localPart:'spare',domain,durationMinutes:60});
      const [[spareBox]]=await connection.execute('SELECT id FROM mailboxes WHERE public_id=?',[spare.id]);
      await connection.execute('UPDATE mailboxes SET relay_account_id=? WHERE id IN (?,?)',[relay.insertId,box.id,spareBox.id]);
      const params={message:{messageId:'synthetic-uid-20',fromAddress:'sender@example.com',subject:'relay-dedup',textContent:'test',htmlContent:'',sizeBytes:10,riskStatus:'SAFE',receivedAt:new Date()},attachments:[],attachmentStore:store,mailboxQuota:{maxMessages:1,maxBytes:10000},relaySource:{accountId:relay.insertId,uidValidity:1,uid:20}};
      await assert.rejects(saveDelivery({...params,recipients:[{id:box.id}]}),/quota/);
      const [[failed]]=await connection.execute('SELECT COUNT(*) AS total FROM relay_message_links WHERE relay_account_id=? AND imap_uid=20',[relay.insertId]);
      assert.equal(Number(failed.total),0);
      assert.equal((await saveDelivery({...params,recipients:[{id:spareBox.id}]})).inserted,1);
      assert.equal((await saveDelivery({...params,recipients:[{id:spareBox.id}]})).inserted,0);
      // Delete this test message so the following inbox boundary count is stable.
      await connection.execute('DELETE FROM mailboxes WHERE id=?',[spareBox.id]);
      await connection.execute('UPDATE mailboxes SET relay_account_id=NULL WHERE id=?',[box.id]);
    });

    await t.test('admin pages/search include records older than latest 200',async()=>{
      for(let i=0;i<205;i++) {
        const [result]=await connection.execute("INSERT INTO users(public_id,email,password_hash) VALUES (?,?,'test-only-unusable-hash')",[`U-${randomUUID()}`,`paging-${i}-${suffix}@example.com`]);
        users.push(result.insertId);
      }
      const data=await getAdminData({section:'users',page:11});
      assert.equal(data.pagination.users.pages>=11,true);
      assert.equal(data.users.some(user=>user.email===`review-${suffix}@example.com`),true);
      const search=await getAdminData({section:'users',query:`review-${suffix}@example.com`});
      assert.equal(search.pagination.users.total,1);
      for(const section of ['mailboxes','messages','domains','orders','transactions','apiKeys','audit']) {
        const page=await getAdminData({section,page:1});
        assert.equal(Array.isArray(page[section]),true);
        assert.equal(page.pagination[section].page,1);
      }
    });

    await t.test('member total inbox pages/search beyond 200 and excludes other owner',async()=>{
      await deliver(otherBox.id,'private-other-owner');
      for(let i=0;i<205;i++) await deliver(box.id,`synthetic-${i}`);
      const page=await getMemberMessagePage({userId:owner.userId,page:21});
      assert.equal(page.pagination.total,206);
      assert.equal(page.messages.some(message=>message.subject==='new-after-recall'),true);
      const old=await getMemberMessagePage({userId:owner.userId,query:'new-after-recall'});
      assert.equal(old.pagination.total,1);
      const hidden=await getMemberMessagePage({userId:owner.userId,query:'private-other-owner'});
      assert.equal(hidden.pagination.total,0);
    });
  } finally {
    // Remove only test-owned rows; never truncate shared tables.
    for(const id of users) {
      await connection.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);
      await connection.execute('DELETE FROM point_transactions WHERE user_id=? OR operator_user_id=?',[id,id]);
      await connection.execute('DELETE FROM recharge_orders WHERE user_id=?',[id]);
      await connection.execute('DELETE FROM users WHERE id=?',[id]);
    }
    for(const id of accounts)await connection.execute('DELETE FROM relay_accounts WHERE id=?',[id]);
    for(const domain of domainNames)await connection.execute('DELETE FROM domains WHERE domain=?',[domain]);
    connection.release();await closeDatabasePool();
    await rm(root,{recursive:true,force:true});
    if(originalStorage===undefined)delete process.env.MAIL_ATTACHMENT_DIR;else process.env.MAIL_ATTACHMENT_DIR=originalStorage;
  }
});
