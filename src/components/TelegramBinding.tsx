import {useTranslator} from '../lib/useTranslator';
import {useEffect,useRef,useState} from 'react';
type State={enabled:boolean;bound:boolean;username:string;telegramId:string;botUsername:string;pending:null|{ready:boolean;username:string;telegramId:string;requestId:string;expiresAt:string}};
export default function TelegramBinding(){
  const t=useTranslator();
  const [state,setState]=useState<State|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[link,setLink]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false),generation=useRef(0);
  useEffect(()=>{const controller=new AbortController();fetch('/api/user/telegram',{signal:controller.signal}).then(async r=>{const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||'读取失败');setState(p.result);}).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});return()=>{controller.abort();generation.current++;};},[]);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
  useEffect(()=>{
    if(!open||!state?.pending||state.pending.ready)return;
    let stopped=false;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      const current=generation.current;
      try{
        if(!document.hidden){const r=await fetch('/api/user/telegram',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});const p=await r.json();if(r.ok&&p.ok&&!stopped&&current===generation.current&&!lock.current){setState(p.result);if(!p.result.pending)setMessage('绑定链接已过期，请重新生成。');}}
      }catch{}finally{if(!stopped)timer=setTimeout(poll,6000);}
    }
    timer=setTimeout(poll,3000);return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[open,state?.pending?.requestId,state?.pending?.ready]);
  async function act(action:'begin'|'confirm'|'unlink'){
    if(lock.current)return;lock.current=true;generation.current++;setBusy(true);setMessage('');
    try{
      const r=await fetch('/api/user/telegram',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,requestId:state?.pending?.requestId}),signal:AbortSignal.timeout(20000)});
      const p=await r.json().catch(()=>({}));if(!r.ok||!p.ok)throw Error(p.message||'操作未确认，请刷新核对绑定状态。');setState(p.result);
      if(action==='begin'){setLink(p.result.url);setOpen(true);}
      else {setLink('');setMessage(action==='confirm'?'Telegram 绑定成功。':'Telegram 已解绑。');setOpen(false);}
    }catch(e){setMessage(e instanceof Error?e.message:'操作失败。');}finally{lock.current=false;setBusy(false);}
  }
  async function unlink(){const yes=await ((window as any).NodeMailDialog?.confirm('确认解除 Telegram 绑定？')??Promise.resolve(window.confirm('确认解除 Telegram 绑定？')));if(yes)void act('unlink');}
  return <>
    <dd><strong>{state?.bound?(state.username?'@'+state.username:'Telegram 已绑定'):'Telegram 未绑定'}</strong>
      {state?.bound?<button type="button" className="telegram-bind-action" disabled={busy} onClick={unlink}>解绑</button>:<button type="button" className="telegram-bind-action" disabled={busy||!state?.enabled} title={state?.enabled?'绑定自己的 Telegram 账号':'管理员尚未开启 Telegram 绑定'} onClick={()=>{setMessage('');setOpen(true);}}>点击绑定</button>}
    </dd>
    <small className="telegram-bind-note">{t("当前仅完成账号绑定，暂不推送邮件或通知，也不能用于登录。")}</small>
    {message&&!open&&<small className="telegram-member-message" role="status">{message}</small>}
    <dialog ref={dialog} className="telegram-bind-dialog" onCancel={()=>{setOpen(false);setLink('');}} onClose={()=>setOpen(false)}>
      <header><h2>绑定 Telegram</h2><button type="button" aria-label="关闭" onClick={()=>{setOpen(false);setLink('');}}>×</button></header>
      <p>先打开机器人并点击 Start / 开始，再回此处确认。</p>
      <div className="telegram-bind-stage">
        {state?.pending?.ready?<><strong>请确认这是你的 Telegram</strong><p>{state.pending.username?'@'+state.pending.username:'无用户名'} · ID {state.pending.telegramId}</p><button className="telegram-primary" type="button" disabled={busy} onClick={()=>void act('confirm')}>确认绑定这个账号</button></>:<>
          {link?<><a className="telegram-primary" href={link} target="_blank" rel="noopener noreferrer">打开 Telegram 机器人 ↗</a><small>链接 10 分钟有效，请勿分享。返回网站后会自动检查。</small></>:<button className="telegram-primary" type="button" disabled={busy||!state?.enabled} onClick={()=>void act('begin')}>{busy?'生成中…':'生成绑定链接'}</button>}
        </>}
        {state?.pending&&<button className="telegram-bind-action" type="button" disabled={busy} onClick={()=>{setLink('');void act('begin');}}>重新生成链接</button>}
      </div>
      {message&&<p role="status" className="telegram-member-message">{message}</p>}
      <p className="telegram-bind-note">{t("当前仅完成账号绑定，暂不推送邮件或通知，也不能用于登录。")} {t("每个 Telegram 账号只能绑定一个本站账户。")}</p>
    </dialog>
  </>;
}
