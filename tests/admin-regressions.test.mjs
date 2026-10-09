import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as csv from '../src/lib/csv.mjs';

// Exercise the real component functions with a completed server page and a
// populated search input. Hooks are inert because this is render verification;
// no browser, fetch, credentials or production services are involved.
async function adminRenderer() {
  const source = await readFile(new URL('../src/components/AdminConsole.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(`${source}\nexport const reviewComponents={Users,Mailboxes,Messages,Domains,Orders,Transactions,Audit};`, {
    compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const require = createRequire(import.meta.url);
  let query = '', hook = 0;
  const hooks = {...React, useRef:value=>({current:value}), useEffect:()=>{}, useState:initial=>{
    const value = initial === '' && hook++ === 0 ? query : (typeof initial === 'function' ? initial() : initial);
    return [value,()=>{}];
  }};
  const tabSource=await readFile(new URL('../src/components/AdminTabs.tsx',import.meta.url),'utf8');
  const tabExports={};runInNewContext(ts.transpileModule(tabSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports:tabExports,require:name=>name==='react'?hooks:require(name)});
  const exports = {};
  runInNewContext(compiled, {exports, require:specifier=>{
    if (specifier === 'react') return hooks;
    if (specifier === './AdminTabs') return tabExports;
    if (specifier === './AuditRetentionControls' || specifier === './TransactionReceipt') return {__esModule:true,default:()=>null};
    if (specifier === './NodelocOAuthSettings') return {__esModule:true,default:()=>null};
    if (specifier === './TelegramSettings') return {__esModule:true,default:()=>null};
    if (specifier === './PasswordMailSettings') return {__esModule:true,default:()=>null};
    if (specifier === '../lib/csv.mjs') return csv;
    if (specifier === './GmpayPaymentStatus') return {__esModule:true,default:()=>null};
    if (specifier === './NodelocPaymentSettings') return {__esModule:true,default:()=>null};
    if (specifier === '../styles/nodeloc-payment.css') return {};
    if (specifier === './AdminServiceStatus') return {__esModule:true,default:()=>null};
    // Release UI has its own renderer/browser tests; these cases exercise server-filtered lists.
    if (specifier === './AdminUpdates') return {__esModule:true,default:()=>null};
    if (specifier === './TurnstileWidget') return {__esModule:true,default:()=>null};
    return require(specifier);
  }});
  return (name, data, search)=>{
    hook = 0; query = search;
    return renderToStaticMarkup(exports.reviewComponents[name]({data}));
  };
}

test('admin renders server matches without filtering translated or hidden fields again', async()=>{
  const render = await adminRenderer();
  const base = {counts:{},plans:[],security:{turnstileConfigured:false}};
  const cases = [
    ['Users','users',{id:'U-render',email:'member@example.test',role:'USER',score:0,mailboxes:0,status:'ACTIVE'},' USER ','U-render'],
    ['Mailboxes','mailboxes',{id:'MB-render',address:'box@example.test',owner:'owner@example.test',status:'ACTIVE'},'  box  ','MB-render'],
    ['Messages','messages',{id:'M-render',recipient:'box@example.test',sender:'sender@example.test',subject:'subject',risk_status:'SAFE'},'  subject  ','M-render'],
    ['Domains','domains',{domain:'domain.example.test',kind:'PUBLIC',mx_status:'ACTIVE',status:'ACTIVE'},'  domain  ','domain.example.test'],
    ['Orders','orders',{id:'RO-render',user:'member@example.test',points:10,amount_usd_cents:100,status:'PENDING'},'  member  ','RO-render'],
    ['Transactions','transactions',{id:'PT-render',user:'member@example.test',type:'ADMIN_ADJUSTMENT',amount:3,reference_id:'42',note:'note-only-match'},'  note-only-match  ','PT-render'],
    ['Audit','audit',{id:'AL-render',actor:'admin@example.test',action:'sample-action',entity_type:'USER',status:'SUCCESS'},'  sample-action  ','AL-render'],
  ];
  for (const [name,section,row,query,id] of cases) {
    const html = render(name,{...base,[section]:[row]},query);
    assert.ok(html.includes(`<code>${id}</code>`) || html.includes(`<strong>${id}</strong>`), `${name} must display the server match`);
    if (section === 'transactions') assert.ok(html.includes('42 · note-only-match'), 'both reference and matching note remain visible');
  }
  const publicHtml = render('Domains',{...base,domains:[{domain:'platform.test',kind:'PUBLIC',mx_status:'ACTIVE',status:'ACTIVE',owner:null}]},'');
  assert.equal(publicHtml.includes('<option value="PRIVATE">'),false,'ownerless platform domains must not offer private conversion');
  for (const mx_status of ['PENDING','MISMATCH','NOT_FOUND','UNAVAILABLE']) {
    const pausedHtml=render('Domains',{...base,domains:[{domain:'paused.test',kind:'PUBLIC',mx_status,status:'ACTIVE',owner:null}]},'');
    assert.match(pausedHtml,/解析异常 \/ 暂停收信/);
  }
  assert.doesNotMatch(publicHtml,/解析异常 \/ 暂停收信/,'healthy domains should not carry a pause warning');
  const privateHtml = render('Domains',{...base,domains:[{domain:'private.test',kind:'PRIVATE',mx_status:'ACTIVE',status:'ACTIVE',owner:'member@test'}]},'');
  assert.equal(privateHtml.includes('<select value="PRIVATE">'),false,'private ownership cannot be changed by the type selector');
});

test('admin mutations and search against disposable MySQL', {timeout:90000}, async t=>{
  // Fail before importing database access, even when invoked accidentally.
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const {openDatabase,closeDatabasePool} = await import('../server/db/database.mjs');
  const {updateDomain,updateMailboxStatus,updateSystemSettings,permanentlyDeleteMailbox} = await import('../server/admin/mutations.mjs');
  const {getAdminData} = await import('../server/admin/read-model.mjs');
  const {createMailbox} = await import('../server/member/mutations.mjs');
  const {recallMailbox} = await import('../server/member/mailbox-recall.mjs');
  const {runMailboxMaintenance} = await import('../server/mail/maintenance.mjs');
  const {AttachmentStore} = await import('../server/mail/attachment-store.mjs');
  const {saveDelivery} = await import('../server/mail/repository.mjs');
  const connection = await openDatabase();
  const suffix = randomUUID();
  const users = [], domainNames = [], guestSessions = [];
  const root = await mkdtemp(join(tmpdir(),'nodemail-admin-regression-'));
  const originalStorage = process.env.MAIL_ATTACHMENT_DIR;
  process.env.MAIL_ATTACHMENT_DIR = root;
  const store = new AttachmentStore(root); await store.initialize();
  const [[cleanupSetting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='relay_remote_cleanup_enabled'");
  try {
    // Maintenance must never contact any upstream service during this suite.
    await connection.execute("UPDATE system_settings SET value='false' WHERE `key`='relay_remote_cleanup_enabled'");
    for (const label of ['owner','other']) {
      const [result] = await connection.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'unusable-test-fixture',10000)",[`U-${randomUUID()}`,`${label}-${suffix}@example.test`]);
      users.push(result.insertId);
    }
    const [owner, other] = users;
    const actor = {actorUserId:owner};
    const addDomain = async (label,kind,ownerId=null)=>{
      const domain = `${label}-${suffix}.example.test`; domainNames.push(domain);
      const [result] = await connection.execute("INSERT INTO domains(domain,kind,owner_user_id,status,mx_status) VALUES (?,?,?,'ACTIVE','ACTIVE')",[domain,kind,ownerId]);
      return {domain,id:result.insertId};
    };
    const platform = await addDomain('platform','PUBLIC');
    const owned = await addDomain('owned','PRIVATE',owner);
    const update = (domain,kind,status='ACTIVE')=>updateDomain({domain,kind,status,mxStatus:'ACTIVE',...actor});

    await t.test('platform/private type transitions preserve ownership and mailbox access',async()=>{
      await assert.rejects(update(platform.domain,'PRIVATE'),/私有域名必须属于/);
      await update(platform.domain,'LOGIN');
      await update(platform.domain,'PUBLIC');
      await assert.rejects(update(owned.domain,'PUBLIC'),/不能在此改为平台公共/);
      await update(owned.domain,'PRIVATE','DISABLED');
      await assert.rejects(update(owned.domain,'PRIVATE'), /核实/);
      await updateDomain({domain:owned.domain,kind:'PRIVATE',status:'ACTIVE',mxStatus:'ACTIVE',ownershipVerified:true,...actor});
      const [[row]] = await connection.execute('SELECT owner_user_id,kind FROM domains WHERE id=?',[owned.id]);
      assert.equal(Number(row.owner_user_id),owner); assert.equal(row.kind,'PRIVATE');
      await createMailbox({userId:owner,localPart:'owned',domain:owned.domain,durationMinutes:60});
      await assert.rejects(createMailbox({userId:other,localPart:'outsider',domain:owned.domain,durationMinutes:60}));
      const legacy = await addDomain('legacy-orphan','PRIVATE');
      await assert.rejects(update(legacy.domain,'PRIVATE'),/私有域名必须属于/);
      await update(legacy.domain,'PRIVATE','DISABLED');
    });

    await t.test('manual expiry allows paid recall; pause and hidden transitions cannot revive expired mail',async()=>{
      const mailbox = await createMailbox({userId:owner,localPart:'expiry',domain:platform.domain,durationMinutes:60});
      const params = {publicId:mailbox.id,...actor};
      const [[before]] = await connection.execute('SELECT expires_at FROM mailboxes WHERE public_id=?',[mailbox.id]);
      await updateMailboxStatus({...params,status:'PAUSED'});
      const paused = await updateMailboxStatus({...params,status:'ACTIVE'});
      assert.equal(paused.expires_at,new Date(before.expires_at).toISOString(),'pause/resume does not change deadline');
      const expired = await updateMailboxStatus({...params,status:'EXPIRED'});
      assert.ok(Date.parse(expired.expires_at) <= Date.now());
      await assert.rejects(updateMailboxStatus({...params,status:'ACTIVE'}),/召回/);
      const recalled = await recallMailbox({userId:owner,mailboxId:mailbox.id,durationHours:24,expectedPrice:3,requestId:randomUUID(),captchaVerified:true});
      assert.ok(recalled);
      // A pre-fix record may say EXPIRED with a future deadline. Neither direct
      // activation nor routing through hidden/paused is allowed to revive it.
      await connection.execute("UPDATE mailboxes SET status='EXPIRED',expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE public_id=?",[mailbox.id]);
      await assert.rejects(updateMailboxStatus({...params,status:'ACTIVE'}),/召回/);
      await updateMailboxStatus({...params,status:'DELETED'});
      await updateMailboxStatus({...params,status:'PAUSED'});
      await assert.rejects(updateMailboxStatus({...params,status:'ACTIVE'}),/召回/);
    });

    await t.test('manual expiry cleans member/guest attachments while retaining active inboxes',async()=>{
      const member = await createMailbox({userId:owner,localPart:'cleanup',domain:platform.domain,durationMinutes:60});
      const active = await createMailbox({userId:other,localPart:'active',domain:platform.domain,durationMinutes:60});
      const guestId = randomUUID();guestSessions.push(guestId);
      await connection.execute('INSERT INTO guest_sessions(id,token_hash,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',[guestId,randomBytes(32).toString('hex')]);
      const guestPublicId = `GMB-${randomUUID()}`;
      await connection.execute("INSERT INTO mailboxes(public_id,user_id,guest_session_id,domain_id,address,duration_minutes,status,expires_at) VALUES (?,NULL,?,?,?,60,'ACTIVE',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[guestPublicId,guestId,platform.id,`guest@${platform.domain}`]);
      const keys = new Map();
      for (const publicId of [member.id,guestPublicId,active.id]) {
        const [[box]] = await connection.execute('SELECT id FROM mailboxes WHERE public_id=?',[publicId]);
        await saveDelivery({recipients:[{id:box.id}],message:{messageId:randomUUID(),fromAddress:'synthetic@example.test',subject:'cleanup fixture',textContent:'test',htmlContent:'',sizeBytes:4,riskStatus:'SAFE',receivedAt:new Date()},attachments:[{filename:'test.txt',contentType:'text/plain',size:4,content:Buffer.from('test')}],attachmentStore:store,mailboxQuota:{maxMessages:10,maxBytes:10000}});
        const [[file]] = await connection.execute('SELECT a.storage_key FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE m.mailbox_id=?',[box.id]);
        keys.set(publicId,file.storage_key);await access(join(root,file.storage_key));
      }
      for (const publicId of [member.id,guestPublicId]) await updateMailboxStatus({publicId,status:'EXPIRED',...actor});
      await runMailboxMaintenance({attachmentStore:store});
      for (const publicId of [member.id,guestPublicId]) await assert.rejects(access(join(root,keys.get(publicId))));
      await access(join(root,keys.get(active.id)));
      const [[memberRow]] = await connection.execute('SELECT status FROM mailboxes WHERE public_id=?',[member.id]);
      assert.equal(memberRow.status,'EXPIRED');
      const [[guestCount]] = await connection.execute('SELECT COUNT(*) AS total FROM mailboxes WHERE public_id=?',[guestPublicId]);
      assert.equal(Number(guestCount.total),0);
      const [[activeCount]] = await connection.execute('SELECT COUNT(*) AS total FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.public_id=?',[active.id]);
      assert.equal(Number(activeCount.total),1);
    });

    await t.test('guest cleanup and permanent delete survive a drifted zero domain mailbox count',async()=>{
      const drifted = await addDomain('drifted','PUBLIC');
      const guestId = randomUUID();guestSessions.push(guestId);
      await connection.execute('INSERT INTO guest_sessions(id,token_hash,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',[guestId,randomBytes(32).toString('hex')]);
      const guestPublicId = `GMB-${randomUUID()}`;
      await connection.execute("INSERT INTO mailboxes(public_id,user_id,guest_session_id,domain_id,address,duration_minutes,status,expires_at) VALUES (?,NULL,?,?,?,60,'ACTIVE',DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE))",[guestPublicId,guestId,drifted.id,`guest@${drifted.domain}`]);
      await runMailboxMaintenance({attachmentStore:store});
      assert.equal(Number((await connection.execute('SELECT COUNT(*) AS total FROM mailboxes WHERE public_id=?',[guestPublicId]))[0][0].total),0);
      const memberPublicId = `MB-${randomUUID()}`;
      await connection.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,address,duration_minutes,status,expires_at) VALUES (?,?,?,?,60,'ACTIVE',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[memberPublicId,owner,drifted.id,`member@${drifted.domain}`]);
      await connection.execute("UPDATE users SET role='SUPER_ADMIN' WHERE id=?",[owner]);
      try{await permanentlyDeleteMailbox({publicId:memberPublicId,...actor});}finally{await connection.execute("UPDATE users SET role='USER' WHERE id=?",[owner]);}
      assert.equal(Number((await connection.execute('SELECT mailbox_count FROM domains WHERE id=?',[drifted.id]))[0][0].mailbox_count),0);
    });

    await t.test('search trims input and matches transaction note with a nonempty reference',async()=>{
      const note = `search-${suffix}`;
      const id = `PT-${randomUUID()}`;
      await connection.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_id,note) VALUES (?,?,'ADMIN_ADJUSTMENT',1,10000,'42',?)",[id,owner,note]);
      const result = await getAdminData({section:'transactions',query:`  ${note}  `});
      assert.equal(result.pagination.transactions.total,1);
      assert.equal(result.transactions[0].id,id);
      const render = await adminRenderer();
      assert.ok(render('Transactions',result,`  ${note}  `).includes(`<code>${id}</code>`));
      const roles = await getAdminData({section:'users',query:' USER ',status:'正常'});
      assert.ok(roles.users.some(row=>row.email===`owner-${suffix}@example.test`));
    });

    await t.test('admin membership grant keeps remaining paid time; cancel ends it',async()=>{
      const {setUserMembership}=await import('../server/admin/membership-control.mjs');
      const [[plan]]=await connection.execute('SELECT code,duration_days FROM membership_plans ORDER BY id LIMIT 1');
      const [[target]]=await connection.execute('SELECT public_id FROM users WHERE id=?',[other]);
      const day=86400000,days=Number(plan.duration_days)*day;
      const first=await setUserMembership({publicId:target.public_id,planCode:plan.code,mode:'GRANT',...actor});
      const firstEnd=new Date(first.membership_expires_at).getTime();assert.ok(Math.abs(firstEnd-(Date.now()+days))<60000);
      const second=await setUserMembership({publicId:target.public_id,planCode:plan.code,mode:'GRANT',...actor});
      assert.equal(new Date(second.membership_expires_at).getTime(),firstEnd+days);
      assert.equal((await connection.execute("SELECT COUNT(*) n FROM memberships WHERE user_id=? AND status='ACTIVE'",[other]))[0][0].n,1);
      const cancelled=await setUserMembership({publicId:target.public_id,mode:'CANCEL',...actor});assert.equal(cancelled.is_member,false);
      assert.equal((await connection.execute("SELECT COUNT(*) n FROM memberships WHERE user_id=? AND status='ACTIVE'",[other]))[0][0].n,0);
      const fresh=await setUserMembership({publicId:target.public_id,planCode:plan.code,mode:'GRANT',...actor});
      assert.ok(Math.abs(new Date(fresh.membership_expires_at).getTime()-(Date.now()+days))<60000);
    });
    await t.test('settings reject durations beyond SQL storage and unsafe prices',async()=>{
      for (const plan of [{minutes:0xffffffff,points:1},{minutes:0x100000000,points:1},{minutes:120,points:Number.MAX_SAFE_INTEGER+1}]) {
        await assert.rejects(updateSystemSettings({values:{mailbox_duration_plans:JSON.stringify([{id:'test',label:'test',enabled:true,...plan}])},...actor}),/字段不完整/);
      }
    });
  } finally {
    try {
      if (cleanupSetting) await connection.execute("UPDATE system_settings SET value=? WHERE `key`='relay_remote_cleanup_enabled'",[cleanupSetting.value]);
      for (const id of guestSessions) await connection.execute('DELETE FROM guest_sessions WHERE id=?',[id]);
      // User-owned domains cascade when users are deleted; clear their mailbox
      // references first so foreign-key ordering cannot interrupt cleanup.
      for (const id of users) await connection.execute('DELETE FROM mailboxes WHERE user_id=?',[id]);
      for (const domain of domainNames) await connection.execute('DELETE FROM domains WHERE domain=?',[domain]);
      for (const id of users) {
        await connection.execute('DELETE FROM audit_logs WHERE actor_user_id=?',[id]);
        await connection.execute('DELETE FROM point_transactions WHERE user_id=? OR operator_user_id=?',[id,id]);
        await connection.execute('DELETE FROM users WHERE id=?',[id]);
      }
    } finally {
      connection.release();
      await closeDatabasePool();
      await rm(root,{recursive:true,force:true});
      if (originalStorage === undefined) delete process.env.MAIL_ATTACHMENT_DIR; else process.env.MAIL_ATTACHMENT_DIR = originalStorage;
    }
  }
});
