import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {PassThrough,Readable} from 'node:stream';
import net from 'node:net';
import {once} from 'node:events';
import {SMTPServer} from 'smtp-server';
import {parseLimitedMessage,installSmtpConnectionGuards} from '../server/mail/smtp-service.mjs';

const within=(promise,ms=1500)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('operation did not finish')),ms);timer.unref();})]);
test('SMTP rejects oversized DATA before sender finishes, preserves normal parser',async()=>{
  const stream=new PassThrough();const result=assert.rejects(parseLimitedMessage(stream,128),e=>e.responseCode===552);
  stream.write(Buffer.alloc(256,97));await within(result);assert.equal(stream.destroyed,true);
  const raw=Buffer.from('From: sender@example.test\r\nSubject: ok\r\n\r\nnormal body\r\n');
  const value=await parseLimitedMessage(Readable.from([raw]),1024);assert.equal(value.parsed.subject,'ok');assert.match(value.parsed.text,/normal body/);assert.equal(value.byteLength,raw.length);
});
test('SMTP aborted or interrupted streams settle without waiting for EOF',async()=>{
  const controller=new AbortController(),stream=new PassThrough();
  const result=assert.rejects(parseLimitedMessage(stream,1024,{signal:controller.signal}),e=>e.responseCode===421);
  stream.write('From: sender@example.test\r\n');controller.abort();await within(result);
  const interrupted=new PassThrough(),closed=assert.rejects(parseLimitedMessage(interrupted,1024),e=>e.responseCode===451);
  interrupted.destroy();await within(closed);
});
test('SMTP lifetime and per-IP concurrency are enforced on real loopback sockets',async()=>{
  const server=new SMTPServer({disabledCommands:['AUTH','STARTTLS'],disableReverseLookup:true,logger:false});
  installSmtpConnectionGuards(server,{maxConnectionsPerIp:1,connectionLifetimeMs:500});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const connect=()=>net.connect(server.server.address().port,'127.0.0.1');const sockets=[];
  try {
    const serverClosed=new Promise(resolve=>server.server.once('connection',socket=>socket.once('close',resolve)));
    const first=connect();sockets.push(first);first.on('error',()=>{});const greeting=once(first,'data');await once(first,'connect');
    const firstClosed=once(first,'close');
    const second=connect();sockets.push(second);second.on('error',()=>{});let response='';second.on('data',chunk=>response+=chunk);
    await within(once(second,'close'));assert.match(response,/421 Too many simultaneous/);
    await greeting;const start=Date.now();
    const keepAlive=setInterval(()=>first.write('NOOP\r\n'),40);
    try{await within(firstClosed);await serverClosed;assert.ok(Date.now()-start>200,'activity must not prematurely close connection');}finally{clearInterval(keepAlive);}
    const third=connect();sockets.push(third);third.on('error',()=>{});let thirdResponse='';third.on('data',chunk=>thirdResponse+=chunk);
    await within(once(third,'close'));assert.doesNotMatch(thirdResponse,/Too many simultaneous/);
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});

import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
async function mountComponent(name,props){
  let cursor=0,dirty=true,tree,handler=async()=>Response.json({ok:true,mailbox:props.initialMailbox,messages:[],pagination:{page:1,pages:1,total:0}});
  const slots=[],effects=[],timers=new Map();let timer=0;
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;dirty=true;}];},useRef(value){return slots[cursor++]??={current:value};},useMemo(fn){cursor++;return fn();},useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((x,j)=>x!==previous.deps[j]))effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
  const translator=()=>((text,...values)=>text.replace(/\{(\d+)\}/g,(_,n)=>values[n]));
  const imports={react:hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'./ui/MailReader':{__esModule:true,default:'reader'},'./TurnstileWidget':{__esModule:true,default:'captcha'},'./ui/ChoicePicker':{__esModule:true,default:'picker'},'../lib/useTranslator':{useTranslator:translator},'../lib/clipboard':{copyText:async()=>true},'./ui/useDialog':{useDialog(){}},'../../server/member/mailbox-price.mjs':{discountedMailboxPrice:points=>points},'./ui/useGuestAttempt':{useGuestAttempt:()=>({remaining:0,close(){}})}};
  const globals={exports:{},require:n=>{assert.ok(imports[n],n);return imports[n];},console,URLSearchParams,Intl,Date,crypto:{randomUUID},fetch:(...args)=>handler(...args),clearInterval:id=>timers.delete(id),document:{body:{classList:{add(){},remove(){},toggle(){}}},addEventListener(){},removeEventListener(){}},window:{setInterval(fn,ms){timers.set(++timer,{fn,ms});return timer;},clearInterval:id=>timers.delete(id),setTimeout(){},location:{assign(){}}}};
  const source=await readFile(new URL(`../src/components/${name}.tsx`,import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,globals);
  async function flush(){for(let n=0;n<25;n++){await Promise.resolve();if(dirty){dirty=false;cursor=0;tree=globals.exports.default(props);while(effects.length)effects.shift()();}}}
  function nodes(value=tree){if(!value||typeof value!=='object')return [];if(Array.isArray(value))return value.flatMap(x=>nodes(x??null));return [value,...nodes(value.props?.children??null)];}
  await flush();return {flush,nodes,set fetch(fn){handler=fn;},get text(){return JSON.stringify(tree);},async poll(){[...timers.values()].find(t=>t.ms===8000).fn();await flush();}};
}
const testBox={id:'MB-example',address:'hello@example.test',domain:'example.test',duration_minutes:1500,durationMinutes:1500,expires_at:'2099-01-01T00:00:00Z',available:false};
const testProps={initialMailbox:testBox,initialMessages:[],initialPagination:{page:1,pages:1,total:0},authenticated:true,captchaEnabled:false,turnstileConfigured:false,turnstileSiteKey:'',domains:[{domain:'example.test',kind:'PUBLIC'}],suffixes:[{suffix:'example.test'}],plans:[{id:'hour',label:'1 小时',minutes:60,points:0},{id:'day',label:'1 天',minutes:1440,points:3}],currentPoints:100,discountPercent:100};
test('ordinary current duration and both member receiving states follow mailbox not application choices',async()=>{
  for(const name of ['MailApply','RelayMailbox']){
    const app=await mountComponent(name,testProps);
    const preview=app.nodes().find(n=>n.props?.className==='preview-panel');
    assert.match(JSON.stringify(preview),/1500 分钟/);assert.match(JSON.stringify(preview),/暂停收信/);assert.doesNotMatch(JSON.stringify(preview),/收信中/);
    app.fetch=async()=>Response.json({ok:true,mailbox:{...testBox,available:true},messages:[]});await app.poll();assert.match(app.text,/收信中/);
  }
});
test('relay changed parameters use a new intent, unchanged failed request remains retryable',async()=>{
  const app=await mountComponent('RelayMailbox',testProps);const requests=[];
  app.fetch=async(_url,options)=>{requests.push(JSON.parse(options.body));throw Error('simulated lost response');};
  const open=async()=>{app.nodes().find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await app.flush();};
  const confirm=async()=>{app.nodes().find(n=>n.props?.className==='score-confirm-submit').props.onClick();await app.flush();};
  await open();await confirm();await confirm();assert.equal(requests[0].requestId,requests[1].requestId);
  app.nodes().find(n=>n.props?.className==='score-confirm-cancel').props.onClick();await app.flush();
  app.nodes().find(n=>n.type==='input'&&n.props?.name==='relay-duration'&&!n.props.checked).props.onChange();await app.flush();await open();await confirm();
  assert.equal(requests[2].durationMinutes,1440);assert.notEqual(requests[2].requestId,requests[0].requestId);
});
test('ordinary guest expiry closes reader and ignores its pending response',async()=>{
  const app=await mountComponent('GuestMailbox',{...testProps,authenticated:false});
  const message={id:'MSG-example',sender:'synthetic',subject:'synthetic',bodyText:'previous body'};
  app.fetch=async()=>Response.json({ok:true,mailbox:testBox,messages:[message]});await app.poll();
  let resolve;app.fetch=()=>new Promise(done=>{resolve=done;});
  const row=app.nodes().find(n=>n.props?.className?.includes('app-mail-row'));assert.ok(row);row.props.onClick();await app.flush();assert.ok(app.nodes().some(n=>n.type==='reader'));
  app.fetch=async()=>Response.json({ok:false},{status:410});await app.poll();assert.ok(!app.nodes().some(n=>n.type==='reader'));
  resolve(Response.json({ok:true,message}));await app.flush();assert.ok(!app.nodes().some(n=>n.type==='reader'));
});

test('purchase request survives page reload, separates user/price and is cleared only on success',async()=>{
  const source=await readFile(new URL('../src/lib/purchase-intent.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const saved=new Map();const storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  const load=()=>{const exports={};runInNewContext(code,{exports,sessionStorage:storage,crypto:{randomUUID}});return exports;};
  const first=load(),params={code:'VIP_30',expectedPrice:100};const id=first.purchaseIntent('one','membership',params);
  assert.equal(load().purchaseIntent('one','membership',params),id);
  assert.notEqual(first.purchaseIntent('two','membership',params),id);
  assert.notEqual(first.purchaseIntent('one','membership',{...params,expectedPrice:200}),id);
  first.completePurchaseIntent('one','membership',params);assert.notEqual(load().purchaseIntent('one','membership',params),id);
});
