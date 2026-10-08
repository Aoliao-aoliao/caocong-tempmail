import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {openDatabase} from '../db/database.mjs';
import {hashPassword} from './service.mjs';
import {readMailConfig,sendResetCode} from './password-mail.mjs';
import {lockNodelocBindings,removeNodelocBinding} from './nodeloc-oauth.mjs';

const deliveryTasks=new Set();
export async function waitForResetDeliveries(){await Promise.allSettled([...deliveryTasks]);}
const invalid=()=>Object.assign(new Error('验证码无效、已过期或尝试次数过多，请重新获取。'),{status:400});
export function resetEmail(value) {
  if(typeof value!=='string')throw Object.assign(new Error('请输入有效的账户邮箱。'),{status:400});
  const email=value.trim().toLowerCase();
  if(email.length>254||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email))throw Object.assign(new Error('请输入有效的账户邮箱。'),{status:400});
  return email;
}
const digest=(id,code,passwordHash)=>createHash('sha256').update(JSON.stringify(['nodemail:password-reset:v1',id,code,passwordHash])).digest('hex');
// Short-lived reset challenges reuse expiring sessions with a reserved ID
// namespace. They NEVER use login token hashes, and login queries exclude them.
export async function requestPasswordReset({email:rawEmail}, {configReader=readMailConfig,send=sendResetCode}={}) {
  const email=resetEmail(rawEmail);
  const config=await configReader();
  if(!config?.enabled || !config.secret)throw Object.assign(new Error('密码找回邮件服务尚未启用，请联系账户支持。'),{status:503});
  if(deliveryTasks.size>=10)throw Object.assign(new Error('密码找回邮件服务繁忙，请稍后再试。'),{status:503});
  const id=`pr:${randomBytes(16).toString('hex')}`;
  const code=String(randomInt(0,100000000)).padStart(8,'0');
  const c=await openDatabase();let user;
  try {
    await c.beginTransaction();
    [[user]]=await c.execute("SELECT id,email,password_hash FROM users WHERE email=? AND status='ACTIVE' FOR UPDATE",[email]);
    if(user){
      await c.execute("DELETE FROM sessions WHERE user_id=? AND id LIKE 'pr:%'",[user.id]);
      await c.execute("INSERT INTO sessions(id,user_id,token_hash,user_agent,expires_at) VALUES (?,?,?,'0',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))",[id,user.id,digest(id,code,user.password_hash)]);
    }
    await c.commit();
  }catch(error){await c.rollback();throw error;}finally{c.release();}
  if(user && deliveryTasks.size>=10){
    const cleanup=await openDatabase();
    try{await cleanup.execute('DELETE FROM sessions WHERE id=?',[id]);}finally{cleanup.release();}
    user=null;
  }
  if(user){
    // Submit outside the response path so SMTP latency cannot reveal whether an
    // account exists. Pending sends are bounded; a restart may require resend.
    const task=new Promise(resolve=>setImmediate(resolve)).then(()=>send({config,to:user.email,code})).catch(async()=>{
      const cleanup=await openDatabase();try{await cleanup.execute('DELETE FROM sessions WHERE id=?',[id]);}finally{cleanup.release();}
      console.warn('[password-reset] delivery failed');
    }).catch(()=>console.warn('[password-reset] delivery cleanup failed'));
    deliveryTasks.add(task);void task.finally(()=>deliveryTasks.delete(task));
  }
  return {requestId:id,message:'如果该邮箱存在且可用，您将收到验证码。请查看收件箱及垃圾邮件。'};
}
export async function confirmPasswordReset({email:rawEmail,requestId,code,password}) {
  const email=resetEmail(rawEmail);
  if(typeof password!=='string'||password.length<8||password.length>255)throw Object.assign(new Error('密码长度需要为 8–255 个字符。'),{status:400});
  if(typeof requestId!=='string'||!/^pr:[a-f0-9]{32}$/.test(requestId)||typeof code!=='string'||!/^\d{8}$/.test(code))throw invalid();
  const c=await openDatabase();
  try {
    await c.beginTransaction();await lockNodelocBindings(c);
    const [[user]]=await c.execute("SELECT id,password_hash FROM users WHERE email=? AND status='ACTIVE' FOR UPDATE",[email]);
    if(!user){await c.rollback();throw invalid();}
    const [[challenge]]=await c.execute("SELECT token_hash,user_agent FROM sessions WHERE id=? AND user_id=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",[requestId,user.id]);
    const attempts=Number(challenge?.user_agent);
    if(!challenge||!Number.isInteger(attempts)||attempts<0||attempts>=5){await c.rollback();throw invalid();}
    if(!timingSafeEqual(Buffer.from(challenge.token_hash,'hex'),Buffer.from(digest(requestId,code,user.password_hash),'hex'))){
      if(attempts+1>=5)await c.execute('DELETE FROM sessions WHERE id=?',[requestId]);
      else await c.execute('UPDATE sessions SET user_agent=? WHERE id=?',[String(attempts+1),requestId]);
      await c.commit();throw invalid();
    }
    await c.execute('UPDATE users SET password_hash=? WHERE id=?',[hashPassword(password),user.id]);
    // Revoke every login session and reset challenge atomically, including this
    // one. Concurrent confirmations cannot reuse a successfully consumed code.
    await c.execute('DELETE FROM sessions WHERE user_id=?',[user.id]);
    // Revoke bearer credentials too. Preserve DISABLED keys so automatic key
    // provisioning cannot bypass an administrator's API restriction.
    await c.execute("UPDATE api_keys SET status='REVOKED' WHERE user_id=? AND status='ACTIVE'",[user.id]);
    // A disabled token must not become usable again when an admin re-enables
    // API access. Keep the restriction row, but destroy the old credential.
    const [disabledKeys]=await c.execute("SELECT id FROM api_keys WHERE user_id=? AND status='DISABLED' FOR UPDATE",[user.id]);
    for(const key of disabledKeys) await c.execute(`UPDATE api_keys SET key_hash=?,
      key_ciphertext=NULL,key_kdf_salt=NULL,key_iv=NULL,key_auth_tag=NULL WHERE id=?`,
      [createHash('sha256').update(randomBytes(32)).digest('hex'),key.id]);
    // A NodeLoc account bound by whoever held the account before the mailbox
    // owner reset it must not survive as a second way in.
    const unlinked=await removeNodelocBinding(c,user.id);
    await c.commit();return {message:unlinked?'密码已更新，NodeLoc 绑定已同时解除；请使用新密码重新登录，需要时可在用户中心重新绑定。':'密码已更新，请使用新密码重新登录。'};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
