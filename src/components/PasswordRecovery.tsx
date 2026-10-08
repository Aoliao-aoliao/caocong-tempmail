import {useTranslator} from '../lib/useTranslator';
import {useState,type FormEvent} from 'react';
import TurnstileWidget from './TurnstileWidget';
export default function PasswordRecovery({siteKey,configured}:{siteKey:string;configured:boolean}){
  const t=useTranslator();
  const [email,setEmail]=useState(''),[code,setCode]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
  const [requestId,setRequestId]=useState(''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[done,setDone]=useState(false),[reset,setReset]=useState(0);
  async function send(){
    if(busy)return;setBusy(true);setMessage('');setRequestId('');
    try{
      const r=await fetch('/api/auth/password/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,turnstileToken:token})});const p=await r.json();
      if(!r.ok||!p.ok)throw new Error(p.message||t("发送失败，请稍后重试。"));
      setRequestId(p.requestId);setMessage(p.message);
    }catch(e){setMessage(e instanceof Error?e.message:t("发送失败。"));}finally{setBusy(false);setToken('');setReset(v=>v+1);}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(busy)return;
    if(password!==confirm){setMessage(t("两次输入的密码不一致。"));return;}
    setBusy(true);setMessage('');
    try{const r=await fetch('/api/auth/password/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,requestId,code,password})});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.message||t("重置失败。"));setDone(true);setPassword('');setConfirm('');setCode('');setMessage(t(p.message));}
    catch(e){setMessage(e instanceof Error?e.message:t("重置失败。"));}finally{setBusy(false);}
  }
  return <form className="auth-form" onSubmit={submit}>
    {!done&&<><label htmlFor="recovery-email">{t("账户邮箱")}</label><input id="recovery-email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={e=>{setEmail(e.target.value);setRequestId('');}}/>
    {configured?<TurnstileWidget siteKey={siteKey} action="password_reset" resetKey={reset} onVerify={setToken} onExpire={()=>setToken('')} onError={()=>{setToken('');setMessage(t("人机验证暂时不可用。"));}} responsive/>:<p>{t("人机验证尚未启用，请联系账户支持。")}</p>}
    <label htmlFor="recovery-code">{t("8 位验证码（10 分钟有效）")}</label><div className="auth-code-row"><input id="recovery-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} required value={code} onChange={e=>setCode(e.target.value)}/><button type="button" disabled={busy||!token||!email} onClick={send}>{busy?t("处理中…"):t("发送验证码")}</button></div>
    <label htmlFor="recovery-password">{t("新密码")}</label><input id="recovery-password" type="password" autoComplete="new-password" minLength={8} maxLength={255} required value={password} onChange={e=>setPassword(e.target.value)}/>
    <label htmlFor="recovery-confirm">{t("确认新密码")}</label><input id="recovery-confirm" type="password" autoComplete="new-password" minLength={8} maxLength={255} required value={confirm} onChange={e=>setConfirm(e.target.value)}/>
    <button className="auth-submit" disabled={busy||!requestId}>{t("重置密码")}</button></>}
    <p role="status" aria-live="polite">{message}</p>{done&&<a href="/user/login.cgi">{t("返回登录")}</a>}
  </form>;
}
