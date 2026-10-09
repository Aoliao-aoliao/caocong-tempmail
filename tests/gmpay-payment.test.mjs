import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutExpiration,canonical,signature,verified,units,config,publicConfig,gateway,paymentUrl,assertNotification,assertCounter} from '../server/payment/gmpay-protocol.mjs';
const key='synthetic-secret-key-only',env={GMPAY_ENABLED:'true',GMPAY_PID:'1000',GMPAY_SECRET_KEY:key};
const signed=p=>({...p,signature:signature(p,key)});
const address='T'+'A'.repeat(33),order={id:'GP-'+'1'.repeat(28),merchant_pid:'1000',points:100,amount_usd_cents:123,trade_id:'t_1',actual_amount:'1.234567',receive_address:address};
const notification={pid:'1000',order_id:order.id,trade_id:'t_1',amount:1.23,actual_amount:1.234567,receive_address:address,token:'USDT',block_transaction_id:'a'.repeat(64),status:2};
const counter={order_id:order.id,trade_id:'t_1',amount:1.23,actual_amount:1.234567,receive_address:address,token:'USDT',currency:'USD',network:'tron',status:2};
test('GMPay v2 ASCII canonical and HMAC SHA256 match independent reference',()=>{
 assert.equal(canonical({z:0,a:'中文',signature:'ignored',empty:'',absent:null,n:1e-7}),'a=中文&n=0.0000001&z=0');
 assert.equal(signature({amount:100,order_id:'ORD20260424001',pid:'1000'},'test-secret'),'a10a66f6ad84b0970eab16f04f5596c0594fef9f3256e5f6d96005da5a50b750');
 assert.ok(verified(signed(notification),key));assert.ok(!verified({...signed(notification),amount:1.22},key));assert.ok(!verified({...notification,signature:'0'.repeat(32)},key));
 assert.throws(()=>canonical({a:{nested:1}}));assert.throws(()=>canonical({n:NaN}));
});
test('exact fiat/token arithmetic rejects fractions, rounding and invalid values',()=>{
 assert.equal(units('1.230000',2),123n);assert.equal(units(1e-6),1n);assert.throws(()=>units('1.230001',2));assert.throws(()=>units('0.0000001'));assert.throws(()=>units(-1));assert.throws(()=>units('Infinity'));
});
test('credentials stay backend-only and destinations stay pinned',()=>{
 assert.equal(config(env).pid,'1000');assert.ok(!JSON.stringify(publicConfig(env)).includes(key));assert.ok(!JSON.stringify(publicConfig(env)).includes('1000'));assert.equal(publicConfig({}).enabled,false);
 assert.throws(()=>config({...env,GMPAY_BASE_URL:'https://evil.example'}));assert.throws(()=>config({...env,GMPAY_SECRET_KEY:''}));assert.throws(()=>config({...env,GMPAY_SITE_ORIGIN:'http://example.test'}));
 assert.equal(paymentUrl('https://pay.example.test/pay/checkout-counter/t_1','t_1'),'https://pay.example.test/pay/checkout-counter/t_1');
 for(const u of ['https://evil.example/pay/checkout-counter/t_1','https://user@pay.example.test/pay/checkout-counter/t_1','https://pay.example.test/pay/checkout-counter/t_2','https://pay.example.test/pay/checkout-counter/t_1?redirect=evil'])assert.throws(()=>paymentUrl(u,'t_1'));
});
test('signed callback must bind merchant, order, fiat, precise USDT, target and chain hash',()=>{
 assertNotification(signed(notification),order,config(env));
 for(const change of [{pid:'other'},{order_id:'GP-other'},{amount:1.22},{actual_amount:1.23},{token:'TRX'},{network:'ethereum'},{currency:'CNY'},{trade_id:'t_2'},{receive_address:'T'+'B'.repeat(33)},{status:1},{block_transaction_id:'invalid'}])assert.throws(()=>assertNotification(signed({...notification,...change}),order,config(env)));
 assert.throws(()=>assertNotification(signed({...notification,block_transaction_id:'b'.repeat(64)}),{...order,block_transaction_id:'a'.repeat(64)},config(env)));
});
test('counter network/currency and precise settlement match callback binding',()=>{
 assertCounter(counter,order);assertCounter({...counter,order_id:undefined},order);for(const change of [{order_id:'GP-other'},{network:'ethereum'},{currency:'CNY'},{token:'TRX'},{actual_amount:1.23},{trade_id:'t_2'},{receive_address:'other'},{amount:1.24},{block_transaction_id:'bad'}])assert.throws(()=>assertCounter({...counter,...change},order));
});
test('gateway uses pinned HTTPS, rejects redirects, failed envelopes and oversized data',async()=>{
 const data=await gateway('/pay/checkout-counter-resp/t_1',{fetchImpl:async(url,o)=>{assert.equal(url,'https://pay.example.test/pay/checkout-counter-resp/t_1');assert.equal(o.redirect,'error');assert.ok(o.signal);return Response.json({status_code:200,data:counter});}});assert.equal(data.status,2);
 await assert.rejects(gateway('/pay/checkout-counter-resp/t_1',{fetchImpl:async()=>Response.json({status_code:401,message:key})}));
 await assert.rejects(gateway('/pay/checkout-counter-resp/t_1',{fetchImpl:async()=>new Response('a'.repeat(33000))}));
 let called=false;await assert.rejects(gateway('https://evil.example',{fetchImpl:async()=>{called=true;}}));assert.equal(called,false);
});

test('GMPay encryption is randomized, authenticated and isolated from other secrets',async()=>{
 const {encryptGmpay,decryptGmpay,decryptPayment}=await import('../server/security/secret-box.mjs');const box=encryptGmpay(key),other=encryptGmpay(key);assert.equal(decryptGmpay(box),key);assert.notDeepEqual(box.ciphertext,other.ciphertext);assert.throws(()=>decryptPayment(box));box.ciphertext[0]^=1;assert.throws(()=>decryptGmpay(box));
});

test('official v2 checkout milliseconds and create seconds normalize with bounded expiry',()=>{
 const now=Date.UTC(2026,9,5,16),deadline=now+600000;
 assert.equal(checkoutExpiration(deadline,now).getTime(),deadline);
 assert.equal(checkoutExpiration(deadline/1000,now).getTime(),deadline);
 for(const value of [now,now/1000,now-1,now+24*3600000+1,0,-1,1.5,'1791216600000',NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>checkoutExpiration(value,now));
});

test('recharge renders only enabled online channels and disables checkout when both are unavailable',async()=>{
 const {readFile}=await import('node:fs/promises');const {createRequire}=await import('node:module');const {runInNewContext}=await import('node:vm');
 const ts=(await import('typescript')).default,React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const require=createRequire(import.meta.url),exports={};
 const source=await readFile(new URL('../src/components/RechargeConsole.tsx',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(compiled,{exports,require:specifier=>{
  if(specifier==='./PaymentPicker')return {__esModule:true,default:({channels})=>React.createElement('select',{},...channels.map(c=>React.createElement('option',{key:c.code,value:c.code},c.label)))};
  if(specifier==='./MemberHistory')return {__esModule:true,default:()=>null,PendingRechargeOrders:()=>null};
  if(specifier==='./GmpayCheckout')return {__esModule:true,default:()=>null};
  return require(specifier);
 }});
 const props={plans:[{code:'POINTS_100',points:100,amount_usd_cents:100}],channels:[{code:'USD_ALIPAY',mode:'FIAT',label:'支付宝'},{code:'USDC_ERC20',mode:'CRYPTO',token:'USDC',network:'Ethereum',label:'USDC'}],orders:[],pagination:{page:1,pageSize:10,total:0,totalPages:1}};
 for(const nodeloc of [false,true])for(const gmpay of [false,true]){
  const html=renderToStaticMarkup(React.createElement(exports.default,{...props,initialView:{enabled:nodeloc,plans:[]},initialGmpay:{enabled:gmpay,origin:'https://pay.example.test'}}));
  assert.equal(html.includes('value="NODELOC_ENERGY"'),nodeloc);assert.equal(html.includes('value="GMPAY_USDT"'),gmpay);
  assert.doesNotMatch(html,/USD_ALIPAY|USDC_ERC20|支付宝|生成待支付订单/);
  if(!nodeloc&&!gmpay)assert.match(html,/disabled=""/);
 }
});
