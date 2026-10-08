import {readReceipt,saveReceipt} from '../member/business-receipts.mjs';
import { relayPublicRoutes, chooseRoutedAccount, relayExtraAddresses } from './address-routes.mjs';
import { lockRelayRouting, unlockRelayRouting } from './routing-lock.mjs';
import { freeMailboxMinutes } from '../member/mailbox-policy.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { ensureGuestSession } from '../guest/service.mjs';
import { encryptRelayCredential } from '../security/secret-box.mjs';
import { activeMailboxLimit, assertExpectedMailboxPrice, isValidMailboxDuration, discountedMailboxPrice } from '../member/mailbox-policy.mjs';
import { normalizeImapHost } from './network-policy.mjs';
import { createRelayClient } from './connection.mjs';
import { microsoftOAuth } from './microsoft-oauth.mjs';

const emailPattern=/^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const suffixPattern=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const iso=(value)=>value instanceof Date?value.toISOString():value?new Date(value).toISOString():null;
const httpError=(message,status=400)=>Object.assign(new Error(message),{status});
const normalizeEmail=(value)=>String(value||'').trim().toLowerCase();
const normalizeSuffix=(value)=>String(value||'').trim().toLowerCase();
const mailboxResult=(row)=>({id:row.public_id,address:row.address,duration_minutes:Number(row.duration_minutes||0),received_count:Number(row.received_count||0),status:row.status,expires_at:iso(row.expires_at),created_at:iso(row.created_at),pointsBalance:Number(row.points_balance||0),price:Number(row.price||0)});

function accountInput(input,{requireCredential=false}={}){
  const provider=String(input.provider||'CUSTOM').toUpperCase();
  if(!['GMAIL','OUTLOOK','CUSTOM'].includes(provider))throw httpError('中继服务商无效。');
  const email=normalizeEmail(input.email);
  if(!emailPattern.test(email)||email.length>320)throw httpError('请输入有效的中继邮箱账号。');
  const suffix=normalizeSuffix(input.suffix||email.split('@')[1]);
  if(!suffixPattern.test(suffix)||suffix.length>253)throw httpError('中继邮箱后缀无效。');
  const host=normalizeImapHost(input.imapHost||(provider==='GMAIL'?'imap.gmail.com':provider==='OUTLOOK'?'outlook.office365.com':''));
  const port=Number(input.imapPort||993);if(!Number.isSafeInteger(port)||port<1||port>65535)throw httpError('IMAP 端口无效。');
  const maxAliases=Number(input.maxAliases||500);if(!Number.isSafeInteger(maxAliases)||maxAliases<1||maxAliases>100000)throw httpError('别名容量必须为 1–100000。');
  const username=String(input.username||email).trim();if(!username||username.length>320)throw httpError('IMAP 用户名无效。');
  const credential=String(input.credential||'');if(requireCredential&&provider!=='OUTLOOK'&&!credential)throw httpError('首次添加必须填写 IMAP 应用密码。');
  if(credential.length>400)throw httpError('IMAP 凭据过长。');
  if(provider==='OUTLOOK'&&suffix!==email.split('@')[1])throw httpError('微软中继后缀必须与真实邮箱账号一致。');
  if(provider==='OUTLOOK'&&(host!=='outlook.office365.com'||port!==993||input.imapSecure===false||username.toLowerCase()!==email))throw httpError('微软邮箱必须使用 outlook.office365.com:993、TLS，用户名与邮箱一致。');
  if(provider==='OUTLOOK'&&credential)throw httpError('微软邮箱使用 OAuth2 授权，不接受应用密码。');
  return {provider,email,suffix,host,port,secure:input.imapSecure!==false,username,maxAliases,credential};
}

export async function listRelayAccounts(){
  const connection=await openDatabase();try{const [rows]=await connection.execute(`SELECT public_id AS id,provider,email,suffix,imap_host,imap_port,imap_secure,username,status,max_aliases,last_uid,uid_validity,last_error,last_checked_at,created_at FROM relay_accounts ORDER BY id DESC`);const extraAddresses=await relayExtraAddresses();const oauthStatuses=await microsoftOAuth.statuses(rows.filter(row=>row.provider==='OUTLOOK').map(row=>row.id));return rows.map(row=>({...row,extraAddresses:extraAddresses.get(row.id)||[],oauthStatus:row.provider==='OUTLOOK'?(oauthStatuses.get(row.id)||'NOT_AUTHORIZED'):null,imap_port:Number(row.imap_port),imap_secure:Boolean(row.imap_secure),max_aliases:Number(row.max_aliases),last_uid:Number(row.last_uid),uid_validity:Number(row.uid_validity),last_checked_at:iso(row.last_checked_at),created_at:iso(row.created_at),credentialConfigured:true}));}finally{connection.release();}
}

export async function saveRelayAccount(input,{actorUserId,ipAddress}={}){
  const id=String(input.id||'').trim();const values=accountInput(input,{requireCredential:!id});const connection=await openDatabase();
  try{await lockRelayRouting(connection);await connection.beginTransaction();let publicId=id;
    const [[mapped]]=await connection.execute('SELECT relay_account_id FROM relay_account_addresses WHERE address=? FOR UPDATE',[values.email]);
    if(mapped)throw httpError('该地址已作为独立收信别名，请使用原物理账号。',409);
    if(id){const [[current]]=await connection.execute('SELECT id,email,suffix,provider FROM relay_accounts WHERE public_id=? FOR UPDATE',[id]);if(!current)throw httpError('中继账号不存在。',404);const [[mapping]]=await connection.execute('SELECT address FROM relay_account_addresses WHERE relay_account_id=? LIMIT 1 FOR UPDATE',[current.id]);if(mapping&&(current.email!==values.email||current.suffix!==values.suffix||current.provider!==values.provider))throw httpError('该账号已有收信别名，不能修改邮箱、后缀或服务商；请新增账号。',409);if(current.provider!==values.provider&&values.provider!=='OUTLOOK'&&!values.credential)throw httpError('更换服务商时请填写对应应用密码。');if(current.email!==values.email||current.suffix!==values.suffix){const [[linked]]=await connection.execute('SELECT COUNT(*) AS count FROM mailboxes WHERE relay_account_id=?',[current.id]);if(Number(linked.count)>0)throw httpError('该账号已分配过中继地址，不能修改账号邮箱或后缀；请新增另一个账号。',409);}let encrypted=null;if(values.credential)encrypted=encryptRelayCredential(values.credential);
      await connection.execute(`UPDATE relay_accounts SET provider=?,email=?,suffix=?,imap_host=?,imap_port=?,imap_secure=?,username=?,max_aliases=?,updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at))${encrypted?',credential_ciphertext=?,credential_kdf_salt=?,credential_iv=?,credential_auth_tag=?':''} WHERE public_id=?`,[values.provider,values.email,values.suffix,values.host,values.port,values.secure,values.username,values.maxAliases,...(encrypted?[encrypted.ciphertext,encrypted.kdfSalt,encrypted.iv,encrypted.authTag]:[]),id]);
    }else{publicId=`RA-${randomUUID()}`;const encrypted=encryptRelayCredential(values.credential||'MICROSOFT_OAUTH_PENDING');await connection.execute(`INSERT INTO relay_accounts(public_id,provider,email,suffix,imap_host,imap_port,imap_secure,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'DISABLED',?)`,[publicId,values.provider,values.email,values.suffix,values.host,values.port,values.secure,values.username,encrypted.ciphertext,encrypted.kdfSalt,encrypted.iv,encrypted.authTag,values.maxAliases]);}
    await connection.execute(`INSERT INTO domains(domain,kind,mx_status,status) VALUES (?,'RELAY','ACTIVE','ACTIVE') ON DUPLICATE KEY UPDATE kind=IF(kind='RELAY','RELAY',kind),mx_status=IF(kind='RELAY','ACTIVE',mx_status),status=IF(kind='RELAY','ACTIVE',status)`,[values.suffix]);
    await connection.execute(`INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address) VALUES (?,?,?,'RELAY_ACCOUNT',?,?,?)`,[`AL-${randomUUID()}`,actorUserId||null,id?'更新中继账号':'添加中继账号',publicId,JSON.stringify({provider:values.provider,email:values.email,suffix:values.suffix}),String(ipAddress||'').slice(0,45)||null]);await connection.commit();return {id:publicId};
  }catch(error){await connection.rollback();if(error?.code==='ER_DUP_ENTRY')throw httpError('该中继邮箱账号已经存在。',409);throw error;}finally{try{await unlockRelayRouting(connection);}finally{connection.release();}}
}

function safeRelayError(error){if(String(error?.code||'').startsWith('MICROSOFT_'))return ['MICROSOFT_REAUTH_REQUIRED','MICROSOFT_ACCOUNT_MISMATCH'].includes(error.code)?'微软授权已失效或账号不匹配，请重新授权。':'微软授权服务暂时不可用，请核对应用配置或稍后重试。';if(error?.authenticationFailed)return 'IMAP 登录失败，请检查账号授权或应用专用密码。';const source=String(error?.message||'').toLowerCase();const code=String(error?.code||'').toUpperCase();if(code==='ENOTFOUND'||code==='ENODATA')return 'IMAP 服务器域名无法解析，请检查服务器地址。';if(code==='ETIMEDOUT'||source.includes('timeout')||source.includes('timed out'))return '连接 IMAP 服务器超时，请检查地址、端口和防火墙。';if(source.includes('auth')||source.includes('login')||source.includes('credential')||source.includes('password'))return 'IMAP 登录失败，请检查邮箱账号和应用专用密码。';if(source.includes('certificate')||source.includes('tls')||source.includes('ssl'))return 'TLS 安全连接失败，请检查端口和证书配置。';if(code==='ECONNREFUSED')return 'IMAP 服务器拒绝连接，请检查端口是否正确。';return 'IMAP 连接失败，请检查服务商、服务器、端口、用户名和应用专用密码。';}

export async function testRelayAccount({id,activate=false,actorUserId,ipAddress}, dependencies={}) {
  const connection=await (dependencies.openDatabase||openDatabase)();
  const shouldActivate=activate===true;
  let client, row, transaction=false;
  try {
    [[row]]=await connection.execute('SELECT * FROM relay_accounts WHERE public_id=? LIMIT 1',[String(id||'')]);
    if(!row)throw httpError('中继账号不存在。',404);
    client=await (dependencies.createClient||createRelayClient)(row);
    await client.connect();
    const lock=await client.getMailboxLock('INBOX');
    try {
      if(shouldActivate) {
        const uidValidity=Number(client.mailbox?.uidValidity||0);
        const uidNext=Number(client.mailbox?.uidNext||0);
        if(!Number.isSafeInteger(uidValidity)||uidValidity<1||!Number.isSafeInteger(uidNext)||uidNext<1) {
          throw new Error('IMAP mailbox UID metadata unavailable');
        }
        // Do not hold a database row lock while connecting to an upstream.
        // Re-read under lock and reject a stale check before changing state.
        await connection.beginTransaction();
        transaction=true;
        const [[current]]=await connection.execute('SELECT * FROM relay_accounts WHERE id=? FOR UPDATE',[row.id]);
        if(!current||current.status!==row.status||iso(current.updated_at)!==iso(row.updated_at)) {
          throw Object.assign(httpError('检测期间账号状态或配置已变化，请重试。',409),{code:'RELAY_CHECK_STALE'});
        }
        // UID zero is a valid saved cursor for a formerly empty inbox. Only a
        // previously unseen UID namespace starts at the current tail.
        const initialUid=Number(current.uid_validity||0)===uidValidity?Number(current.last_uid||0):uidNext-1;
        await connection.execute(`UPDATE relay_accounts SET status='ACTIVE',last_uid=?,uid_validity=?,last_error=NULL,last_checked_at=UTC_TIMESTAMP(3),updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at)) WHERE id=?`,[initialUid,uidValidity,row.id]);
      } else {
        // A diagnostic check must not consume mail or rewrite a concurrently
        // changed lifecycle status. The poller owns recovery from ERROR.
        await connection.execute('UPDATE relay_accounts SET last_error=NULL,last_checked_at=UTC_TIMESTAMP(3),updated_at=updated_at WHERE id=?',[row.id]);
      }
    } finally { lock.release(); }
    await connection.execute(`INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address) VALUES (?,?,?,'RELAY_ACCOUNT',?,'{}',?)`,[`AL-${randomUUID()}`,actorUserId||null,shouldActivate?'启用中继账号':'测试中继连接',row.public_id,String(ipAddress||'').slice(0,45)||null]);
    if(transaction) { await connection.commit(); transaction=false; }
    return {ok:true,activated:shouldActivate,id:row.public_id};
  } catch(error) {
    if(transaction) { await connection.rollback(); transaction=false; }
    if(error?.status===404||error?.code==='RELAY_CHECK_STALE')throw error;
    const safeError=safeRelayError(error);
    if(row)await connection.execute('UPDATE relay_accounts SET last_error=?,last_checked_at=UTC_TIMESTAMP(3),updated_at=updated_at WHERE id=?',[safeError,row.id]).catch(()=>{});
    throw httpError(safeError,409);
  } finally {
    await client?.logout().catch(()=>{});
    connection.release();
  }
}

export async function testAllRelayAccounts({actorUserId,ipAddress}={}){const connection=await openDatabase();let ids=[];try{const [rows]=await connection.query('SELECT public_id FROM relay_accounts ORDER BY id LIMIT 100');ids=rows.map(row=>row.public_id);}finally{connection.release();}const results=[];let cursor=0;const workers=Array.from({length:Math.min(3,Math.max(1,ids.length))},async()=>{while(cursor<ids.length){const id=ids[cursor++];try{await testRelayAccount({id,actorUserId,ipAddress});results.push({id,ok:true});}catch(error){results.push({id,ok:false,message:error.message});}}});await Promise.all(workers);return {checked:results.length,healthy:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok).length,results};}

export async function setRelayAccountStatus({id,status,actorUserId,ipAddress}){const next=String(status||'').toUpperCase();if(!['ACTIVE','DISABLED'].includes(next))throw httpError('中继账号状态无效。');if(next==='ACTIVE')return testRelayAccount({id,activate:true,actorUserId,ipAddress});const connection=await openDatabase();try{await connection.beginTransaction();const [result]=await connection.execute("UPDATE relay_accounts SET status='DISABLED',last_error=NULL,updated_at=GREATEST(UTC_TIMESTAMP(3),TIMESTAMPADD(MICROSECOND,1000,updated_at)) WHERE public_id=?",[String(id||'')]);if(!result.affectedRows)throw httpError('中继账号不存在。',404);await connection.execute(`INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address) VALUES (?,?,?,'RELAY_ACCOUNT',?,'{}',?)`,[`AL-${randomUUID()}`,actorUserId||null,'停用中继账号',String(id||''),String(ipAddress||'').slice(0,45)||null]);await connection.commit();return {ok:true};}catch(error){await connection.rollback();throw error;}finally{connection.release();}}

export async function getRelayPublicData(){return relayPublicRoutes();}

export async function getLatestMemberRelayMailboxId(userId){const connection=await openDatabase();try{const [[row]]=await connection.execute("SELECT public_id FROM mailboxes WHERE user_id=? AND relay_account_id IS NOT NULL AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP(3) ORDER BY id DESC LIMIT 1",[userId]);return row?.public_id||'';}finally{connection.release();}}

export async function planPrice(connection,userId,minutes,expectedPrice) {
  if(!isValidMailboxDuration(minutes))throw httpError('邮箱有效时长不合法或已停用。');
  const [[setting]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
  let plans=[];try{plans=JSON.parse(setting?.value||'[]')}catch{}
  const plan=Array.isArray(plans)?plans.find(item=>item&&item.enabled!==false&&Number(item.minutes)===minutes):null;
  if(!plan)throw httpError('邮箱有效时长不合法或已停用。');
  const basePrice=Number(plan.points);
  if(!Number.isSafeInteger(basePrice)||basePrice<0)throw httpError('邮箱价格配置无效，请联系管理员。',409);
  const [[membership]]=await connection.execute("SELECT mp.mailbox_discount_percent FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) ORDER BY ms.expires_at DESC LIMIT 1",[userId]);
  const discount=membership?Number(membership.mailbox_discount_percent):100;
  if(!Number.isSafeInteger(discount)||discount<0||discount>100)throw httpError('会员邮箱折扣配置无效，请联系管理员。',409);
  const price=discountedMailboxPrice(basePrice,discount);
  assertExpectedMailboxPrice(expectedPrice,price);
  return price;
}

async function chooseAccount(connection,suffix){return chooseRoutedAccount(connection,suffix);}
function aliasAddress(account){const base=String(account.routing_email||account.email).split('@')[0].split('+')[0];return `${base}+${randomBytes(4).toString('hex').slice(0,6)}@${account.suffix}`.toLowerCase();}

async function assertRelayReplay(connection,row,{userId,requestId,suffix,durationMinutes,expectedPrice}) {
  const receipt=await readReceipt(connection,`RC-${userId}-${requestId}`,userId,'用户创建中继邮箱');
  const original=receipt?(typeof receipt.detail_json==='string'?JSON.parse(receipt.detail_json):receipt.detail_json):{suffix:row.address.split('@')[1],durationMinutes:Number(row.duration_minutes),expectedPrice:Number(row.price)};
  if(row.relay_account_id==null || original.suffix!==normalizeSuffix(suffix) || original.durationMinutes!==Number(durationMinutes) || original.expectedPrice!==Number(expectedPrice))throw httpError('该请求标识已用于其他中继申请，请核对原申请结果。',409);
}
export async function getRelayMailboxByRequestId(options){
  const connection=await openDatabase();
  try {
    const requestId=String(options.requestId||'').trim().toLowerCase();
    const [[row]]=await connection.execute(`SELECT mb.*,u.points_balance,COALESCE(-pt.amount,0) AS price FROM mailboxes mb JOIN users u ON u.id=mb.user_id LEFT JOIN point_transactions pt ON pt.user_id=mb.user_id AND pt.reference_type='MAILBOX' AND CAST(pt.reference_id AS UNSIGNED)=mb.id AND pt.type='MAILBOX_PURCHASE' WHERE mb.user_id=? AND mb.request_id=? LIMIT 1`,[options.userId,requestId]);
    if(!row)return null;
    await assertRelayReplay(connection,row,{...options,requestId});
    return mailboxResult(row);
  }finally{connection.release();}
}

export async function createMemberRelayMailbox({userId,suffix,durationMinutes,requestId,expectedPrice}){const minutes=Number(durationMinutes);const normalizedSuffix=normalizeSuffix(suffix);const normalizedRequest=String(requestId||'').trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedRequest))throw httpError('请求标识无效。');const connection=await openDatabase();try{await connection.beginTransaction();const [[user]]=await connection.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[userId]);if(!user)throw httpError('账户不存在。',404);const [[existing]]=await connection.execute(`SELECT mb.*,COALESCE(-pt.amount,0) AS price FROM mailboxes mb LEFT JOIN point_transactions pt ON pt.user_id=mb.user_id AND pt.reference_type='MAILBOX' AND CAST(pt.reference_id AS UNSIGNED)=mb.id AND pt.type='MAILBOX_PURCHASE' WHERE mb.user_id=? AND mb.request_id=? LIMIT 1`,[userId,normalizedRequest]);if(existing){await assertRelayReplay(connection,existing,{userId,requestId:normalizedRequest,suffix:normalizedSuffix,durationMinutes:minutes,expectedPrice});await connection.commit();return mailboxResult({...existing,points_balance:user.points_balance});}const price=await planPrice(connection,userId,minutes,expectedPrice);const [[limitSetting]]=await connection.execute("SELECT value FROM system_settings WHERE `key`='active_mailbox_limit_per_user'");const limit=activeMailboxLimit(limitSetting?.value);const [[active]]=await connection.execute("SELECT COUNT(*) AS count FROM mailboxes WHERE user_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))",[userId]);if(Number(active.count)>=limit)throw httpError(`当前活动邮箱已达上限（${limit} 个）。`,409);if(Number(user.points_balance)<price)throw httpError('当前积分不足，请先充值。',409);const account=await chooseAccount(connection,normalizedSuffix);const [[domain]]=await connection.execute("SELECT id FROM domains WHERE domain=? AND kind='RELAY' AND status='ACTIVE' LIMIT 1 FOR UPDATE",[normalizedSuffix]);if(!domain)throw httpError('该中继后缀当前不可用。',409);let address='';for(let i=0;i<8;i++){address=aliasAddress(account);const [[used]]=await connection.execute('SELECT 1 FROM mailboxes WHERE address=? LIMIT 1',[address]);if(!used)break;address='';}if(!address)throw httpError('暂时无法分配中继地址，请稍后再试。',503);const expiresAt=new Date(Date.now()+minutes*60000);const publicId=`MB-${randomUUID()}`;const [result]=await connection.execute("INSERT INTO mailboxes(public_id,request_id,user_id,domain_id,relay_account_id,address,duration_minutes,status,expires_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',?)",[publicId,normalizedRequest,userId,domain.id,account.id,address,minutes,expiresAt]);await connection.execute('UPDATE domains SET mailbox_count=mailbox_count+1 WHERE id=?',[domain.id]);const after=Number(user.points_balance)-price;if(price>0){await connection.execute('UPDATE users SET points_balance=? WHERE id=?',[after,userId]);await connection.execute(`INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note) VALUES (?,?,'MAILBOX_PURCHASE',?,?,'MAILBOX',?,'创建中继邮箱')`,[`PT-${randomUUID()}`,userId,-price,after,String(result.insertId)]);}await saveReceipt(connection,{publicId:`RC-${userId}-${normalizedRequest}`,userId,action:'用户创建中继邮箱',entityType:'MAILBOX',entityId:publicId,detail:{suffix:normalizedSuffix,durationMinutes:minutes,expectedPrice:Number(expectedPrice)}});await connection.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'用户创建中继邮箱','MAILBOX',?,?)",[`RC-${userId}-${normalizedRequest}`,userId,publicId,JSON.stringify({suffix:normalizedSuffix,durationMinutes:minutes,expectedPrice:Number(expectedPrice)})]);await connection.commit();return {id:publicId,address,duration_minutes:minutes,received_count:0,status:'ACTIVE',expires_at:expiresAt.toISOString(),created_at:new Date().toISOString(),pointsBalance:after,price};}catch(error){await connection.rollback();throw error;}finally{connection.release();}}

export async function createGuestRelayMailbox({ cookieValue, ipAddress, userAgent, suffix }) {
  const normalizedSuffix = normalizeSuffix(suffix);
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[durationSetting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='free_mailbox_minutes'");
    const durationMinutes = freeMailboxMinutes(durationSetting?.value);
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);
    // Session renewal and mailbox creation must commit together. A failed
    // allocation must neither expire the old inbox nor extend an unsent cookie.
    const session = await ensureGuestSession({
      cookieValue, ipAddress, userAgent, connection, minimumExpiresAt: expiresAt,
    });
    await connection.execute("UPDATE mailboxes SET status='EXPIRED',expires_at=LEAST(expires_at,UTC_TIMESTAMP(3)) WHERE guest_session_id=? AND status='ACTIVE'", [session.id]);
    const account = await chooseAccount(connection, normalizedSuffix);
    const [[domain]] = await connection.execute("SELECT id FROM domains WHERE domain=? AND kind='RELAY' AND status='ACTIVE' LIMIT 1 FOR UPDATE", [account.suffix]);
    if (!domain) throw httpError('该中继后缀当前不可用。', 409);
    let address = '';
    for (let i = 0; i < 8; i++) {
      address = aliasAddress(account);
      const [[used]] = await connection.execute('SELECT 1 FROM mailboxes WHERE address=? LIMIT 1', [address]);
      if (!used) break;
      address = '';
    }
    if (!address) throw httpError('暂时无法分配中继地址，请稍后再试。', 503);
    const publicId = `MB-${randomUUID()}`;
    await connection.execute("INSERT INTO mailboxes(public_id,user_id,guest_session_id,domain_id,relay_account_id,address,duration_minutes,status,expires_at) VALUES (?,NULL,?,?,?,?,?,'ACTIVE',?)", [publicId, session.id, domain.id, account.id, address, durationMinutes, expiresAt]);
    await connection.execute('UPDATE domains SET mailbox_count=mailbox_count+1 WHERE id=?', [domain.id]);
    await connection.commit();
    return {
      mailbox: { id: publicId, address, localPart: address.split('@')[0], domain: account.suffix, durationMinutes, receivedCount: 0, expiresAt: expiresAt.toISOString(), createdAt: new Date().toISOString() },
      issuedCookie: session.issuedCookie,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
