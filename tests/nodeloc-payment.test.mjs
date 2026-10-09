import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign as rsaSign} from 'node:crypto';
import {canonical,signature,verified,moneyCents,paymentUrl,queryParameters,gatewayRequest,safeRejectionReason} from '../server/payment/nodeloc-protocol.mjs';
import {assertPayment} from '../server/payment/nodeloc-service.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const signed=p=>({...p,sign_type:'RSA',sign:signature(p,keys.privateKey)});
test('RSA canonicalization preserves unicode, signs unknown fields, excludes only signature metadata/empty',()=>{
 const p={z:'',b:'付款',a:'1',extra:'future'};assert.equal(canonical(p),'a=1&b=付款&extra=future');const data=signed(p);assert.ok(verified(data,keys.publicKey));assert.ok(!verified({...data,extra:'tampered'},keys.publicKey));assert.ok(!verified({...data,sign_type:'MD5'},keys.publicKey));assert.throws(()=>canonical({data:{status:1}}));
});
test('payment URLs, decimal money and duplicate notification keys fail closed',()=>{
 assert.equal(moneyCents('25.00'),2500);assert.equal(moneyCents('25'),2500);for(const n of ['25.001','2e2','-1','NaN'])assert.throws(()=>moneyCents(n));
 for(const u of ['http://www.nodeloc.com/payment/pay/x','https://evil.test/payment/x','https://www.nodeloc.com.evil.test/payment/x','https://user@www.nodeloc.com/payment/x'])assert.throws(()=>paymentUrl(u));
 assert.throws(()=>queryParameters(new URL('https://example.test/?pid=1&pid=2')));
});
test('signed callbacks still require exact merchant, amount, order and transaction',()=>{
 const order={id:'NL-example',energy:25,trade_no:'T1',config_json:{pid:'123',platformKey:keys.publicKey}};
 const data={pid:'123',out_trade_no:order.id,money:'25.00',trade_no:'T1',trade_status:'TRADE_SUCCESS',timestamp:'1234567890'};
 assert.ok(assertPayment(signed(data),order,{notification:true}));
 for(const change of [{pid:'124'},{money:'24.99'},{out_trade_no:'NL-other'},{trade_no:'T2'}])assert.throws(()=>assertPayment(signed({...data,...change}),order,{notification:true}));
 assert.equal(assertPayment(signed({...data,trade_status:'WAIT_BUYER_PAY'}),order,{notification:true}),false);
});
test('gateway requests target fixed HTTPS host, reject redirects/unsigned/oversized replies',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 let called=false;await gatewayRequest('query',{out_trade_no:'NL-test'},config,{fetchImpl:async(url,options)=>{
  called=true;assert.equal(url,'https://www.nodeloc.com/payment/api/pay/query');assert.equal(options.redirect,'error');assert.ok(options.signal);const p=Object.fromEntries(options.body);assert.ok(verified(p,keys.publicKey));assert.match(p.timestamp,/^\d{10}$/);return Response.json(signed({code:0,status:'0'}));
 }});assert.ok(called);
 await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>Response.json({status:1})}));
 await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>new Response('x'.repeat(33000))}));
});
test('unsigned gateway rejections give fixed guidance without trusting payment data or leaking response text',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 const logs=[],original=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{
  for(const [msg,expected] of [['签名验证失败','商户私钥'],['商户不存在','商户 ID'],['时间戳无效或已过期','服务器时间'],['订单不存在','继续付款']]){
   await assert.rejects(gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json({code:1,msg,trade_no:'fake',pay_type:'jump',pay_info:'https://www.nodeloc.com/payment/fake',private_key:keys.privateKey})}),e=>e.status===503&&e.message.includes(expected));
  }
  await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>Response.json({code:1,msg:'secret-value-do-not-expose'})}),e=>e.message.includes('拒绝了这次支付请求')&&!e.message.includes('secret-value'));
  await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>Response.json({...signed({code:0,status:1}),msg:'签名验证失败'})}),e=>e.message.includes('响应签名未通过验证'));
  assert.deepEqual(logs,['[NodeLoc] REQUEST_SIGNATURE','[NodeLoc] MERCHANT_UNKNOWN','[NodeLoc] REQUEST_TIMESTAMP','[NodeLoc] ORDER_UNKNOWN','[NodeLoc] GATEWAY_REJECTED','[NodeLoc] RESPONSE_SIGNATURE']);
  assert.ok(!logs.join('').includes('PRIVATE KEY'));
 }finally{console.warn=original;}
});
test('transport diagnostics distinguish timeout, HTTP and malformed replies; paid code 1 still requires RSA',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>{throw new DOMException('secret-network-details','TimeoutError');}}),e=>e.message.includes('超时')&&!e.message.includes('secret-network'));
 await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>{throw Error('secret-network-details');}}),e=>e.message.includes('无法连接')&&!e.message.includes('secret-network'));
 await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>new Response('private upstream text',{status:403})}),e=>e.message.includes('连接 NodeLoc 支付网关失败'));
 for(const value of ['invalid json','null','[]'])await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>new Response(value)}),e=>e.message.includes('无法识别'));
 const result=await gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json(signed({code:1,trade_no:'T1'}))});assert.equal(result.trade_no,'T1');
});
test('official V2 default RSA replies verify without sign_type; notifications remain explicit',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 const data={code:0,pay_info:'https://www.nodeloc.com/payment/pay/synthetic',pay_type:'jump',trade_no:'T1'};
 // Independent fixture follows the official SDK signing steps, without our canonical helper.
 data.sign=rsaSign('RSA-SHA256',Buffer.from('code=0&pay_info=https://www.nodeloc.com/payment/pay/synthetic&pay_type=jump&trade_no=T1'),keys.privateKey).toString('base64');
 assert.equal(verified(data,keys.publicKey),false);
 assert.equal(verified(data,keys.publicKey,{defaultRsa:true}),true);
 const fetchReply=reply=>({fetchImpl:async()=>Response.json(reply)});
 assert.equal((await gatewayRequest('create',{},config,fetchReply(data))).trade_no,'T1');
 for(const changed of [{...data,pay_info:'https://www.nodeloc.com/payment/pay/changed'},{...data,sign_type:'MD5'},{...data,sign_type:''},{...data,sign:'invalid'}])await assert.rejects(gatewayRequest('create',{},config,fetchReply(changed)));
 const unsigned={...data};delete unsigned.sign;
 await assert.rejects(gatewayRequest('create',{},config,fetchReply(unsigned)),e=>e.message.includes('缺少签名'));
 const order={id:'NL-example',energy:25,trade_no:'T1',config_json:{pid:'123',platformKey:keys.publicKey}};
 const query=signed({code:0,pid:'123',out_trade_no:order.id,money:'25.00',trade_no:'T1',status:1,trade_status:'TRADE_SUCCESS'});delete query.sign_type;
 assert.equal(assertPayment(query,order),true);
 assert.throws(()=>assertPayment(query,order,{notification:true}));
});
test('business rejection codes cannot become payment links or paid query results',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 for(const reply of [{code:42,msg:'sensitive upstream text'},signed({code:42,trade_no:'T1',pay_type:'jump',pay_info:'https://www.nodeloc.com/payment/pay/synthetic'}),{code:1,trade_no:'T1'}]){
  await assert.rejects(gatewayRequest('query',{},config,{fetchImpl:async()=>Response.json(reply)}),e=>e.message.includes('拒绝了这次支付请求')&&!e.message.includes('sensitive'));
 }
 await assert.rejects(gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json({code:1,trade_no:'T1'})}),e=>e.message.includes('缺少签名'));
 await assert.rejects(gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json(signed({code:1,trade_no:'T1',pay_info:'https://www.nodeloc.com/payment/pay/synthetic'}))}),e=>e.message.includes('拒绝了这次支付请求'));
});
test('Chinese rejection reasons are actionable; credentials, URLs and raw payloads never escape',async()=>{
 const config={pid:'123',privateKey:keys.privateKey,platformKey:keys.publicKey};
 assert.equal(safeRejectionReason('商户未配置公钥'),'商户未配置公钥');
 assert.equal(safeRejectionReason('out_trade_no 格式无效'),'商户订单号 格式无效');
 for(const value of [keys.privateKey,keys.publicKey,'https://example.test/private', 'abcdef0123456789abcdef0123456789', 'msg=付款失败&sign=secret','订单 '+ 'abc123', '异常'.repeat(81),{msg:'商户停用'}])assert.equal(safeRejectionReason(value),'');
 const logs=[],original=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{
  await assert.rejects(gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json({code:2,msg:'支付应用尚未启用'})}),e=>e.status===503&&e.message.includes('返回码 2')&&e.message.includes('支付应用尚未启用'));
  await assert.rejects(gatewayRequest('create',{},config,{fetchImpl:async()=>Response.json({code:2,msg:keys.privateKey})}),e=>!e.message.includes('PRIVATE KEY'));
  assert.deepEqual(logs,['[NodeLoc] GATEWAY_REJECTED','[NodeLoc] GATEWAY_REJECTED']);
 }finally{console.warn=original;}
});
