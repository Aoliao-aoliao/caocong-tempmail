import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function route(kind) {
  const file=kind==='normal'?'guest/mailbox.ts':'guest/relay/mailbox.ts';
  const url=new URL(`../src/pages/api/${file}`,import.meta.url);
  const source=await readFile(url,'utf8'),imports={};
  for(const node of ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true).statements){
    if(!ts.isImportDeclaration(node)||node.importClause?.isTypeOnly)continue;
    const name=node.moduleSpecifier.text;imports[name]=await import(new URL(name,url));
    if(name.endsWith('/turnstile.mjs'))imports[name]={...imports[name],requireTurnstileToken:async()=>{throw Object.assign(new Error('人机验证失败（隔离测试）'),{status:403});}};
  }
  const exports={};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name],Request,Response,URL,Buffer,Error,console});return exports.POST;
}

test('guest rolling creation limits against isolated MySQL', {timeout:90000}, async t=>{
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {consumeGuestCreationLimit}=await import('../server/guest/creation-limit.mjs');
  const db=await openDatabase(),prefix=randomUUID(),keys=new Set();
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const identifier=name=>{const value=`${prefix}:${name}`;keys.add(hash(value));return value;};
  const seed=async(action,ip,time,count)=>db.execute('INSERT INTO auth_rate_limits(action,key_hash,window_start,attempt_count) VALUES (?,?,?,?)',[action,hash(ip),time,count]);
  try{
    for(const kind of ['normal','relay']){
      await t.test(`${kind}: parallel callers share an atomic four-per-minute allowance`,async()=>{
        const ipAddress=identifier(`concurrent-${kind}`);
        const results=await Promise.all(Array.from({length:40},()=>consumeGuestCreationLimit({kind,ipAddress})));
        assert.equal(results.filter(x=>x.allowed).length,4);
        assert.ok(results.filter(x=>!x.allowed).every(x=>x.retryAfter>=1&&x.retryAfter<=60));
      });
      await t.test(`${kind}: minute/hour boundaries do not reset quotas; expiry releases slots`,async()=>{
        const ipAddress=identifier(`edge-${kind}`),action=kind==='normal'?'GUEST_NORMAL_ROLLING':'GUEST_RELAY_ROLLING';
        const base=2000000000-baseRemainder(2000000000)+3599;
        await db.query(`SET timestamp=${base}`);
        for(let i=0;i<4;i++)assert.equal((await consumeGuestCreationLimit({kind,ipAddress,connection:db})).allowed,true);
        await db.query(`SET timestamp=${base+1}`);
        let limited=await consumeGuestCreationLimit({kind,ipAddress,connection:db});assert.equal(limited.allowed,false);assert.equal(limited.retryAfter,59);
        await db.query(`SET timestamp=${base+60}`);
        for(let i=0;i<4;i++)assert.equal((await consumeGuestCreationLimit({kind,ipAddress,connection:db})).allowed,true);
        await db.query(`SET timestamp=${base+120}`);
        for(let i=0;i<4;i++)assert.equal((await consumeGuestCreationLimit({kind,ipAddress,connection:db})).allowed,true);
        await db.query(`SET timestamp=${base+180}`);
        limited=await consumeGuestCreationLimit({kind,ipAddress,connection:db});assert.equal(limited.allowed,false);assert.equal(limited.retryAfter,3420);
        await db.query(`SET timestamp=${base+3600}`);assert.equal((await consumeGuestCreationLimit({kind,ipAddress,connection:db})).allowed,true);
        const [[count]]=await db.execute('SELECT SUM(attempt_count) n FROM auth_rate_limits WHERE action=? AND key_hash=?',[action,hash(ipAddress)]);assert.equal(Number(count.n),9);
        await db.query('SET timestamp=0');
      });
      await t.test(`${kind}: old fixed-hour usage survives deployment conservatively`,async()=>{
        const ipAddress=identifier(`legacy-${kind}`),legacy=kind==='normal'?'GUEST_MAILBOX_CREATE_IP':'GUEST_RELAY_CREATE_IP';
        const base=1999998000;
        await db.query(`SET timestamp=${base+3601}`);await seed(legacy,ipAddress,base,12);
        let result=await consumeGuestCreationLimit({kind,ipAddress,connection:db});assert.equal(result.allowed,false);assert.equal(result.retryAfter,3599);
        await db.query(`SET timestamp=${base+7200}`);assert.equal((await consumeGuestCreationLimit({kind,ipAddress,connection:db})).allowed,true);
        await db.query('SET timestamp=0');
      });
      await t.test(`${kind}: changing cookies never evades IP minute gate or adds rejected cookie rows`,async()=>{
        const handler=await route(kind);const ip=kind==='normal'?'192.0.2.210':'192.0.2.211';keys.add(hash(ip));
        await db.execute('DELETE FROM auth_rate_limits WHERE key_hash=?',[hash(ip)]);
        let before;
        for(let i=0;i<44;i++){
          const cookie=`${prefix}-cookie-${i}`;keys.add(hash(cookie));keys.add(hash(`${ip}:${cookie}`));
          const response=await handler({request:new Request('https://example.test/api/test',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'{}'}),url:new URL('https://example.test/api/test'),clientAddress:ip,cookies:{get:()=>({value:cookie})}});
          assert.equal(response.status,i<4?403:429);
          if(i>=4){assert.ok(Number(response.headers.get('retry-after'))>0);assert.equal(response.headers.get('cache-control'),'no-store');}
          if(i===3)[[before]]=await db.execute('SELECT COUNT(*) n FROM auth_rate_limits');
        }
        const [[after]]=await db.execute('SELECT COUNT(*) n FROM auth_rate_limits');assert.equal(after.n,before.n);
      });
    }
    await t.test('normal and relay quotas remain independent',async()=>{
      const ipAddress=identifier('independent');for(const kind of ['normal','relay'])for(let i=0;i<4;i++)assert.equal((await consumeGuestCreationLimit({kind,ipAddress})).allowed,true);
    });
    await t.test('lock failures reject safely and release errors discard poisoned connections',async()=>{
      let released=0,destroyed=0;
      const denied={execute:async()=>[[{acquired:0}]],release:()=>released++};
      assert.equal((await consumeGuestCreationLimit({kind:'normal',ipAddress:'test',connection:denied})).allowed,false);
      const broken={execute:async sql=>{if(sql.startsWith('SELECT GET_LOCK'))return [[{acquired:1}]];if(sql.startsWith('SELECT RELEASE_LOCK'))throw new Error('release failed');return [[],[]];},query:async()=>[[{now:2000000000}]],destroy:()=>destroyed++,release:()=>released++};
      await assert.rejects(consumeGuestCreationLimit({kind:'normal',ipAddress:'test',connection:broken}),/release failed/);assert.equal(destroyed,1);assert.equal(released,0);
    });
  }finally{
    await db.query('SET timestamp=0');
    for(const key of keys)await db.execute('DELETE FROM auth_rate_limits WHERE key_hash=?',[key]);
    db.release();await closeDatabasePool();
  }
});
function baseRemainder(seconds){return seconds%3600;}
