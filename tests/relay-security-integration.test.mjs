import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('relay state and custom purchases against disposable MySQL', {timeout:60000}, async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {testRelayAccount,setRelayAccountStatus,createMemberRelayMailbox}=await import('../server/relay/service.mjs');
  const {updateState}=await import('../server/relay/poller.mjs');
  const connection=await openDatabase();
  const suffix=`relay-review-${randomUUID()}.example.com`,publicId=`RA-${randomUUID()}`;
  let accountId,userId,domainId,oldPlans;
  const fakeClient=(onConnect=async()=>{},mailbox={uidValidity:2,uidNext:101})=>({
    createClient:async()=>({mailbox,connect:onConnect,logout:async()=>{},getMailboxLock:async()=>({release(){}})}),
  });
  const row=async()=>{const [[value]]=await connection.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);return value;};
  const reset=async(status='ACTIVE',uid=50,validity=1)=>connection.execute('UPDATE relay_accounts SET status=?,last_uid=?,uid_validity=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[status,uid,validity,accountId]);
  try {
    const [account]=await connection.execute(`INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,last_uid,uid_validity)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',50,1)`,[publicId,`inbox@${suffix}`,suffix,'imap.example.com','synthetic-only',Buffer.from('synthetic-only'),Buffer.alloc(16),Buffer.alloc(12),Buffer.alloc(16)]);
    accountId=account.insertId;

    await t.test('successful/failed diagnostic preserves concurrent disable and original cursor',async()=>{
      for(const fail of [false,true]) {
        await reset();
        const checking=testRelayAccount({id:publicId},fakeClient(async()=>{
          await setRelayAccountStatus({id:publicId,status:'DISABLED'});
          if(fail)throw new Error('AUTH synthetic-test-password');
        }));
        if(fail)await assert.rejects(checking,error=>error.status===409&&!error.message.includes('synthetic-test-password'));
        else await checking;
        const after=await row();
        assert.equal(after.status,'DISABLED');
        assert.equal(Number(after.last_uid),50);
        assert.equal(Number(after.uid_validity),1);
      }
    });

    await t.test('repeated disable always advances revision even inside the same clock millisecond',async()=>{
      await reset('DISABLED');
      // A future fixture timestamp makes both updates use the +1ms branch,
      // independently of wall-clock scheduling. No process/system clock change.
      await connection.execute('UPDATE relay_accounts SET updated_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?',[accountId]);
      const before=await row();
      await setRelayAccountStatus({id:publicId,status:'DISABLED'});
      const first=await row();
      await setRelayAccountStatus({id:publicId,status:'DISABLED'});
      const second=await row();
      assert.equal(first.updated_at.getTime()-before.updated_at.getTime(),1);
      assert.equal(second.updated_at.getTime()-first.updated_at.getTime(),1);
    });

    await t.test('disable repeated during activation invalidates the old successful check',async()=>{
      await reset('DISABLED');
      await assert.rejects(testRelayAccount({id:publicId,activate:true},fakeClient(async()=>{
        await setRelayAccountStatus({id:publicId,status:'DISABLED'});
      })),error=>error.code==='RELAY_CHECK_STALE');
      const after=await row();
      assert.equal(after.status,'DISABLED');
      assert.equal(Number(after.last_uid),50);
      assert.equal(Number(after.uid_validity),1);
    });

    await t.test('activation initializes only new namespace and rejects stale poll checkpoints',async()=>{
      await reset();
      const before=await row();
      await testRelayAccount({id:publicId,activate:true},fakeClient());
      assert.equal(await updateState(accountId,{uid:51,uidValidity:1,expected:{uid:50,uidValidity:1,updatedAt:before.updated_at}}),false);
      let after=await row();
      assert.equal(Number(after.last_uid),100);
      assert.equal(Number(after.uid_validity),2);
      assert.equal(await updateState(accountId,{uid:101,uidValidity:2,retryError:'Synthetic retry',expected:{uid:100,uidValidity:2,updatedAt:after.updated_at}}),true);
      after=await row();
      assert.equal(after.status,'ERROR');
      assert.equal(Number(after.last_uid),101);
      assert.equal(after.last_error,'Synthetic retry');
      await reset('DISABLED',0,2);
      await testRelayAccount({id:publicId,activate:true},fakeClient());
      assert.equal(Number((await row()).last_uid),0);
    });

    await t.test('custom 120-minute relay purchase charges configured price once and respects disable',async()=>{
      const [[plans]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
      oldPlans=plans.value;
      await connection.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[JSON.stringify([{id:'two-hours',label:'2 hours',minutes:120,points:7,enabled:true}])]);
      const [user]=await connection.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic-unusable-hash',100)",[`U-${randomUUID()}`,`relay-owner-${randomUUID()}@example.com`]);
      userId=user.insertId;
      const [domain]=await connection.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'RELAY','ACTIVE','ACTIVE')",[suffix]);
      domainId=domain.insertId;
      await reset();
      const params={userId,suffix,durationMinutes:120,requestId:randomUUID(),expectedPrice:7};
      const mailbox=await createMemberRelayMailbox(params);
      assert.equal(mailbox.duration_minutes,120);
      assert.equal(mailbox.price,7);
      assert.equal(mailbox.pointsBalance,93);
      assert.equal((await createMemberRelayMailbox(params)).id,mailbox.id);
      const [[counts]]=await connection.execute("SELECT COUNT(*) AS total FROM point_transactions WHERE user_id=? AND type='MAILBOX_PURCHASE'",[userId]);
      assert.equal(Number(counts.total),1);
      await connection.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[JSON.stringify([{minutes:120,points:7,enabled:false}])]);
      await assert.rejects(createMemberRelayMailbox({...params,requestId:randomUUID()}),/已停用/);
    });
  } finally {
    if(oldPlans!==undefined)await connection.execute("UPDATE system_settings SET value=? WHERE `key`='mailbox_duration_plans'",[oldPlans]);
    if(userId) {
      await connection.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[userId]);
      await connection.execute('DELETE FROM point_transactions WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM mailboxes WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM users WHERE id=?',[userId]);
    }
    await connection.execute("DELETE FROM audit_logs WHERE entity_type='RELAY_ACCOUNT' AND entity_id=?",[publicId]);
    if(accountId)await connection.execute('DELETE FROM relay_accounts WHERE id=?',[accountId]);
    if(domainId)await connection.execute('DELETE FROM domains WHERE id=?',[domainId]);
    connection.release();
    await closeDatabasePool();
  }
});
