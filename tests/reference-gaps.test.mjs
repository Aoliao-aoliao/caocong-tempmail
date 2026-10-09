import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsAddressProfile,NO_STATE_SALES_TAX} from '../server/tools/us-address.mjs';
import {validateMailConfig,isPublicMailAddress,sendResetCode,publicMailConfig} from '../server/auth/password-mail.mjs';
import {encryptPasswordMail,decryptPasswordMail,decryptRelayCredential} from '../server/security/secret-box.mjs';

test('tax-free selection applies to explicit and random states',()=>{
  for(let i=0;i<80;i++)assert.ok(NO_STATE_SALES_TAX.includes(createUsAddressProfile({domain:'mail.example.test',localPart:'valid123',taxFreeOnly:true}).stateCode));
  assert.throws(()=>createUsAddressProfile({domain:'mail.example.test',localPart:'valid123',taxFreeOnly:true,stateCode:'CA'}));
  assert.equal(createUsAddressProfile({domain:'mail.example.test',localPart:'valid123',taxFreeOnly:true,stateCode:'OR'}).stateCode,'OR');
});
test('SMTP configuration requires TLS ports and rejects header injection',()=>{
  const valid={host:'smtp.example.com',port:465,from:'test@example.com',username:'test',enabled:true};
  assert.equal(validateMailConfig(valid).port,465);
  for(const patch of [{port:25},{host:'127.0.0.1'},{from:'test@example.com\r\nBcc: victim@example.com'},{username:'x\n'}])assert.throws(()=>validateMailConfig({...valid,...patch}));
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','192.168.1.1','::1'])assert.equal(isPublicMailAddress(ip),false);
  assert.equal(isPublicMailAddress('8.8.8.8'),true);
});
test('SMTP secrets use purpose-separated encryption and safe public projection',async()=>{
  const secret=encryptPasswordMail('synthetic-password');
  assert.equal(decryptPasswordMail(secret),'synthetic-password');
  assert.throws(()=>decryptRelayCredential(secret));
  const config={host:'smtp.example.com',port:587,from:'sender@example.com',username:'sender',enabled:true,secret:Object.fromEntries(Object.entries(secret).map(([k,v])=>[k,v.toString('base64')]))};
  assert.equal(publicMailConfig(config).secret,undefined);
  let options,message,closed=false;
  await sendResetCode({config,to:'receiver@example.test',code:'12345678'},{resolve:async()=>['8.8.8.8'],createTransport:o=>{options=o;return {sendMail:async m=>{message=m;},close:()=>{closed=true;}};}});
  assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.tls.servername,config.host);assert.equal(options.host,'8.8.8.8');assert.equal(options.logger,false);assert.equal(message.to,'receiver@example.test');assert.equal(closed,true);
  await assert.rejects(sendResetCode({config,to:'receiver@example.test',code:'12345678'},{resolve:async()=>['127.0.0.1'],createTransport:()=>{throw new Error('must not connect');}}),/destination/);
});
