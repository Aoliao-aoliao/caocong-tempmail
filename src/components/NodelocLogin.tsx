import {useRef,useState} from 'react';
import {useTranslator} from '../lib/useTranslator';
import '../styles/nodeloc-oauth.css';
export default function NodelocLogin(){
  const t=useTranslator(),lock=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function login(){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{
    const r=await fetch('/api/auth/nodeloc/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'login'}),signal:AbortSignal.timeout(15000)}),p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||t('发起 NodeLoc 授权失败。'));window.location.assign(p.url);
  }catch(e){setMessage(e instanceof Error?e.message:t('发起 NodeLoc 授权失败。'));lock.current=false;setBusy(false);}}
  return <div className="nodeloc-login"><button type="button" disabled={busy} onClick={()=>void login()}>{t(busy?'正在跳转…':'使用 NodeLoc 登录')}</button><small>{t('首次登录自动注册，已有账户请先登录后绑定。')}</small>{message&&<p role="alert">{t(message)}</p>}</div>;
}
