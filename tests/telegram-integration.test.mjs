import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
async function route(path){
 const url=new URL(path,import.meta.url),source=await readFile(url,'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),imports={};
 for(const n of ast.statements)if(ts.isImportDeclaration(n)&&!n.importClause?.isTypeOnly)imports[n.moduleSpecifier.text]=await import(new URL(n.moduleSpecifier.text,url));
 const exports={};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>imports[n],Response,Request,URL,Buffer,console});return exports;
}
test('Telegram binding lifecycle and permissions in isolated MySQL',{timeout:60000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const {createSession}=await import('../server/auth/service.mjs');
 const service=await import('../server/telegram/service.mjs');
 const {TELEGRAM_SETTING}=await import('../server/telegram/protocol.mjs');
 const {decryptTelegramSecret}=await import('../server/security/secret-box.mjs');
 const c=await openDatabase(),users=[];const [[old]]=await c.execute('SELECT * FROM system_settings WHERE `key`=?',[TELEGRAM_SETTING]);
 const token='123456789:'+'A'.repeat(35);let registered='',secret='';
 const call=async(tokenValue,method,body)=>{assert.equal(tokenValue,token);if(method==='getMe')return {id:123456789,is_bot:true,username:'NodeMailTestBot'};if(method==='getWebhookInfo')return {url:registered,pending_update_count:0};if(method==='setWebhook'){registered=body.url;secret=body.secret_token;return true;}if(method==='deleteWebhook'){registered='';return true;}throw Error('unexpected');};
 const update=(request,tg=123,username='test_user')=>({update_id:1,message:{chat:{type:'private',id:tg},from:{id:tg,username},text:'/start bind_'+new URL(request.url).searchParams.get('start').slice(5)}});
 let request;
 try{
  await c.execute('DELETE FROM system_settings WHERE `key`=?',[TELEGRAM_SETTING]);
  for(const role of ['SUPER_ADMIN','USER','USER']){const [r]=await c.execute('INSERT INTO users(public_id,email,password_hash,role) VALUES (?,?,?,?)',['U-'+randomUUID(),randomUUID()+'@example.test','not-a-password',role]);users.push(r.insertId);}
  await t.test('only super admin saves, token encrypted, public settings exclude ciphertext',async()=>{
   await assert.rejects(service.saveTelegramConfig({token,origin:'https://app.example.com',enabled:true},{actorUserId:users[1],call}),e=>e.status===403);
   const cfg=await service.saveTelegramConfig({token,origin:'https://app.example.com',enabled:true},{actorUserId:users[0],call});assert.equal(cfg.enabled,true);assert.equal(cfg.botUsername,'NodeMailTestBot');assert.equal(registered,'https://app.example.com/api/telegram/webhook');assert.ok(!JSON.stringify(cfg).includes(token));
   const [[r]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[TELEGRAM_SETTING]);assert.ok(!r.value.includes(token));const stored=JSON.parse(r.value);assert.equal(JSON.parse(decryptTelegramSecret(Object.fromEntries(Object.entries(stored.secret).map(([k,v])=>[k,Buffer.from(v,'base64')])))).token,token);
   const {getPublicToolData,getMemberData}=await import('../server/member/read-model.mjs');const {getAdminData}=await import('../server/admin/read-model.mjs');
   for(const data of [await getPublicToolData(),await getMemberData(users[1]),await getAdminData()]){assert.equal(Object.hasOwn(data.settings,TELEGRAM_SETTING),false);assert.ok(!JSON.stringify(data).includes(Object.values(stored.secret)[0]));assert.ok(!JSON.stringify(data).includes(token));}
  });
  await t.test('Telegram callback only prepares, site owner must confirm, replay rejected',async()=>{
   request=await service.beginTelegramBinding(users[1]);assert.match(request.url,/^https:\/\/t.me\/NodeMailTestBot\?start=bind_[A-Za-z0-9_-]{43}$/);
   const rawToken=new URL(request.url).searchParams.get('start').slice(5);assert.equal(request.pending.requestId,createHash('sha256').update(rawToken).digest('hex'));
   await assert.rejects(service.receiveTelegramBinding('forged',update(request)),e=>e.status===403);assert.equal((await service.getTelegramState(users[1])).pending.ready,false);
   await service.receiveTelegramBinding(secret,update(request));const state=await service.getTelegramState(users[1]);assert.equal(state.pending.ready,true);assert.equal(state.bound,false);
   await assert.rejects(service.confirmTelegramBinding(users[2],request.pending.requestId));
   await service.receiveTelegramBinding(secret,update(request,999,'attacker'));assert.equal((await service.getTelegramState(users[1])).pending.telegramId,'123');
   const attempts=await Promise.allSettled([1,2].map(()=>service.confirmTelegramBinding(users[1],request.pending.requestId)));assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal((await service.getTelegramState(users[1])).bound,true);
  });
  await t.test('Telegram identity cannot steal another account and expired/replaced links fail',async()=>{
   const other=await service.beginTelegramBinding(users[2]);await service.receiveTelegramBinding(secret,update(other));await assert.rejects(service.confirmTelegramBinding(users[2],other.pending.requestId),e=>e.status===409);assert.equal((await service.getTelegramState(users[1])).bound,true);
   const replaced=await service.beginTelegramBinding(users[2]),fresh=await service.beginTelegramBinding(users[2]);await service.receiveTelegramBinding(secret,update(replaced,456));assert.equal((await service.getTelegramState(users[2])).pending.ready,false);
   await c.execute('UPDATE telegram_binding_requests SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id=?',[users[2]]);await service.receiveTelegramBinding(secret,update(fresh,456));await assert.rejects(service.confirmTelegramBinding(users[2],fresh.pending.requestId));
  });
  await t.test('disable works without Telegram network, unlink cancels pending challenges',async()=>{
   await service.saveTelegramConfig({origin:'https://app.example.com',enabled:false},{actorUserId:users[0],call:async()=>{throw Error('offline');}});
   await assert.rejects(service.beginTelegramBinding(users[1]),e=>e.status===503);await assert.rejects(service.receiveTelegramBinding(secret,update(request)),e=>e.status===403);
   assert.equal((await service.unlinkTelegram(users[1])).bound,false);assert.equal((await service.getTelegramState(users[1])).pending,null);
   await service.saveTelegramConfig({origin:'https://app.example.com',enabled:true},{actorUserId:users[0],call});
   const pending=await service.beginTelegramBinding(users[1]);await service.receiveTelegramBinding(secret,update(pending,456));await service.unlinkTelegram(users[1]);await assert.rejects(service.confirmTelegramBinding(users[1],pending.pending.requestId));
  });
  await t.test('dedicated bot protects other webhook, failed registration preserves configuration',async()=>{
   registered='https://other.example.com/bot';await assert.rejects(service.saveTelegramConfig({origin:'https://app.example.com',enabled:true},{actorUserId:users[0],call}),e=>e.status===409);assert.equal((await service.getTelegramConfig()).enabled,true);
   registered='https://app.example.com/api/telegram/webhook';await assert.rejects(service.saveTelegramConfig({origin:'https://new.example.com',enabled:true},{actorUserId:users[0],call:async(...args)=>{if(args[1]==='setWebhook')throw Error('simulated');return call(...args);}}));assert.equal((await service.getTelegramConfig()).origin,'https://app.example.com');
  });
  await t.test('HTTP anonymous/member/admin and cross origin permissions fail closed',async()=>{
   const admin=await route('../src/pages/api/admin/telegram.ts'),member=await route('../src/pages/api/user/telegram.ts'),hook=await route('../src/pages/api/telegram/webhook.ts');
   const context=(session,origin='https://app.example.com',body={action:'test'})=>({request:new Request('https://app.example.com/api/admin/telegram',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),url:new URL('https://app.example.com/api/admin/telegram'),cookies:{get:()=>session?{value:session}:undefined},clientAddress:'127.0.0.1'});
   assert.equal((await admin.POST(context())).status,401);assert.equal((await member.POST(context())).status,401);
   const s=await createSession({userId:users[1],ipAddress:'127.0.0.1',userAgent:'isolated'});
   assert.equal((await admin.POST(context(s.token))).status,403);assert.equal((await member.POST(context(s.token,'https://evil.example.com'))).status,403);assert.equal((await hook.POST(context())).status,403);
  });
 }finally{
  for(const id of users){await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);await c.execute('UPDATE system_settings SET updated_by_user_id=NULL WHERE updated_by_user_id=?',[id]);await c.execute('DELETE FROM users WHERE id=?',[id]);}
  await c.execute('DELETE FROM system_settings WHERE `key`=?',[TELEGRAM_SETTING]);if(old)await c.execute('INSERT INTO system_settings(`key`,value,value_type,description,updated_by_user_id) VALUES (?,?,?,?,?)',[old.key,old.value,old.value_type,old.description,old.updated_by_user_id]);c.release();await closeDatabasePool();
 }
});
