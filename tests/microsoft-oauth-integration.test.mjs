import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createMicrosoftOAuthService,MICROSOFT_CONFIG_KEY} from '../server/relay/microsoft-oauth.mjs';
import {MICROSOFT_TENANT} from '../server/relay/microsoft-protocol.mjs';
import {encryptMicrosoft,decryptMicrosoft} from '../server/security/secret-box.mjs';
import {saveRelayAccount,listRelayAccounts,testRelayAccount,getRelayPublicData} from '../server/relay/service.mjs';
const pack=value=>Object.fromEntries(Object.entries(encryptMicrosoft(JSON.stringify(value))).map(([k,v])=>[k,v.toString('base64')]));
const unpack=value=>JSON.parse(decryptMicrosoft(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Buffer.from(v,'base64')]))));
test('Microsoft authorization and refresh lifecycle on disposable MySQL only',{timeout:90000},async t=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');const c=await openDatabase();
 const origin='https://app.example.test',clientId='12345678-1234-1234-1234-123456789012',email=`oauth-${randomUUID()}@hotmail.com`,session='synthetic-admin-session';
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture-key'};
 let actor,id,accountId,mailboxId,attachmentDir,oldConfig,oldDomain,nonce='',refreshes=0,refreshFailure=null,identityEmail=email,identitySubject='fixture-personal-subject';const states=[];
 const service=createMicrosoftOAuthService({fetcher:async(url,options)=>{
   if(url.endsWith('/keys'))return Response.json({keys:[jwk]});
   assert.equal(url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');const body=new URLSearchParams(options.body);assert.equal(body.get('client_secret'),'synthetic-client-secret');
   if(body.get('grant_type')==='refresh_token'){refreshes++;if(refreshFailure)return Response.json({error:refreshFailure,error_description:'must-never-leak-secret'},{status:400});}
   const parts=[{alg:'RS256',kid:jwk.kid},{iss:`https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,tid:MICROSOFT_TENANT,aud:body.get('client_id'),nonce,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),sub:identitySubject,preferred_username:identityEmail}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url'));
   const token=parts.join('.')+'.'+sign('RSA-SHA256',Buffer.from(parts.join('.')),pair.privateKey).toString('base64url');
   return Response.json({access_token:'synthetic-access-'+refreshes,refresh_token:'synthetic-refresh-'+refreshes,expires_in:3600,token_type:'Bearer',scope:'https://outlook.office.com/IMAP.AccessAsUser.All',id_token:token});
 }});
 const read=async key=>(await c.execute('SELECT value FROM system_settings WHERE `key`=?',[key]))[0][0];
 const begin=async()=>{const r=await service.begin({id,actor,session,origin});const u=new URL(r.url);nonce=u.searchParams.get('nonce');const state=u.searchParams.get('state');states.push('microsoft_relay_state:'+createHash('sha256').update(state).digest('hex'));return state;};
 const complete=state=>service.complete({state,code:'synthetic-code',actor,session,origin});
 const expired=async()=>{const row=JSON.parse((await read('microsoft_relay_token:'+id)).value);const value=unpack(row.secret);row.secret=pack({...value,expiresAt:Date.now()-1});await c.execute('UPDATE system_settings SET value=? WHERE `key`=?',[JSON.stringify(row),'microsoft_relay_token:'+id]);};
 try{
  oldConfig=(await read(MICROSOFT_CONFIG_KEY))?.value;oldDomain=(await c.execute("SELECT id FROM domains WHERE domain='hotmail.com'"))[0][0];
  const [user]=await c.execute("INSERT INTO users(public_id,email,password_hash,role) VALUES (?,?,'synthetic-unusable','SUPER_ADMIN')",['U-'+randomUUID(),`oauth-admin-${randomUUID()}@example.test`]);actor={id:Number(user.insertId),role:'SUPER_ADMIN'};
  await t.test('only super admin configures; client secret encrypted and never returned',async()=>{
    const input={clientId,clientSecret:'synthetic-client-secret',redirectUri:origin+'/api/admin/microsoft/callback'};
    await assert.rejects(service.saveConfig(input,{actor:{...actor,role:'ADMIN'},origin}));
    const saved=await service.saveConfig(input,{actor,origin});assert.equal(saved.secretConfigured,true);assert.equal(JSON.stringify(saved).includes('synthetic-client-secret'),false);assert.equal((await read(MICROSOFT_CONFIG_KEY)).value.includes('synthetic-client-secret'),false);
  });
  const saved=await saveRelayAccount({provider:'OUTLOOK',email,suffix:'hotmail.com',imapHost:'outlook.office365.com',imapPort:993,imapSecure:true,username:email,maxAliases:500},{actorUserId:actor.id});id=saved.id;accountId=(await c.execute('SELECT id FROM relay_accounts WHERE public_id=?',[id]))[0][0].id;
  await c.execute("UPDATE relay_accounts SET status='DISABLED',last_uid=24,uid_validity=123 WHERE id=?",[accountId]);
  await t.test('unauthorized account cannot request tokens and user cannot start authorization',async()=>{const [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);await assert.rejects(service.accessToken(a),e=>e.code==='MICROSOFT_REAUTH_REQUIRED');await assert.rejects(service.begin({id,actor:{...actor,role:'USER'},session,origin}));});
  await t.test('state bound to exact administrator and session, consumed once, no UID/status reset',async()=>{
    const state=await begin();await assert.rejects(service.complete({state,code:'synthetic-code',actor,session:'different-session',origin}));
    await assert.rejects(service.complete({state,code:'synthetic-code',actor:{...actor,id:actor.id+1},session,origin}));
    await complete(state);await assert.rejects(complete(state));
    const [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);assert.equal(a.status,'DISABLED');assert.equal(Number(a.last_uid),24);assert.equal(Number(a.uid_validity),123);
    const token=(await read('microsoft_relay_token:'+id)).value;assert.equal(token.includes('synthetic-access'),false);assert.equal(token.includes('synthetic-refresh'),false);
    const accounts=await listRelayAccounts();assert.equal(accounts.find(a=>a.id===id).oauthStatus,'AUTHORIZED');assert.equal(JSON.stringify(accounts).includes('synthetic-access'),false);
  });
  await t.test('wrong Microsoft identity and expired/cancelled callbacks leave token and cursor intact',async()=>{
    const before=(await read('microsoft_relay_token:'+id)).value;let state=await begin();identityEmail='wrong@hotmail.com';await assert.rejects(complete(state),e=>e.code==='MICROSOFT_ACCOUNT_MISMATCH');identityEmail=email;assert.equal((await read('microsoft_relay_token:'+id)).value,before);
    state=await begin();const key=states.at(-1);const data=JSON.parse((await read(key)).value);data.expiresAt=1;await c.execute('UPDATE system_settings SET value=? WHERE `key`=?',[JSON.stringify(data),key]);await assert.rejects(complete(state));
    state=await begin();const extendedKey=states.at(-1),extended=JSON.parse((await read(extendedKey)).value);extended.secret=pack({...unpack(extended.secret),expiresAt:1});extended.expiresAt=Date.now()+600000;await c.execute('UPDATE system_settings SET value=? WHERE `key`=?',[JSON.stringify(extended),extendedKey]);await assert.rejects(complete(state));
    state=await begin();await assert.rejects(service.complete({state,denied:true,actor,session,origin}),e=>e.code==='MICROSOFT_ACCESS_DENIED');await assert.rejects(complete(state));assert.equal((await read('microsoft_relay_token:'+id)).value,before);
  });
  await t.test('two workers refreshing concurrently rotate only once and preserve UID',async()=>{
    await expired();const [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);const results=await Promise.all([service.accessToken(a),service.accessToken(a)]);assert.deepEqual(results,['synthetic-access-1','synthetic-access-1']);assert.equal(refreshes,1);assert.equal(Number((await c.execute('SELECT last_uid FROM relay_accounts WHERE id=?',[accountId]))[0][0].last_uid),24);
  });
  await t.test('temporary provider failure preserves grant; invalid_grant persists reauth requirement',async()=>{
    await expired();let [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);const before=(await read('microsoft_relay_token:'+id)).value;refreshFailure='temporarily_unavailable';await assert.rejects(service.accessToken(a),e=>!e.message.includes('must-never'));assert.equal((await read('microsoft_relay_token:'+id)).value,before);
    refreshFailure='invalid_grant';await assert.rejects(service.accessToken(a),e=>e.code==='MICROSOFT_REAUTH_REQUIRED');assert.equal((await service.statuses([id])).get(id),'REAUTH_REQUIRED');const calls=refreshes;await assert.rejects(service.accessToken(a));assert.equal(refreshes,calls);refreshFailure=null;
    await c.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[accountId]);assert.equal((await getRelayPublicData()).some(s=>s.suffix==='hotmail.com'),false);
  });
  await t.test('reauthorization preserves disabled lifecycle and cursor; in-flight admin change cannot be overwritten',async()=>{
    await c.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?",[accountId]);let state=await begin();await complete(state);let [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);assert.equal(a.status,'DISABLED');assert.equal(Number(a.last_uid),24);assert.equal(Number(a.uid_validity),123);
    state=await begin();await c.execute("UPDATE relay_accounts SET username='different@hotmail.com' WHERE id=?",[accountId]);await assert.rejects(complete(state));await c.execute('UPDATE relay_accounts SET username=? WHERE id=?',[email,accountId]);
    // Diagnostic fake permits only CONNECT / mailbox metadata / LOGOUT.
    const calls=[];await testRelayAccount({id},{createClient:async()=>({connect:async()=>calls.push('connect'),getMailboxLock:async()=>{calls.push('metadata');return {release(){}};},logout:async()=>calls.push('logout')})});assert.deepEqual(calls,['connect','metadata','logout']);
    [[a]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);assert.equal(Number(a.last_uid),24);assert.equal(Number(a.uid_validity),123);assert.equal(a.status,'DISABLED');
  });
  await t.test('generic user and admin settings exclude OAuth secrets and encrypted tokens',async()=>{
    const {getMemberData}=await import('../server/member/read-model.mjs');
    const publicData=await getMemberData(actor.id);assert.equal(JSON.stringify(publicData).includes('microsoft_relay_'),false);
    const {getAdminData}=await import('../server/admin/read-model.mjs');const adminData=await getAdminData();assert.equal(JSON.stringify(adminData.settings).includes('microsoft_relay_'),false);assert.equal(JSON.stringify(adminData).includes('synthetic-refresh'),false);
  });

  await t.test('OAuth client and poll persist a real isolated message',async()=>{
    const {createRelayClient}=await import('../server/relay/connection.mjs');const {pollAccount}=await import('../server/relay/poller.mjs');const {AttachmentStore}=await import('../server/mail/attachment-store.mjs');const {mkdtemp}=await import('node:fs/promises');const {EventEmitter}=await import('node:events');
    attachmentDir=await mkdtemp('/tmp/nodemail-ms-attachments-');const attachmentStore=new AttachmentStore(attachmentDir);await attachmentStore.initialize();
    await c.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[accountId]);
    const domain=(await c.execute("SELECT id FROM domains WHERE domain='hotmail.com'"))[0][0];const address=email.replace('@','+isolated@');
    const [box]=await c.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,relay_account_id,address,duration_minutes,status,expires_at,created_at) VALUES (?,?,?,?,?,60,'ACTIVE',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),'2020-01-01')",['MB-'+randomUUID(),actor.id,domain.id,accountId,address]);mailboxId=box.insertId;
    const [[account]]=await c.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);
    const client=await createRelayClient(account,{getAccessToken:a=>service.accessToken(a),resolveTarget:async()=>({address:'1.1.1.1',hostname:'outlook.office365.com'}),Client:class extends EventEmitter{
      constructor(options){super();assert.ok(options.auth.accessToken.startsWith('synthetic-access'));assert.equal(options.auth.pass,undefined);this.mailbox={uidValidity:123};}
      async connect(){}async getMailboxLock(){return {release(){}};}async search(){return [25];}
      async *fetch(){yield {uid:25,internalDate:new Date(),source:Buffer.from(`From: sender@example.test\r\nTo: ${address}\r\nSubject: isolated OAuth receipt\r\n\r\nsynthetic message`)};}
      async logout(){}
    }});
    await pollAccount(account,{attachmentStore,config:{maxMessageBytes:10000,maxAttachments:10,maxAttachmentBytes:10000,mailboxMaxMessages:10,mailboxMaxBytes:100000},dependencies:{client}});
    assert.equal((await c.execute('SELECT subject FROM messages WHERE mailbox_id=?',[mailboxId]))[0][0].subject,'isolated OAuth receipt');assert.equal(Number((await c.execute('SELECT last_uid FROM relay_accounts WHERE id=?',[accountId]))[0][0].last_uid),25);
    assert.equal((await getRelayPublicData()).some(x=>x.suffix==='hotmail.com'),true);
  });
  await t.test('application change invalidates old authorization, unchanged saves preserve it',async()=>{
    const current=await service.config(origin);await service.saveConfig({...current,clientSecret:''},{actor,origin});assert.equal((await service.statuses([id])).get(id),'AUTHORIZED');
    await service.saveConfig({...current,clientSecret:'different-synthetic-secret'},{actor,origin});assert.equal((await service.statuses([id])).get(id),'REAUTH_REQUIRED');assert.equal((await getRelayPublicData()).some(x=>x.suffix==='hotmail.com'),false);
    // Microsoft sub is pairwise per application. A new Client ID must verify
    // the same email afresh rather than require the old application's subject.
    await service.saveConfig({...current,clientId:'87654321-4321-4321-4321-210987654321',clientSecret:'synthetic-client-secret'},{actor,origin});identitySubject='new-application-pairwise-subject';await complete(await begin());assert.equal((await service.statuses([id])).get(id),'AUTHORIZED');assert.equal(Number((await c.execute('SELECT last_uid FROM relay_accounts WHERE id=?',[accountId]))[0][0].last_uid),25);
  });
 }finally{
  for(const key of [...states,...(id?['microsoft_relay_token:'+id]:[])])await c.execute('DELETE FROM system_settings WHERE `key`=?',[key]);
  if(mailboxId)await c.execute('DELETE FROM mailboxes WHERE id=?',[mailboxId]);if(attachmentDir){const {rm}=await import('node:fs/promises');await rm(attachmentDir,{recursive:true,force:true});}
  if(accountId)await c.execute('DELETE FROM relay_accounts WHERE id=?',[accountId]);if(!oldDomain)await c.execute("DELETE FROM domains WHERE domain='hotmail.com' AND mailbox_count=0");
  await c.execute('DELETE FROM system_settings WHERE `key`=?',[MICROSOFT_CONFIG_KEY]);if(oldConfig!==undefined)await c.execute("INSERT INTO system_settings(`key`,value,value_type) VALUES (?,?,'json')",[MICROSOFT_CONFIG_KEY,oldConfig]);
  if(actor){await c.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[actor.id]);await c.execute('DELETE FROM users WHERE id=?',[actor.id]);}c.release();await closeDatabasePool();
 }
});
