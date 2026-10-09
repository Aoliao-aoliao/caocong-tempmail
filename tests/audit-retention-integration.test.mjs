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
test('audit retention preserves business state in isolated MySQL',{timeout:60000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const service=await import('../server/admin/audit-retention.mjs');
 const {resolveApiRateLimit}=await import('../server/member/api-key.mjs');
 const {updateApiKey}=await import('../server/admin/mutations.mjs');
 const {transactionReceipt}=await import('../server/admin/transaction-receipt.mjs');
 const c=await openDatabase(),users=[];
 const [oldSettings]=await c.query("SELECT * FROM system_settings WHERE `key` IN ('audit_retention','audit_retention_ready')");
 // Existing fixture rows are restored; no production host/database is accepted.
 const [oldAudit]=await c.query('SELECT * FROM audit_logs');
 const due=()=>c.query("UPDATE system_settings SET value=JSON_SET(value,'$.nextAt',0) WHERE `key`='audit_retention'");
 const add=async(action='测试管理操作',detail={},old=true,id='AL-'+randomUUID(),entity='USER',entityId='fixture')=>{
  await c.execute('INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)',[id,users[0],action,entity,entityId,JSON.stringify(detail),new Date(Date.now()-(old?40:0)*86400000)]);return id;
 };
 try{
  await c.query("DELETE FROM system_settings WHERE `key` IN ('audit_retention','audit_retention_ready')");await c.query('DELETE FROM audit_logs');
  for(const role of ['SUPER_ADMIN','ADMIN','USER']){const [r]=await c.execute('INSERT INTO users(public_id,email,password_hash,role) VALUES (?,?,?,?)',['U-'+randomUUID(),randomUUID()+'@example.test','synthetic',role]);users.push(r.insertId);}
  const actorUserId=users[0];
  await t.test('release gate protects legacy rollback, only superadmin may change retention',async()=>{
   const id=await add();assert.equal((await service.runAuditRetention()).deleted,0);
   assert.equal((await c.execute('SELECT id FROM audit_logs WHERE public_id=?',[id]))[0].length,1);
   for(const actor of users.slice(1))await assert.rejects(service.configureAuditRetention({actorUserId:actor,action:'save',days:30}),e=>e.status===403);
   await assert.rejects(service.configureAuditRetention({actorUserId,action:'save',days:0}),e=>e.status===400);
   await assert.rejects(service.configureAuditRetention({actorUserId,action:'clear',confirm:'CLEAR_AUDIT'}),e=>e.status===409);
   await service.activateAuditRetention();await service.configureAuditRetention({actorUserId,action:'save',days:30});
   const {getPublicToolData,getMemberData}=await import('../server/member/read-model.mjs');for(const data of [await getPublicToolData(),await getMemberData(users[2])])for(const k of ['audit_retention','audit_retention_ready'])assert.equal(Object.hasOwn(data.settings,k),false);
  });
  await t.test('expired audit removed, fresh audit and compact historical receipt survive',async()=>{
   const fresh=await add('新管理操作',{},false),id=await add('用户购买会员',{code:'fixture',expectedPrice:20,result:{}},true,'MP-'+randomUUID(),'MEMBERSHIP','123');
   const failed=await add('用户购买会员');await c.execute("UPDATE audit_logs SET status='FAILED' WHERE public_id=?",[failed]);
   await service.runAuditRetention();assert.equal((await c.execute('SELECT id FROM audit_logs WHERE public_id=?',[id]))[0].length,0);
   assert.equal((await c.execute('SELECT id FROM audit_logs WHERE public_id=?',[fresh]))[0].length,1);
   assert.equal((await c.execute('SELECT public_id FROM business_receipts WHERE public_id=?',[id]))[0].length,1);
   const pt='PT-'+randomUUID();await c.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id) VALUES (?,?,'MEMBERSHIP_PURCHASE',-20,0,'MEMBERSHIP','123')",[pt,actorUserId]);
   assert.equal((await transactionReceipt(pt)).requestId,id);assert.equal((await transactionReceipt(pt)).protected,true);
  });
  await t.test('conflicting historical receipt fails closed without deleting the batch',async()=>{
   const id=await add('用户购买会员',{code:'original'},true,'MP-'+randomUUID(),'MEMBERSHIP','124');
   await c.execute("INSERT INTO business_receipts(public_id,user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'用户购买会员','MEMBERSHIP','124','{}')",[id,actorUserId]);await due();
   await assert.rejects(service.runAuditRetention(),/mismatch/);assert.equal((await c.execute('SELECT id FROM audit_logs WHERE public_id=?',[id]))[0].length,1);
   await c.execute('DELETE FROM business_receipts WHERE public_id=?',[id]);await service.runAuditRetention();
  });
  const key='AK-'+randomUUID();await c.execute('INSERT INTO api_keys(public_id,user_id,key_prefix,key_hash) VALUES (?,?,?,?)',[key,actorUserId,'fixture',createHash('sha256').update(key).digest('hex')]);
  await t.test('API limit override survives cleanup and later status-only changes',async()=>{
   await add('更新 API 密钥',{after:{rateLimit:71}},true,undefined,'API_KEY',key);
   await add('更新 API 密钥',{after:{rateLimit:83}},true,undefined,'API_KEY',key);
   await due();await service.runAuditRetention();assert.equal(await resolveApiRateLimit(c,{publicId:key,userId:actorUserId}),83);
   await updateApiKey({publicId:key,status:'ACTIVE',rateLimit:96,actorUserId});
   await updateApiKey({publicId:key,status:'DISABLED',rateLimit:96,actorUserId});
   await c.execute('DELETE FROM audit_logs WHERE entity_id=?',[key]);assert.equal(await resolveApiRateLimit(c,{publicId:key,userId:actorUserId}),96);
  });
  await t.test('500 row bound, serialized workers, clear cutoff preserves new events and clear record',async()=>{
   for(let i=0;i<501;i++)await add();
   await service.configureAuditRetention({actorUserId,action:'clear',confirm:'CLEAR_AUDIT'});
   await assert.rejects(service.configureAuditRetention({actorUserId,action:'clear',confirm:'CLEAR_AUDIT'}),e=>e.status===409);
   const newer=await add('清理后新事件',{},false);
   const results=await Promise.all([service.runAuditRetention(),service.runAuditRetention()]);assert.equal(results.reduce((n,r)=>n+r.deleted,0),500);
   await due();await service.runAuditRetention();assert.equal((await service.auditRetentionStatus()).clearing,false);
   const [rows]=await c.query('SELECT public_id,action FROM audit_logs');assert.ok(rows.some(r=>r.public_id===newer));assert.ok(rows.some(r=>r.action==='管理员清空审计日志'));
   assert.equal((await c.execute('SELECT public_id FROM point_transactions WHERE user_id=?',[actorUserId]))[0].length,1);
   assert.equal(await resolveApiRateLimit(c,{publicId:key,userId:actorUserId}),96);
  });
  await t.test('HTTP endpoints reject anonymous, member, admin writes and cross-origin requests',async()=>{
   const api=await route('../src/pages/api/admin/audit-retention.ts'),details=await route('../src/pages/api/admin/transaction-receipt.ts');
   const {createSession}=await import('../server/auth/service.mjs');
   const context=(token,origin='https://app.example.test')=>({request:new Request('https://app.example.test/api/admin/audit-retention',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'save',days:30})}),url:new URL('https://app.example.test/api/admin/audit-retention'),cookies:{get:()=>token?{value:token}:undefined},clientAddress:'127.0.0.1'});
   assert.equal((await api.POST(context())).status,401);assert.equal((await details.GET(context())).status,401);
   for(const uid of users.slice(1)){const s=await createSession({userId:uid,ipAddress:'127.0.0.1',userAgent:'isolated'});assert.equal((await api.POST(context(s.token))).status,403);}
   const s=await createSession({userId:actorUserId,ipAddress:'127.0.0.1',userAgent:'isolated'});assert.equal((await api.POST(context(s.token,'https://evil.example.test'))).status,403);assert.equal((await api.POST(context(s.token))).status,200);
  });
 }finally{
  try{await c.query('DELETE FROM audit_logs');for(const row of oldAudit)await c.query('INSERT INTO audit_logs SET ?',[{...row,detail_json:row.detail_json==null?null:JSON.stringify(row.detail_json)}]);
   for(const uid of users){await c.execute('DELETE FROM point_transactions WHERE user_id=?',[uid]);await c.execute('DELETE FROM users WHERE id=?',[uid]);}
   await c.query("DELETE FROM system_settings WHERE `key` IN ('audit_retention','audit_retention_ready')");for(const row of oldSettings)await c.query('INSERT INTO system_settings SET ?',[row]);
  }finally{c.release();await closeDatabasePool();}
 }
});
