import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {validateConfig,authorizationUrl,checkedIdentity,exchangeIdentity} from '../server/auth/nodeloc-protocol.mjs';
import {encryptNodelocOAuth,decryptNodelocOAuth,decryptMicrosoft} from '../server/security/secret-box.mjs';
const config={enabled:true,origin:'https://app.example.test',clientId:'client-id',clientSecret:'private-secret'};
test('NodeLoc canonical configuration and fixed authorization scope',()=>{
  assert.equal(validateConfig({...config,origin:config.origin+'/'}).origin,config.origin);
  for(const origin of ['http://app.example.test','https://u:p@app.example.test','https://app.example.test/path','https://app.example.test/?x=1','https://app.example.test/#x'])assert.throws(()=>validateConfig({...config,origin}));
  assert.throws(()=>validateConfig({...config,clientId:'a\nb'}));assert.throws(()=>validateConfig({...config,enabled:'true'}));
  const u=new URL(authorizationUrl(config,'state'));assert.equal(u.origin,'https://www.nodeloc.com');assert.equal(u.pathname,'/oauth-provider/authorize');assert.equal(u.searchParams.get('state'),'state');assert.equal(u.searchParams.get('scope'),'openid profile email');assert.equal(u.searchParams.get('redirect_uri'),config.origin+'/api/auth/nodeloc/callback');assert.ok(!u.href.includes(config.clientSecret));
});
test('NodeLoc stable identity and email are validated without trusting claimed verified/sub fields',()=>{
  assert.deepEqual(checkedIdentity({id:123,email:' User@example.test ',username:'user',sub:'attacker'}),{subject:'123',email:'user@example.test',username:'user',trustLevel:null});
  for(const value of [{id:'123',email:'a@b.com'},{id:0,email:'a@b.com'},{id:Number.MAX_SAFE_INTEGER+1,email:'a@b.com'},{id:1,email:'a\nb@c.com'},{id:1},{id:1,email:'<script>@c.com'}])assert.throws(()=>checkedIdentity(value));
});
test('NodeLoc trust levels accept only official integer levels, including zero',()=>{
  for(const level of [0,1,2,3,4])assert.equal(checkedIdentity({id:1,email:'a@b.com',trust_level:level}).trustLevel,level);
  for(const level of [undefined,null,'2',-1,5,1.5,{},'<script>'])assert.equal(checkedIdentity({id:1,email:'a@b.com',trust_level:level}).trustLevel,null);
});

test('NodeLoc exchange bounds data, fixes endpoints, blocks redirects and hides provider secrets/errors',async()=>{
  const calls=[];const fetcher=async(url,options)=>{calls.push([url,options]);return new Response(JSON.stringify(calls.length===1?{access_token:'access-secret',token_type:'Bearer'}:{id:456,email:'user@example.test',username:'name'}));};
  const identity=await exchangeIdentity(config,'auth-code',{fetcher});assert.equal(identity.subject,'456');assert.equal(calls.length,2);
  assert.equal(calls[0][0],'https://www.nodeloc.com/oauth-provider/token');assert.equal(calls[0][1].method,'POST');assert.equal(new URLSearchParams(calls[0][1].body).get('client_secret'),config.clientSecret);
  assert.equal(calls[1][0],'https://www.nodeloc.com/oauth-provider/userinfo');assert.equal(calls[1][1].headers.authorization,'Bearer access-secret');assert.ok(calls.every(([,o])=>o.redirect==='error'&&o.signal));
  for(const fetcher of [async()=>{throw Error(config.clientSecret);},async()=>new Response(JSON.stringify({error_description:config.clientSecret}),{status:401}),async()=>new Response('x'.repeat(32769)),async()=>new Response(JSON.stringify({access_token:'a\r\nb',token_type:'Bearer'}))])await assert.rejects(exchangeIdentity(config,'code',{fetcher}),e=>e.status===503&&!e.message.includes(config.clientSecret));
});
test('NodeLoc secrets use authenticated encryption with an isolated cryptographic domain',()=>{
  const sealed=encryptNodelocOAuth(config.clientSecret);assert.equal(decryptNodelocOAuth(sealed),config.clientSecret);assert.throws(()=>decryptMicrosoft(sealed));const corrupt={...sealed,ciphertext:Buffer.from(sealed.ciphertext)};corrupt.ciphertext[0]^=1;assert.throws(()=>decryptNodelocOAuth(corrupt));
});
test('NodeLoc admin/login UI renders translated setup and registration policy without exposing credentials',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../src/lib/ui-translations.json',import.meta.url),'utf8'));
  for(const name of ['NodelocLogin','NodelocOAuthSettings'])for(const locale of ['cn','en','tw']){
    const s=await readFile(new URL('../src/components/'+name+'.tsx',import.meta.url),'utf8');const exports={};
    runInNewContext(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>id==='react'?React:id==='react/jsx-runtime'?jsx:{useTranslator:()=>text=>{if(locale==='cn')return text;assert.ok(catalog[text]?.[locale],'missing '+text);return catalog[text][locale];}}});
    const html=renderToStaticMarkup(React.createElement(exports.default));assert.ok(html.includes('NodeLoc'));assert.ok(!html.includes(config.clientSecret));
    if(name==='NodelocOAuthSettings'){assert.ok(html.includes('oauth-provider/applications'));assert.ok(html.includes('TL2'));assert.ok(html.includes('email'));}
  }
});
