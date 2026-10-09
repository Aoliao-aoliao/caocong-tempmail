import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {authorizationUrl,validateMicrosoftConfig,checkedToken,requestMicrosoftToken,verifyMicrosoftIdentity,MICROSOFT_TENANT,MICROSOFT_SCOPES} from '../server/relay/microsoft-protocol.mjs';
import {encryptMicrosoft,decryptMicrosoft,encryptRelayCredential} from '../server/security/secret-box.mjs';
import {createRelayClient} from '../server/relay/connection.mjs';
import {pollAccount} from '../server/relay/poller.mjs';
const clientId='12345678-1234-1234-1234-123456789012',origin='https://app.example.test';
const config={clientId,redirectUri:origin+'/api/admin/microsoft/callback',clientSecret:'synthetic-only'};
const pair=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...pair.publicKey.export({format:'jwk'}),kid:'test-key',use:'sig'};
function signed(overrides={}){const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');const claims={iss:`https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,tid:MICROSOFT_TENANT,aud:clientId,nonce:'nonce',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),sub:'stable-personal-subject',preferred_username:'user@hotmail.com',...overrides};const body=Buffer.from(JSON.stringify(claims)).toString('base64url');return header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),pair.privateKey).toString('base64url');}
const jwks=async url=>{assert.equal(url,'https://login.microsoftonline.com/consumers/discovery/v2.0/keys');return Response.json({keys:[jwk]});};
test('Microsoft auth code uses consumers, delegated IMAP, offline access and S256; callback is exact',()=>{
 assert.deepEqual(validateMicrosoftConfig(config,origin),{clientId,redirectUri:config.redirectUri});
 for(const redirectUri of ['https://other.example/api/admin/microsoft/callback',config.redirectUri+'/',config.redirectUri+'?x=1','http://app.example.test/api/admin/microsoft/callback'])assert.throws(()=>validateMicrosoftConfig({...config,redirectUri},origin));
 const url=new URL(authorizationUrl(config,{state:'state',nonce:'nonce',verifier:'verifier',email:'user@hotmail.com'}));assert.equal(url.pathname,'/consumers/oauth2/v2.0/authorize');assert.equal(url.searchParams.get('scope'),MICROSOFT_SCOPES);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('state'),'state');assert.equal(url.searchParams.has('client_secret'),false);
});
test('Microsoft ID token signature, issuer, audience, nonce, expiry and exact account binding are verified',async()=>{
 const opts={clientId,nonce:'nonce',email:'user@hotmail.com'};
 assert.equal((await verifyMicrosoftIdentity(signed(),opts,jwks)).subject,'stable-personal-subject');
 for(const overrides of [{aud:'other'},{iss:'https://evil.example'},{tid:'enterprise-tenant'},{nonce:'wrong'},{exp:1},{sub:''},{iat:9999999999},{preferred_username:'other@hotmail.com'}])await assert.rejects(verifyMicrosoftIdentity(signed(overrides),opts,jwks));
 await assert.rejects(verifyMicrosoftIdentity(signed(),{...opts,subject:'different-subject'},jwks));
 await assert.rejects(verifyMicrosoftIdentity(signed().slice(0,-12)+'aaaaaaaaaaaa',opts,jwks));
});
test('token exchange failure is sanitized; refresh rotation and missing refresh token preservation follow protocol',async()=>{
 const token={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'Bearer',scope:'https://outlook.office.com/IMAP.AccessAsUser.All'};
 const saved=checkedToken(token);assert.equal(saved.refreshToken,'synthetic-refresh');assert.equal(checkedToken({...token,refresh_token:undefined},saved).refreshToken,saved.refreshToken);
 for(const bad of [{scope:'Mail.Read'},{expires_in:0},{token_type:'Basic'},{refresh_token:''}])assert.throws(()=>checkedToken({...token,...bad}));
 await assert.rejects(requestMicrosoftToken(config,{grant_type:'refresh_token',refresh_token:'synthetic-refresh'},async(url,options)=>{assert.equal(url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');assert.equal(options.redirect,'error');assert.equal(new URLSearchParams(options.body).get('client_secret'),'synthetic-only');return Response.json({error:'invalid_grant',error_description:'sensitive-synthetic-upstream-text'},{status:400});}),e=>e.code==='MICROSOFT_REAUTH_REQUIRED'&&!e.message.includes('sensitive'));
});
test('Microsoft token encryption is authenticated and cannot be reused as Gmail password ciphertext',()=>{
 const saved=encryptMicrosoft('synthetic-access-and-refresh');assert.equal(decryptMicrosoft(saved),'synthetic-access-and-refresh');assert.throws(()=>decryptMicrosoft(encryptRelayCredential('synthetic-password')));const damaged={...saved,ciphertext:Buffer.from(saved.ciphertext)};damaged.ciphertext[0]^=1;assert.throws(()=>decryptMicrosoft(damaged));
});
test('Outlook uses XOAUTH2 accessToken, fixed TLS host; Gmail and custom remain password authenticated',async()=>{
 const target={hostname:'outlook.office365.com',address:'1.1.1.1'};let options;
 class Client extends EventEmitter{constructor(o){super();options=o;}}
 const ms={provider:'OUTLOOK',username:'user@hotmail.com',imap_host:'outlook.office365.com',imap_port:993,imap_secure:true};
 await createRelayClient(ms,{resolveTarget:async()=>target,getAccessToken:async()=> 'synthetic-access',decryptCredential:()=>{throw Error('must not decrypt password');},Client});
 assert.deepEqual(options.auth,{user:ms.username,accessToken:'synthetic-access'});assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.tls.servername,target.hostname);
 for(const provider of ['GMAIL','CUSTOM']){await createRelayClient({...ms,provider},{resolveTarget:async()=>target,decryptCredential:()=> 'synthetic-password',getAccessToken:()=>{throw Error('must not use OAuth');},Client});assert.deepEqual(options.auth,{user:ms.username,pass:'synthetic-password'});}
});
test('OAuth authenticated relay still routes and saves received messages without altering delivery isolation',async()=>{
 const account={id:12,public_id:'RA-test',provider:'OUTLOOK',last_uid:50,uid_validity:1,updated_at:new Date('2026-01-01')};let saved,updated;
 const client={connect:async()=>{},mailbox:{uidValidity:1},getMailboxLock:async()=>({release(){}}),search:async()=>[51],async *fetch(){yield {uid:51,source:Buffer.from('From: sender@example.com\r\nTo: user+alias@hotmail.com\r\nSubject: OAuth receipt\r\n\r\nsynthetic body'),internalDate:new Date()};},logout:async()=>{}};
 await pollAccount(account,{attachmentStore:{},config:{maxMessageBytes:10000,mailboxMaxMessages:10,mailboxMaxBytes:10000},dependencies:{client,aliasesFor:async()=>[{id:7,address:'user+alias@hotmail.com',activation_id:0,activated_at:new Date('2020-01-01')}],saveDelivery:async input=>{saved=input;},readInboxProgress:async()=>[],updateState:async(id,input)=>{updated=input;}}});
 assert.equal(saved.message.subject,'OAuth receipt');assert.equal(saved.relaySource.accountId,12);assert.equal(saved.relaySource.uid,51);assert.equal(updated.uid,51);
});
test('callback route requires administrator, rejects duplicated state and exposes only fixed outcomes',async()=>{
 const {readFile}=await import('node:fs/promises');const ts=await import('typescript');
 const source=await readFile(new URL('../src/pages/api/admin/microsoft/callback.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
 let actor=null,calls=0,failure;
 const GET=new Function('getSessionUser','sessionCookieName','microsoftOAuth',js.replace('export const GET','const GET')+'\nreturn GET;')(async()=>actor,'session',{complete:async()=>{calls++;if(failure)throw failure;}});
 const context=query=>({url:new URL('https://app.example.test/api/admin/microsoft/callback'+query),cookies:{get:()=>({value:'synthetic-session'})}});
 for(const value of [null,{role:'USER'}]){actor=value;assert.equal((await GET(context('?state=state&code=code'))).status,403);}assert.equal(calls,0);
 actor={role:'ADMIN'};let response=await GET(context('?state=one&state=two&code=code'));assert.equal(response.headers.get('location'),'/admin/relays.cgi?microsoft=failed');assert.equal(calls,0);
 response=await GET(context('?state=state&code=synthetic-code'));assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/admin/relays.cgi?microsoft=success');assert.equal(response.headers.get('cache-control'),'no-store');
 failure={code:'MICROSOFT_ACCOUNT_MISMATCH',message:'synthetic-sensitive-token'};response=await GET(context('?state=state&code=synthetic-code'));assert.equal(response.headers.get('location'),'/admin/relays.cgi?microsoft=account-mismatch');assert.equal((await response.text()).includes('synthetic-sensitive-token'),false);
});

test('admin Microsoft request works without AbortSignal.timeout and preserves actionable API rejection',async()=>{
 const {readFile}=await import('node:fs/promises');const ts=await import('typescript');
 const source=await readFile(new URL('../src/components/MicrosoftRelayConfig.tsx',import.meta.url),'utf8');
 const functionSource=source.slice(source.indexOf('export async function microsoftRequest'),source.indexOf('export default function'));
 const js=ts.transpileModule(functionSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('export async function','async function');
 let calls=0,aborted=false;
 const Controller=class{signal={aborted:false};abort(){this.signal.aborted=true;aborted=true;}};
 let response=Response.json({ok:true,result:{url:'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'}});
 const request=new Function('fetch','AbortController','setTimeout','clearTimeout',js+';return microsoftRequest;')(async(url,options)=>{calls++;assert.equal(url,'/api/admin/microsoft');assert.equal(options.headers['content-type'],'application/json');assert.ok(options.signal);return response;},Controller,setTimeout,clearTimeout);
 assert.equal((await request({action:'authorize',id:'RA-test'})).ok,true);
 response=Response.json({ok:false,message:'请先配置微软应用。'},{status:409});
 await assert.rejects(request({action:'authorize',id:'RA-test'}),/请先配置微软应用/);
 assert.equal(calls,2);assert.equal(aborted,false);
});
