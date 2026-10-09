import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { htmlToPlainText } from '../server/mail/body-text.mjs';
import { pollAccount } from '../server/relay/poller.mjs';
import { mergeCompletedRanges, completedRangeContains, MAX_COMPLETED_RANGES, readInboxProgress } from '../server/relay/inbox-progress.mjs';
import { runApiLogRetention } from '../server/openapi/log-retention.mjs';

test('HTML text fallback handles malformed mail in bounded time and preserves readable text', () => {
  assert.equal(htmlToPlainText('İ中文<p>A&nbsp;&lt;B&gt;<br/>C</p><STYLE>x</STYLE><script>x()</script>&quot;&#39;&amp;'), 'İ中文A <B>\nC\n\n"\'&');
  assert.equal(htmlToPlainText('before<script>unclosed'), 'before');
  assert.equal(htmlToPlainText('<script>if(a<b) f()</script ><p>kept</p>'), 'kept');
  assert.equal(htmlToPlainText('<p>hello</p>tail <'), 'hello\n\ntail <');
  // Child timeout makes a reintroduced catastrophic regex fail without hanging
  // the complete test runner. No machine-specific millisecond timing threshold.
  const moduleUrl = new URL('../server/mail/body-text.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {htmlToPlainText} from ${JSON.stringify(moduleUrl)};
    const input='<'.repeat(1024*1024);
    if(htmlToPlainText(input)!==input)process.exit(2);
    if(htmlToPlainText('<style>'.repeat(50000))!=='')process.exit(3);
  `], {timeout:5000,encoding:'utf8'});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
});

const config={maxMessageBytes:10000,maxAttachments:5,maxAttachmentBytes:5000,mailboxMaxMessages:10,mailboxMaxBytes:100000};
let nextAccountId=48171;
function fixture() {
  let ranges=[], validity=1;
  const bodies=[], metadata=[], saved=[];
  const failures=new Set([1]), messages=new Map();
  const account={id:nextAccountId++,uid_validity:1,last_uid:0};
  const add=(uid,size=100)=>messages.set(uid,{uid,size,internalDate:new Date(),source:Buffer.from(`To: alias@example.test\r\nSubject: ${uid}\r\n\r\ntext`)});
  const client={
    mailbox:{uidValidity:1,uidNext:1},async connect(){},async logout(){},async getMailboxLock(){return {release(){}};},
    async search(){return [...messages.keys()].filter(uid=>uid>account.last_uid);},
    async *fetch(uids,query){
      assert.ok(uids.length>0&&uids.length<=100);
      (query.source?bodies:metadata).push([...uids]);
      for(const uid of uids)if(messages.has(uid)){
        const item=messages.get(uid);
        yield query.source?item:{uid,size:item.size};
      }
    },
  };
  const dependencies={client,aliasesFor:async()=>[{id:1,address:'alias@example.test',activated_at:'2020-01-01'}],
    readInboxProgress:async(_,v)=>v===validity?structuredClone(ranges):[],
    updateState:async(_,state)=>{account.last_uid=state.uid;account.uid_validity=state.uidValidity;account.retryError=state.retryError;validity=state.uidValidity;ranges=structuredClone(state.completedRanges);},
    saveDelivery:async({relaySource})=>{if(failures.has(relaySource.uid))throw Error('synthetic full mailbox');saved.push(relaySource.uid);},
  };
  return {account,client,dependencies,failures,messages,bodies,metadata,saved,add,get ranges(){return ranges;},set ranges(value){ranges=value;},
    async poll(){await pollAccount({...account},{config,attachmentStore:{},dependencies:{...dependencies}});}};
}
test('INBOX persists successes across polls, accepts new mail and retries only unfinished UIDs',async()=>{
  const f=fixture();f.add(1);f.add(2);
  await f.poll();await f.poll();f.add(3);await f.poll();
  assert.deepEqual(f.bodies,[[1,2],[1],[3,1]]);
  assert.deepEqual(f.saved,[2,3]);assert.equal(f.account.last_uid,0);
  assert.deepEqual(f.ranges,[[2,3]]);
  f.failures.clear();await f.poll();
  assert.deepEqual(f.saved,[2,3,1]);assert.equal(f.account.last_uid,3);assert.deepEqual(f.ranges,[]);
});
test('INBOX skips oversized bodies, still receives later mail, and retries when the limit permits',async()=>{
  const f=fixture();f.failures.clear();f.add(1,10001);f.add(2);
  await f.poll();await f.poll();assert.deepEqual(f.bodies,[[2]]);
  assert.equal(f.account.last_uid,0);f.messages.get(1).size=100;await f.poll();
  assert.deepEqual(f.saved,[2,1]);assert.equal(f.account.last_uid,2);
});
test('INBOX batches stay bounded and completed ranges cannot grow without bound',async()=>{
  const healthy=fixture();healthy.failures.clear();for(let i=1;i<=251;i++)healthy.add(i);
  await healthy.poll();assert.equal(healthy.account.last_uid,100);assert.equal(healthy.account.retryError,null);
  const f=fixture();for(let i=1;i<=251;i++)f.add(i);
  await f.poll();await f.poll();await f.poll();await f.poll();
  assert.equal(f.saved.length,250);assert.equal(new Set(f.saved).size,250);
  assert.deepEqual(f.ranges,[[2,251]]);
  f.ranges=Array.from({length:MAX_COMPLETED_RANGES},(_,i)=>[2*i+2,2*i+2]);
  f.messages.clear();for(let i=1;i<=MAX_COMPLETED_RANGES*2+2;i++)f.add(i);
  await f.poll();assert.ok(f.ranges.length<=MAX_COMPLETED_RANGES);
  f.failures.clear();await f.poll();assert.ok(f.ranges.length<MAX_COMPLETED_RANGES);
});
test('UIDVALIDITY resets ignore old completions and recovered INBOX mail is not swallowed',async()=>{
  const f=fixture();f.add(1);f.add(2);await f.poll();
  f.messages.clear();f.failures.clear();f.client.mailbox={uidValidity:2,uidNext:2};
  f.dependencies.recoverJunkMail=async()=>f.add(2);
  await f.poll();assert.equal(f.account.uid_validity,2);assert.equal(f.account.last_uid,2);
  assert.deepEqual(f.saved,[2,2]);assert.deepEqual(f.ranges,[]);
});
test('expunged failed UID releases the highwater without re-fetching completed mail',async()=>{
  const f=fixture();f.add(1);f.add(2);await f.poll();f.messages.delete(1);await f.poll();
  assert.equal(f.account.last_uid,2);assert.deepEqual(f.bodies,[[1,2]]);assert.deepEqual(f.ranges,[]);
});
test('range encoding merges adjacency and rejects invalid UID metadata',()=>{
  const ranges=mergeCompletedRanges([[5,8],[2,3]],[4,9,12],2);
  assert.deepEqual(ranges,[[3,9],[12,12]]);
  assert.equal(completedRangeContains(ranges,7),true);assert.equal(completedRangeContains(ranges,10),false);
  assert.throws(()=>mergeCompletedRanges([[1,Infinity]]));
});
test('stale INBOX metadata cannot be loaded for an old account revision',async()=>{
  let released=false;
  await assert.rejects(readInboxProgress({id:1,last_uid:0,uid_validity:1,updated_at:new Date(1)},1,{openDatabase:async()=>({
    execute:async()=>[[{last_uid:0,uid_validity:1,updated_at:new Date(2),value:'{}'}]],release(){released=true;},
  })}),/changed/);assert.equal(released,true);
});
test('API diagnostics retention is bounded and releases its connection on failure',async()=>{
  let released=0;
  const connection={execute:async sql=>{assert.match(sql,/DELETE FROM api_request_logs/);assert.match(sql,/INTERVAL 30 DAY/);assert.match(sql,/LIMIT 1000/);return [{affectedRows:7}];},release(){released++;}};
  assert.deepEqual(await runApiLogRetention({openDatabase:async()=>connection}),{deleted:7});
  connection.execute=async()=>{throw Error('synthetic DB failure');};
  await assert.rejects(runApiLogRetention({openDatabase:async()=>connection}));assert.equal(released,2);
});
