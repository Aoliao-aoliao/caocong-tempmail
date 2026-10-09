import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';

test('guest read gates use atomic bounded records in isolated MySQL', {timeout:60000}, async t => {
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
  const {consumeGuestReadLimit}=await import('../server/guest/read-limit.mjs');
  const {guestReadIdentity}=await import('../server/guest/service.mjs');
  const c=await openDatabase(), prefix='seven-read-'+randomUUID(), hashes=new Set();
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const remember=value=>{hashes.add(hash(value));return value;};
  const window=()=>Math.floor(Date.now()/60000)*60;
  const seed=async(ip,count)=>c.execute('INSERT INTO auth_rate_limits(action,key_hash,window_start,attempt_count) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE attempt_count=VALUES(attempt_count)',['GUEST_READ_IP',hash(remember(ip)),window(),count]);
  try {
    await t.test('parallel reads share the final two IP slots; rejected cookies allocate no rows',async()=>{
      const ip=prefix+'-parallel';
      // Avoid a wall-clock minute boundary during the very short concurrency assertion.
      const remaining=60000-Date.now()%60000;
      if(remaining<5000)await new Promise(resolve=>setTimeout(resolve,remaining+20));
      await seed(ip,598);
      const result=await Promise.all(Array.from({length:30},(_,i)=>consumeGuestReadLimit({kind:['mailbox','list','detail'][i%3],ipAddress:ip,cookieValue:'forged-'+i})));
      assert.equal(result.filter(r=>r.allowed).length,2);
      assert.ok(result.filter(r=>!r.allowed).every(r=>r.retryAfter>=1&&r.retryAfter<=60));
      const [[row]]=await c.execute('SELECT COUNT(*) n,MAX(attempt_count) attempts FROM auth_rate_limits WHERE key_hash=?',[hash(ip)]);
      assert.equal(Number(row.n),1);assert.equal(Number(row.attempts),600);
      const other=remember(prefix+'-other');
      assert.equal((await consumeGuestReadLimit({kind:'mailbox',ipAddress:other,cookieValue:'forged'})).allowed,true);
    });
    await t.test('valid signature uses stable session buckets while a changed signature only consumes IP quota',async()=>{
      const ip=remember(prefix+'-session'),payload=randomUUID()+'.'+'x'.repeat(43);
      const secret=process.env.GUEST_SESSION_SECRET||process.env.SESSION_SECRET||process.env.MYSQL_PASSWORD;
      const cookieValue=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
      const identifier=remember(ip+':'+guestReadIdentity(cookieValue));
      const first=await consumeGuestReadLimit({kind:'detail',ipAddress:ip,cookieValue});
      assert.equal(first.allowed,true);assert.equal(first.sessionIdentifier,identifier);
      const second=await consumeGuestReadLimit({kind:'detail',ipAddress:ip,cookieValue:cookieValue+'!'});
      assert.equal(second.allowed,true);assert.equal(second.sessionIdentifier,null);
      const [[row]]=await c.execute('SELECT COUNT(*) n,MAX(attempt_count) attempts FROM auth_rate_limits WHERE key_hash=?',[hash(identifier)]);
      assert.equal(Number(row.n),1);assert.equal(Number(row.attempts),1);
    });
    await t.test('expired IP window does not block a fresh window',async()=>{
      const ip=remember(prefix+'-expired');
      await c.execute('INSERT INTO auth_rate_limits(action,key_hash,window_start,attempt_count) VALUES (?,?,?,600)',['GUEST_READ_IP',hash(ip),window()-60]);
      assert.equal((await consumeGuestReadLimit({kind:'list',ipAddress:ip,cookieValue:'invalid'})).allowed,true);
    });
  } finally {
    for(const key of hashes)await c.execute('DELETE FROM auth_rate_limits WHERE key_hash=?',[key]);
    c.release();await closeDatabasePool();
  }
});
