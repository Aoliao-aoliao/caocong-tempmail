import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useTranslator} from '../lib/useTranslator';
import '../styles/nodeloc-oauth.css';
type Config={enabled:boolean;clientId:string;clientSecret:string;origin:string;secretConfigured:boolean};
export default function NodelocOAuthSettings(){
  const t=useTranslator(),lock=useRef(false);
  const [form,setForm]=useState<Config>({enabled:false,clientId:'',clientSecret:'',origin:'',secretConfigured:false});
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{const controller=new AbortController();fetch('/api/admin/nodeloc-oauth',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}).then(async r=>{const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||t('读取配置失败。'));setForm({...p.config,clientSecret:'',origin:p.config.origin||window.location.origin});setLoaded(true);}).catch(e=>{if(!controller.signal.aborted)setMessage(e instanceof Error?e.message:t('读取配置失败。'));});return()=>controller.abort();},[]);
  async function save(e:FormEvent){e.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setMessage('');
    try{const r=await fetch('/api/admin/nodeloc-oauth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:form.enabled,clientId:form.clientId,clientSecret:form.clientSecret,origin:form.origin}),signal:AbortSignal.timeout(15000)});const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||t('保存失败。'));setForm({...p.config,clientSecret:''});setMessage(t('NodeLoc 登录配置已保存。'));}
    catch(e){setMessage(e instanceof Error?e.message:t('保存失败。'));}finally{lock.current=false;setBusy(false);}
  }
  return <section className="admin-panel nodeloc-oauth-settings"><header><div><h2>{t('NodeLoc 登录')}</h2><p>{t('首次登录自动注册，已有账户可在用户中心绑定。')}</p></div><span className="admin-badge info">{t('仅超级管理员')}</span></header>
    <div className="nodeloc-oauth-body">
      {!loaded&&!message&&<p role="status">{t('正在读取配置…')}</p>}
      {loaded&&<form onSubmit={save}><fieldset className="password-mail-fields nodeloc-config-fields" disabled={busy}><legend className="sr-only">{t('NodeLoc 登录配置')}</legend>
        <label>Client ID<input value={form.clientId} maxLength={256} required={form.enabled} onChange={e=>setForm({...form,clientId:e.target.value})}/></label>
        <label>Client Secret<input type="password" autoComplete="new-password" maxLength={4096} value={form.clientSecret} required={form.enabled&&!form.secretConfigured} onChange={e=>setForm({...form,clientSecret:e.target.value})} placeholder={t(form.secretConfigured?'已加密保存，留空保留':'填写应用 Client Secret')}/><small>{t('密钥加密保存，不会回显；更换 Client ID 时需填写新密钥。')}</small></label>
        <label className="nodeloc-full-row">{t('用户端网站地址')}<input type="url" required value={form.origin} onChange={e=>setForm({...form,origin:e.target.value})} placeholder="https://mail.example.com"/><small>{t('填写公网 HTTPS 根地址，登录入口只在此域名显示。')}</small></label>
        <label className="password-mail-toggle nodeloc-full-row"><span><strong>{t('启用 NodeLoc 登录')}</strong><small>{t('先完成 NodeLoc 应用审核，再开启登录入口。')}</small></span><input type="checkbox" role="switch" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/></label>
      </fieldset><div className="nodeloc-oauth-callback"><strong>{t('授权回调地址')}</strong><code>{form.origin.replace(/\/$/,'')}/api/auth/nodeloc/callback</code><small>{t('完整复制到 NodeLoc 应用的 Redirect URI，必须完全一致。')}</small></div>
      <div className="nodeloc-oauth-actions"><button className="admin-primary" disabled={busy} type="submit">{t(busy?'保存中…':'保存 NodeLoc 登录配置')}</button></div></form>}
      {message&&<p className="nodeloc-oauth-message" role="status">{t(message)}</p>}
      <div className="nodeloc-oauth-guide"><h3>{t('如何配置')}</h3><ol>
        <li>{t('使用 TL2 及以上的 NodeLoc 账号创建 OAuth 应用。')} <a href="https://www.nodeloc.com/oauth-provider/applications" target="_blank" rel="noopener noreferrer">{t('打开应用管理')} ↗</a></li>
        <li>{t('申请 openid、profile、email 权限；email 权限需要 NodeLoc 管理员审核。')}</li>
        <li>{t('填写回调地址，将 Client ID 和 Client Secret 保存到这里，审核通过后开启登录。')}</li>
        <li>{t('用户可在登录或注册页选择 NodeLoc；已有账户请先用原方式登录，再在用户中心绑定，保留原积分和邮箱。')}</li>
      </ol><p>{t('同邮箱不会自动合并账户。解绑需验证本站密码；未设置密码请先通过忘记密码设置。关闭入口不会删除用户或绑定。')}</p><a href="https://docs.nodeloc.com/api-reference/introduction" target="_blank" rel="noopener noreferrer">{t('NodeLoc 官方接入文档')} ↗</a></div>
    </div></section>;
}
