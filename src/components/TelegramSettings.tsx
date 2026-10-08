import {useTranslator} from '../lib/useTranslator';
import {useEffect,useRef,useState,type FormEvent} from 'react';
export default function TelegramSettings(){
  const t=useTranslator();
  const [form,setForm]=useState({enabled:false,origin:'',botUsername:'',tokenConfigured:false,token:''});
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const lock=useRef(false);
  useEffect(()=>{const controller=new AbortController();fetch('/api/admin/telegram',{signal:controller.signal}).then(async r=>{const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||'读取失败。');setForm({...p.config,token:''});setLoaded(true);}).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});return()=>controller.abort();},[]);
  async function run(action:'save'|'test'){
    if(lock.current)return;lock.current=true;setBusy(true);setMessage('');
    try{
      const r=await fetch('/api/admin/telegram',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='save'?{...form,action}:{action}),signal:AbortSignal.timeout(45000)});
      const p=await r.json().catch(()=>({}));if(!r.ok||!p.ok)throw Error(p.message||'操作失败，请刷新核对配置后重试。');
      if(action==='save'){setForm({...p.config,token:''});setMessage(p.config.enabled?'配置已保存，机器人绑定已开启。':'配置已保存，绑定功能已关闭。');}
      else setMessage(!p.config.botValid?'机器人身份不匹配，请重新保存配置。':!p.config.enabled?'机器人连接正常，当前绑定功能已关闭。':!p.config.webhookReady?'机器人连接正常，但回调未就绪，请重新保存。':p.config.deliveryError?'机器人和回调已配置，但有历史投递错误，请确认域名可访问且未拦截回调，再用新绑定验证。':'机器人连接正常，回调地址已就绪。');
    }catch(e){setMessage(e instanceof Error?e.message:'操作失败。');}finally{lock.current=false;setBusy(false);}
  }
  function save(e:FormEvent){e.preventDefault();void run('save');}
  return <section className="admin-panel telegram-settings">
    <header><div><h2>Telegram 绑定</h2><p>连接专用机器人，让用户绑定自己的 Telegram 账号。</p></div><span className="admin-badge info">仅超级管理员</span></header>
    <div className="telegram-settings-body">
      <p className="telegram-bind-note">{t("当前仅完成账号绑定，暂不推送邮件或通知，也不能用于登录。")}</p>
      {!loaded&&!message&&<p role="status">正在读取配置…</p>}
      {loaded&&<form onSubmit={save}>
        <fieldset disabled={busy} className="password-mail-fields"><legend className="sr-only">Telegram 机器人配置</legend>
          <label>机器人 Token<input type="password" autoComplete="new-password" value={form.token} onChange={e=>setForm({...form,token:e.target.value})} placeholder={form.tokenConfigured?'已加密保存，留空保留':'从 BotFather 复制 Token'} required={form.enabled&&!form.tokenConfigured}/><small>保存后不回显；不要填写个人账号验证码或密码。</small></label>
          <label>网站地址<input type="url" value={form.origin} onChange={e=>setForm({...form,origin:e.target.value})} required placeholder="https://mail.example.com"/><small>填写用户端的公网 HTTPS 根地址。</small></label>
          <label>机器人账号<input readOnly value={form.botUsername?'@'+form.botUsername:'保存后自动识别'}/><small>系统向 Telegram 核验，不需要手工填写。</small></label>
          <label className="password-mail-toggle"><span><strong>启用 Telegram 绑定</strong><small>保存时自动设置机器人回调</small></span><input type="checkbox" role="switch" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/></label>
        </fieldset>
        <div className="telegram-webhook"><strong>自动回调地址</strong><code>{form.origin.replace(/\/$/,'')}/api/telegram/webhook</code></div>
        <div className="telegram-settings-actions"><button type="button" className="admin-secondary" disabled={busy||!form.tokenConfigured} onClick={()=>void run('test')}>检查已保存配置</button><button type="submit" className="admin-primary" disabled={busy}>{busy?'处理中…':'保存 Telegram 配置'}</button></div>
      </form>}
      {message&&<p className="telegram-settings-message" role="status">{message}</p>}
      <div className="telegram-setup-guide"><h3>如何配置</h3><ol>
        <li>在 Telegram 打开 <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather ↗</a>，发送 <code>/newbot</code>，按提示创建专用机器人。</li>
        <li>复制 Token 填到上方，核对网站地址，开启绑定并保存。系统会自动设置回调，无需手动运行命令。</li>
        <li>点击“检查已保存配置”。域名必须可公网访问；Cloudflare/WAF 不应对 <code>/api/telegram/webhook</code> 设置登录或人机挑战。</li>
        <li>用户在用户中心点击绑定，打开机器人并点击 Start / 开始，再回网站核对 Telegram 账号并确认绑定。</li>
      </ol><p>绑定链接 10 分钟有效，请勿分享。每个 Telegram 账号只能绑定一个本站账户。更换机器人前先关闭并保存，用户需重新绑定。{t("当前仅完成账号绑定，暂不推送邮件或通知，也不能用于登录。")}</p><a href="https://core.telegram.org/bots/features#deep-linking" target="_blank" rel="noopener noreferrer">Telegram 官方说明 ↗</a></div>
    </div>
  </section>;
}
