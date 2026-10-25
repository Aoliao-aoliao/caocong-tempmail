import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
assert.ok(process.env.NODEMAIL_BROWSER_WORKDIR);
const {openDatabase,closeDatabasePool}=await import('../../server/db/database.mjs');
const {createSession,sessionCookieName}=await import('../../server/auth/service.mjs');
const {ensureGuestSession,createOrRotateGuestMailbox,guestCookieName}=await import('../../server/guest/service.mjs');
const {createGuestRelayMailbox}=await import('../../server/relay/service.mjs');
const {encryptRelayCredential}=await import('../../server/security/secret-box.mjs');
const c=await openDatabase(),marker=randomUUID(),ua='otp-browser-fixture',params={userAgent:ua,ipAddress:'127.0.0.1'};
try{
 const [u]=await c.execute("INSERT INTO users(public_id,email,password_hash) VALUES (?,?,'synthetic-unused')",['U-'+marker,marker+'@example.test']);
 const token=await createSession({userId:u.insertId,...params});
 const domains=[];
 for(const kind of ['PUBLIC','RELAY']){
  const domain=kind.toLowerCase()+marker+'.example.test';const [d]=await c.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,?,'ACTIVE','ACTIVE')",[domain,kind]);domains.push({id:d.insertId,domain});
 }
 const cred=encryptRelayCredential('synthetic-never-connect');
 const [a]=await c.execute("INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases) VALUES (?,?,?,'imap.example.test','synthetic',?,?,?,?,'ACTIVE',500)",['RA-'+marker,'owner@'+domains[1].domain,domains[1].domain,cred.ciphertext,cred.kdfSalt,cred.iv,cred.authTag]);
 const boxes=[];
 for(let i=0;i<2;i++){
  const [b]=await c.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,relay_account_id,address,duration_minutes,expires_at) VALUES (?,?,?,?,?,60,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",['MB-'+randomUUID(),u.insertId,domains[i].id,i?a.insertId:null,randomUUID()+'@'+domains[i].domain]);boxes.push(b.insertId);
 }
 const guest=await ensureGuestSession(params),guestToken=guest.issuedCookie.cookieValue;
 await createOrRotateGuestMailbox({...params,cookieValue:guestToken,domain:domains[0].domain});
 await createGuestRelayMailbox({...params,cookieValue:guestToken,suffix:domains[1].domain});
 const [guestBoxes]=await c.execute('SELECT id FROM mailboxes WHERE guest_session_id=?',[guest.id]);boxes.push(...guestBoxes.map(b=>b.id));
 for(const box of boxes)await c.execute("INSERT INTO messages(public_id,mailbox_id,from_address,subject,text_content,html_content,size_bytes,risk_status,received_at) VALUES (?,?,'sender@example.test','Synthetic verification mail',NULL,'<p>Your verification code is <b>001234</b></p>',70,'SAFE',UTC_TIMESTAMP(3))",['M-'+randomUUID(),box]);
 await writeFile(process.env.NODEMAIL_BROWSER_WORKDIR+'/browser-session.json',JSON.stringify({sessionCookieName,token:token.token,guestCookieName,guestToken,ua,boxes}),{mode:0o600});
 console.log('Isolated browser fixtures ready');
}finally{c.release();await closeDatabasePool();}
