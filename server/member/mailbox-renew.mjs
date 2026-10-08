import {readReceipt,saveReceipt} from './business-receipts.mjs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../db/database.mjs';
import {normalizeMailboxRecallRequestId, resolveMailboxRecallPlan} from './mailbox-recall-policy.mjs';
import {assertMailboxRecallCaptcha} from './mailbox-captcha.mjs';
import {assertExpectedMailboxPrice, isValidMailboxDuration} from './mailbox-policy.mjs';
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const iso=value=>new Date(value).toISOString();
function normalize(options) {
  const requestId=normalizeMailboxRecallRequestId(options.requestId);
  const mailboxId=String(options.mailboxId||'').trim();
  if(!/^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailboxId))throw fail('邮箱标识无效。',400);
  return {...options,mailboxId,requestId,operationId:`RN-${options.userId}-${requestId}`};
}
async function replay(connection,options) {
  const row=await readReceipt(connection,options.operationId,options.userId,'用户续期邮箱');
  if(!row)return null;
  const record=typeof row.detail_json==='string'?JSON.parse(row.detail_json):row.detail_json;
  if(record.mailboxId!==options.mailboxId||record.durationHours!==options.durationHours||record.expectedPrice!==options.expectedPrice)throw fail('该请求标识已用于其他续期操作。');
  const [[current]]=await connection.execute(`SELECT mb.public_id AS id,mb.address,mb.status,mb.received_count,mb.duration_minutes,mb.expires_at,mb.created_at,u.points_balance
    FROM mailboxes mb JOIN users u ON u.id=mb.user_id WHERE mb.public_id=? AND mb.user_id=?`,[options.mailboxId,options.userId]);
  if(!current)throw fail('续期已处理，但邮箱已不存在，请刷新列表。',404);
  return {...record.result,pointsBalance:Number(current.points_balance),mailbox:{id:current.id,address:current.address,status:current.status,received_count:Number(current.received_count),duration_minutes:Number(current.duration_minutes),expires_at:current.expires_at?iso(current.expires_at):null,created_at:iso(current.created_at)}};
}
export async function getMailboxRenewByRequestId(options) {
  options=normalize(options);
  const c=await openDatabase();try{return await replay(c,options);}finally{c.release();}
}
/** Renewal preserves contents and relay activation generation. Never insert a recall record. */
export async function renewMailbox(options) {
  options=normalize(options);
  await assertMailboxRecallCaptcha(options.captchaVerified);
  const {userId,mailboxId,durationHours,expectedPrice,operationId,ipAddress}=options;
  if(!Number.isSafeInteger(durationHours)||!Number.isSafeInteger(expectedPrice)||expectedPrice<0)throw fail('续期参数无效。',400);
  const c=await openDatabase();
  try {
    await c.beginTransaction();
    const [[user]]=await c.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE',[userId]);
    if(!user)throw fail('账户不存在。',404);
    const existing=await replay(c,options);
    if(existing){await c.commit();return existing;}
    const [[setting]]=await c.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans' FOR UPDATE");
    const [[membership]]=await c.execute("SELECT mp.mailbox_discount_percent FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) ORDER BY ms.expires_at DESC LIMIT 1",[userId]);
    const plan=resolveMailboxRecallPlan({rawPlans:setting?.value,durationHours,discountPercent:membership?Number(membership.mailbox_discount_percent):100});
    assertExpectedMailboxPrice(expectedPrice,plan.price);
    const [[binding]]=await c.execute('SELECT relay_account_id FROM mailboxes WHERE public_id=? AND user_id=?',[mailboxId,userId]);
    let relay;
    if(binding?.relay_account_id!=null)[[relay]]=await c.execute('SELECT id,status,max_aliases FROM relay_accounts WHERE id=? FOR UPDATE',[binding.relay_account_id]);
    const [[box]]=await c.execute(`SELECT mb.*,d.kind AS domain_kind,d.status AS domain_status,d.mx_status,d.owner_user_id,
      (mb.expires_at>UTC_TIMESTAMP(3)) AS valid FROM mailboxes mb JOIN domains d ON d.id=mb.domain_id
      WHERE mb.public_id=? AND mb.user_id=? FOR UPDATE`,[mailboxId,userId]);
    if(!box)throw fail('邮箱不存在或无权续期。',404);
    if(box.status!=='ACTIVE'||Number(box.valid)!==1)throw fail('只有有效期内的正常邮箱可以续期；已过期邮箱请使用召回。');
    if(box.domain_status!=='ACTIVE'||box.mx_status!=='ACTIVE'||(box.domain_kind==='PRIVATE'&&Number(box.owner_user_id)!==Number(userId)))throw fail('该邮箱所属域名当前不可用。');
    if(box.domain_kind==='MEMBER'&&!membership)throw fail('有效会员才可以续期该邮箱。');
    if(box.domain_kind==='RELAY'||box.relay_account_id!=null){
      if(!relay||relay.status!=='ACTIVE'||Number(relay.id)!==Number(box.relay_account_id))throw fail('中继账号当前不可用，未扣除积分。');
      const [[usage]]=await c.execute("SELECT COUNT(*) AS count FROM mailboxes WHERE relay_account_id=? AND id<>? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) FOR UPDATE",[relay.id,box.id]);
      if(Number(usage.count)>=Number(relay.max_aliases))throw fail('中继账号容量不足，未扣除积分。');
    }
    const oldExpiry=new Date(box.expires_at).getTime(),duration=Number(box.duration_minutes)+plan.durationMinutes;
    if(!isValidMailboxDuration(plan.durationMinutes,oldExpiry)||!Number.isSafeInteger(duration)||duration>0xffffffff)throw fail('续期后有效时长超出允许范围。');
    const expiresAt=new Date(oldExpiry+plan.durationMinutes*60000),before=Number(user.points_balance);
    if(before<plan.price)throw fail('当前积分不足，请先充值。');
    const after=before-plan.price;
    await c.execute('UPDATE users SET points_balance=? WHERE id=?',[after,userId]);
    await c.execute('UPDATE mailboxes SET expires_at=?,duration_minutes=? WHERE id=?',[expiresAt,duration,box.id]);
    const result={mailbox:{id:box.public_id,address:box.address,status:box.status,received_count:Number(box.received_count),duration_minutes:duration,expires_at:iso(expiresAt),created_at:iso(box.created_at)},pointsBalance:after,price:plan.price,durationHours};
    await saveReceipt(c,{publicId:operationId,userId,action:'用户续期邮箱',entityType:'MAILBOX',entityId:mailboxId,detail:{mailboxId,durationHours,expectedPrice,previousExpiresAt:iso(box.expires_at),result}});
    await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address) VALUES (?,?,'用户续期邮箱','MAILBOX',?,?,?)",[operationId,userId,mailboxId,JSON.stringify({mailboxId,durationHours,expectedPrice,previousExpiresAt:iso(box.expires_at),result}),String(ipAddress||'').slice(0,45)||null]);
    if(plan.price>0)await c.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,reference_type,reference_id,note) VALUES (?,?,'MAILBOX_PURCHASE',?,?,'MAILBOX_RENEW',?,'续期邮箱')",[`PT-${randomUUID()}`,userId,-plan.price,after,operationId]);
    await c.commit();return result;
  } catch(error){await c.rollback();throw error;} finally{c.release();}
}
