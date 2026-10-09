import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const box=n=>({id:`box-${n}`,address:`alias-${n}@example.test`,domain:'example.test',expiresAt:'2099-01-01T00:00:00Z',durationMinutes:60});
const inbox=mailbox=>Response.json({ok:true,mailbox,messages:[],pagination:{page:1,pages:1,total:0}});

// Execute the real component handlers with deterministic hook/timer/network substitutes.
// Browser validation separately covers React hydration, DOM rendering and the widget.
async function mount(kind,{delayRestore=false,initial=box(0)}={}) {
  let cursor=0,dirty=true,tree,current=initial,postCount=0,clock=Date.now();
  const posts=[];
  const slots=[],effects=[],timers=new Map(),pending=[],restore=deferred();let timerId=0;
  const hooks={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;dirty=true;}];},
    useRef(value){const i=cursor++;return slots[i]??=( {current:value} );},
    useMemo(fn){cursor++;return fn();},
    useEffect(fn,deps){const i=cursor++;const previous=slots[i];if(!previous||deps.some((v,n)=>v!==previous.deps[n])){effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()};});}},
  };
  const imports={'./ui/MailReader':{__esModule:true,default:'mail-reader'},react:hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'./TurnstileWidget':{__esModule:true,default:'captcha'},'../lib/useTranslator':{useTranslator:()=>text=>text},'./ui/ChoicePicker':{__esModule:true,default:'picker'},'../lib/clipboard':{copyText:async()=>true},'./ui/useDialog':{useDialog(){}},'../../server/member/mailbox-price.mjs':{discountedMailboxPrice:()=>0}};
  const hookSource=await readFile(new URL('../src/components/ui/useGuestAttempt.ts',import.meta.url),'utf8');
  const globals={exports:{},require:name=>{assert.ok(imports[name],name);return imports[name];},URLSearchParams,Intl,Date:class extends Date{static now(){return clock;}},Error,console,crypto:{randomUUID:()=>String(postCount)},document:{body:{classList:{toggle(){},add(){},remove(){}}},addEventListener(){},removeEventListener(){}},window:{setInterval(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearInterval(id){timers.delete(id);},setTimeout(){},location:{assign(){}}},clearInterval:id=>timers.delete(id),fetch:async(url,options={})=>{
    if(options.method==='POST'){postCount++;posts.push({url,body:JSON.parse(options.body)});const response=deferred();pending.push(response);return response.promise;}
    if(url==='/api/guest/mailbox'&&delayRestore)return restore.promise;
    return url==='/api/guest/mailbox'?Response.json({ok:true,mailbox:current}):inbox(current);
  }};
  const hookExports={};runInNewContext(ts.transpileModule(hookSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{...globals,exports:hookExports});imports['./ui/useGuestAttempt']=hookExports;
  const file=kind==='relay'?'RelayMailbox':'GuestMailbox';
  const source=await readFile(new URL(`../src/components/${file}.tsx`,import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,globals);
  const props={authenticated:false,initialMailbox:current,suffixes:[{suffix:'example.test',provider:'test'}],domains:[{domain:'example.test',kind:'PUBLIC'},{domain:'second.example.test',kind:'PUBLIC'}],plans:[{id:'free',minutes:60,points:0,label:'1 小时'}],memberDiscountPercent:100,turnstileSiteKey:'synthetic',turnstileConfigured:true};
  async function flush(){for(let i=0;i<15;i++){await Promise.resolve();if(dirty){dirty=false;cursor=0;tree=globals.exports.default(props);while(effects.length)effects.shift()();}}}
  function nodes(value=tree){if(!value||typeof value!=='object')return [];if(Array.isArray(value))return value.flatMap(x=>nodes(x));return [value,...nodes(value.props?.children??null)];}
  function clickChange(){const node=nodes().find(x=>['换一个','更换邮箱'].includes(x.props?.['aria-label']))||nodes().find(x=>x.props?.className==='guest-primary-action');assert.ok(node);node.props.onClick();}
  async function verify(){clickChange();await flush();const node=nodes().find(x=>x.type==='captcha');assert.ok(node);node.props.onVerify('synthetic');return node;}
  await flush();
  return {flush,verify,restore,nodes,requests:posts,async selectDomain(value){const node=nodes().find(x=>x.props?.role==='option'&&JSON.stringify(x).includes(value));assert.ok(node);node.props.onClick();await flush();},get domain(){const toggle=nodes().find(x=>x.props?.className==='guest-domain-toggle');return toggle?nodes(toggle).find(x=>x.type==='span')?.props.children:undefined;},async advance(ms){clock+=ms;for(const timer of [...timers.values()].filter(x=>x.ms===1000))timer.fn();await flush();},get posts(){return postCount;},get text(){return JSON.stringify(tree);},get address(){const row=nodes().find(x=>x.props?.className==='guest-current-row');return nodes(row).find(x=>x.type==='strong')?.props.children;},set current(value){current=value;},async complete(mailbox=box(1),status=201,headers={}){current=mailbox;pending.shift().resolve(Response.json(status===201?{ok:true,mailbox}:{ok:false,message:'操作过于频繁，请稍后再试。'},{status,headers}));await flush();},delayPoll(){const oldFetch=globals.fetch;const response=deferred();globals.fetch=(url,options)=>{if(String(url).includes('/messages')&&!options?.method){globals.fetch=oldFetch;return response.promise;}return oldFetch(url,options);};const poll=[...timers.values()].find(x=>x.ms===8000);assert.ok(poll);poll.fn();return response;}};
}

for(const kind of ['ordinary','relay']){
  test(`${kind}: late inbox cannot restore old address or clear new mailbox`,async()=>{
    for(const code of [200,410]){
      const app=await mount(kind);const old=app.delayPoll();
      await app.verify();await app.complete();assert.equal(app.address,box(1).address);
      old.resolve(code===200?inbox(box(0)):Response.json({ok:false},{status:410}));await app.flush();
      assert.equal(app.address,box(1).address);assert.match(app.text,/邮箱已更换/);
    }
  });
  test(`${kind}: duplicate verification callback sends one POST`,async()=>{
    const app=await mount(kind);const captcha=await app.verify();captcha.props.onVerify('duplicate');
    assert.equal(app.posts,1);await app.complete();assert.equal(app.address,box(1).address);
  });
  test(`${kind}: failure stops auto callbacks and only explicit retry rearms`,async()=>{
    const app=await mount(kind);await app.verify();await app.complete(box(0),503);
    assert.equal(app.address,box(0).address);assert.match(app.text,/操作过于频繁/);
    assert.equal(app.nodes().find(x=>x.type==='captcha'),undefined);
    const retry=app.nodes().find(x=>x.props?.children==='重新验证');assert.ok(retry);retry.props.onClick();await app.flush();
    const captcha=app.nodes().find(x=>x.type==='captcha');assert.ok(captcha);captcha.props.onVerify('retry');await app.complete();assert.equal(app.address,box(1).address);
  });
  test(`${kind}: unchanged success response is reported as failure`,async()=>{
    const app=await mount(kind);await app.verify();await app.complete(box(0));
    assert.equal(app.address,box(0).address);assert.match(app.text,/邮箱地址未更换/);
  });
}
test('ordinary: initial session restore arriving after creation cannot restore old address',async()=>{
  const app=await mount('ordinary',{delayRestore:true});await app.verify();await app.complete();
  app.restore.resolve(Response.json({ok:true,mailbox:box(0)}));await app.flush();assert.equal(app.address,box(1).address);
});

for(const kind of ['ordinary','relay']){
 test(`${kind}: rate limit unmounts CAPTCHA and blocks queued success callbacks and reopening`,async()=>{
  const app=await mount(kind);const captcha=await app.verify();await app.complete(box(0),429);
  assert.equal(app.nodes().find(x=>x.type==='captcha'),undefined);
  for(let i=0;i<5;i++)captcha.props.onVerify('automatic-repeat');
  const retry=app.nodes().find(x=>x.props?.children==='60s');assert.ok(retry?.props.disabled);retry.props.onClick();await app.flush();
  assert.equal(app.posts,1);assert.equal(app.address,box(0).address);
 });
 test(`${kind}: callbacks from a closed dialog cannot submit`,async()=>{
  const app=await mount(kind);const captcha=await app.verify();await app.complete(box(0),503);
  const close=app.nodes().find(x=>x.type==='button'&&x.props.children==='取消');assert.ok(close);close.props.onClick();await app.flush();
  captcha.props.onVerify('late');assert.equal(app.posts,1);
 });
}

for(const kind of ['ordinary','relay']) {
 test(`${kind}: Retry-After countdown ends without automatically submitting, and stale callbacks stay rejected`,async()=>{
  const app=await mount(kind);const old=await app.verify();await app.complete(box(0),429,{'retry-after':'2'});
  assert.ok(app.nodes().find(x=>x.type==='button'&&x.props.children==='2s')?.props.disabled);
  await app.advance(2000);assert.equal(app.posts,1);
  const retry=app.nodes().find(x=>x.type==='button'&&x.props.children==='重新验证');assert.ok(retry&&!retry.props.disabled);retry.props.onClick();await app.flush();
  old.props.onVerify('late-old-token');assert.equal(app.posts,1);
  app.nodes().find(x=>x.type==='captcha').props.onVerify('new-token');await app.complete();assert.equal(app.posts,2);assert.equal(app.address,box(1).address);
 });
}


test('ordinary: restoring a relay inbox preserves reading but creates with a public suffix',async()=>{
 const relay={...box(0),address:'base+alias@relay.example.test',domain:'relay.example.test'};
 const app=await mount('ordinary',{initial:relay});
 assert.equal(app.address,relay.address);assert.equal(app.domain,'example.test');
 await app.verify();assert.equal(app.requests[0].body.domain,'example.test');assert.equal(app.requests[0].url,'/api/guest/mailbox');
 await app.complete();assert.equal(app.address,box(1).address);
});
test('ordinary: background inbox refresh does not overwrite the next selected suffix',async()=>{
 const app=await mount('ordinary');await app.selectDomain('second.example.test');
 const poll=app.delayPoll();poll.resolve(inbox(box(0)));await app.flush();
 assert.equal(app.domain,'second.example.test');assert.equal(app.address,box(0).address);
 await app.verify();assert.equal(app.requests[0].body.domain,'second.example.test');
 await app.complete({...box(1),domain:'second.example.test',address:'new@second.example.test'});
});
test('ordinary: late session restore preserves a manually selected public suffix',async()=>{
 const app=await mount('ordinary',{delayRestore:true});await app.selectDomain('second.example.test');
 app.restore.resolve(Response.json({ok:true,mailbox:box(0)}));await app.flush();
 assert.equal(app.domain,'second.example.test');assert.equal(app.address,box(0).address);
});
test('ordinary: an existing public mailbox restores its eligible suffix',async()=>{
 const app=await mount('ordinary',{initial:{...box(0),domain:'second.example.test',address:'old@second.example.test'}});
 assert.equal(app.domain,'second.example.test');
});
