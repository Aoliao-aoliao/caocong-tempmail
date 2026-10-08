import {useEffect,useRef,useState} from 'react';
import '../styles/audit-retention.css';
type Status={days:number;ready:boolean;clearing:boolean;deleted:number;canManage:boolean};
export default function AuditRetentionControls({onChange=()=>{}}:{onChange?:()=>void}){
 const [status,setStatus]=useState<Status|null>(null),[days,setDays]=useState('30'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);const lock=useRef(false),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const c=new AbortController();fetch('/api/admin/audit-retention',{signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])}).then(async r=>{const p=await r.json();if(!r.ok||!p.ok)throw Error('读取日志设置失败。');setStatus(p);setDays(String(p.days));}).catch(()=>{if(!c.signal.aborted)setMessage('读取日志设置失败，请刷新重试。');});return()=>c.abort();},[]);
 useEffect(()=>{if(!status?.clearing)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const r=await fetch('/api/admin/audit-retention',{signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])}),p=await r.json();if(r.ok&&p.ok&&!c.signal.aborted){setStatus(p);if(!p.clearing){setMessage('清理已完成，业务记录和本次清空记录已保留。');onChange();return;}}}catch{}if(!c.signal.aborted)timer=setTimeout(poll,5000);};timer=setTimeout(poll,5000);return()=>{c.abort();clearTimeout(timer);};},[status?.clearing]);
 async function run(action:string){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{
  const r=await fetch('/api/admin/audit-retention',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,days:Number(days),...(action==='clear'?{confirm:'CLEAR_AUDIT'}:{})}),signal:AbortSignal.timeout(15000)});const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||'操作失败。');setMessage(action==='clear'?'清理任务已安排，将分批处理；本次清空记录会保留。':'保留期限已保存。');if(action==='clear')setStatus(v=>v?{...v,clearing:true}:v);dialog.current?.close();onChange();
 }catch(e){setMessage(e instanceof Error?e.message:'操作失败。');}finally{lock.current=false;setBusy(false);}}
 return <section className="admin-panel audit-retention"><header><div><h2>日志保留</h2><p>默认保留 30 天，系统分批清理；订单、积分流水和业务防重复凭据独立保留。</p></div></header><div className="audit-retention-body">
 {status&&<><label>保留天数<input type="number" min={7} max={3650} step={1} value={days} disabled={busy||!status.canManage} onChange={e=>setDays(e.target.value)}/></label>
 {status.canManage&&<div className="audit-retention-actions"><button className="admin-primary" disabled={busy} onClick={()=>void run('save')}>保存期限</button><button className="admin-secondary" disabled={busy||!status.ready||status.clearing} onClick={()=>{setMessage('');dialog.current?.showModal();}}>{status.clearing?'正在分批清理':'清空现有日志'}</button></div>}
 {!status.ready&&<p>发布准备完成后将启用自动清理。</p>}</>}
 {message&&<p role="status">{message}</p>}
 </div><dialog ref={dialog} className="audit-confirm"><h2>清空审计日志？</h2><p>将分批删除当前审计日志。订单、积分流水、业务防重复凭据和本次清空记录会保留。</p><div className="audit-retention-actions"><button className="admin-secondary" disabled={busy} onClick={()=>dialog.current?.close()}>取消</button><button className="admin-primary" disabled={busy} onClick={()=>void run('clear')}>确认清空</button></div>{message&&<p role="alert">{message}</p>}</dialog></section>;
}
