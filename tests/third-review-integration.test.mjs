import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function route(path, overrides={}) {
  const url=new URL(path,import.meta.url);
  const source=await readFile(url,'utf8');
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  const imports={};
  for(const node of ast.statements) if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly) {
    const name=node.moduleSpecifier.text;
    imports[name]=overrides[name]||await import(new URL(name,url));
  }
  const exports={};
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(compiled,{exports,require:name=>imports[name],Response,Request,URL,Buffer,console});
  return exports;
}

test('third review fixes against isolated MySQL only', {timeout:90000}, async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {createMailbox}=await import('../server/member/mutations.mjs');
  const {selectOpenApiDomain}=await import('../server/openapi/contract.mjs');
  const {findActiveRecipient,saveDelivery}=await import('../server/mail/repository.mjs');
  const {recallMailbox}=await import('../server/member/mailbox-recall.mjs');
  const {resolveMailboxRecallPlan}=await import('../server/member/mailbox-recall-policy.mjs');
  const {createMemberRelayMailbox,createGuestRelayMailbox}=await import('../server/relay/service.mjs');
  const {verifyDomainDns}=await import('../server/admin/domain-dns.mjs');
  const {updateDomain,updateSystemSettings}=await import('../server/admin/mutations.mjs');
  const {consumeRefreshCooldown}=await import('../server/auth/request-security.mjs');
  const {encryptRelayCredential}=await import('../server/security/secret-box.mjs');
  const connection=await openDatabase();
  const suffix=randomUUID();
  const users=[],domains=[],guestIds=[],rateHashes=[];
  let accountId,oldFree,oldCleanup;
  const storage=await mkdtemp(join(tmpdir(),'nodemail-third-review-'));
  const originalStorage=process.env.MAIL_ATTACHMENT_DIR;
  process.env.MAIL_ATTACHMENT_DIR=storage;
  const hash=value=>createHash('sha256').update(value).digest('hex');
  try {
    for(const name of ['owner','other']) {
      const [row]=await connection.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'unusable-synthetic',10000)",[`U-${randomUUID()}`,`${name}-${suffix}@example.test`]);users.push(row.insertId);
    }
    const [owner,other]=users;
    const makeDomain=async(kind,ownerId=null)=>{
      const name=`${kind.toLowerCase()}-${suffix}.example.test`;
      const [row]=await connection.execute("INSERT INTO domains(domain,kind,owner_user_id,status,mx_status) VALUES (?,?,?,'ACTIVE','ACTIVE')",[name,kind,ownerId]);
      const result={id:row.insertId,domain:name}; domains.push(result);return result;
    };
    const ordinary=await makeDomain('PUBLIC'),relay=await makeDomain('RELAY'),privateDomain=await makeDomain('PRIVATE',owner);
    const encrypted=encryptRelayCredential('synthetic-never-connect');
    const [account]=await connection.execute(`INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases)
      VALUES (?,?,?,'127.0.0.1','synthetic',?,?,?,?,'ACTIVE',2)`,[`RA-${randomUUID()}`,`base@${relay.domain}`,relay.domain,encrypted.ciphertext,encrypted.kdfSalt,encrypted.iv,encrypted.authTag]);
    accountId=account.insertId;
    const [[setting]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
    const plan=resolveMailboxRecallPlan({rawPlans:setting.value,durationHours:24});
    const create=(domain,localPart='normal')=>createMailbox({userId:owner,domain,localPart,durationMinutes:60,captchaVerified:true});
    const box=await create(ordinary.domain);
    const [[normal]]=await connection.execute('SELECT id,address FROM mailboxes WHERE public_id=?',[box.id]);
    const makeRelay=async(userId=owner)=>{
      const result=await createMemberRelayMailbox({userId,suffix:relay.domain,durationMinutes:60,expectedPrice:0,requestId:randomUUID()});
      const [[row]]=await connection.execute('SELECT id,public_id,address FROM mailboxes WHERE public_id=?',[result.id]);return row;
    };
    const relayBox=await makeRelay();
    const recallParams=box=>({userId:owner,mailboxId:box.public_id,durationHours:24,expectedPrice:plan.price,requestId:randomUUID(),captchaVerified:true});
    const expire=box=>connection.execute("UPDATE mailboxes SET status='EXPIRED',expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[box.id]);
    const balance=async()=>Number((await connection.execute('SELECT points_balance FROM users WHERE id=?',[owner]))[0][0].points_balance);

    await t.test('normal and explicit OpenAPI relay domain creation is rejected without charge',async()=>{
      const before=await balance();
      await assert.rejects(create(relay.domain),/域名.*不可用/);
      for(const selector of [{domainId:relay.id},{legacyDomain:relay.domain}]) await assert.rejects(selectOpenApiDomain({userId:owner,...selector}),error=>error.apiCode===-1401);
      assert.equal((await selectOpenApiDomain({userId:owner,domainId:ordinary.id})).domain,ordinary.domain);
      assert.equal(await balance(),before);
    });
    await t.test('SMTP rejects relay aliases at RCPT and at storage; authenticated IMAP source still delivers',async()=>{
      assert.equal((await findActiveRecipient(normal.address)).id,normal.id);
      assert.equal(await findActiveRecipient(relayBox.address),null);
      const delivery={message:{messageId:`synthetic-${suffix}`,fromAddress:'sender@example.test',subject:'test',htmlContent:'<p>123456</p>',sizeBytes:10,riskStatus:'SAFE',receivedAt:new Date()},attachments:[],attachmentStore:{persist:async()=>({records:[],cleanup:async()=>{}})},mailboxQuota:{maxMessages:10,maxBytes:10000}};
      await assert.rejects(saveDelivery({...delivery,recipients:[relayBox]}),error=>error.responseCode===451);
      await assert.rejects(saveDelivery({...delivery,recipients:[normal],relaySource:{accountId,uidValidity:1,uid:1}}),/state changed/);
      assert.equal((await saveDelivery({...delivery,recipients:[normal]})).inserted,1);
      assert.equal((await saveDelivery({...delivery,recipients:[relayBox],relaySource:{accountId,uidValidity:1,uid:1}})).inserted,1);
      const openApi=await import('../server/openapi/service.mjs');
      const detail=await route('../src/pages/openapi/v1/mail/detail.cgi.ts',{'../../../../../server/openapi/service.mjs':{...openApi,runApi:async(_context,handler)=>handler({user_id:owner})}});
      const [[message]]=await connection.execute('SELECT id FROM messages WHERE mailbox_id=?',[normal.id]);
      const data=await detail.POST({request:new Request('http://localhost/detail',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:message.id})})});
      assert.equal(data.textContent,'123456');
    });
    await t.test('relay recall rejects disabled/error/missing/full accounts and leaves balance and expiry unchanged',async()=>{
      await expire(relayBox);
      for(const status of ['DISABLED','ERROR']) {
        await connection.execute('UPDATE relay_accounts SET status=? WHERE id=?',[status,accountId]);
        const before=await balance();await assert.rejects(recallMailbox(recallParams(relayBox)),/账号当前不可用/);assert.equal(await balance(),before);
      }
      await connection.execute("UPDATE relay_accounts SET status='ACTIVE',max_aliases=1 WHERE id=?",[accountId]);
      const occupied=await makeRelay(other);
      const before=await balance();await assert.rejects(recallMailbox(recallParams(relayBox)),/容量已满/);assert.equal(await balance(),before);
      await expire(occupied);
      await connection.execute('UPDATE mailboxes SET relay_account_id=NULL WHERE id=?',[relayBox.id]);
      await assert.rejects(recallMailbox(recallParams(relayBox)),/账号当前不可用/);assert.equal(await balance(),before);
      await connection.execute('UPDATE mailboxes SET relay_account_id=? WHERE id=?',[accountId,relayBox.id]);
      const request=recallParams(relayBox);const result=await recallMailbox(request);assert.equal(result.price,plan.price);
      assert.equal(await balance(),before-plan.price);
      await recallMailbox(request);assert.equal(await balance(),before-plan.price,'replay succeeds even when the account is now full');
      const [[count]]=await connection.execute('SELECT COUNT(*) AS count FROM messages WHERE mailbox_id=?',[relayBox.id]);assert.equal(Number(count.count),0,'recall must not restore old mail');
    });
    await t.test('concurrent allocations cannot exceed the final account slot',async()=>{
      await expire(relayBox);
      const results=await Promise.allSettled([makeRelay(owner),makeRelay(other)]);
      assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
      assert.equal(results.filter(row=>row.status==='rejected').length,1);
      const [[usage]]=await connection.execute("SELECT COUNT(*) AS total FROM mailboxes WHERE relay_account_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP(3)",[accountId]);assert.equal(Number(usage.total),1);
    });
    await t.test('DNS needs private approval, retains manual disable, recovers health, and survives a timeout',async()=>{
      const dependencies={lookupMx:async()=>({status:'ACTIVE',records:[{exchange:'mx.example.test',priority:10}],error:null})};
      await connection.execute("UPDATE domains SET status='PENDING',mx_status='PENDING' WHERE id=?",[privateDomain.id]);
      let result=await verifyDomainDns({domain:privateDomain.domain},dependencies);assert.equal(result.status,'PENDING');assert.equal(result.mx_status,'ACTIVE');
      const update={domain:privateDomain.domain,kind:'PRIVATE',status:'ACTIVE',mxStatus:'ACTIVE',actorUserId:owner};
      await assert.rejects(updateDomain(update),/核实/);
      await updateDomain({...update,ownershipVerified:true});
      await connection.execute("UPDATE domains SET status='DISABLED',mx_status='MISMATCH' WHERE id=?",[privateDomain.id]);
      result=await verifyDomainDns({domain:privateDomain.domain},dependencies);assert.equal(result.status,'DISABLED');
      const bad={lookupMx:async()=>({status:'MISMATCH',records:[],error:'wrong MX'})};
      result=await verifyDomainDns({domain:ordinary.domain},bad);assert.equal(result.status,'ACTIVE');assert.equal(result.mx_status,'MISMATCH');assert.equal(await findActiveRecipient(normal.address),null);
      await verifyDomainDns({domain:ordinary.domain},dependencies);
      result=await verifyDomainDns({domain:ordinary.domain},{lookupMx:async()=>({status:'UNAVAILABLE',records:[],error:'timeout'})});
      assert.equal(result.mx_status,'ACTIVE');assert.equal(result.mx_error,'timeout');assert.ok(await findActiveRecipient(normal.address));
    });
    await t.test('rotating invalid guest cookies cannot bypass the IP hourly cap',async()=>{
      const ip='198.51.100.123';rateHashes.push(hash(ip));
      const turnstilePath='../../../../../server/security/turnstile.mjs';
      const handler=await route('../src/pages/api/guest/relay/mailbox.ts',{[turnstilePath]:{requireTurnstileToken:async()=>{throw Object.assign(new Error('synthetic CAPTCHA rejection'),{status:403});}}});
      for(let i=0;i<13;i++) {
        const cookie=`invalid-${suffix}-${i}`;rateHashes.push(hash(`${ip}:${cookie}`));
        const context={url:new URL('https://example.test/api/guest/relay/mailbox'),clientAddress:ip,cookies:{get:()=>({value:cookie})},request:new Request('https://example.test/api/guest/relay/mailbox',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'{}'})};
        const response=await handler.POST(context);assert.equal(response.status,i<4?403:429,await response.text());
      }
    });
    await t.test('guest duration uses the configured value and invalid settings are rejected',async()=>{
      [[oldFree]]=await connection.execute("SELECT value,updated_by_user_id,updated_at FROM system_settings WHERE `key`='free_mailbox_minutes'");
      await updateSystemSettings({values:{free_mailbox_minutes:90},actorUserId:owner});
      await connection.execute('UPDATE relay_accounts SET max_aliases=20 WHERE id=?',[accountId]);
      const result=await createGuestRelayMailbox({cookieValue:'',ipAddress:'127.0.0.1',userAgent:suffix,suffix:relay.domain});
      assert.equal(result.mailbox.durationMinutes,90);
      const [[row]]=await connection.execute('SELECT guest_session_id FROM mailboxes WHERE public_id=?',[result.mailbox.id]);guestIds.push(row.guest_session_id);
      for(const minutes of [0,1,1441]) await assert.rejects(updateSystemSettings({values:{free_mailbox_minutes:minutes},actorUserId:owner}),/5–1440/);
    });
    await t.test('VIP expiry does not remove still-valid mailboxes or mail',async()=>{
      const {runMailboxMaintenance}=await import('../server/mail/maintenance.mjs');
      const {AttachmentStore}=await import('../server/mail/attachment-store.mjs');
      const store=new AttachmentStore(storage);await store.initialize();
      [[oldCleanup]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='relay_remote_cleanup_enabled'");
      await connection.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES ('relay_remote_cleanup_enabled','false','boolean') ON DUPLICATE KEY UPDATE value='false'");
      const [[membershipPlan]]=await connection.execute('SELECT id FROM membership_plans LIMIT 1');
      await connection.execute("INSERT INTO memberships(user_id,plan_id,status,starts_at,expires_at) VALUES (?,?,'ACTIVE',DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 DAY),DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",[owner,membershipPlan.id]);
      await runMailboxMaintenance({attachmentStore:store});
      const [[current]]=await connection.execute('SELECT status FROM mailboxes WHERE id=?',[normal.id]);
      const [[messages]]=await connection.execute('SELECT COUNT(*) AS total FROM messages WHERE mailbox_id=?',[normal.id]);
      assert.equal(current.status,'ACTIVE');assert.equal(Number(messages.total),1);
    });
    await t.test('refresh cooldown is atomic across workers and does not reset at a ten-second boundary',async()=>{
      const action='THIRD_REVIEW_COOLDOWN',identifier=suffix;rateHashes.push(hash(identifier));
      const results=await Promise.all(Array.from({length:5},()=>consumeRefreshCooldown({action,identifier})));
      assert.equal(results.filter(row=>row.allowed).length,1);
      // The concurrent calls above use the real pool. Freeze MySQL's clock on
      // this owned connection for exact boundary assertions: wall-clock queries
      // around a second rollover made the old "-9 seconds" fixture already expire.
      const {getDatabasePool}=await import('../server/db/database.mjs');
      const pool=getDatabasePool(), acquire=pool.getConnection;
      const borrowed={query:(...args)=>connection.query(...args),execute:(...args)=>connection.execute(...args),release(){},destroy:()=>connection.destroy()};
      try {
        await connection.query('SET timestamp = 1801657960.500');
        pool.getConnection=async()=>borrowed;
        // attempt_count encodes milliseconds + 1: age 9.999s then exactly 10s.
        await connection.execute('UPDATE auth_rate_limits SET window_start=FLOOR(UNIX_TIMESTAMP())-10,attempt_count=502 WHERE action=? AND key_hash=?',[action,hash(identifier)]);
        assert.equal((await consumeRefreshCooldown({action,identifier})).allowed,false);
        await connection.execute('UPDATE auth_rate_limits SET attempt_count=501 WHERE action=? AND key_hash=?',[action,hash(identifier)]);
        assert.equal((await consumeRefreshCooldown({action,identifier})).allowed,true);
      } finally {
        pool.getConnection=acquire;
        await connection.query('SET timestamp = 0');
      }
    });
  } finally {
    try {
    if(oldFree)await connection.execute("UPDATE system_settings SET value=?,updated_by_user_id=?,updated_at=? WHERE `key`='free_mailbox_minutes'",[oldFree.value,oldFree.updated_by_user_id,oldFree.updated_at]);
    if(oldCleanup)await connection.execute("UPDATE system_settings SET value=? WHERE `key`='relay_remote_cleanup_enabled'",[oldCleanup.value]);
    for(const userId of users) {
      await connection.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[userId]);
      await connection.execute('DELETE FROM point_transactions WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM users WHERE id=?',[userId]);
    }
    for(const id of guestIds)await connection.execute('DELETE FROM guest_sessions WHERE id=?',[id]);
    if(accountId)await connection.execute('DELETE FROM relay_accounts WHERE id=?',[accountId]);
    for(const domain of domains){await connection.execute("DELETE FROM audit_logs WHERE entity_type='DOMAIN' AND entity_id=?",[domain.domain]);await connection.execute('DELETE FROM domains WHERE id=?',[domain.id]);}
    for(const keyHash of rateHashes)await connection.execute('DELETE FROM auth_rate_limits WHERE key_hash=?',[keyHash]);
    } finally {
    connection.release();await closeDatabasePool();await rm(storage,{recursive:true,force:true});
    if(originalStorage===undefined)delete process.env.MAIL_ATTACHMENT_DIR;else process.env.MAIL_ATTACHMENT_DIR=originalStorage;
    }
  }
});
