import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
async function route(path){
  const url=new URL(path,import.meta.url),source=await readFile(url,'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),imports={};
  for(const n of ast.statements)if(ts.isImportDeclaration(n)&&!n.importClause?.isTypeOnly){const spec=n.moduleSpecifier.text;imports[spec]=spec.endsWith('/locale')?{requestLocale:()=> 'zh-CN'}:await import(new URL(spec,url));}
  const exports={};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>imports[n],Response,Request,URL,Buffer,console});return exports;
}
test('NodeLoc registration, binding, session and route security in isolated MySQL',{timeout:60000},async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {createNodelocOAuthService}=await import('../server/auth/nodeloc-oauth.mjs');
  const {createSession,getSessionUser,hashPassword,verifyPassword}=await import('../server/auth/service.mjs');
  const {NODELOC_CONFIG_KEY,hash}=await import('../server/auth/nodeloc-protocol.mjs');
  const c=await openDatabase(),users=[],email=randomUUID()+'@example.test',origin='https://app.example.test';
  const [prior]=await c.execute("SELECT * FROM system_settings WHERE `key` LIKE 'nodeloc_oauth_%'");
  let identity={subject:'123',email,username:'test_user'},exchanges=0;
  const service=createNodelocOAuthService({exchange:async()=>{exchanges++;return identity;}});
  const cfg={enabled:true,clientId:'test-client',clientSecret:'disposable-client-secret',origin};let admin,member,other;
  const begin=async opts=>{const r=await service.begin({origin,...opts});return {origin,state:new URL(r.url).searchParams.get('state'),nonce:r.nonce,code:'isolated-code',...opts};};
  try{
    await c.execute("DELETE FROM system_settings WHERE `key` LIKE 'nodeloc_oauth_%'");
    for(const role of ['SUPER_ADMIN','USER','USER']){const [r]=await c.execute('INSERT INTO users(public_id,email,password_hash,role) VALUES (?,?,?,?)',['U-'+randomUUID(),randomUUID()+'@example.test',hashPassword('test-password-123'),role]);users.push(Number(r.insertId));}
    [admin,member,other]=users;
    await t.test('super admin only; encrypted secret retained on blank save; no generic settings leakage',async()=>{
      assert.equal((await service.config()).enabled,false);await assert.rejects(service.save(cfg,{actorUserId:member}),e=>e.status===403);
      const result=await service.save(cfg,{actorUserId:admin});assert.equal(result.enabled,true);assert.ok(!JSON.stringify(result).includes(cfg.clientSecret));
      const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[NODELOC_CONFIG_KEY]);assert.ok(!row.value.includes(cfg.clientSecret));
      await service.save({...cfg,clientSecret:''},{actorUserId:admin});assert.equal((await service.config()).secretConfigured,true);
      await assert.rejects(service.save({...cfg,clientId:'changed',clientSecret:''},{actorUserId:admin}));
      const {getPublicToolData,getMemberData}=await import('../server/member/read-model.mjs');const {getAdminData}=await import('../server/admin/read-model.mjs');
      for(const data of [await getPublicToolData(),await getMemberData(member),await getAdminData()])assert.equal(Object.keys(data.settings).some(k=>k.startsWith('nodeloc_oauth_')),false);
    });
    await t.test('browser nonce, session, origin and expiry enforced before contacting provider',async()=>{
      const flow=await begin();const n=exchanges;
      for(const changes of [{nonce:'x'.repeat(43)},{sessionToken:'wrong-session'},{origin:'https://evil.example.test'}])await assert.rejects(service.complete({...flow,...changes}));
      assert.equal(exchanges,n);await c.execute('UPDATE system_settings SET value=JSON_SET(value,\'$.expiresAt\',0) WHERE `key`=?',['nodeloc_oauth_state:'+hash(flow.state)]);await assert.rejects(service.complete(flow));
      const denial=await begin();await assert.rejects(service.complete({...denial,error:'access_denied'}));await assert.rejects(service.complete(denial));assert.equal(exchanges,n);
    });
    await t.test('first login creates one account, API key, configured bonus and session; replay cannot create duplicates',async()=>{
      const flow=await begin();const both=await Promise.allSettled([service.complete(flow),service.complete(flow)]);assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
      const result=both.find(x=>x.status==='fulfilled').value;const user=await getSessionUser(result.token);assert.equal(user.email,email);users.push(Number(user.id));
      const [[u]]=await c.execute('SELECT password_hash,points_balance FROM users WHERE id=?',[user.id]);assert.match(u.password_hash,/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);assert.equal(verifyPassword('anything',u.password_hash),false);
      assert.equal((await c.execute('SELECT COUNT(*) n FROM api_keys WHERE user_id=?',[user.id]))[0][0].n,1);
      const [[bonus]]=await c.execute("SELECT value FROM system_settings WHERE `key`='registration_bonus_points'");assert.equal(Number(u.points_balance),Math.max(0,Math.floor(Number(bonus?.value||0))));
      const again=await service.complete(await begin());assert.equal(Number((await getSessionUser(again.token)).id),Number(user.id));assert.equal((await c.execute('SELECT COUNT(*) n FROM users WHERE email=?',[email]))[0][0].n,1);
    });
    await t.test('email collision NEVER logs into existing local account; authenticated binding keeps original user and points',async()=>{
      const [[u]]=await c.execute('SELECT email,points_balance FROM users WHERE id=?',[member]);identity={subject:'456',email:u.email,username:'linked_user'};
      await assert.rejects(service.complete(await begin()),e=>e.status===409);assert.equal((await service.binding(member,origin)).bound,false);
      const session=await createSession({userId:member});const flow=await begin({mode:'bind',userId:member,sessionToken:session.token});await service.complete(flow);
      assert.equal((await service.binding(member,origin)).username,'linked_user');const logged=await service.complete(await begin());assert.equal(Number((await getSessionUser(logged.token)).id),member);
      assert.equal((await c.execute('SELECT points_balance FROM users WHERE id=?',[member]))[0][0].points_balance,u.points_balance);
      const otherSession=await createSession({userId:other});await assert.rejects(service.complete(await begin({mode:'bind',userId:other,sessionToken:otherSession.token})),e=>e.status===409);
    });
    await t.test('community profile refresh preserves identity, denies another subject and needs live session',async()=>{
      identity={...identity,trustLevel:0};
      const session=await createSession({userId:member});
      await service.complete(await begin({mode:'refresh',userId:member,sessionToken:session.token}));
      assert.equal((await service.binding(member,origin)).trustLevel,0);
      identity={...identity,subject:'789',trustLevel:4};
      await assert.rejects(service.complete(await begin({mode:'refresh',userId:member,sessionToken:session.token})),e=>e.status===409);
      assert.equal((await service.binding(member,origin)).trustLevel,0);
      identity={...identity,subject:'456',trustLevel:3,username:'updated_user'};
      await service.complete(await begin());
      assert.equal((await service.binding(member,origin)).trustLevel,3);
      assert.equal((await c.execute('SELECT role FROM users WHERE id=?',[member]))[0][0].role,'USER');
      assert.equal((await service.binding(member,origin)).username,'updated_user');
      const pending=await begin({mode:'refresh',userId:member,sessionToken:session.token});
      await c.execute('DELETE FROM sessions WHERE token_hash=?',[hash(session.token)]);
      await assert.rejects(service.complete(pending));
      await assert.rejects(begin({mode:'refresh',userId:other,sessionToken:(await createSession({userId:other})).token}));
    });
    await t.test('configuration change during exchange prevents finalization, disabled user cannot login',async()=>{
      let release;const delayed=createNodelocOAuthService({exchange:async()=>{await new Promise(r=>{release=r;});return identity;}});
      const flow=await begin(),pending=delayed.complete(flow);while(!release)await new Promise(r=>setTimeout(r,5));
      await service.save({...cfg,clientSecret:''},{actorUserId:admin});release();await assert.rejects(pending);
      await c.execute("UPDATE users SET status='DISABLED' WHERE id=?",[member]);await assert.rejects(service.complete(await begin()));await c.execute("UPDATE users SET status='ACTIVE' WHERE id=?",[member]);
    });
    await t.test('unlink requires local password, revokes sessions and pending binding, disable preserves identity',async()=>{
      await assert.rejects(service.unlink(member,'wrong'),e=>e.status===403);assert.equal((await service.binding(member,origin)).bound,true);
      const session=await createSession({userId:member});await service.save({...cfg,enabled:false,clientSecret:''},{actorUserId:admin});assert.equal((await service.binding(member,origin)).bound,true);await assert.rejects(begin(),e=>e.status===503);
      await service.unlink(member,'test-password-123');assert.equal(await getSessionUser(session.token),null);assert.equal((await service.binding(member,origin)).bound,false);
      await service.save({...cfg,clientSecret:''},{actorUserId:admin});const otherSession=await createSession({userId:other});const pending=await begin({mode:'bind',userId:other,sessionToken:otherSession.token});await service.unlink(other,'test-password-123');await assert.rejects(service.complete(pending));
    });
    await t.test('password reset by the mailbox owner removes a NodeLoc binding left by a previous holder',async()=>{
      const {requestPasswordReset,confirmPasswordReset,waitForResetDeliveries}=await import('../server/auth/password-reset.mjs');
      const [[o]]=await c.execute('SELECT email FROM users WHERE id=?',[other]);identity={subject:'999',email:randomUUID()+'@example.test',username:'previous_holder'};
      const session=await createSession({userId:other});await service.complete(await begin({mode:'bind',userId:other,sessionToken:session.token}));assert.equal((await service.binding(other,origin)).bound,true);
      const captured=[];const result=await requestPasswordReset({email:o.email},{configReader:async()=>({enabled:true,secret:{}}),send:async value=>{captured.push(value);}});await waitForResetDeliveries();
      const done=await confirmPasswordReset({email:o.email,requestId:result.requestId,code:captured.at(-1).code,password:'owner-new-password'});assert.ok(done.message.includes('NodeLoc'));
      assert.equal((await service.binding(other,origin)).bound,false);assert.equal((await c.execute('SELECT COUNT(*) n FROM system_settings WHERE `key`=?',['nodeloc_oauth_identity:'+hash('999')]))[0][0].n,0);
      const [[before]]=await c.execute('SELECT COUNT(*) n FROM users');const relogin=await service.complete(await begin());assert.notEqual(Number((await getSessionUser(relogin.token)).id),other);users.push(Number((await getSessionUser(relogin.token)).id));assert.equal((await c.execute('SELECT COUNT(*) n FROM users'))[0][0].n,before.n+1);
      await c.execute('UPDATE users SET password_hash=? WHERE id=?',[hashPassword('test-password-123'),other]);
      const [[m]]=await c.execute('SELECT email FROM users WHERE id=?',[member]);const plain=await requestPasswordReset({email:m.email},{configReader:async()=>({enabled:true,secret:{}}),send:async value=>{captured.push(value);}});await waitForResetDeliveries();
      assert.ok(!(await confirmPasswordReset({email:m.email,requestId:plain.requestId,code:captured.at(-1).code,password:'test-password-123'})).message.includes('NodeLoc'));
    });
    await t.test('routes reject anonymous/admin misuse, cross-origin starts and GET login; callback never reflects errors',async()=>{
      const adminRoute=await route('../src/pages/api/admin/nodeloc-oauth.ts'),start=await route('../src/pages/api/auth/nodeloc/start.ts'),memberRoute=await route('../src/pages/api/user/nodeloc-oauth.ts'),callback=await route('../src/pages/api/auth/nodeloc/callback.ts');
      const context=(token='',site=origin,method='POST',body={mode:'login'})=>({request:new Request(origin+'/api/auth/nodeloc/start',{method,headers:{origin:site,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}),url:new URL(origin+'/api/auth/nodeloc/start'),cookies:{get:key=>key==='nodemail_session'&&token?{value:token}:undefined,set(){},delete(){}},clientAddress:'127.0.0.1'});
      assert.equal((await adminRoute.GET(context())).status,401);assert.equal((await memberRoute.GET(context())).status,401);
      const session=await createSession({userId:other});assert.equal((await adminRoute.POST(context(session.token))).status,403);assert.equal((await adminRoute.GET(context(session.token,origin,'GET'))).status,403);
      assert.equal((await memberRoute.POST(context(session.token,'https://evil.example.test','POST',{action:'unlink',password:'test-password-123'}))).status,403);
      assert.equal((await start.POST(context('','https://evil.example.test'))).status,403);assert.equal((await start.POST(context('',origin,'POST',{mode:'bind'}))).status,401);assert.equal((await start.POST(context('',origin,'POST',{mode:'refresh'}))).status,401);assert.equal(start.GET,undefined);
      const ctx=context('',origin,'GET');ctx.url.search='?error_description=<script>secret</script>&state=bad';const response=await callback.GET(ctx);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/user/login.cgi?nodeloc=failed');assert.equal(response.headers.get('cache-control'),'no-store');
    });
  }finally{
    for(const id of users){await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);await c.execute('DELETE FROM point_transactions WHERE user_id=?',[id]);await c.execute('DELETE FROM users WHERE id=?',[id]);}
    await c.execute('DELETE FROM users WHERE email=?',[email]);await c.execute("DELETE FROM system_settings WHERE `key` LIKE 'nodeloc_oauth_%'");
    for(const row of prior)await c.execute('INSERT INTO system_settings(`key`,value,value_type,description,updated_by_user_id) VALUES (?,?,?,?,?)',[row.key,row.value,row.value_type,row.description,row.updated_by_user_id]);
    c.release();await closeDatabasePool();
  }
});
