import {useEffect,useState,type FormEvent} from 'react';
export default function PasswordMailSettings(){
  const [form,setForm]=useState({host:'',port:465,from:'',username:'',enabled:false,passwordConfigured:false,password:''});
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{let active=true;fetch('/api/admin/password-mail',{headers:{'content-type':'application/json'}}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.message);if(active){setForm({...p.config,password:''});setLoaded(true);}}).catch(e=>{if(active)setMessage(e.message);});return()=>{active=false;};},[]);
  async function save(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setMessage('');try{const r=await fetch('/api/admin/password-mail',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(form)});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.message);setForm({...p.config,password:''});setMessage('发信配置已保存。请核对发信账号和服务商要求；保存不代表实际投递已验证。');}catch(e){setMessage(e instanceof Error?e.message:'保存失败。');}finally{setBusy(false);}}
  return <section className="admin-panel password-mail-panel">
    <header><div><h2>密码找回发信</h2><p>配置用于发送找回密码验证码的专用邮箱。</p></div><span className="admin-badge info">仅超级管理员</span></header>
    <div className="password-mail-body">
      <p className="password-mail-notice">强制使用 TLS 加密连接，密码加密保存且不回显。此处不修改中继收信账号。</p>
      {!loaded && !message && <p role="status">正在读取发信配置…</p>}
      {loaded && <form className="password-mail-form" onSubmit={save}>
        <fieldset disabled={busy} className="password-mail-fields"><legend className="sr-only">发信服务器配置</legend>
          <label>SMTP 主机<input required value={form.host} onChange={e=>setForm({...form,host:e.target.value})} placeholder="smtp.example.com"/></label>
          <label>加密端口<select value={form.port} onChange={e=>setForm({...form,port:Number(e.target.value)})}><option value={465}>465 · TLS</option><option value={587}>587 · STARTTLS</option></select></label>
          <label>发件邮箱<input type="email" required value={form.from} onChange={e=>setForm({...form,from:e.target.value})} placeholder="mail@example.com"/></label>
          <label>SMTP 登录账号<input autoComplete="off" required value={form.username} onChange={e=>setForm({...form,username:e.target.value})} placeholder="通常为完整邮箱地址"/></label>
          <label className="password-mail-password">密码或应用密码<input type="password" autoComplete="new-password" value={form.password} required={!form.passwordConfigured} placeholder={form.passwordConfigured?'已保存，留空保留':'输入专用发信密码'} onChange={e=>setForm({...form,password:e.target.value})}/><small>服务商要求应用密码时，请使用应用密码。</small></label>
          <label className="password-mail-toggle"><span><strong>启用密码找回邮件</strong><small>确认配置正确后开启</small></span><input type="checkbox" role="switch" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/></label>
        </fieldset>
        <div className="password-mail-actions"><small>保存配置不代表已验证实际投递。</small><button disabled={busy} className="admin-primary">{busy?'保存中…':'保存发信配置'}</button></div>
      </form>}
      {message && <p className="password-mail-message" role="status">{message}</p>}
    </div>
  </section>;
}
