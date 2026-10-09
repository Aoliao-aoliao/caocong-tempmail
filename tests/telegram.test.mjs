import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {validateOrigin,validateBotToken,matchesWebhookSecret,parseBindingUpdate,telegramCall} from '../server/telegram/protocol.mjs';
import {encryptTelegramSecret,decryptTelegramSecret,decryptPasswordMail} from '../server/security/secret-box.mjs';
const token='123456789:'+ 'A'.repeat(35);
test('binding-only purpose is visible in member/admin initial render in all supported languages',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {runInNewContext}=await import('node:vm');
 const ts=(await import('typescript')).default;
 const React=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const jsx=await import('react/jsx-runtime');
 const note='当前仅完成账号绑定，暂不推送邮件或通知，也不能用于登录。';
 const catalog=JSON.parse(await readFile(new URL('../src/lib/ui-translations.json',import.meta.url),'utf8'));
 for(const language of ['cn','tw','en'])for(const name of ['TelegramBinding','TelegramSettings']){
  const source=await readFile(new URL('../src/components/'+name+'.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  runInNewContext(compiled,{exports,require:id=>id==='react'?React:id==='react/jsx-runtime'?jsx:{useTranslator:()=>text=>language==='cn'?text:catalog[text][language]}});
  const html=renderToStaticMarkup(React.createElement(exports.default));
  assert.ok(html.includes(language==='cn'?note:catalog[note][language]),name+' '+language);
  if(name==='TelegramBinding'){
   const unique='每个 Telegram 账号只能绑定一个本站账户。';
   assert.ok(html.includes(language==='cn'?unique:catalog[unique][language]),'binding uniqueness note '+language);
   if(language!=='cn')assert.ok(!html.includes(unique),'untranslated uniqueness note '+language);
  }
 }
});
test('Telegram config validates endpoints and credentials',()=>{
 assert.equal(validateOrigin('https://app.example.com/'),'https://app.example.com');
 for(const value of ['http://example.com','https://example.com/x','https://127.0.0.1','https://localhost','https://a.local','https://u:p@example.com','https://example.com:444','https://example.com/?x=1'])assert.throws(()=>validateOrigin(value));
 assert.equal(validateBotToken(token),token);assert.throws(()=>validateBotToken(token+'\n'));
});
test('Telegram webhook requires matching secret and private human sender',()=>{
 const secret=randomBytes(32).toString('hex');assert.ok(matchesWebhookSecret(secret,secret));assert.ok(!matchesWebhookSecret('',secret));assert.ok(!matchesWebhookSecret(secret+'x',secret));
 const id=randomBytes(32).toString('base64url');const u={update_id:1,message:{chat:{type:'private',id:123},from:{id:123,username:'tester'},text:'/start bind_'+id}};
 assert.deepEqual(parseBindingUpdate(u),{token:id,telegramId:'123',username:'tester'});
 for(const bad of [{...u,update_id:'1'},{...u,message:{...u.message,chat:{type:'group',id:123}}},{...u,message:{...u.message,from:{id:999}}},{...u,message:{...u.message,from:{id:123,is_bot:true}}},{...u,message:{...u.message,text:'/start bind_short'}}])assert.equal(parseBindingUpdate(bad),null);
});
test('Telegram credential encryption is authenticated and isolated from SMTP secrets',()=>{
 const fields=encryptTelegramSecret(token);assert.equal(decryptTelegramSecret(fields),token);assert.throws(()=>decryptPasswordMail(fields));const altered={...fields,ciphertext:Buffer.from(fields.ciphertext)};altered.ciphertext[0]^=1;assert.throws(()=>decryptTelegramSecret(altered));
});
test('Telegram API never exposes token-bearing URL or untrusted platform error',async()=>{
 await assert.rejects(telegramCall(token,'getMe',{},async url=>{throw Error(url);}),e=>e.status===503&&!e.message.includes(token));
 await assert.rejects(telegramCall(token,'getMe',{},async()=>new Response(JSON.stringify({ok:false,description:token}),{status:401})),e=>e.status===400&&!e.message.includes(token));
 await assert.rejects(telegramCall(token,'getUpdates'),/Unsupported/);
 const result=await telegramCall(token,'getMe',{},async(url,opts)=>{assert.ok(url.startsWith('https://api.telegram.org/bot'));assert.equal(opts.redirect,'error');return new Response(JSON.stringify({ok:true,result:{id:1}}));});assert.equal(result.id,1);
});
