import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('renewal and per-mailbox inbox in isolated MySQL',{timeout:60000},async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {renewMailbox,getMailboxRenewByRequestId}=await import('../server/member/mailbox-renew.mjs');
  const {getMemberMessagePage,getMailboxInbox}=await import('../server/member/read-model.mjs');
  const {resolveMailboxRecallPlan}=await import('../server/member/mailbox-recall-policy.mjs');
  const {encryptRelayCredential}=await import('../server/security/secret-box.mjs');
  const {getMemberToolInbox,selectMemberInbox,rememberMemberInbox}=await import('../server/member/inbox-selection.mjs');
  const c=await openDatabase(),users=[],domains=[];let relayId;
  try {
    for(let i=0;i<2;i++){const [r]=await c.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic-unusable',10000)",[`U-${randomUUID()}`,`${randomUUID()}@example.test`]);users.push(r.insertId);}
    const [owner,other]=users;
    for(const kind of ['PUBLIC','RELAY','PRIVATE','MEMBER']){const [r]=await c.execute("INSERT INTO domains(domain,kind,owner_user_id,status,mx_status) VALUES (?,?,?,'ACTIVE','ACTIVE')",[`${randomUUID()}.example.test`,kind,kind==='PRIVATE'?other:null]);domains.push(r.insertId);}
    const secret=encryptRelayCredential('synthetic-never-connect');
    const [r]=await c.execute("INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases) VALUES (?,?,'example.test','127.0.0.1','synthetic',?,?,?,?,'ACTIVE',1)",[`RA-${randomUUID()}`,`${randomUUID()}@example.test`,secret.ciphertext,secret.kdfSalt,secret.iv,secret.authTag]);relayId=r.insertId;
    const makeBox=async(userId=owner,domainId=domains[0],account=null)=>{
      const id=`MB-${randomUUID()}`,address=`${randomUUID()}@example.test`;
      const [r]=await c.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,relay_account_id,address,status,duration_minutes,expires_at) VALUES (?,?,?,?,?,'ACTIVE',60,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[id,userId,domainId,account,address]);
      return {id,pk:r.insertId,address};
    };
    const box=await makeBox(),second=await makeBox(),foreign=await makeBox(other),relay=await makeBox(owner,domains[1],relayId);
    const [[settings]]=await c.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
    const plan=resolveMailboxRecallPlan({rawPlans:settings.value,durationHours:24});
    const args=(b=box)=>({userId:owner,mailboxId:b.id,durationHours:24,expectedPrice:plan.price,requestId:randomUUID(),captchaVerified:true});
    const snapshot=async b=>(await c.execute('SELECT expires_at,duration_minutes FROM mailboxes WHERE id=?',[b.pk]))[0][0];
    const balance=async()=>Number((await c.execute('SELECT points_balance FROM users WHERE id=?',[owner]))[0][0].points_balance);
    const addMail=async b=>{const [r]=await c.execute("INSERT INTO messages(public_id,mailbox_id,from_address,subject,text_content,size_bytes,risk_status,received_at) VALUES (?,?,'sender@example.test','synthetic','KEEP_BODY',9,'SAFE',UTC_TIMESTAMP(3))",[`MSG-${randomUUID()}`,b.pk]);return r.insertId;};
    const messageId=await addMail(box);await addMail(second);await addMail(foreign);const relayMessage=await addMail(relay);
    await c.execute("INSERT INTO relay_message_links(relay_account_id,uid_validity,imap_uid,mailbox_id) VALUES (?,1,1,?)",[relayId,relay.pk]);
    await c.execute("INSERT INTO message_attachments(message_id,file_name,content_type,size_bytes,storage_key) VALUES (?,'synthetic.txt','text/plain',4,'synthetic-reader-fixture')",[messageId]);
    await t.test('entry routes select the exact owned mailbox and keep ordinary/relay preferences separate',async()=>{
      const jar=new Map();
      const context={url:new URL('https://example.test/user/mailbox.cgi'),cookies:{get:name=>jar.get(name),set:(name,value,options)=>jar.set(name,{value,options})}};
      assert.equal((await getMemberToolInbox(context,owner,'ordinary')).mailbox.id,second.id);
      assert.equal((await getMemberToolInbox(context,owner,'relay')).mailbox.id,relay.id);
      assert.equal(await selectMemberInbox(context,owner,box.id),'/tools/mail.cgi');
      assert.equal(await selectMemberInbox(context,owner,relay.id),'/tools/real_mail.cgi');
      assert.equal((await getMemberToolInbox(context,owner,'ordinary')).mailbox.id,box.id);
      assert.equal((await getMemberToolInbox(context,owner,'relay')).mailbox.id,relay.id);
      for(const value of jar.values()){assert.equal(value.options.httpOnly,true);assert.equal(value.options.secure,true);assert.equal(value.options.sameSite,'lax');}
      assert.equal((await getMailboxInbox({userId:owner,mailboxId:box.id})).messages[0].recipient,box.address);
      await assert.rejects(selectMemberInbox(context,owner,foreign.id),e=>e.status===404);
      await assert.rejects(selectMemberInbox(context,owner,''),e=>e.status===400);
      await assert.rejects(getMailboxInbox({userId:owner,mailboxId:relay.id,kind:'ordinary'}),e=>e.status===404);
      await assert.rejects(getMailboxInbox({userId:owner,mailboxId:box.id,kind:'relay'}),e=>e.status===404);
      assert.equal((await getMemberToolInbox(context,other,'ordinary')).mailbox.id,foreign.id,'another login ignores previous account preference');
      rememberMemberInbox(context,owner,'ordinary',foreign.id);
      await assert.rejects(getMemberToolInbox(context,owner,'ordinary'),e=>e.status===404,'forged preference is not authorization');
      rememberMemberInbox(context,owner,'ordinary',box.id);
      await c.execute("UPDATE mailboxes SET status='PAUSED' WHERE id=?",[box.pk]);
      await assert.rejects(getMemberToolInbox(context,owner,'ordinary'),e=>e.status===404,'stale selection must not fall back to newer mailbox');
      await c.execute("UPDATE mailboxes SET status='ACTIVE' WHERE id=?",[box.pk]);
      // A successful creation/replay selects the new box through the same helper.
      rememberMemberInbox(context,owner,'ordinary',second.id);
      assert.equal((await getMemberToolInbox(context,owner,'ordinary')).mailbox.id,second.id);
    });
    await t.test('parallel replay extends once from old expiry, charges once and preserves mail',async()=>{
      const before=await snapshot(box),points=await balance(),input=args();
      const results=await Promise.all([renewMailbox(input),renewMailbox(input)]);
      assert.deepEqual(results[0],results[1]);
      assert.equal((await snapshot(box)).expires_at.getTime(),before.expires_at.getTime()+86400000);
      assert.equal(await balance(),points-plan.price);
      assert.equal((await c.execute('SELECT text_content FROM messages WHERE id=?',[messageId]))[0][0].text_content,'KEEP_BODY');
      assert.equal((await c.execute('SELECT storage_key FROM message_attachments WHERE message_id=?',[messageId]))[0][0].storage_key,'synthetic-reader-fixture');
      assert.equal((await c.execute('SELECT COUNT(*) AS n FROM mailbox_recall_requests WHERE mailbox_id=?',[box.pk]))[0][0].n,0);
      assert.deepEqual(await getMailboxRenewByRequestId(input),results[0]);
      await assert.rejects(renewMailbox({...input,mailboxId:second.id}),/其他续期/);
      await assert.rejects(renewMailbox({...input,expectedPrice:plan.price+1}),/其他续期/);
    });
    await t.test('different concurrent requests both extend without lost time or balance',async()=>{
      const before=await snapshot(box),points=await balance();
      await Promise.all([renewMailbox(args()),renewMailbox(args())]);
      assert.equal((await snapshot(box)).expires_at.getTime(),before.expires_at.getTime()+2*86400000);assert.equal(await balance(),points-2*plan.price);
    });
    await t.test('membership discount and zero-price renewals use server pricing and durable replay',async()=>{
      const [[membershipPlan]]=await c.execute('SELECT id,mailbox_discount_percent FROM membership_plans WHERE enabled=1 LIMIT 1');
      const [membership]=await c.execute("INSERT INTO memberships(user_id,plan_id,status,starts_at,expires_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",[owner,membershipPlan.id]);
      try {
        const discounted=resolveMailboxRecallPlan({rawPlans:settings.value,durationHours:24,discountPercent:Number(membershipPlan.mailbox_discount_percent)});
        const before=await balance();await renewMailbox({...args(),expectedPrice:discounted.price});assert.equal(await balance(),before-discounted.price);
      } finally {await c.execute('DELETE FROM memberships WHERE id=?',[membership.insertId]);}
      const raw=typeof settings.value==='string'?JSON.parse(settings.value):settings.value;
      const free=raw.map(p=>Number(p.minutes)===1440?{...p,points:0}:p);
      try {
        await c.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[JSON.stringify(free)]);
        const input={...args(),expectedPrice:0},before=await snapshot(box),points=await balance();
        await renewMailbox(input);await renewMailbox(input);
        assert.equal(await balance(),points);assert.equal((await snapshot(box)).expires_at.getTime(),before.expires_at.getTime()+86400000);
      } finally {await c.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[settings.value]);}
    });
    await t.test('ownership, captcha, invalid plans and stale price reject without charge',async()=>{
      const points=await balance();
      await assert.rejects(renewMailbox(args(foreign)),e=>e.status===404);
      const [[captcha]]=await c.execute("SELECT value FROM system_settings WHERE `key`='captcha_before_mailbox_create'");
      try{
        await c.execute("UPDATE system_settings SET value='true' WHERE `key`='captcha_before_mailbox_create'");
        await assert.rejects(renewMailbox({...args(),captchaVerified:false}),e=>e.status===403);
        assert.equal(await balance(),points);
        // The admin switch governs renewal exactly like mailbox creation.
        await c.execute("UPDATE system_settings SET value='false' WHERE `key`='captcha_before_mailbox_create'");
        await renewMailbox({...args(second),captchaVerified:false});
      }finally{await c.execute("UPDATE system_settings SET value=? WHERE `key`='captcha_before_mailbox_create'",[captcha?.value??'false']);}
      const charged=await balance();
      for(const durationHours of [1,24.5,NaN,0])await assert.rejects(renewMailbox({...args(),durationHours}));
      await assert.rejects(renewMailbox({...args(),expectedPrice:plan.price+1}),/价格已更新/);
      assert.equal(await balance(),charged);
    });
    await t.test('disabled/expired mailboxes, domain failure, ownership and VIP fail closed',async()=>{
      const points=await balance();
      for(const status of ['PAUSED','DELETED','EXPIRED']){await c.execute('UPDATE mailboxes SET status=? WHERE id=?',[status,second.pk]);await assert.rejects(renewMailbox(args(second)),/有效期内/);}
      await c.execute("UPDATE mailboxes SET status='ACTIVE',expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[second.pk]);await assert.rejects(renewMailbox(args(second)),/有效期内/);
      await c.execute("UPDATE domains SET mx_status='MISMATCH' WHERE id=?",[domains[0]]);await assert.rejects(renewMailbox(args()),/域名当前不可用/);await c.execute("UPDATE domains SET mx_status='ACTIVE' WHERE id=?",[domains[0]]);
      await assert.rejects(renewMailbox(args(await makeBox(owner,domains[2]))),/域名当前不可用/);
      await assert.rejects(renewMailbox(args(await makeBox(owner,domains[3]))),/有效会员/);
      assert.equal(await balance(),points);
    });
    await t.test('relay renewal at capacity preserves activation and upstream linkage; disabled/overcapacity fails',async()=>{
      const input=args(relay);await renewMailbox(input);
      assert.equal((await c.execute('SELECT COUNT(*) AS n FROM relay_message_links WHERE mailbox_id=?',[relay.pk]))[0][0].n,1);
      assert.equal((await c.execute('SELECT COUNT(*) AS n FROM mailbox_recall_requests WHERE mailbox_id=?',[relay.pk]))[0][0].n,0);
      await c.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?",[relayId]);await assert.rejects(renewMailbox(args(relay)),/账号当前不可用/);
      await c.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[relayId]);await makeBox(other,domains[1],relayId);await assert.rejects(renewMailbox(args(relay)),/容量不足/);
    });
    await t.test('insufficient funds and overflowing lifetime leave state intact',async()=>{
      const before=await snapshot(box),points=await balance();await c.execute('UPDATE users SET points_balance=0 WHERE id=?',[owner]);await assert.rejects(renewMailbox(args()),/积分不足/);assert.deepEqual(await snapshot(box),before);await c.execute('UPDATE users SET points_balance=? WHERE id=?',[points,owner]);
      await c.execute('UPDATE mailboxes SET duration_minutes=4294967295 WHERE id=?',[box.pk]);await assert.rejects(renewMailbox(args()),/超出允许/);assert.equal(await balance(),points);await c.execute('UPDATE mailboxes SET duration_minutes=? WHERE id=?',[before.duration_minutes,box.pk]);
    });
    await t.test('selected inbox lists exactly that owned active mailbox; no fallback to other inboxes',async()=>{
      const result=await getMemberMessagePage({userId:owner,mailboxId:box.id});assert.equal(result.mailbox.id,box.id);assert.equal(result.messages.length,1);assert.equal(result.messages[0].recipient,box.address);
      assert.equal((await getMemberMessagePage({userId:owner,mailboxId:box.id,query:'no match'})).pagination.total,0);
      for(const mailboxId of [foreign.id,second.id,`MB-${randomUUID()}`])await assert.rejects(getMemberMessagePage({userId:owner,mailboxId}),e=>e.status===404);
      await assert.rejects(getMemberMessagePage({userId:owner,mailboxId:"' OR 1=1"}),e=>e.status===400);
    });
  }finally{
    try {
    for(const id of domains)await c.execute("UPDATE domains SET owner_user_id=NULL WHERE id=?",[id]);
    for(const id of users){await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);await c.execute('DELETE FROM point_transactions WHERE user_id=?',[id]);await c.execute('DELETE FROM mailboxes WHERE user_id=?',[id]);await c.execute('DELETE FROM users WHERE id=?',[id]);}
    if(relayId)await c.execute('DELETE FROM relay_accounts WHERE id=?',[relayId]);
    for(const id of domains)await c.execute('DELETE FROM domains WHERE id=?',[id]);
    } finally {c.release();await closeDatabasePool();}
  }
});
