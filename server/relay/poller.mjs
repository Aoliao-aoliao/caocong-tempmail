import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { openDatabase } from '../db/database.mjs';
import { clip,isRiskyAttachment,normalizeMailboxAddress } from '../mail/mail-utils.mjs';
import { saveDelivery } from '../mail/repository.mjs';
import { createRelayClient } from './connection.mjs';
import { readInboxProgress, writeInboxProgress, mergeCompletedRanges, completedRangeContains, MAX_COMPLETED_RANGES } from './inbox-progress.mjs';
import { junkCursorKey, readJunkCursor, writeJunkCursor } from './junk-cursor.mjs';

const safeError=(error)=>{if(String(error?.code||'').startsWith('MICROSOFT_'))return error.code==='MICROSOFT_REAUTH_REQUIRED'?'微软授权已失效，请重新授权。':'微软授权服务暂时不可用，请核对应用配置或稍后重试。';if(error?.authenticationFailed)return 'IMAP 登录失败，请检查账号授权或应用专用密码。';const source=String(error?.message||'').toLowerCase();const code=String(error?.code||'').toUpperCase();if(code==='ENOTFOUND'||code==='ENODATA')return 'IMAP 服务器域名无法解析。';if(code==='ETIMEDOUT'||source.includes('timeout'))return '连接 IMAP 服务器超时。';if(source.includes('auth')||source.includes('login')||source.includes('credential')||source.includes('password'))return 'IMAP 登录失败，请检查账号和应用专用密码。';if(source.includes('public')||source.includes('公开访问'))return 'IMAP 服务器必须使用可公开访问的网络地址。';return 'IMAP 连接或收信失败，请检查账号配置。';};

async function activeAccounts(){const connection=await openDatabase();try{const [rows]=await connection.execute("SELECT * FROM relay_accounts WHERE status IN ('ACTIVE','ERROR') ORDER BY id");return rows;}finally{connection.release();}}
async function aliasesFor(accountId){const connection=await openDatabase();try{const [rows]=await connection.execute(`SELECT mb.id,mb.address,COALESCE((SELECT MAX(rr.id) FROM mailbox_recall_requests rr WHERE rr.mailbox_id=mb.id),0) AS activation_id,GREATEST(mb.created_at,COALESCE((SELECT MAX(rr.created_at) FROM mailbox_recall_requests rr WHERE rr.mailbox_id=mb.id),mb.created_at)) AS activated_at FROM mailboxes mb WHERE mb.relay_account_id=? AND mb.status='ACTIVE' AND mb.expires_at>UTC_TIMESTAMP(3)`,[accountId]);return rows;}finally{connection.release();}}
export async function updateState(id,{uid,uidValidity,error,expected,retryError,completedRanges},dependencies={}) {
  const connection=await (dependencies.openDatabase||openDatabase)();
  const checkpoint = !error && completedRanges !== undefined;
  try {
    if (checkpoint) {
      if (!expected) throw Error('INBOX checkpoint requires account version');
      await connection.beginTransaction();
    }
    // A connection/activation/edit may finish while an older poll is still in
    // flight. Its checkpoint must not replace the newer cursor or namespace.
    const guard=expected?' AND last_uid=? AND uid_validity=? AND updated_at=?':'';
    const guardValues=expected?[expected.uid,expected.uidValidity,expected.updatedAt]:[];
    const [result]=error
      ? await connection.execute(`UPDATE relay_accounts SET status='ERROR',last_error=?,last_checked_at=UTC_TIMESTAMP(3),updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at)) WHERE id=? AND status<>'DISABLED'${guard}`,[error,id,...guardValues])
      : await connection.execute(`UPDATE relay_accounts SET status=?,last_uid=?,uid_validity=?,last_error=?,last_checked_at=UTC_TIMESTAMP(3),updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at)) WHERE id=? AND status<>'DISABLED'${guard}`,[retryError?'ERROR':'ACTIVE',uid||0,uidValidity||0,retryError||null,id,...guardValues]);
    if (checkpoint) {
      if (result.affectedRows > 0) await writeInboxProgress(connection,id,uidValidity,completedRanges,uid||0);
      await connection.commit();
    }
    return result.affectedRows>0;
  } catch (error) { if (checkpoint) await connection.rollback(); throw error; }
  finally { connection.release(); }
}


// Only parsed recipient mailboxes participate in routing. Display names,
// Subject, From, arbitrary X headers and addresses in the body are not recipients.
export function matchingRecipients(parsed, aliases) {
  const addresses = new Set();
  const visit = (values) => { for (const value of values || []) {
    if (value.group) visit(value.group);
    else { const address = normalizeMailboxAddress(value.address); if (address) addresses.add(address); }
  } };
  for (const field of [parsed.to,parsed.cc,parsed.bcc]) {
    for (const header of Array.isArray(field)?field:[field]) visit(header?.value);
  }
  return aliases.filter(row => addresses.has(normalizeMailboxAddress(row.address)));
}

// Keep the durable cursor behind every unfinished UID. Rotate the scan window
// independently so a poison message cannot starve even mails after 100 failures.
// Successful UIDs are persisted separately; restarting loses only scheduling hints.
const scanPositions = new Map();
export function selectUidBatch(uids, after = 0, size = 100) {
  const sorted = [...new Set(uids.map(Number))].sort((a,b) => a-b);
  return [...sorted.filter(uid => uid > after), ...sorted.filter(uid => uid <= after)].slice(0,size);
}
export function completedUidCursor(uids, completed, previous) {
  const unfinished = uids.filter(uid => !completed.has(Number(uid)));
  return unfinished.length ? Math.max(previous, unfinished.reduce((min,uid)=>Math.min(min,uid),Infinity)-1) : uids.reduce((max,uid)=>Math.max(max,uid),previous);
}


// Header-only, forward-only Junk scan. A failed fetch/move does not commit the
// batch; successfully moved mail is absent on retry and enters the normal INBOX
// dedup/retry/cleanup pipeline. Search dates have day precision, so also enforce
// the exact 24-hour cutoff using INTERNALDATE before moving anything.
export async function recoverJunkMail(client, aliases, config, accountId, dependencies = {}) {
  aliases = aliases.filter(alias => Number.isFinite(new Date(alias.activated_at).getTime()));
  if (!aliases.length) return 0;
  const folders = await client.list();
  const junk = folders.find(folder => folder.specialUse === '\\Junk');
  if (!junk?.path || junk.path.toUpperCase() === 'INBOX') return 0;
  const lock = await client.getMailboxLock(junk.path);
  try {
    const validity = String(client.mailbox.uidValidity);
    if (!/^[1-9][0-9]*$/.test(validity)) throw Error('Junk UIDVALIDITY unavailable');
    const key = junkCursorKey(accountId, junk.path);
    const state = await (dependencies.readCursor || readJunkCursor)(key, validity);
    const now = (dependencies.now || Date.now)();
    const cutoff = Math.max(now - 24 * 60 * 60 * 1000, Math.min(...aliases.map(a => new Date(a.activated_at).getTime())));
    const uids = (await client.search({since: new Date(cutoff), uid: `${state.uid + 1}:*`}, {uid: true}) || [])
      .map(Number).filter(uid => Number.isSafeInteger(uid) && uid > state.uid);
    const pending = [...new Set(uids)].sort((a,b) => a-b).slice(0,100);
    if (!pending.length) return 0;
    const selected = new Set(pending), seen = new Set(), move = [];
    for await (const item of client.fetch(pending, {uid:true,envelope:true,internalDate:true,size:true}, {uid:true})) {
      const uid = Number(item.uid);
      if (!selected.has(uid) || seen.has(uid)) continue;
      seen.add(uid);
      if (!item.envelope) throw Error('Junk recipient envelope unavailable');
      const received = new Date(item.internalDate).getTime();
      if (!Number.isFinite(received)) throw Error('Junk delivery date unavailable');
      if (received < cutoff || Number(item.size) > config.maxMessageBytes) continue;
      const parsed = Object.fromEntries(['to','cc','bcc'].map(field => [field,{value:item.envelope[field] || []}]));
      const matches = matchingRecipients(parsed, aliases).filter(alias => received >= Math.floor(new Date(alias.activated_at).getTime()/1000)*1000);
      if (matches.length) move.push(uid);
    }
    // FETCH can omit concurrently expunged messages. Other fetch/move errors
    // abort without advancing, so unfinished mail remains retryable.
    for (const uid of move) {
      if (await client.messageMove(String(uid), 'INBOX', {uid:true}) === false) throw Error('Junk recovery move not confirmed');
    }
    await (dependencies.writeCursor || writeJunkCursor)(key, validity, pending.at(-1), state.previous);
    return move.length;
  } finally { lock.release(); }
}

export async function pollAccount(account,{attachmentStore,config,dependencies={}}) {
  const client=dependencies.client || await createRelayClient(account,{resolveTarget:dependencies.resolveTarget,decryptCredential:dependencies.decryptCredential});
  let highest=Number(account.last_uid||0);
  const expected={uid:highest,uidValidity:Number(account.uid_validity||0),updatedAt:account.updated_at};
  try {
    await client.connect();
    // Establish a new INBOX namespace before moving Junk messages, otherwise
    // its initial tail could swallow the UIDs created by those moves.
    if (!dependencies.client || dependencies.recoverJunkMail) {
      const initialLock=await client.getMailboxLock('INBOX');
      try {
        if(Number(account.uid_validity||0)!==Number(client.mailbox?.uidValidity||0)) {
          highest=Math.max(0,Number(client.mailbox?.uidNext||1)-1);
          scanPositions.delete(account.id);
        }
      } finally { initialLock.release(); }
    }
    const inboxValidityBeforeRecovery=Number(client.mailbox?.uidValidity||0);
    let junkError = false;
    if (!dependencies.client || dependencies.recoverJunkMail) {
      try { await (dependencies.recoverJunkMail || recoverJunkMail)(client, await (dependencies.aliasesFor || aliasesFor)(account.id), config, account.id); }
      catch { junkError = true; console.error('[relay] junk recovery will retry', {account:account.public_id}); }
    }
    const lock=await client.getMailboxLock('INBOX');
    try {
      const uidValidity=Number(client.mailbox?.uidValidity||0);
      if(Number(account.uid_validity||0)!==uidValidity && ((!dependencies.client || dependencies.recoverJunkMail) ? inboxValidityBeforeRecovery!==uidValidity : true)) {
        // A new UID namespace cannot identify previously activated mail. Start
        // at its current tail rather than importing the entire historic inbox.
        highest=Math.max(0,Number(client.mailbox?.uidNext||1)-1);
        scanPositions.delete(account.id);
      }
      const ranges = await (dependencies.readInboxProgress || readInboxProgress)(account,uidValidity);
      const uids=[...new Set((await client.search({uid:`${highest+1}:*`},{uid:true}) || []).map(Number))]
        .filter(uid=>Number.isSafeInteger(uid)&&uid>highest&&uid<=4294967295).sort((a,b)=>a-b);
      const unfinished=uids.filter(uid=>!completedRangeContains(ranges,uid));
      const position=scanPositions.get(account.id);
      // Each success can introduce at most one range. At the cap retry the first
      // gap, which advances last_uid or joins ranges, without discarding retries.
      const room=MAX_COMPLETED_RANGES-ranges.length;
      const pending=room>0?selectUidBatch(unfinished,position?.validity===uidValidity?position.after:highest,Math.min(100,room)):unfinished.slice(0,1);
      if(!pending.length){
        highest=uids.at(-1)||highest;
        await (dependencies.updateState||updateState)(account.id,{uid:highest,uidValidity,expected,completedRanges:mergeCompletedRanges(ranges,[],highest),retryError:junkError?'垃圾邮件同步暂未完成，将自动重试。':null});return;
      }
      const aliases=await (dependencies.aliasesFor||aliasesFor)(account.id);
      const completed=new Set();
      let failed=junkError;
      // RFC822.SIZE is cheap: known oversized mail stays retryable if limits
      // change, without downloading its entire body on every polling cycle.
      const selected=new Set(pending), downloadable=new Set();
      for await(const item of client.fetch(pending,{uid:true,size:true},{uid:true})) {
        const uid=Number(item.uid),size=Number(item.size ?? item.source?.length);
        if(!selected.has(uid))continue;
        scanPositions.set(account.id,{validity:uidValidity,after:uid});
        if(!Number.isSafeInteger(size)||size<0||size>config.maxMessageBytes){failed=true;continue;}
        downloadable.add(uid);
      }
      const seen=new Set();
      for await(const item of (downloadable.size?client.fetch([...downloadable],{uid:true,source:true,internalDate:true},{uid:true}):[])) {
        const uid=Number(item.uid||0);
        if(!downloadable.has(uid)||seen.has(uid))continue;
        seen.add(uid);
        try {
          if(!item.source) throw new Error('IMAP message source unavailable');
          if(item.source.length > config.maxMessageBytes) throw new Error('IMAP message too large');
          const parsed=await simpleParser(item.source,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:Math.min(item.source.length,2*1024*1024)});
          if(parsed.attachments.length>config.maxAttachments || parsed.attachments.some(a=>Number(a.size||a.content?.length||0)>config.maxAttachmentBytes)) throw new Error('IMAP attachment limit exceeded');
          const receivedAt=new Date(item.internalDate);
          if(!Number.isFinite(receivedAt.getTime())) throw new Error('IMAP delivery date unavailable');
          const recipients=matchingRecipients(parsed,aliases).filter(alias=>receivedAt.getTime()>=Math.floor(new Date(alias.activated_at).getTime()/1000)*1000);
          let deliveryFailed=false;
          for(const recipient of recipients) {
            try {
              await (dependencies.saveDelivery||saveDelivery)({recipients:[recipient],message:{messageId:`imap:${account.id}:${uidValidity}:${uid}:${createHash('sha256').update(item.source).digest('hex')}`,fromAddress:clip(parsed.from?.text,320)||'mailer-daemon',subject:clip(parsed.subject,4096),textContent:typeof parsed.text==='string'?parsed.text:'',htmlContent:typeof parsed.html==='string'?parsed.html:'',sizeBytes:item.source.length,riskStatus:parsed.attachments.some(isRiskyAttachment)?'REVIEW':'SAFE',receivedAt},attachments:parsed.attachments,attachmentStore,mailboxQuota:{maxMessages:config.mailboxMaxMessages,maxBytes:config.mailboxMaxBytes},relaySource:{accountId:Number(account.id),uidValidity,uid}});
            } catch { deliveryFailed=true; }
          }
          if(deliveryFailed) failed=true; else completed.add(uid);
        } catch { failed=true; }
      }
      const merged=mergeCompletedRanges(ranges,[...completed]);
      const stillPending=uids.filter(uid=>!completedRangeContains(merged,uid));
      highest=stillPending.length?Math.max(highest,stillPending[0]-1):(uids.at(-1)||highest);
      // A normal backlog larger than this batch is not an account error. Missing
      // FETCH results in the selected batch do remain retryable and diagnostic.
      failed ||= pending.some(uid=>!completed.has(uid));
      const completedRanges=mergeCompletedRanges(merged,[],highest);
      // Store the retry diagnostic and cursor in one guarded update so another
      // activation cannot race a second, unguarded status write.
      await (dependencies.updateState||updateState)(account.id,{uid:highest,uidValidity,expected,completedRanges,retryError:failed?'部分邮件暂未保存，将保留并重试；其余邮件继续收取。':null});
    } finally { lock.release(); }
  } finally { await client.logout().catch(()=>{}); }
}

export function startRelayPoller({attachmentStore,config,intervalMs=30000}){let stopped=false;let running=false;const run=async()=>{if(stopped||running)return;running=true;try{for(const account of await activeAccounts()){if(stopped)break;try{await pollAccount(account,{attachmentStore,config});}catch(error){console.error('[relay] account polling failed',{account:account.public_id,message:safeError(error)});await updateState(account.id,{error:safeError(error),expected:{uid:Number(account.last_uid||0),uidValidity:Number(account.uid_validity||0),updatedAt:account.updated_at}}).catch(()=>{});}}}catch(error){console.error('[relay] polling cycle failed',error);}finally{running=false;}};void run();const timer=setInterval(()=>void run(),Math.max(10000,intervalMs));timer.unref();return {async stop(){stopped=true;clearInterval(timer);const deadline=Date.now()+10000;while(running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));}};}
