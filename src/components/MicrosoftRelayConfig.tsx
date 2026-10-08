import {useEffect,useRef,useState,type FormEvent} from 'react';
export type MicrosoftConfig={clientId:string;redirectUri:string;secretConfigured:boolean};
export async function microsoftRequest(body:unknown){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch('/api/admin/microsoft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!data?.ok)throw new Error(data?.message||'微软授权操作未确认，请刷新核对。');return data;
  }catch(error){
    if(controller.signal.aborted)throw new Error('微软授权请求超时，请检查网络后重试。');
    throw error;
  }finally{clearTimeout(timeout);}
}
export default function MicrosoftRelayConfig({initialConfig,canConfigure}:{initialConfig:MicrosoftConfig;canConfigure:boolean}){
  const [config,setConfig]=useState(initialConfig),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');const lock=useRef(false);
  useEffect(()=>{const outcome=new URLSearchParams(location.search).get('microsoft');if(outcome)setMessage(outcome==='success'?'微软授权已保存。请检测连接；确认成功后启用账号。':outcome==='account-mismatch'?'授权邮箱与指定账号不一致，请选择正确微软账号重新授权。':outcome==='cancelled'?'微软授权已取消。':'微软授权未完成。请核对登录会话、应用配置和回调地址，再重新授权。');},[]);
  const save=async(event:FormEvent)=>{event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{const result=await microsoftRequest({action:'save',...config,clientSecret:secret});setConfig(result.config);setSecret('');setMessage('微软应用配置已保存。修改应用或密钥后，已有微软账号需要重新授权。');}catch(e){setMessage(e instanceof Error?e.message:'保存失败');}finally{lock.current=false;setBusy(false);}};
  return <section className="admin-panel microsoft-relay-config"><header><h2>微软邮箱 OAuth2</h2><p>支持 Outlook.com / Hotmail 个人账号。授权后使用加密连接收信，令牌由服务器自动刷新。</p></header><form onSubmit={save}><fieldset disabled={busy||!canConfigure}><label>应用 Client ID<input required autoComplete="off" value={config.clientId} onChange={e=>setConfig({...config,clientId:e.target.value})}/></label><label>Client Secret（值）<input type="password" autoComplete="new-password" required={!config.secretConfigured} value={secret} onChange={e=>setSecret(e.target.value)} placeholder={config.secretConfigured?'已加密保存；留空保留':'填写 Secret Value，不是 Secret ID'}/></label><label className="microsoft-callback">Web 回调地址<input type="url" required value={config.redirectUri} onChange={e=>setConfig({...config,redirectUri:e.target.value})}/><small>将此完整地址登记到微软应用的 Web 平台，不能添加末尾斜杠。</small></label></fieldset><p>个人 Microsoft 账户 · 委托权限 IMAP.AccessAsUser.All · offline_access。Outlook 网页设置中也需允许 IMAP。</p>{canConfigure?<button type="submit" disabled={busy}>{busy?'正在保存…':'保存微软应用配置'}</button>:<small>只有超级管理员可修改应用配置；管理员可在下方授权和检测邮箱。</small>}{message&&<p role="status" className="relay-admin-message">{message}</p>}</form></section>;
}
