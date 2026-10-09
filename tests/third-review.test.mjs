import test from 'node:test';
import assert from 'node:assert/strict';
import { domainDnsTransition } from '../server/admin/domain-dns.mjs';
import { freeMailboxMinutes } from '../server/member/mailbox-policy.mjs';
import { resolveMailboxRecallPlan, isValidRecallDuration } from '../server/member/mailbox-recall-policy.mjs';
import { htmlToPlainText } from '../server/mail/body-text.mjs';
import { apiFailure } from '../server/openapi/service.mjs';
import { createMailbox } from '../server/member/mutations.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const lookup = status => ({ status, records:[{exchange:'mx.example.test',priority:10}], error:status==='UNAVAILABLE'?'timeout':null });
test('DNS never approves private ownership or reverses administrative disable/rejection', () => {
  for (const status of ['PENDING','DISABLED','REJECTED']) {
    for (const mx_status of ['ACTIVE','MISMATCH','NOT_FOUND','UNAVAILABLE']) {
      assert.equal(domainDnsTransition({kind:'PRIVATE',status,mx_status},lookup('ACTIVE')).status,status);
    }
  }
  assert.equal(domainDnsTransition({kind:'PUBLIC',status:'PENDING'},lookup('ACTIVE')).status,'ACTIVE');
  for (const status of ['DISABLED','REJECTED']) assert.equal(domainDnsTransition({kind:'PUBLIC',status,mx_status:'MISMATCH'},lookup('ACTIVE')).status,status);
});
test('DNS health recovers without changing approval, and timeouts retain the last known result', () => {
  const current={kind:'PUBLIC',status:'ACTIVE',mx_status:'ACTIVE',mx_records_json:[{exchange:'old'}]};
  const failed=domainDnsTransition(current,lookup('MISMATCH'));
  assert.equal(failed.status,'ACTIVE'); assert.equal(failed.mxStatus,'MISMATCH');
  const timeout=domainDnsTransition(current,lookup('UNAVAILABLE'));
  assert.equal(timeout.mxStatus,'ACTIVE'); assert.deepEqual(timeout.records,current.mx_records_json);
  const recovered=domainDnsTransition({...current,mx_status:'MISMATCH'},lookup('ACTIVE'));
  assert.equal(recovered.mxStatus,'ACTIVE');
});
test('free duration is bounded consistently and recall accepts configured custom terms', () => {
  for (const [input,output] of [[undefined,60],['0',5],['90',90],['1441',1440],['bad',60],['1.5',60]]) assert.equal(freeMailboxMinutes(input),output);
  const rawPlans=[{id:'custom',minutes:2880,points:6,enabled:true}];
  assert.equal(resolveMailboxRecallPlan({rawPlans,durationHours:48}).durationMinutes,2880);
  assert.equal(isValidRecallDuration(1470 / 60),false);
  assert.throws(()=>resolveMailboxRecallPlan({rawPlans:[{minutes:1470,points:6,enabled:true}],durationHours:24.5}),/召回有效时长/);
  assert.throws(()=>resolveMailboxRecallPlan({rawPlans:[{...rawPlans[0],enabled:false}],durationHours:48}));
  assert.throws(()=>resolveMailboxRecallPlan({rawPlans:[{minutes:60,points:0}],durationHours:1}));
});
test('HTML mail fallback is text and malformed idempotency IDs are parameter errors', async () => {
  assert.equal(htmlToPlainText('<style>bad</style><p>Code &amp; 123456</p><script>bad()</script>'),'Code & 123456');
  let failure;
  try { await createMailbox({requestId:'invalid'}); } catch(error) { failure=apiFailure(error); }
  assert.equal(failure.code,-1100);
});

// Run the real component callbacks with deferred network responses, without a
// browser or live mailbox. Extract AST initializers instead of duplicating the
// implementation of request sequencing in the regression test.
async function callbacks(file, component, names, globals) {
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===component);
  const selected=[];
  for(const statement of fn.body.statements) {
    if(ts.isFunctionDeclaration(statement)&&names.includes(statement.name?.text))selected.push(statement.getText(ast));
    if(ts.isVariableStatement(statement)) {
    for(const declaration of statement.declarationList.declarations) if(names.includes(declaration.name.getText(ast))) selected.push(`const ${declaration.getText(ast)};`);
  }
  }
  assert.equal(selected.length,names.length);
  const compiled=ts.transpileModule(`${selected.join('\n')}\nreturn {${names.join(',')}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return runInNewContext(`(()=>{${compiled}})()`,globals);
}
for(const relay of [false,true]) test(`${relay?'relay':'member'} reader ignores late replies after another message or close`, async()=>{
  let visible=null,error='',loading=false;
  const pending=[];
  const defer=()=>new Promise(resolve=>pending.push(resolve));
  const globals={setCopyNotice:()=>{},detailRequest:{current:0},setSelected:v=>{visible=v;},setDetail:v=>{visible=v;},setLoading:v=>{loading=v;},setError:v=>{error=v;},setStatus:v=>{error=v;},setMessages:()=>{},postJson:defer,authenticated:true,fetch:defer,Error};
  const {openMessage,closeMessage}=await callbacks(relay?'../src/components/RelayMailbox.tsx':'../src/components/MemberCenter.tsx',relay?'RelayMailbox':'Messages',['openMessage','closeMessage'],globals);
  const reply=value=>relay?{ok:true,json:async()=>({ok:true,result:value})}:value;
  const first=openMessage({id:'first'}),second=openMessage({id:'second'});
  pending[1](reply({id:'second',body_text:'second body'})); await second;
  pending[0](reply({id:'first',body_text:'first body'})); await first;
  assert.equal(visible.id,'second');assert.equal(error,'');assert.equal(loading,false);
  const third=openMessage({id:'third'}); closeMessage(); pending[2](reply({id:'third'}));await third;
  assert.equal(visible,null);
});

for(const authenticated of [false,true]) test(`relay reader loading/error lifecycle (${authenticated?'member':'guest'})`,async()=>{
  let visible=null,error='',loading=false;
  const pending=[];
  const globals={setCopyNotice:()=>{},detailRequest:{current:0},setDetail:v=>{visible=v;},setLoading:v=>{loading=v;},setError:v=>{error=v;},authenticated,
    fetch:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),Error,encodeURIComponent};
  const {openMessage,closeMessage}=await callbacks('../src/components/RelayMailbox.tsx','RelayMailbox',['openMessage','closeMessage'],globals);
  const first=openMessage({id:'first'});
  assert.equal(loading,true);assert.equal(error,'');assert.equal(visible.id,'first');
  pending[0].resolve({ok:false,json:async()=>({ok:false,message:'邮箱已过期。'})});await first;
  assert.equal(loading,false);assert.equal(error,'邮箱已过期。');assert.equal(visible.id,'first','keep the reader open to show its error');
  const second=openMessage({id:'second'}),third=openMessage({id:'third'});
  assert.equal(error,'');assert.equal(loading,true);
  pending[1].reject(new Error('late failure'));await second;
  assert.equal(loading,true,'old request finally must not stop the new loading indicator');assert.equal(error,'');
  const message={id:'third',body_text:'正文'};
  pending[2].resolve({ok:true,json:async()=>({ok:true,result:message,message})});await third;
  assert.equal(visible.body_text,'正文');assert.equal(loading,false);assert.equal(error,'');
  const fourth=openMessage({id:'fourth'});closeMessage();pending[3].reject(new Error('late close failure'));await fourth;
  assert.equal(visible,null);assert.equal(loading,false);assert.equal(error,'');
});

test('shared reader shows complete metadata/body, loading, failure and escaped HTML',async()=>{
  const {createRequire}=await import('node:module');
  const {renderToStaticMarkup}=await import('react-dom/server');
  const require=createRequire(import.meta.url);
  const source=await readFile(new URL('../src/components/ui/MailReader.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  runInNewContext(compiled,{exports,require:name=>name.includes('useTranslator')?{useTranslator:()=>s=>s}:name.includes('clipboard')?{copyText:async()=>true}:name.includes('useDialog')?{}:require(name)});
  const render=(loading,error,message={})=>renderToStaticMarkup(require('react').createElement(exports.MailReaderContent,{loading,error,message,onClose:()=>{}}));
  assert.match(render(true,''),/正在读取邮件…/);assert.doesNotMatch(render(true,''),/邮件正文为空|复制正文/);
  assert.match(render(false,'邮箱已过期。'),/role="alert"/);assert.doesNotMatch(render(false,'邮箱已过期。'),/邮件正文为空|复制正文/);
  assert.match(render(false,''),/邮件正文为空/);
  const long='BEGIN '+('long body '.repeat(10000))+' END';
  const html=render(false,'',{body_text:long+'<script>alert(1)</script>',sender:'sender@example.test',recipient:'receiver@example.test',received_at:'2026-10-04T10:00:00Z'});
  assert.ok(html.includes(long));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  for(const label of ['发件人','收件邮箱','收信时间','复制正文'])assert.ok(html.includes(label));
  assert.match(render(false,'',{bodyText:'camel-case body'}),/camel-case body/);
});

test('member reader copy feedback does not replace the message body with an error',async()=>{
  let notice='',bodyError='';
  const globals={copyText:async()=>true,t:text=>text,setNotice:value=>{notice=value;},setError:value=>{bodyError=value;}};
  const {copy}=await callbacks('../src/components/ui/MailReader.tsx','MailReaderContent',['copy'],globals);
  await copy('synthetic@example.test');assert.equal(notice,'已复制');assert.equal(bodyError,'');
  globals.copyText=async()=>false;await copy('synthetic@example.test');assert.match(notice,/复制失败/);assert.equal(bodyError,'');
});

test('overview reader ignores old success/failure and stays closed after a late response',async()=>{
  let visible=null,error='',loading=false;const pending=[];
  const globals={recentRequest:{current:0},setSelectedMessage:v=>visible=v,setMessageLoading:v=>loading=v,setMessageError:v=>error=v,t:s=>s,Error,postJson:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))};
  const {openRecentMessage,closeRecentMessage}=await callbacks('../src/components/MemberCenter.tsx','Overview',['openRecentMessage','closeRecentMessage'],globals);
  const first=openRecentMessage({id:'first'}),second=openRecentMessage({id:'second'});
  pending[1].resolve({id:'second',body_text:'new'});await second;pending[0].reject(new Error('stale'));await first;
  assert.equal(visible.id,'second');assert.equal(error,'');assert.equal(loading,false);
  const last=openRecentMessage({id:'last'});closeRecentMessage();pending[2].resolve({id:'last'});await last;assert.equal(visible,null);assert.equal(loading,false);
});

for(const aborted of [false,true])test(`selected inbox expiry clears counts, aborted response is ignored (${aborted})`,async()=>{
  const source=await readFile(new URL('../src/components/MemberCenter.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('MemberCenter.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Messages');let load;
  const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='load')load=n.getText(ast);ts.forEachChild(n,visit);};visit(fn);assert.ok(load);
  const changes=[];
  const globals={running:false,setListBusy:()=>{},manualRef:{current:false},controller:{signal:{aborted}},page:1,q:'',mailboxId:'MB-synthetic',URLSearchParams,t:s=>s,Error,fetch:async()=>({status:404,ok:false,json:async()=>({ok:false,message:'邮箱已过期'})}),setMessages:v=>changes.push(['messages',v]),setPagination:v=>changes.push(['total',v.total]),setMailboxError:()=>{},setListError:()=>{},closeMessage:()=>changes.push(['closed']),setPage:()=>{}};
  const compiled=ts.transpileModule(`const ${load};load();`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  await runInNewContext(compiled,globals);
  assert.deepEqual(changes.map(v=>v[0]),aborted?[]:['messages','total','closed']);
  if(!aborted)assert.equal(changes[1][1],0);
});

test('member tool inbox rejects stale polling during creation and clears unavailable selection',async()=>{
  let mailbox={id:'old'},items=[{id:'old-message'}],status='',closed=0,loading=false;
  const pending=[];
  const request={current:0},submitting={current:false};
  const globals={URLSearchParams,Number,Error,submittedQuery:'',mailbox,submittingRef:submitting,inboxRequestRef:request,
    setInboxLoading:v=>{loading=v;},setInboxStatus:v=>{status=v;},setMailbox:v=>{mailbox=v;},setMailItems:v=>{items=v;},
    setPage:()=>{},setPages:()=>{},setTotal:()=>{},closeMessage:()=>{closed++;},t:s=>s,
    fetch:()=>new Promise(resolve=>pending.push(resolve))};
  const {loadMessages}=await callbacks('../src/components/MailApply.tsx','MailApply',['loadMessages'],globals);
  const old=loadMessages();
  submitting.current=true;request.current++;
  await loadMessages();assert.equal(pending.length,1,'no old mailbox polling while creating');
  pending[0]({ok:true,status:200,json:async()=>({ok:true,mailbox:{id:'old'},messages:[{id:'stale'}]})});await old;
  assert.equal(items[0].id,'old-message','late old reply was ignored');
  const fresh=loadMessages(1,'',true,{id:'new'},false,true);
  pending[1]({ok:true,status:200,json:async()=>({ok:true,mailbox:{id:'new'},messages:[],pagination:{}})});await fresh;
  assert.equal(mailbox.id,'new');assert.equal(loading,false);
  submitting.current=false;
  const expired=loadMessages(1,'',true,{id:'new'});
  pending[2]({ok:false,status:404,json:async()=>({ok:false})});await expired;
  assert.equal(mailbox,null);assert.equal(items.length,0);assert.equal(closed,1);assert.match(status,/已失效/);
});
