import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { ImapFlow } from 'imapflow';
import { relayImapOptions, createRelayClient } from '../server/relay/connection.mjs';
import { testRelayAccount, planPrice } from '../server/relay/service.mjs';

const account = () => ({
  id: 21, public_id: 'RA-synthetic', status: 'ACTIVE', imap_host: 'imap.example.com',
  imap_port: 143, imap_secure: false, username: 'synthetic@example.com',
  last_uid: 50, uid_validity: 1, updated_at: new Date('2026-01-01T00:00:00.000Z'),
});

test('relay requires TLS: missing or rejected STARTTLS fails before authentication', async () => {
  const options=relayImapOptions(account(),{address:'1.1.1.1',hostname:'imap.example.com'},'synthetic-only');
  assert.equal(options.secure,false);
  assert.equal(options.doSTARTTLS,true);
  assert.equal(options.tls.rejectUnauthorized,true);
  assert.equal(options.tls.servername,'imap.example.com');
  assert.equal(options.logger,false);
  const client=new ImapFlow(options);
  await assert.rejects(client.upgradeToSTARTTLS(),/does not support STARTTLS/);
  client.capabilities.set('STARTTLS',true);
  client.run=async command=>{assert.equal(command,'STARTTLS');return false;};
  await assert.rejects(client.upgradeToSTARTTLS(),/does not support STARTTLS/);
});

test('direct TLS stays compatible and certificate verification also applies to IP hosts', async () => {
  const direct=new ImapFlow(relayImapOptions({...account(),imap_secure:true},{address:'1.1.1.1',hostname:'imap.example.com'},'synthetic-only'));
  direct.secureConnection=true;
  assert.equal(await direct.upgradeToSTARTTLS(),true);
  assert.equal(direct.options.tls.rejectUnauthorized,true);
  const ipOptions=relayImapOptions(account(),{address:'2606:4700:4700::1111',hostname:'2606:4700:4700::1111'},'synthetic-only');
  assert.equal(ipOptions.tls.rejectUnauthorized,true);
  assert.equal(ipOptions.tls.servername,undefined);
  let captured;
  await createRelayClient(account(),{
    resolveTarget:async host=>{assert.equal(host,'imap.example.com');return {address:'1.1.1.1',hostname:host};},
    decryptCredential:()=> 'synthetic-only',
    Client:class extends EventEmitter {constructor(options){super();captured=options;}},
  });
  assert.equal(captured.doSTARTTLS,true);
  assert.equal(captured.host,'1.1.1.1');
});

test('asynchronous IMAP errors cannot terminate the shared mail process', async () => {
  const client=await createRelayClient(account(),{
    resolveTarget:async()=>({address:'1.1.1.1',hostname:'imap.example.com'}),
    decryptCredential:()=> 'synthetic-only',
  });
  let closed=false;
  client.closeAfter=()=>{closed=true;};
  assert.doesNotThrow(()=>client.emitError(new Error('Synthetic socket failure')));
  assert.equal(closed,true);
  assert.equal(client.listenerCount('error'),1);
  client.close();
});

function relayFixture({initial={},onConnect,mailbox={uidValidity:2,uidNext:101}}={}) {
  const row={...account(),...initial};
  const statements=[],events=[];
  let released=false;
  const connection={
    async beginTransaction(){events.push('begin');},
    async commit(){events.push('commit');},
    async rollback(){events.push('rollback');},
    release(){released=true;},
    async execute(sql,params=[]){
      statements.push({sql,params});
      if(sql.startsWith('SELECT * FROM relay_accounts'))return [[{...row}]];
      if(sql.includes("SET status='ACTIVE'")) {
        row.status='ACTIVE';[row.last_uid,row.uid_validity]=params;
      } else if(sql.startsWith('UPDATE relay_accounts')) {
        assert.doesNotMatch(sql,/\b(?:status|last_uid|uid_validity)\s*=/);
        row.last_error=sql.includes('last_error=NULL')?null:params[0];
      } else if(!sql.startsWith('INSERT INTO audit_logs'))throw new Error(`Unexpected synthetic query: ${sql}`);
      return [{affectedRows:1}];
    },
  };
  const client={
    mailbox,
    async connect(){events.push('connect');await onConnect?.(row,events);},
    async getMailboxLock(){return {release(){events.push('imap-release');}};},
    async logout(){events.push('logout');},
  };
  return {row,statements,events,get released(){return released;},dependencies:{openDatabase:async()=>connection,createClient:async()=>client}};
}

test('ordinary connection checks never consume a new UID namespace or revive disabled accounts', async () => {
  for(const initial of [{},{last_uid:0,uid_validity:0},{status:'DISABLED'}]) {
    const fixture=relayFixture({initial,onConnect(row){row.status='DISABLED';}});
    const before={last_uid:fixture.row.last_uid,uid_validity:fixture.row.uid_validity};
    const result=await testRelayAccount({id:'RA-synthetic'},fixture.dependencies);
    assert.equal(result.activated,false);
    assert.equal(fixture.row.status,'DISABLED');
    assert.equal(fixture.row.last_uid,before.last_uid);
    assert.equal(fixture.row.uid_validity,before.uid_validity);
    assert.equal(fixture.events.includes('begin'),false);
    assert.equal(fixture.released,true);
  }
});

test('failed connection checks preserve concurrent disable and do not expose upstream secrets', async () => {
  const fixture=relayFixture({onConnect(row){row.status='DISABLED';throw new Error('AUTH failed synthetic-only-password');}});
  await assert.rejects(testRelayAccount({id:'RA-synthetic'},fixture.dependencies),error=>{
    assert.equal(error.status,409);
    assert.equal(error.message.includes('synthetic-only-password'),false);
    return true;
  });
  assert.equal(fixture.row.status,'DISABLED');
  assert.equal(fixture.row.last_uid,50);
  assert.equal(fixture.row.uid_validity,1);
  assert.equal(fixture.row.last_error.includes('synthetic-only-password'),false);
  assert.equal(fixture.released,true);
});

test('explicit activation starts a new namespace at its tail but preserves UID zero in an existing namespace', async () => {
  for(const [initial,expected] of [
    [{status:'DISABLED',last_uid:0,uid_validity:0},100],
    [{status:'DISABLED',last_uid:50,uid_validity:1},100],
    [{status:'DISABLED',last_uid:0,uid_validity:2},0],
    [{status:'DISABLED',last_uid:25,uid_validity:2},25],
  ]) {
    const fixture=relayFixture({initial});
    const result=await testRelayAccount({id:'RA-synthetic',activate:true},fixture.dependencies);
    assert.equal(result.activated,true);
    assert.equal(fixture.row.status,'ACTIVE');
    assert.equal(fixture.row.last_uid,expected);
    assert.equal(fixture.row.uid_validity,2);
    assert.ok(fixture.events.indexOf('connect')<fixture.events.indexOf('begin'),'No DB transaction during network connection');
    assert.equal(fixture.events.includes('commit'),true);
    assert.ok(fixture.statements.some(({sql})=>sql.includes('FOR UPDATE')));
  }
});

test('explicit activation rejects stale status, config, or poll progress after the network check', async () => {
  for(const change of [
    row=>{row.status='DISABLED';},
    row=>{row.updated_at=new Date(row.updated_at.getTime()+1);},
    row=>{row.last_uid=75;row.updated_at=new Date(row.updated_at.getTime()+1);},
  ]) {
    const fixture=relayFixture({onConnect:change});
    await assert.rejects(testRelayAccount({id:'RA-synthetic',activate:true},fixture.dependencies),error=>error.code==='RELAY_CHECK_STALE');
    assert.equal(fixture.statements.some(({sql})=>sql.includes("SET status='ACTIVE'")),false);
    assert.equal(fixture.events.includes('rollback'),true);
    assert.equal(fixture.events.includes('commit'),false);
  }
});

test('activation without valid UID metadata fails without changing lifecycle or cursor', async () => {
  for(const mailbox of [{},{uidValidity:0,uidNext:101},{uidValidity:2,uidNext:0}]) {
    const fixture=relayFixture({mailbox,initial:{status:'DISABLED'}});
    await assert.rejects(testRelayAccount({id:'RA-synthetic',activate:true},fixture.dependencies),error=>error.status===409);
    assert.equal(fixture.row.status,'DISABLED');
    assert.equal(fixture.row.last_uid,50);
  }
});

function pricingConnection(plans,membership=null) {
  return {async execute(sql){
    if(sql.includes('system_settings'))return [[{value:JSON.stringify(plans)}]];
    if(sql.includes('memberships'))return [[membership].filter(Boolean)];
    throw new Error('Unexpected synthetic pricing query');
  }};
}

test('custom relay durations use enabled configuration and membership pricing with stale-price protection', async () => {
  const plans=[{minutes:120,points:10,enabled:true},{minutes:60,points:0,enabled:false}];
  assert.equal(await planPrice(pricingConnection(plans),1,120,10),10);
  assert.equal(await planPrice(pricingConnection(plans,{mailbox_discount_percent:70}),1,120,7),7);
  assert.equal(await planPrice(pricingConnection([{minutes:120,points:0}]),1,120,0),0);
  await assert.rejects(planPrice(pricingConnection(plans),1,120,9),error=>error.status===409);
  for(const duration of [60,121,0,-1,1.5,Infinity,2**32]) {
    await assert.rejects(planPrice(pricingConnection(plans),1,duration),/时长/);
  }
  await assert.rejects(planPrice(pricingConnection([{minutes:120,points:-1}]),1,120),/价格配置/);
});

test('relay page sends only enabled plans to its hydrated component', async () => {
  // Execute the actual Astro frontmatter with synthetic read-models, without
  // starting a browser/server or opening a database connection.
  const page=await readFile(new URL('../src/pages/tools/real_mail.cgi.astro',import.meta.url),'utf8');
  const frontmatter=page.split('---')[1].replace(/^import .*;\s*$/gm,'');
  const js=ts.transpileModule(frontmatter,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const props=await vm.runInNewContext(`(async()=>{${js};return props;})()`,{
    Astro:{cookies:{get:()=>null},request:{headers:{get:()=>''}}},sessionCookieName:'synthetic',guestCookieName:'synthetic-guest',
    getSessionUser:async()=>({id:1}),getMemberData:async()=>({plans:[{mailbox_discount_percent:70}],user:{points_balance:10},settings:{mailbox_duration_plans:JSON.stringify([{id:'disabled',minutes:60,points:0,enabled:false},{id:'two-hours',minutes:120,points:3,enabled:true}])}}),
    getRelayPublicData:async()=>[],getResolvedTurnstilePublicConfig:async()=>({configured:false}),getMemberToolInbox:async()=>({mailbox:null,messages:[],pagination:{page:1,pages:1,total:0}}),
  });
  assert.deepEqual(Array.from(props.plans,item=>item.id),['two-hours']);
  assert.equal(props.memberPreviewDiscountPercent,70);
  assert.equal(props.discountPercent,100,'preview discount must not discount a non-member purchase');
});
