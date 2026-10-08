import {randomUUID} from 'node:crypto';
import {openDatabase,closeDatabasePool} from '../db/database.mjs';
import {preserveAuditDependencies} from '../member/business-receipts.mjs';
export {closeDatabasePool};
const KEY='audit_retention';
const defaults={days:30,cursor:0,nextAt:0,clearBeforeId:0,deleted:0};
const parse=v=>({...defaults,...(v?JSON.parse(v):{})});
async function lock(c){
 await c.execute("INSERT IGNORE INTO system_settings(`key`,value,value_type) VALUES (?,?,'json')",[KEY,JSON.stringify(defaults)]);
 const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=? FOR UPDATE',[KEY]);return parse(row.value);
}
async function put(c,v){await c.execute('UPDATE system_settings SET value=? WHERE `key`=?',[JSON.stringify(v),KEY]);}
async function ready(c){const [[row]]=await c.execute("SELECT value FROM system_settings WHERE `key`='audit_retention_ready'");return row?.value==='true';}
export async function activateAuditRetention(){
 const c=await openDatabase();try{await c.execute("INSERT INTO system_settings(`key`,value,value_type) VALUES ('audit_retention_ready','true','boolean') ON DUPLICATE KEY UPDATE value='true'");}finally{c.release();}
}
export async function auditRetentionStatus(){
 const c=await openDatabase();try{
  const [[row]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[KEY]);const v=parse(row?.value);
  return {days:v.days,ready:await ready(c),clearing:Boolean(v.clearBeforeId),deleted:v.deleted,lastRun:v.lastRun||null};
 }finally{c.release();}
}
export async function configureAuditRetention({actorUserId,action,days,confirm}){
 const c=await openDatabase();try{
  await c.beginTransaction();const v=await lock(c);
  const [[actor]]=await c.execute("SELECT role,status FROM users WHERE id=? FOR UPDATE",[actorUserId]);
  if(actor?.role!=='SUPER_ADMIN'||actor.status!=='ACTIVE')throw Object.assign(new Error('只有超级管理员可以清理或配置日志。'),{status:403});
  if(action==='save'){
   if(!Number.isInteger(days)||days<7||days>3650)throw Object.assign(new Error('保留天数须为 7–3650 的整数。'),{status:400});
   v.days=days;v.cursor=0;v.nextAt=0;
  }else if(action==='clear'){
   if(confirm!=='CLEAR_AUDIT')throw Object.assign(new Error('请确认清空审计日志。'),{status:400});
   if(!await ready(c))throw Object.assign(new Error('日志清理尚未完成发布准备，请稍后重试。'),{status:409});
   if(v.clearBeforeId)throw Object.assign(new Error('当前清理任务尚未完成。'),{status:409});
   const [[row]]=await c.execute('SELECT COALESCE(MAX(id),0) max_id FROM audit_logs');
   v.clearBeforeId=Number(row.max_id);v.cursor=0;v.nextAt=0;
  }else throw Object.assign(new Error('未知操作。'),{status:400});
  await put(c,v);
  await c.execute("INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,?,'SYSTEM_SETTING','audit_retention',?)",['AL-'+randomUUID(),actorUserId,action==='clear'?'管理员清空审计日志':'修改审计日志保留期限',JSON.stringify({days:v.days,clearBeforeId:v.clearBeforeId})]);
  await c.commit();return {ok:true};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function runAuditRetention(){
 const c=await openDatabase();try{
  await c.beginTransaction();const v=await lock(c);
  if(!await ready(c)||Date.now()<v.nextAt){await c.commit();return {deleted:0};}
  // Scan by primary key in bounded batches rather than repeatedly scanning an
  // unindexed date predicate. A full cycle waits one day; backlog continues.
  const [rows]=await c.execute('SELECT * FROM audit_logs WHERE id>?'+(v.clearBeforeId?' AND id<=?':'')+' ORDER BY id LIMIT 500 FOR UPDATE',v.clearBeforeId?[v.cursor,v.clearBeforeId]:[v.cursor]);
  const cutoff=Date.now()-v.days*86400000;
  const expired=rows.filter(r=>v.clearBeforeId||new Date(r.created_at).getTime()<cutoff);
  await preserveAuditDependencies(c,expired);
  if(expired.length)await c.execute('DELETE FROM audit_logs WHERE id IN ('+expired.map(()=>'?').join(',')+')',expired.map(r=>r.id));
  v.deleted+=expired.length;v.lastRun=new Date().toISOString();
  if(rows.length===500){v.cursor=Number(rows.at(-1).id);v.nextAt=Date.now()+60000;}
  else{v.cursor=0;v.clearBeforeId=0;v.nextAt=Date.now()+86400000;}
  await put(c,v);await c.commit();return {deleted:expired.length};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export function startAuditRetention(){
 let timer,stopped=false,current=Promise.resolve();
 const run=()=>{if(stopped)return;current=runAuditRetention().catch(()=>console.warn('[audit-retention] batch failed; retained for retry')).finally(()=>{if(!stopped){timer=setTimeout(run,60000);timer.unref();}});};
 run();return {async stop(){stopped=true;clearTimeout(timer);await current;}};
}
