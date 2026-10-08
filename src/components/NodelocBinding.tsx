import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useTranslator} from '../lib/useTranslator';
import '../styles/nodeloc-oauth.css';
type State={available:boolean;bound:boolean;username:string;trustLevel:number|null};
export default function NodelocBinding(){
  const t=useTranslator(),dialog=useRef<HTMLDialogElement>(null),lock=useRef(false);
  const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[password,setPassword]=useState('');
  useEffect(()=>{const controller=new AbortController();fetch('/api/user/nodeloc-oauth',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}).then(async r=>{const p=await r.json();if(r.ok&&p.ok)setState(p);}).catch(()=>{});
    const outcome=new URLSearchParams(window.location.search).get('nodeloc');if(outcome)setMessage(t(outcome==='bound'?'NodeLoc 绑定成功。':outcome==='refreshed'?'NodeLoc 社区资料已更新。':'NodeLoc 授权未完成，请重新尝试。'));return()=>controller.abort();},[]);
  async function run(unlink=false,refresh=false){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{
    const r=await fetch(unlink?'/api/user/nodeloc-oauth':'/api/auth/nodeloc/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(unlink?{action:'unlink',password}:{mode:refresh?'refresh':'bind'}),signal:AbortSignal.timeout(15000)}),p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||t('操作失败。'));window.location.assign(unlink?'/user/login.cgi':p.url);
  }catch(e){setMessage(e instanceof Error?e.message:t('操作失败。'));}finally{setPassword('');lock.current=false;setBusy(false);}}
  function unlink(e:FormEvent){e.preventDefault();void run(true);}
  if(!state?.available&&!state?.bound&&!message)return null;
  return <div className="account-config-item nodeloc-account"><dt>NodeLoc</dt><dd><strong>{state?.bound?(state.username||t('已绑定')):t('未绑定')}</strong>
    {state?.bound&&<span className="nodeloc-level">{t('社区等级')} · {state.trustLevel===null||state.trustLevel===undefined?t('待同步'):`TL${state.trustLevel}`}</span>}
    {state?.bound&&state.available&&<button className="nodeloc-bind-action" disabled={busy} onClick={()=>void run(false,true)}>{t('更新社区资料')}</button>}
    {state?.bound?<button className="nodeloc-bind-action" disabled={busy} onClick={()=>{setMessage('');dialog.current?.showModal();}}>{t('解除绑定')}</button>:<button className="nodeloc-bind-action" disabled={busy||!state?.available} onClick={()=>void run()}>{t('绑定 NodeLoc')}</button>}</dd>
    {state?.bound&&<small className="nodeloc-profile-note">{t('等级来自最近一次 NodeLoc 授权，可更新社区资料同步。')}</small>}
    {message&&<small className="nodeloc-oauth-message" role="status">{t(message)}</small>}
    <dialog className="nodeloc-unlink-dialog" ref={dialog} onCancel={()=>setPassword('')} onClose={()=>setPassword('')}><header><h2>{t('解除 NodeLoc 绑定')}</h2><button type="button" disabled={busy} aria-label={t('关闭')} onClick={()=>{setPassword('');dialog.current?.close();}}>×</button></header>
      <form onSubmit={unlink}><p>{t('解绑需验证本站密码，并退出所有登录。未设置密码请先通过忘记密码设置。')}</p><label>{t('本站登录密码')}<input type="password" required autoComplete="current-password" maxLength={255} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>
      {message&&<p role="alert" className="nodeloc-oauth-message">{t(message)}</p>}<div className="nodeloc-oauth-actions"><a href="/user/password/recover.cgi">{t('忘记密码？')}</a><button type="submit" disabled={busy}>{t('确认解绑')}</button></div></form>
    </dialog></div>;
}
