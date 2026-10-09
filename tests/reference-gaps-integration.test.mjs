import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
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


test('password recovery in explicitly isolated MySQL', {timeout:60000},async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {hashPassword,verifyPassword,createSession,getSessionUser}=await import('../server/auth/service.mjs');
  const {requestPasswordReset,confirmPasswordReset,waitForResetDeliveries}=await import('../server/auth/password-reset.mjs');
  const {saveMailConfig,readMailConfig,MAIL_SETTING}=await import('../server/auth/password-mail.mjs');
  const {getPublicToolData}=await import('../server/member/read-model.mjs');
  const rateKeys=[];
  const c=await openDatabase();const email=`reset-${randomUUID()}@example.test`;let uid;
  const [[old]]=await c.execute('SELECT * FROM system_settings WHERE `key`=?',[MAIL_SETTING]);
  const captured=[];const deps={configReader:async()=>({enabled:true,secret:{}}),send:async value=>{captured.push(value);}};
  const issue=async()=>{const result=await requestPasswordReset({email},deps);await waitForResetDeliveries();return {...result,code:captured.at(-1).code};};
  try{
    const [result]=await c.execute('INSERT INTO users(public_id,email,password_hash) VALUES (?,?,?)',[`U-${randomUUID()}`,email,hashPassword('original-test-password')]);uid=result.insertId;
    await t.test('missing mail configuration fails explicitly',async()=>{await assert.rejects(requestPasswordReset({email},{configReader:async()=>null}),e=>e.status===503);});
    await t.test('single use, parallel replay and old session revocation',async()=>{
      const session=await createSession({userId:uid,ipAddress:'127.0.0.1',userAgent:'isolated'});
      const reset=await issue();
      const [[stored]]=await c.execute('SELECT token_hash FROM sessions WHERE id=?',[reset.requestId]);
      assert.notEqual(stored.token_hash,createHash('sha256').update(reset.code).digest('hex'));
      assert.equal(await getSessionUser(reset.code),null);
      // Even a stored login-style digest cannot turn the reserved ID into auth.
      const challengeHash=stored.token_hash;
      await c.execute('UPDATE sessions SET token_hash=? WHERE id=?',[createHash('sha256').update('forged-login').digest('hex'),reset.requestId]);
      assert.equal(await getSessionUser('forged-login'),null);
      await c.execute('UPDATE sessions SET token_hash=? WHERE id=?',[challengeHash,reset.requestId]);
      const tries=await Promise.allSettled([1,2].map(()=>confirmPasswordReset({...reset,email,password:'new-test-password'})));
      assert.equal(tries.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(await getSessionUser(session.token),null);
      const [[user]]=await c.execute('SELECT password_hash FROM users WHERE id=?',[uid]);assert.ok(verifyPassword('new-test-password',user.password_hash));
    });
    await t.test('wrong codes lock the challenge after five attempts',async()=>{
      const reset=await issue();const wrong=reset.code==='00000000'?'11111111':'00000000';
      for(let i=0;i<5;i++)await assert.rejects(confirmPasswordReset({...reset,email,code:wrong,password:'unused-password'}));
      await assert.rejects(confirmPasswordReset({...reset,email,password:'unused-password'}));
    });
    await t.test('expired and replaced challenges cannot reset passwords',async()=>{
      const expired=await issue();await c.execute('UPDATE sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[expired.requestId]);
      await assert.rejects(confirmPasswordReset({...expired,email,password:'unused-password'}));
      const first=await issue();const latest=await issue();await assert.rejects(confirmPasswordReset({...first,email,password:'unused-password'}));
      await confirmPasswordReset({...latest,email,password:'latest-password'});
    });
    await t.test('unknown and disabled accounts have the same public response without email',async()=>{
      const count=captured.length;const unknown=await requestPasswordReset({email:`unknown-${randomUUID()}@example.test`},deps);
      await c.execute("UPDATE users SET status='DISABLED' WHERE id=?",[uid]);const disabled=await requestPasswordReset({email},deps);await waitForResetDeliveries();
      assert.equal(unknown.message,disabled.message);assert.equal(captured.length,count);
      await c.execute("UPDATE users SET status='ACTIVE' WHERE id=?",[uid]);
    });
    await t.test('stale successful login cannot create a session after reset',async()=>{
      const [[before]]=await c.execute('SELECT password_hash FROM users WHERE id=?',[uid]);
      const reset=await issue();await confirmPasswordReset({...reset,email,password:'changed-again-password'});
      await assert.rejects(createSession({userId:uid,ipAddress:'127.0.0.1',userAgent:'test',expectedPasswordHash:before.password_hash}),e=>e.status===401);
    });
    await t.test('SMTP management rejects anonymous, ordinary users and ordinary admins',async()=>{
      const {GET,POST}=await route('../src/pages/api/admin/password-mail.ts');
      const session=await createSession({userId:uid,ipAddress:'127.0.0.1',userAgent:'test'});
      const context=(token,method='GET',origin='http://localhost')=>({url:new URL('http://localhost/api/admin/password-mail'),request:new Request('http://localhost/api/admin/password-mail',{method,headers:{origin,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})}),cookies:{get:()=>token?{value:token}:undefined},clientAddress:'127.0.0.1'});
      assert.equal((await GET(context(null))).status,401);
      assert.equal((await GET(context(session.token))).status,403);
      await c.execute("UPDATE users SET role='ADMIN' WHERE id=?",[uid]);assert.equal((await POST(context(session.token,'POST'))).status,403);
      await c.execute("UPDATE users SET role='SUPER_ADMIN' WHERE id=?",[uid]);assert.equal((await GET(context(session.token))).status,200);
      assert.equal((await POST(context(session.token,'POST','https://attacker.example'))).status,403);
      await c.execute("UPDATE users SET role='USER' WHERE id=?",[uid]);
    });
    await t.test('recovery API checks origin, captcha and account send limits',async()=>{
      const ip=`2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;rateKeys.push(ip,email,'password-reset');
      let verified=0,issued=0;
      const {POST}=await route('../src/pages/api/auth/password/request.ts',{
        '../../../../../server/security/turnstile.mjs':{requireTurnstileToken:async({token})=>{verified++;if(token!=='isolated-pass')throw Object.assign(new Error('人机验证失败。'),{status:403});}},
        '../../../../../server/auth/password-reset.mjs':{resetEmail:v=>v,requestPasswordReset:async()=>{issued++;return {requestId:'test-only'};}},
      });
      const ctx=(origin,token)=>({url:new URL('http://localhost/api/auth/password/request'),request:new Request('http://localhost/api/auth/password/request',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,turnstileToken:token})}),clientAddress:ip});
      assert.equal((await POST(ctx('https://attacker.example','isolated-pass'))).status,403);assert.equal(verified,0);
      assert.equal((await POST(ctx('http://localhost','missing'))).status,403);assert.equal(issued,0);
      const [[quota]]=await c.execute("SELECT COUNT(*) AS count FROM auth_rate_limits WHERE action IN ('RESET_SEND_ACCOUNT','RESET_SEND_COOLDOWN') AND key_hash=?",[createHash('sha256').update(email).digest('hex')]);assert.equal(Number(quota.count),0);
      assert.equal((await POST(ctx('http://localhost','isolated-pass'))).status,200);assert.equal(issued,1);
      assert.equal((await POST(ctx('http://localhost','isolated-pass'))).status,429);assert.equal(issued,1);
    });
    await t.test('mail failure invalidates the pending code',async()=>{
      const reset=await requestPasswordReset({email},{...deps,send:async()=>{throw new Error('synthetic failure');}});await waitForResetDeliveries();
      const [rows]=await c.execute('SELECT id FROM sessions WHERE id=?',[reset.requestId]);assert.equal(rows.length,0);
    });
    await t.test('signed-in address generator returns a real candidate that can be activated',async()=>{
      const domain=`address-${randomUUID()}.example.test`;
      const [inserted]=await c.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'PUBLIC','ACTIVE','ACTIVE')",[domain]);
      const session=await createSession({userId:uid,ipAddress:'127.0.0.1',userAgent:'test'});
      let mailbox;
      try{
        const {POST}=await route('../src/pages/api/tools/us_address/generate.cgi.ts');
        const context={url:new URL('http://localhost/api/tools/us_address/generate.cgi'),request:new Request('http://localhost/api/tools/us_address/generate.cgi',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({stateCode:'OR',taxFreeOnly:true})}),cookies:{get:name=>name==='nodemail_session'?{value:session.token}:undefined,set:()=>{throw new Error('member must not receive guest session');}},clientAddress:'127.0.0.1'};
        const response=await POST(context);assert.equal(response.status,200);const {address}=await response.json();assert.equal(address.stateCode,'OR');assert.ok(!address.email.endsWith('@example.com'));assert.equal(address.requiresActivation,true);assert.equal(address.mailboxClaim,undefined);
        const {createMailbox}=await import('../server/member/mutations.mjs');
        mailbox=await createMailbox({userId:uid,localPart:address.email.split('@')[0],domain:address.mailboxDomain,durationMinutes:60,requestId:randomUUID(),expectedPrice:0,captchaVerified:true});
        assert.equal(mailbox.address,address.email);
        const {findActiveRecipient}=await import('../server/mail/repository.mjs');assert.ok(await findActiveRecipient(address.email));
      }finally{
        if(mailbox){await c.execute('UPDATE domains d JOIN mailboxes m ON m.domain_id=d.id SET d.mailbox_count=GREATEST(0,d.mailbox_count-1) WHERE m.public_id=?',[mailbox.id]);await c.execute('DELETE FROM mailboxes WHERE public_id=?',[mailbox.id]);}
        await c.execute('DELETE FROM domains WHERE id=?',[inserted.insertId]);
        await c.execute("DELETE FROM auth_rate_limits WHERE action='GUEST_US_ADDRESS_GENERATE_IP' AND key_hash=?",[createHash('sha256').update('127.0.0.1').digest('hex')]);
      }
    });
    await t.test('SMTP secret stays encrypted and is excluded from public settings',async()=>{
      await saveMailConfig({enabled:true,host:'smtp.example.com',port:465,from:'sender@example.test',username:'sender',password:'synthetic-only-secret'});
      const config=await readMailConfig();assert.ok(config.secret);assert.ok(!JSON.stringify(config).includes('synthetic-only-secret'));
      const pub=await getPublicToolData();assert.equal(pub.settings[MAIL_SETTING],undefined);
      await assert.rejects(saveMailConfig({...config,host:'other.example.com',password:''}),/重新输入密码/);
      const preserved=await saveMailConfig({...config,password:''});assert.equal(preserved.passwordConfigured,true);assert.equal(preserved.secret,undefined);
    });
  }finally{
    await waitForResetDeliveries();if(uid)await c.execute('DELETE FROM users WHERE id=?',[uid]);
    if(old)await c.execute('UPDATE system_settings SET value=?,value_type=? WHERE `key`=?',[old.value,old.value_type,MAIL_SETTING]);else await c.execute('DELETE FROM system_settings WHERE `key`=?',[MAIL_SETTING]);
    for(const key of rateKeys)await c.execute("DELETE FROM auth_rate_limits WHERE action LIKE 'RESET_%' AND key_hash=?",[createHash('sha256').update(key).digest('hex')]);
    c.release();await closeDatabasePool();
  }
});
