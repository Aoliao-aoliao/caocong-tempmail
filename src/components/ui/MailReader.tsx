import {useEffect, useId, useState} from 'react';
import {createPortal} from 'react-dom';
import {useTranslator} from '../../lib/useTranslator';
import {copyText} from '../../lib/clipboard';
import {useDialog} from './useDialog';

type Message = {sender?:string; recipient?:string; subject?:string; content_type?:string; contentType?:string; body_text?:string; bodyText?:string; received_at?:string|null; receivedAt?:string|null};
type Props = {message:Message; loading?:boolean; error?:string; onClose:()=>void; recipient?:string};
export function MailReaderContent({message, loading=false, error='', onClose, recipient=''}:Props) {
  const t=useTranslator(), subjectId=useId();
  const [notice,setNotice]=useState('');
  const sender=message.sender||'—', address=message.recipient||recipient||'—';
  const body=message.body_text??message.bodyText??'';
  const received=message.received_at??message.receivedAt;
  const date=received?new Date(received):null;
  const time=date&&Number.isFinite(date.getTime())?date.toLocaleString(documentLocale(),{hour12:false}):'—';
  const copy=async(value:string)=>setNotice(await copyText(value)?t('已复制'):t('复制失败，请手动选择复制。'));
  return <div className="mc-mail-reader" role="presentation">
    <button className="mc-mail-reader-backdrop" type="button" aria-label={t('关闭')} onClick={onClose}/>
    <section className="mc-mail-reader-card" role="dialog" aria-modal="true" aria-labelledby={subjectId}>
      <header className="mc-mail-reader-head"><div className="mc-mail-reader-avatar" aria-hidden="true">{sender.trim().charAt(0).toUpperCase()}</div><div><span>{t('查阅邮件')}</span><strong>{sender}</strong></div><button type="button" aria-label={t('关闭')} onClick={onClose}>×</button></header>
      <div className="mc-mail-reader-content" tabIndex={0} aria-label={t("邮件正文")}>
        <div className="mc-mail-reader-summary"><span>{t(message.content_type||message.contentType||'纯文本邮件')}</span><h2 id={subjectId}>{message.subject||t('（无主题）')}</h2><dl>
          <div className="has-copy"><dt>{t('发件人')}</dt><dd>{sender}</dd><button type="button" aria-label={t('复制发件人')} onClick={()=>void copy(sender)}><CopyIcon/></button></div>
          <div className="has-copy"><dt>{t('收件邮箱：')}</dt><dd>{address}</dd><button type="button" aria-label={t('复制收件邮箱')} onClick={()=>void copy(address)}><CopyIcon/></button></div>
          <div><dt>{t('收信时间')}</dt><dd>{time}</dd></div>
        </dl></div>
        <div className="mc-mail-reader-body" aria-busy={loading}>
          {loading?<div className="mc-mail-reader-loading" role="status"><i/>{t('正在读取邮件…')}</div>:error?<div className="mc-mail-reader-loading" role="alert">{error}</div>:<><button className="mc-mail-body-copy" type="button" aria-label={t('复制正文')} onClick={()=>void copy(body)}><CopyIcon/></button><pre>{body||t('（邮件正文为空）')}</pre></>}
        </div>
      </div>
      <footer><span role="status">{notice||t('邮件内容已隔离展示')}</span><button type="button" onClick={onClose}>{t('关闭')}</button></footer>
    </section>
  </div>;
}
function documentLocale(){return typeof document==='undefined'?'zh-CN':document.documentElement.lang||'zh-CN';}
export default function MailReader(props:Props) {
  const [mounted,setMounted]=useState(false);
  useEffect(()=>{setMounted(true);document.body.classList.add('mc-mail-reader-open');return()=>document.body.classList.remove('mc-mail-reader-open');},[]);
  useDialog(mounted,props.onClose,'.mc-mail-reader-card');
  // Portal avoids ancestor transforms/backdrop filters clipping a fixed dialog.
  return mounted?createPortal(<MailReaderContent {...props}/>,document.body):null;
}

function CopyIcon(){return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>;}
