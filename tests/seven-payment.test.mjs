import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

const baseOrder={id:'GP-'+'1'.repeat(28),status:'PENDING',points:50,amountUsdCents:123,actualAmount:'1.234567',receiveAddress:'T'+'A'.repeat(33),qrCodeDataUrl:'data:image/png;base64,AAAA',paymentUrl:'https://pay.example.test/pay/checkout-counter/t_1',expiresAt:new Date(Date.now()+600000).toISOString()};
async function compile(path,imports,globals={}){
 const source=await readFile(new URL(path,import.meta.url),'utf8'),exports={};
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 runInNewContext(code,{exports,require:name=>{assert.ok(imports[name],name);return imports[name];},Date,Error,Buffer,Response,URL,AbortController,console,...globals});return exports;
}

async function paymentFixture(){
 const rows=new Map(),counters=new Map(),calls=[];let creates=0,credits=0,balance=0,lockRace=false,failGateway=false,onOriginalLock;
 const original={id:baseOrder.id,user_id:1,request_id:randomUUID(),plan_code:'P50',merchant_pid:'synthetic',points:50,amount_usd_cents:123,status:'PENDING',create_state:'BOUND',trade_id:'t_1',actual_amount:'1.234567',receive_address:baseOrder.receiveAddress,payment_url:baseOrder.paymentUrl,expires_at:new Date(Date.now()-10000)};
 rows.set(original.id,original);counters.set('t_1',{order_id:original.id,trade_id:'t_1',amount:1.23,actual_amount:1.234567,receive_address:original.receive_address,token:'USDT',currency:'USD',network:'tron',status:3});
 const connection={async beginTransaction(){},async commit(){},async rollback(){},release(){},async execute(sql,args=[]){
  calls.push(sql);
  if(sql.startsWith('SELECT * FROM gmpay_payment_orders')){
   let row=sql.includes('request_id=?')?[...rows.values()].find(x=>x.user_id===args[0]&&x.request_id===args[1]):rows.get(args[0]);
   if(sql.includes('id=? AND user_id=?')&&row?.user_id!==args[1])row=undefined;
   if(row&&onOriginalLock&&sql.includes('FOR UPDATE')&&row.id===original.id){const hook=onOriginalLock;onOriginalLock=undefined;hook();}
   if(row&&lockRace&&sql.includes('FOR UPDATE')&&row.id===original.id){row.status='PAID';lockRace=false;}
   return [[row?{...row}:undefined].filter(Boolean)];
  }
  if(sql.startsWith('SELECT id FROM users'))return [[{id:1}]];
  if(sql.startsWith('SELECT points_balance FROM users'))return [[{points_balance:balance}]];
  if(sql.startsWith('SELECT code,points'))return [[{code:'P50',points:50,amount_usd_cents:123}]];
  if(sql.startsWith('SELECT value FROM system_settings'))return [[{value:'3'}]];
  if(sql.startsWith('SELECT COUNT(*)'))return [[{n:[...rows.values()].filter(x=>x.status==='PENDING'&&x.expires_at>Date.now()).length}]];
  if(sql.startsWith('INSERT INTO gmpay_payment_orders')){const [id,user_id,request_id,plan_code,merchant_pid,points,amount_usd_cents]=args;rows.set(id,{id,user_id,request_id,plan_code,merchant_pid,points,amount_usd_cents,status:'PENDING',create_state:'NEW',expires_at:new Date(Date.now()+1800000)});return [{affectedRows:1}];}
  if(sql.includes("SET create_state='REQUESTED'")){const row=rows.get(args[0]);if(row.create_state!=='NEW')return [{affectedRows:0}];row.create_state='REQUESTED';return [{affectedRows:1}];}
  if(sql.includes("SET create_state='UNKNOWN'")){const row=rows.get(args[0]);if(row.create_state==='REQUESTED')row.create_state='UNKNOWN';return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE gmpay_payment_orders SET trade_id=')){const [trade_id,actual_amount,receive_address,payment_url,expires_at,id]=args;Object.assign(rows.get(id),{trade_id,actual_amount,receive_address,payment_url,expires_at,create_state:'BOUND'});return [{affectedRows:1}];}
  if(sql.includes("SET status='PAID'")){const [trade_id,actual_amount,receive_address,block_transaction_id,id]=args;Object.assign(rows.get(id),{trade_id,actual_amount,receive_address,block_transaction_id,status:'PAID',create_state:'BOUND'});return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE users SET points_balance')){balance=args[0];return [{affectedRows:1}];}
  if(sql.startsWith('INSERT INTO point_transactions')){credits++;return [{affectedRows:1}];}
  throw Error('Unexpected SQL: '+sql);
 }};
 const protocol=await import('../server/payment/gmpay-protocol.mjs');
 const cfg={pid:'synthetic',secret:'synthetic-test-secret',site:'https://example.test',enabled:true};
 const gateway=async(path,options)=>{
  if(failGateway)throw protocol.fail();
  if(path.includes('create-transaction')){creates++;const p=options.payload,trade_id='t_'+(creates+1);const data={order_id:p.order_id,trade_id,amount:1.23,actual_amount:1.234567,receive_address:baseOrder.receiveAddress,currency:'USD',token:'USDT',network:'tron',status:1,expiration_time:Date.now()+600000,payment_url:'https://pay.example.test/pay/checkout-counter/'+trade_id};counters.set(trade_id,data);return data;}
  return {...counters.get(path.split('/').at(-1))};
 };
 const service=await compile('../server/payment/gmpay-service.mjs',{'node:crypto':await import('node:crypto'),'../db/database.mjs':{openDatabase:async()=>connection},'./gmpay-protocol.mjs':{...protocol,gateway},'./gmpay-config.mjs':{resolvedConfig:async()=>cfg,notificationConfig:async()=>cfg},qrcode:{__esModule:true,default:{toDataURL:async()=>baseOrder.qrCodeDataUrl}}});
 const input=()=>({userId:1,requestId:randomUUID(),planCode:'P50',expectedPoints:50,expectedAmountUsdCents:123,replacesOrderId:original.id});
 return {service,original,rows,counters,calls,input,get creates(){return creates;},get credits(){return credits;},set lockRace(value){lockRace=value;},set failGateway(value){failGateway=value;},set onOriginalLock(value){onOriginalLock=value;}};
}

test('expired bound order permits explicit replacement, idempotent retry, and retains original',async()=>{
 const f=await paymentFixture(),input=f.input();
 assert.equal((await f.service.queryOrder({userId:1,id:f.original.id})).canReplace,true);
 const fresh=await f.service.createOrder(input);assert.notEqual(fresh.id,f.original.id);assert.equal(f.creates,1);assert.equal(f.original.status,'PENDING');
 assert.equal((await f.service.createOrder(input)).id,fresh.id);assert.equal(f.creates,1);assert.equal(f.rows.size,2);
 // A later signed/gateway payment is still processed for the original, once.
 f.counters.get('t_1').status=2;assert.equal((await f.service.queryOrder({userId:1,id:f.original.id})).status,'PAID');
 await f.service.queryOrder({userId:1,id:f.original.id});assert.equal(f.credits,1);
 assert.equal((await f.service.createOrder(input)).id,fresh.id);assert.equal(f.creates,1);
});

test('replacement rejects unexpired, upstream-pending, UNKNOWN, failed gateway, wrong owner and changed plan',async()=>{
 for(const condition of ['local-live','upstream-pending','unknown','gateway-failure','wrong-owner','wrong-plan']){
  const f=await paymentFixture(),input=f.input();
  if(condition==='local-live')f.original.expires_at=new Date(Date.now()+600000);
  if(condition==='upstream-pending')f.counters.get('t_1').status=1;
  if(condition==='unknown'){f.original.create_state='UNKNOWN';f.original.trade_id=null;}
  if(condition==='gateway-failure')f.failGateway=true;
  if(condition==='wrong-owner')input.userId=2;
  if(condition==='wrong-plan')input.expectedPoints=51;
  await assert.rejects(f.service.createOrder(input));assert.equal(f.creates,0,condition);assert.equal(f.rows.size,1,condition);
 }
});

test('paid before replacement or during transaction prevents a new order',async()=>{
 for(const timing of ['local','gateway','race']){
  const f=await paymentFixture();
  if(timing==='local')f.original.status='PAID';
  if(timing==='gateway')f.counters.get('t_1').status=2;
  if(timing==='race')f.lockRace=true;
  assert.equal((await f.service.createOrder(f.input())).status,'PAID');assert.equal(f.creates,0);assert.equal(f.rows.size,1);
 }
});

test('lost replacement result resumes UNKNOWN without another upstream create',async()=>{
 const f=await paymentFixture(),input=f.input(),first=await f.service.createOrder(input),row=f.rows.get(first.id);
 row.create_state='UNKNOWN';row.trade_id=null;row.payment_url=null;
 await assert.rejects(f.service.createOrder(input));assert.equal(f.creates,1);assert.equal(f.rows.size,2);
});

test('concurrent replacement followed by original PAID is preferred after taking the old order lock',async()=>{
 const f=await paymentFixture(),input=f.input(),newId='GP-'+'2'.repeat(28);
 f.onOriginalLock=()=>{f.original.status='PAID';f.rows.set(newId,{...f.original,id:newId,request_id:input.requestId,status:'PENDING',trade_id:'t_2',payment_url:'https://pay.example.test/pay/checkout-counter/t_2',expires_at:new Date(Date.now()+600000)});};
 assert.equal((await f.service.createOrder(input)).id,newId);assert.equal(f.creates,0);assert.equal(f.rows.size,2);
});

async function mountRecharge(){
 let cursor=0,dirty=true,tree,handler,serial=0;const slots=[];
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;dirty=true;}];},useRef(initial){return slots[cursor++]??={current:initial};}};
 const imports={react:hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'./GmpayCheckout':{__esModule:true,default:'checkout'},'./PaymentPicker':{__esModule:true,default:'picker'},'./MemberHistory':{__esModule:true,default:'history',PendingRechargeOrders:'pending'}};
 const ui=await compile('../src/components/RechargeConsole.tsx',imports,{crypto:{randomUUID},fetch:(...args)=>handler(...args),setTimeout:()=>++serial,clearTimeout(){},window:{location:{assign(){throw Error('Unexpected navigation');}}}});
 const props={plans:[{code:'P50',points:50,amount_usd_cents:123}],channels:[],initialView:{enabled:false,plans:[]},initialGmpay:{enabled:true,origin:'https://pay.example.test'},orders:[],pagination:{page:1,pages:1,total:0,pageSize:10}};
 async function flush(){for(let i=0;i<50;i++){await Promise.resolve();if(dirty){dirty=false;cursor=0;tree=ui.default(props);}}}
 function nodes(n=tree){if(!n||typeof n!=='object')return [];if(Array.isArray(n))return n.flatMap(x=>nodes(x??null));return [n,...nodes(n.props?.children??null)];}
 const requests=[];handler=async(url,options)=>{if(!options)return Response.json({ok:true,enabled:false,plans:[]});requests.push(JSON.parse(options.body));return Response.json({ok:true,result:baseOrder});};
 await flush();nodes().find(n=>n.type==='input'&&n.props.name==='recharge-plan').props.onChange();await flush();
 return {flush,nodes,requests,set handler(fn){handler=async(url,o)=>{if(!o)return Response.json({ok:true,enabled:false,plans:[]});const body=JSON.parse(o.body);requests.push(body);return fn(body,o);};},create(){nodes().find(n=>n.props?.className==='create-order').props.onClick();},get checkout(){return nodes().find(n=>n.type==='checkout')?.props;}};
}

test('UI preserves request on active close, lost response and repeated clicks',async()=>{
 const app=await mountRecharge();app.create();app.create();await app.flush();assert.equal(app.requests.length,1);
 app.checkout.onClose();await app.flush();app.create();await app.flush();assert.equal(app.requests[0].requestId,app.requests[1].requestId);
 app.checkout.onClose();await app.flush();app.handler=async()=>{throw Error('timeout');};app.create();await app.flush();app.create();await app.flush();assert.equal(new Set(app.requests.map(r=>r.requestId)).size,1);
});

test('expired close reopens original; explicit replacement switches once and retries same id',async()=>{
 const app=await mountRecharge(),expired={...baseOrder,expiresAt:new Date(Date.now()-1000).toISOString()};app.handler=async()=>Response.json({ok:true,result:expired});
 app.create();await app.flush();app.checkout.onClose();await app.flush();app.create();await app.flush();assert.equal(app.requests.length,1);assert.equal(app.checkout.order.id,expired.id);
 app.handler=async()=>{throw Error('lost response');};app.checkout.onRestart();app.checkout.onRestart();await app.flush();assert.equal(app.requests.length,2);assert.notEqual(app.requests[1].requestId,app.requests[0].requestId);assert.equal(app.requests[1].replacesOrderId,expired.id);
 app.checkout.onRestart();await app.flush();assert.equal(app.requests[2].requestId,app.requests[1].requestId);
 app.checkout.onClose();await app.flush();app.create();await app.flush();assert.equal(app.requests[3].requestId,app.requests[1].requestId);assert.equal(app.requests[3].replacesOrderId,expired.id);
});

test('replacement PAID response stops checkout without automatically creating again',async()=>{
 const app=await mountRecharge();app.handler=async()=>Response.json({ok:true,result:{...baseOrder,expiresAt:new Date(Date.now()-1000).toISOString()}});app.create();await app.flush();
 app.handler=async()=>Response.json({ok:true,result:{id:baseOrder.id,status:'PAID'}});app.checkout.onRestart();await app.flush();assert.equal(app.checkout,undefined);assert.equal(app.requests.length,2);
 assert.match(JSON.stringify(app.nodes()),/支付已核实/);
});

test('replacement copy is present in all three languages',async()=>{
 const catalog=JSON.parse(await readFile(new URL('../src/lib/ui-translations.json',import.meta.url),'utf8'));
 for(const text of ['仅未转账时重新生成；已转账请继续查询原订单。','未转账，重新生成','重新生成时请保留原充值档位。','原订单尚未确认过期，请查询到账；已转账请勿重新生成。','原订单状态已变化，请查询到账后重试。']){
  assert.ok(catalog[text]?.en,text);assert.ok(catalog[text]?.tw,text);
 }
});
