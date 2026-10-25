import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('owned member/guest lists extract existing mail without body leakage or read side effects',async()=>{
 assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
 assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
 const {openDatabase,closeDatabasePool}=await import('../server/db/database.mjs');
 const {getMemberMessagePage,getMemberData,getMailboxInbox}=await import('../server/member/read-model.mjs');
 const {ensureGuestSession,createOrRotateGuestMailbox,listGuestMessages}=await import('../server/guest/service.mjs');
 const c=await openDatabase(), users=[], domains=[], sessions=[];
 const params={userAgent:'verification-code-isolated',ipAddress:'127.0.0.1'};
 try{
  for(let i=0;i<2;i++){
   const [u]=await c.execute("INSERT INTO users(public_id,email,password_hash) VALUES (?,?,'synthetic-unused')",['U-'+randomUUID(),randomUUID()+'@example.test']);users.push(u.insertId);
  }
  const domain=randomUUID()+'.example.test';
  const [d]=await c.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'PUBLIC','ACTIVE','ACTIVE')",[domain]);domains.push(d.insertId);
  const boxes=[];
  for(const user of users){
   const [b]=await c.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,address,duration_minutes,expires_at) VALUES (?,?,?,?,60,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",['MB-'+randomUUID(),user,d.insertId,randomUUID()+'@'+domain]);boxes.push(b.insertId);
  }
  for(let i=0;i<2;i++){
   const s=await ensureGuestSession(params);sessions.push(s.id);
   const b=await createOrRotateGuestMailbox({...params,cookieValue:s.issuedCookie.cookieValue,domain});
   const [[row]]=await c.execute('SELECT id FROM mailboxes WHERE public_id=?',[b.mailbox.id]);boxes.push(row.id);
   sessions[i]={id:s.id,cookieValue:s.issuedCookie.cookieValue};
  }
  for(const [i,box] of boxes.entries())await c.execute("INSERT INTO messages(public_id,mailbox_id,from_address,subject,text_content,html_content,size_bytes,risk_status,received_at) VALUES (?,?,'sender@example.test','Welcome',?,?,80,'SAFE',UTC_TIMESTAMP(3))",['M-'+randomUUID(),box,i===0?'Your code is 001234. PRIVATE_TEXT':null,`<p>Verification code ${i===0?'001234':'654321'}</p><p>PRIVATE_HTML</p>`]);
  const own=await getMemberMessagePage({userId:users[0]});
  assert.equal(own.messages.length,1);assert.equal(own.messages[0].verificationCode,'001234');
  const inbox=await getMailboxInbox({userId:users[0],kind:'ordinary'});assert.equal(inbox.messages[0].verificationCode,'001234');
  const overview=await getMemberData(users[0]);assert.equal(overview.messages[0].verificationCode,'001234');
  const guest=await listGuestMessages({...params,cookieValue:sessions[0].cookieValue});
  assert.equal(guest.messages.length,1);assert.equal(guest.messages[0].verificationCode,'654321');
  for(const list of [own.messages,inbox.messages,overview.messages,guest.messages]){
   assert.doesNotMatch(JSON.stringify(list),/PRIVATE_TEXT|PRIVATE_HTML|_code_text|_code_html|text_content|html_content/);
  }
  const [rows]=await c.execute('SELECT is_read FROM messages WHERE mailbox_id IN (?,?,?,?)',boxes);
  assert.ok(rows.every(row=>!row.is_read));
  await c.execute("UPDATE messages SET risk_status='REVIEW' WHERE mailbox_id=?",[boxes[0]]);
  assert.equal((await getMemberMessagePage({userId:users[0]})).messages.length,0);
  const [[foreign]]=await c.execute('SELECT public_id FROM mailboxes WHERE id=?',[boxes[1]]);
  await assert.rejects(getMemberMessagePage({userId:users[0],mailboxId:foreign.public_id}),/无权访问/);
 }finally{
  for(const user of users){await c.execute('DELETE FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?)',[user]);await c.execute('DELETE FROM mailboxes WHERE user_id=?',[user]);await c.execute('DELETE FROM users WHERE id=?',[user]);}
  for(const s of sessions){const id=typeof s==='object'?s.id:s;await c.execute('DELETE FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE guest_session_id=?)',[id]);await c.execute('DELETE FROM mailboxes WHERE guest_session_id=?',[id]);await c.execute('DELETE FROM guest_sessions WHERE id=?',[id]);}
  for(const id of domains)await c.execute('DELETE FROM domains WHERE id=?',[id]);c.release();await closeDatabasePool();
 }
});
