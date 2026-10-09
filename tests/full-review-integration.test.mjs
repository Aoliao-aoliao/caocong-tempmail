import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

test('review fixes against explicitly isolated MySQL', {timeout:90000}, async t => {
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {hashPassword}=await import('../server/auth/service.mjs');
  const {requestPasswordReset,confirmPasswordReset,waitForResetDeliveries}=await import('../server/auth/password-reset.mjs');
  const {ensureUserApiKey}=await import('../server/member/api-key.mjs');
  const {authenticateApiRequest}=await import('../server/openapi/service.mjs');
  const {runApiLogRetention}=await import('../server/openapi/log-retention.mjs');
  const {pollAccount,updateState}=await import('../server/relay/poller.mjs');
  const {inboxProgressKey,readInboxProgress}=await import('../server/relay/inbox-progress.mjs');
  const c=await openDatabase(),email=`review-${randomUUID()}@example.test`;
  let uid,accountId;
  const authenticate=key=>authenticateApiRequest(new Request('https://example.test/openapi/v1/mail/list.cgi',{headers:{apiKey:key}}));
  const issue=async()=>{
    let code;
    const challenge=await requestPasswordReset({email},{configReader:async()=>({enabled:true,secret:{}}),send:async mail=>{code=mail.code;}});
    await waitForResetDeliveries();return {...challenge,email,code,password:'new-synthetic-password'};
  };
  try {
    const [user]=await c.execute('INSERT INTO users(public_id,email,password_hash) VALUES (?,?,?)',['U-'+randomUUID(),email,hashPassword('original-synthetic-password')]);uid=user.insertId;
    const [[plan]]=await c.execute('SELECT id FROM membership_plans ORDER BY id LIMIT 1');
    await c.execute("INSERT INTO memberships(user_id,plan_id,starts_at,expires_at) VALUES (?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",[uid,plan.id]);
    await t.test('reset revokes active and legacy keys; wrong code does not revoke; replacement works',async()=>{
      const original=await ensureUserApiKey(uid),legacy=randomUUID();
      await c.execute('INSERT INTO api_keys(public_id,user_id,key_prefix,key_hash) VALUES (?,?,?,?)',['AK-'+randomUUID(),uid,'legacy',createHash('sha256').update(legacy).digest('hex')]);
      assert.equal((await authenticate(original.key)).user_id,uid);assert.equal((await authenticate(legacy)).user_id,uid);
      const reset=await issue();
      await assert.rejects(confirmPasswordReset({...reset,code:reset.code==='00000000'?'11111111':'00000000'}));
      assert.equal((await authenticate(original.key)).user_id,uid);
      await confirmPasswordReset(reset);
      for(const key of [original.key,legacy])await assert.rejects(authenticate(key),e=>e.status===401);
      const replacement=await ensureUserApiKey(uid);assert.notEqual(replacement.key,original.key);
      assert.equal((await authenticate(replacement.key)).user_id,uid);
    });
    await t.test('reset keeps admin disable; re-enabling cannot revive the old token',async()=>{
      const original=await ensureUserApiKey(uid);
      await c.execute("UPDATE api_keys SET status='DISABLED' WHERE public_id=?",[original.id]);
      await confirmPasswordReset(await issue());
      const disabled=await ensureUserApiKey(uid);
      assert.equal(disabled.id,original.id);assert.equal(disabled.status,'DISABLED');assert.equal(disabled.key,null);
      await assert.rejects(authenticate(original.key),e=>e.status===401);
      await c.execute("UPDATE api_keys SET status='ACTIVE' WHERE public_id=?",[original.id]);
      await assert.rejects(authenticate(original.key),e=>e.status===401);
      assert.equal((await authenticate((await ensureUserApiKey(uid)).key)).user_id,uid);
    });
    await t.test('API logs retain the exact 30-day boundary and delete at most 1000; business records stay intact',async()=>{
      // All effects are rolled back, including any diagnostics left by earlier
      // fixtures. A fixed connection clock makes the exact boundary repeatable.
      await c.beginTransaction();
      try {
        await c.query('SET timestamp=946684800');
        const [[key]]=await c.execute('SELECT id FROM api_keys WHERE user_id=? ORDER BY id DESC LIMIT 1',[uid]);
        const before={};for(const table of ['business_receipts','point_transactions','memberships','recharge_orders'])before[table]=(await c.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n;
        for(let i=0;i<1002;i++)await c.execute("INSERT INTO api_request_logs(api_key_id,user_id,method,path,status_code,created_at) VALUES (?,?,'GET','/synthetic-old',200,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 31 DAY))",[key.id,uid]);
        for(const days of [30,29])await c.execute("INSERT INTO api_request_logs(api_key_id,user_id,method,path,status_code,created_at) VALUES (?,?,'GET','/synthetic-retained',200,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY))",[key.id,uid,days]);
        const deps={openDatabase:async()=>({execute:(...args)=>c.execute(...args),release(){}})};
        assert.equal((await runApiLogRetention(deps)).deleted,1000);
        assert.equal((await runApiLogRetention(deps)).deleted,2);
        assert.equal((await runApiLogRetention(deps)).deleted,0);
        assert.equal(Number((await c.execute("SELECT COUNT(*) n FROM api_request_logs WHERE user_id=? AND path='/synthetic-retained'",[uid]))[0][0].n),2);
        for(const [table,count]of Object.entries(before))assert.equal((await c.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n,count);
      } finally {await c.rollback();await c.query('SET timestamp=0');}
    });
    const [account]=await c.execute(`INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,last_uid,uid_validity)
      VALUES (?,?,?,'127.0.0.1','synthetic',?,?,?,?,'ACTIVE',0,1)`,['RA-'+randomUUID(),email,'example.test',Buffer.from('synthetic'),Buffer.alloc(16),Buffer.alloc(12),Buffer.alloc(16)]);
    accountId=account.insertId;
    const row=async()=>(await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]))[0][0];
    const expected=a=>({uid:Number(a.last_uid),uidValidity:Number(a.uid_validity),updatedAt:a.updated_at});
    await t.test('successful UIDs persist in SQL across fresh poll calls and clear after retry succeeds',async()=>{
      let fail=true;const downloads=[];
      const raw=Buffer.from('To: alias@example.test\r\n\r\nsynthetic');
      const deps={aliasesFor:async()=>[{id:1,address:'alias@example.test',activated_at:'2020-01-01'}],saveDelivery:async({relaySource})=>{if(fail&&relaySource.uid===1)throw Error('synthetic quota');}};
      const run=async()=>pollAccount(await row(),{config:{maxMessageBytes:10000,maxAttachments:5,maxAttachmentBytes:1000},attachmentStore:{},dependencies:{...deps,client:{
        mailbox:{uidValidity:1},async connect(){},async logout(){},async getMailboxLock(){return {release(){}};},async search(){return [1,2];},
        async *fetch(uids,query){if(query.source)downloads.push([...uids]);for(const uid of uids)yield query.source?{uid,source:raw,internalDate:new Date()}:{uid,size:raw.length};},
      }}});
      await run();await run();assert.deepEqual(downloads,[[1,2],[1]]);
      assert.deepEqual(await readInboxProgress(await row(),1),[[2,2]]);
      fail=false;await run();assert.deepEqual(downloads,[[1,2],[1],[1]]);
      assert.equal(Number((await row()).last_uid),2);assert.deepEqual(await readInboxProgress(await row(),1),[]);
    });
    await t.test('checkpoint writes are atomic, guarded against stale/disabled accounts and UID namespaces',async()=>{
      const before=await row();
      assert.equal(await updateState(accountId,{uid:2,uidValidity:1,expected:expected(before),completedRanges:[[4,4]]}),true);
      const fresh=await row();
      const {getAdminData}=await import('../server/admin/read-model.mjs');
      const {getMemberData,getPublicToolData}=await import('../server/member/read-model.mjs');
      for(const result of [await getAdminData({section:'users'}),await getMemberData(uid),await getPublicToolData()]) {
        assert.equal(result.settings[inboxProgressKey(accountId)],undefined);
      }
      assert.equal(await updateState(accountId,{uid:3,uidValidity:1,expected:expected(before),completedRanges:[]}),false);
      assert.deepEqual(await readInboxProgress(fresh,1),[[4,4]]);
      assert.deepEqual(await readInboxProgress(fresh,2),[]);
      const isolated=await openDatabase();
      try {
        await assert.rejects(updateState(accountId,{uid:3,uidValidity:1,expected:expected(fresh),completedRanges:[[5,5]]},{openDatabase:async()=>({
          beginTransaction:()=>isolated.beginTransaction(),commit:()=>isolated.commit(),rollback:()=>isolated.rollback(),release(){},
          execute:(sql,params)=>{if(sql.startsWith('INSERT INTO system_settings'))throw Error('synthetic checkpoint disk failure');return isolated.execute(sql,params);},
        })}),/synthetic checkpoint/);
      } finally {isolated.release();}
      assert.equal(Number((await row()).last_uid),2);assert.deepEqual(await readInboxProgress(await row(),1),[[4,4]]);
      await c.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?",[accountId]);
      assert.equal(await updateState(accountId,{uid:4,uidValidity:1,expected:expected(await row()),completedRanges:[]}),false);
      assert.deepEqual(await readInboxProgress(await row(),1),[[4,4]]);
    });
  } finally {
    try {
      await waitForResetDeliveries();
      if(accountId){await c.execute('DELETE FROM system_settings WHERE `key`=?',[inboxProgressKey(accountId)]);await c.execute('DELETE FROM relay_accounts WHERE id=?',[accountId]);}
      if(uid){
        await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[uid]);
        await c.execute('DELETE FROM users WHERE id=?',[uid]);
      }
    } finally {c.release();await closeDatabasePool();}
  }
});
