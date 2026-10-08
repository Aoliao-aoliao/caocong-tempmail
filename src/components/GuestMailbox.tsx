import MailReader from './ui/MailReader';
import { useGuestAttempt } from './ui/useGuestAttempt';
import { discountedMailboxPrice } from "../../server/member/mailbox-price.mjs";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import TurnstileWidget from "./TurnstileWidget";

type Domain = { domain: string; kind: "PUBLIC" | "LOGIN" | "MEMBER" };
type Plan = { id: string; label: string; minutes: number; points: number };
type AppLocale = "zh-CN" | "zh-TW" | "en-US";
type GuestMailboxData = { available?:boolean; id:string; address:string; localPart:string; domain:string; durationMinutes:number; receivedCount:number; expiresAt:string; createdAt:string };
type GuestMessage = { id:string; sender:string; subject:string; sizeBytes:number; isRead:boolean; receivedAt:string };
type GuestMessageDetail = GuestMessage & { recipient:string; contentType:string; bodyText:string };

const LOGIN_URL = "/user/login.cgi";
const messages = {
  "zh-CN": { title:"临时邮箱",description:"一键领取随机邮箱地址，无需设置名称和保留周期。地址仅在当前会话中使用。",activeDescription:"复制邮箱地址即可开始使用，收到的新邮件会自动出现在下方列表中。",mailboxName:"邮箱名称",custom:"自定义邮箱",waiting:"等待生成",noDomain:"暂无可用域名",memberOnly:"会员专用",loginRequired:"需登录",freeMailbox:"免费邮箱",random:"随机生成邮箱",guestIntro:"临时收信",receiving:"邮箱正在接收邮件",currentAddress:"当前收信地址",change:"换一个",copy:"复制完整邮箱地址",copied:"已复制",copyFailed:"复制失败，请手动复制邮箱地址。",validUntil:"有效至",validity:"1 小时",stockReady:"库存充足",stockEmpty:"等待启用域名",noDomainStatus:"管理员尚未启用可收信域名",inbox:"收件箱",inboxDescription:"创建邮箱后，收到的邮件会自动显示在这里。",waitingMail:"等待新邮件",refresh:"刷新",searchPlaceholder:"搜索发件人或主题",search:"搜索",noData:"暂无数据",previous:"上一页",next:"下一页",human:"人机验证",confirm:"确认申请",validTime:"有效时长",points:"积分",memberPrice:"会员价",free:"免费",captchaAction:"进行人机身份验证",cancel:"取消",close:"关闭",creating:"正在分配临时邮箱…",created:"邮箱已启用，可以开始收信",changed:"邮箱已更换，请复制上方新地址。",unchanged:"邮箱地址未更换，请重新验证后再试。",loadFailed:"收件箱读取失败，请稍后重试。",expired:"临时邮箱已过期，请重新生成。",sender:"发件人",subject:"主题",keyInfo:"关键信息",receivedAt:"收信时间",action:"操作",openMail:"查看邮件",reading:"正在读取邮件…",recipient:"收件邮箱",emptyBody:"（邮件正文为空）" },
  "zh-TW": { title:"臨時郵箱",description:"一鍵領取隨機郵箱地址，無需設定名稱和保留週期。地址僅在目前工作階段中使用。",activeDescription:"複製郵箱地址即可開始使用，收到的新郵件會自動出現在下方列表中。",mailboxName:"郵箱名稱",custom:"自訂郵箱",waiting:"等待生成",noDomain:"暫無可用域名",memberOnly:"會員專用",loginRequired:"需要登入",freeMailbox:"免費郵箱",random:"隨機生成郵箱",guestIntro:"臨時收信",receiving:"郵箱正在接收郵件",currentAddress:"目前收信地址",change:"換一個",copy:"複製完整郵箱地址",copied:"已複製",copyFailed:"複製失敗，請手動複製郵箱地址。",validUntil:"有效至",validity:"1 小時",stockReady:"庫存充足",stockEmpty:"等待啟用域名",noDomainStatus:"管理員尚未啟用可收信域名",inbox:"收件箱",inboxDescription:"建立郵箱後，收到的郵件會自動顯示在這裡。",waitingMail:"等待新郵件",refresh:"重新整理",searchPlaceholder:"搜尋寄件者或主旨",search:"搜尋",noData:"暫無資料",previous:"上一頁",next:"下一頁",human:"人機驗證",confirm:"確認申請",validTime:"有效時長",points:"積分",memberPrice:"會員價",free:"免費",captchaAction:"進行人機身分驗證",cancel:"取消",close:"關閉",creating:"正在分配臨時郵箱…",created:"郵箱已啟用，可以開始收信",changed:"郵箱已更換，請複製上方新地址。",unchanged:"郵箱地址未更換，請重新驗證後再試。",loadFailed:"收件箱讀取失敗，請稍後重試。",expired:"臨時郵箱已過期，請重新生成。",sender:"寄件者",subject:"主旨",keyInfo:"關鍵資訊",receivedAt:"收信時間",action:"操作",openMail:"查看郵件",reading:"正在讀取郵件…",recipient:"收件郵箱",emptyBody:"（郵件正文為空）" },
  "en-US": { title:"Temporary mailbox",description:"Get a random email address with one click, without setting a name and retention period. The address is used only in this session.",activeDescription:"Copy the email address to start using it. New messages will automatically appear below.",mailboxName:"Email name",custom:"Custom email",waiting:"Waiting for generation",noDomain:"No domain available",memberOnly:"Members only",loginRequired:"Login required",freeMailbox:"Free email",random:"Randomly generate email",guestIntro:"Temporary inbox",receiving:"Mailbox is receiving messages",currentAddress:"Current receiving address",change:"Change",copy:"Copy full email address",copied:"Copied",copyFailed:"Unable to copy. Please copy the address manually.",validUntil:"Valid until",validity:"1 hour",stockReady:"Sufficient stock",stockEmpty:"Waiting for domain",noDomainStatus:"No receiving domain has been enabled",inbox:"Inbox",inboxDescription:"After you create a mailbox, incoming emails will automatically appear here.",waitingMail:"Wait for new mail",refresh:"Refresh",searchPlaceholder:"Search sender or subject",search:"Search",noData:"No data yet",previous:"Previous",next:"Next",human:"Human verification",confirm:"Confirm application",validTime:"Valid time",points:"points",memberPrice:"Member price",free:"free",captchaAction:"Verify that you are human",cancel:"Cancel",close:"Close",creating:"Allocating a temporary mailbox…",created:"Mailbox is enabled and ready to receive mail",changed:"Mailbox changed. Copy the new address above.",unchanged:"The mailbox address did not change. Verify again and retry.",loadFailed:"Unable to load the inbox. Please try again.",expired:"This temporary mailbox has expired. Generate a new one.",sender:"Sender",subject:"Subject",keyInfo:"Key information",receivedAt:"Received",action:"Action",openMail:"Open",reading:"Loading message…",recipient:"Recipient",emptyBody:"(Empty message body)" },
} as const;

export default function GuestMailbox({ domains,plans,memberDiscountPercent,turnstileSiteKey,turnstileConfigured,freeMailboxMinutes=60,locale="zh-CN" }: { domains:Domain[]; plans:Plan[]; memberDiscountPercent:number; turnstileSiteKey:string; turnstileConfigured:boolean; freeMailboxMinutes?:number; locale?:AppLocale }) {
  const t=messages[locale];
  const unavailableMessage=locale==="en-US"?"Receiving paused. Contact the administrator.":locale==="zh-TW"?"暫停收信，請聯絡管理員":"暂停收信，请联系管理员";
  const captchaExpiredMessage=locale==="en-US"?"Verification expired. Please complete it again.":locale==="zh-TW"?"驗證已過期，請重新完成驗證。":"验证已过期，请重新完成验证。";
  const captchaUnavailableMessage=locale==="en-US"?"Human verification is temporarily unavailable. Please try again.":locale==="zh-TW"?"人機驗證暫時無法使用，請稍後再試。":"人机验证暂时不可用，请稍后重试。";
  const captchaNotConfiguredMessage=locale==="en-US"?"Human verification has not been configured. Please contact the administrator.":locale==="zh-TW"?"人機驗證尚未設定，請聯絡管理員。":"人机验证尚未配置，请联系管理员。";
  const usableDomains=useMemo(()=>domains.filter((item)=>item.kind==="PUBLIC"),[domains]);
  const [domain,setDomain]=useState(usableDomains[0]?.domain||"");
  // Receiving the previous inbox must not replace the next creation choice.
  const domainChosenRef=useRef(false);
  const [domainOpen,setDomainOpen]=useState(false);
  const [captchaOpen,setCaptchaOpen]=useState(false);
  const [captchaMessage,setCaptchaMessage]=useState("");
  const attempt=useGuestAttempt();
  const [selectedPlan,setSelectedPlan]=useState(plans.find((item)=>item.points===0)?.id||plans[0]?.id||"");
  const [status,setStatus]=useState("");
  const [query,setQuery]=useState("");
  const [submittedQuery,setSubmittedQuery]=useState("");
  const [mailbox,setMailbox]=useState<GuestMailboxData|null>(null);
  const [mailItems,setMailItems]=useState<GuestMessage[]>([]);
  const [page,setPage]=useState(1);
  const [pages,setPages]=useState(1);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(false);
  const [refreshCooldown,setRefreshCooldown]=useState(0);
  const [copied,setCopied]=useState(false);
  const [selectedMessage,setSelectedMessage]=useState<GuestMessageDetail|null>(null);
  const [messageLoading,setMessageLoading]=useState(false);
  const [messageError,setMessageError]=useState("");
  const pickerRef=useRef<HTMLDivElement>(null);
  const captchaSubmissionRef=useRef(false);
  const messageRequestRef=useRef(0);
  const listRequestRef=useRef(0);
  const refreshTimerRef=useRef<number|null>(null);

  const validityLabel=useMemo(()=>{
    const minutes=Math.max(1,Number(freeMailboxMinutes||60));
    if(locale==="en-US"){
      if(minutes%1440===0)return `${minutes/1440} ${minutes===1440?"day":"days"}`;
      if(minutes%60===0)return `${minutes/60} ${minutes===60?"hour":"hours"}`;
      return `${minutes} minutes`;
    }
    if(minutes%1440===0)return `${minutes/1440} 天`;
    if(minutes%60===0)return `${minutes/60} ${locale==="zh-TW"?"小時":"小时"}`;
    return `${minutes} ${locale==="zh-TW"?"分鐘":"分钟"}`;
  },[freeMailboxMinutes,locale]);
  const planLabel=(item:Plan)=>{
    if(locale==="zh-CN")return item.label;
    if(locale==="zh-TW")return item.label.replaceAll("小时","小時");
    if(item.minutes%1440===0){const days=item.minutes/1440;return `${days} ${days===1?"day":"days"}`;}
    const hours=item.minutes/60;return `${hours} ${hours===1?"hour":"hours"}`;
  };
  const formatTime=(value:string)=>{try{return new Intl.DateTimeFormat(locale,{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(value));}catch{return value;}};

  async function loadMessages(nextPage=1,search=submittedQuery,silent=false,manual=false){
    if(captchaSubmissionRef.current)return;
    const requestId=listRequestRef.current+1;listRequestRef.current=requestId;
    if(!silent)setLoading(true);
    try{
      const params=new URLSearchParams({page:String(nextPage)});if(search)params.set("q",search);if(manual)params.set("manual","1");
      const response=await fetch(`/api/guest/messages?${params}`,{cache:"no-store",headers:{accept:"application/json"}});
      const result=await response.json().catch(()=>null);
      if(listRequestRef.current!==requestId)return;
      if(!response.ok||!result?.ok){
        if(response.status===401||response.status===410){closeMessage();setMailbox(null);setMailItems([]);setTotal(0);setPage(1);setPages(1);setStatus(t.expired);return;}
        throw new Error(result?.message||t.loadFailed);
      }
      setMailbox(result.mailbox);setMailItems(result.messages||[]);setTotal(Number(result.pagination?.total||0));setPage(Number(result.pagination?.page||1));setPages(Number(result.pagination?.pages||1));
    }catch(error){if(listRequestRef.current===requestId&&!silent)setStatus(error instanceof Error?error.message:t.loadFailed);}finally{if(listRequestRef.current===requestId)setLoading(false);}
  }

  useEffect(()=>{let cancelled=false;const requestId=++listRequestRef.current;void(async()=>{try{const response=await fetch("/api/guest/mailbox",{cache:"no-store",headers:{accept:"application/json"}});const result=await response.json().catch(()=>null);if(cancelled||listRequestRef.current!==requestId||!response.ok||!result?.ok||!result.mailbox)return;setMailbox(result.mailbox);if(!domainChosenRef.current&&usableDomains.some(item=>item.domain===result.mailbox.domain))setDomain(result.mailbox.domain);await loadMessages(1,"",true);}catch{/* A missing guest cookie is a normal first visit. */}})();return()=>{cancelled=true;listRequestRef.current+=1;};},[]);
  useEffect(()=>{closeMessage();},[mailbox?.id]);
  useEffect(()=>()=>{messageRequestRef.current+=1;},[]);
  useEffect(()=>{if(!mailbox)return;const timer=window.setInterval(()=>void loadMessages(page,submittedQuery,true),8000);return()=>window.clearInterval(timer);},[mailbox?.id,page,submittedQuery]);
  useEffect(()=>{
    const closePicker=(event:MouseEvent)=>{if(!pickerRef.current?.contains(event.target as Node))setDomainOpen(false);};
    const closeWithEscape=(event:KeyboardEvent)=>{if(event.key!=="Escape")return;setDomainOpen(false);closeCaptcha();closeMessage();};
    document.addEventListener("mousedown",closePicker);document.addEventListener("keydown",closeWithEscape);
    return()=>{document.removeEventListener("mousedown",closePicker);document.removeEventListener("keydown",closeWithEscape);};
  },[]);
  useEffect(()=>{document.body.classList.toggle("recaptcha-dialog-open",captchaOpen);document.body.classList.toggle("mc-mail-reader-open",Boolean(selectedMessage));return()=>{document.body.classList.remove("recaptcha-dialog-open");document.body.classList.remove("mc-mail-reader-open");};},[captchaOpen,selectedMessage]);
  useEffect(()=>()=>{if(refreshTimerRef.current!==null)window.clearInterval(refreshTimerRef.current);},[]);

  function openVerification(){if(captchaSubmissionRef.current)return;if(!usableDomains.some(item=>item.domain===domain)){setStatus(t.noDomainStatus);return;}setCaptchaMessage(turnstileConfigured?"":captchaNotConfiguredMessage);if(!attempt.open())return;setStatus("");setCaptchaOpen(true);}
  function closeCaptcha(){if(captchaSubmissionRef.current)return;attempt.close();setCaptchaMessage("");setCaptchaOpen(false);}
  function closeMessage(){messageRequestRef.current+=1;setSelectedMessage(null);setMessageLoading(false);setMessageError("");}
  function chooseDomain(item:Domain){setDomainOpen(false);if(item.kind!=="PUBLIC"){window.location.assign(LOGIN_URL);return;}domainChosenRef.current=true;setDomain(item.domain);}
  function choosePlan(item:Plan){if(item.points>0){window.location.assign(LOGIN_URL);return;}setSelectedPlan(item.id);}
  async function copyMailboxAddress(){
    if(!mailbox)return;
    try{await navigator.clipboard.writeText(mailbox.address);setCopied(true);window.setTimeout(()=>setCopied(false),1600);}
    catch{setStatus(t.copyFailed);}
  }
  async function createMailbox(turnstileToken:string,attemptId:number){
    if(captchaSubmissionRef.current||!attempt.take(attemptId))return;
    captchaSubmissionRef.current=true;
    // Retire both the initial restore and any inbox reads from the old mailbox.
    listRequestRef.current+=1;
    setCaptchaMessage(t.creating);setStatus(t.creating);setLoading(true);
    let created=false;
    let creationResponse:Response|undefined;
    try{
      const response=await fetch("/api/guest/mailbox",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({domain,turnstileToken})});
      creationResponse=response;
      const result=await response.json().catch(()=>null);if(!response.ok||!result?.ok)throw new Error(result?.message||t.loadFailed);
      const next=result.mailbox;
      if(!next?.id||!next?.address||next.id===mailbox?.id||next.address===mailbox?.address)throw new Error(t.unchanged);
      setMailbox(next);setDomain(next.domain);setQuery("");setSubmittedQuery("");
      setMailItems([]);setTotal(0);setPage(1);setPages(1);setCopied(false);closeMessage();
      setStatus(mailbox?t.changed:t.created);setCaptchaMessage("");setCaptchaOpen(false);created=true;
    }catch(error){
      const message=error instanceof Error?error.message:t.loadFailed;
      setStatus(message);setCaptchaMessage(message);attempt.fail(creationResponse);
    }finally{captchaSubmissionRef.current=false;setLoading(false);}
    if(created)await loadMessages(1,"",true);
  }
  function searchInbox(event:FormEvent){event.preventDefault();if(!mailbox)return;const normalized=query.trim();setSubmittedQuery(normalized);void loadMessages(1,normalized);}
  function refreshInbox(){
    if(!mailbox||loading||refreshCooldown>0)return;
    setRefreshCooldown(10);
    if(refreshTimerRef.current!==null)window.clearInterval(refreshTimerRef.current);
    refreshTimerRef.current=window.setInterval(()=>setRefreshCooldown((seconds)=>{
      if(seconds<=1){if(refreshTimerRef.current!==null)window.clearInterval(refreshTimerRef.current);refreshTimerRef.current=null;return 0;}
      return seconds-1;
    }),1000);
    void loadMessages(page,submittedQuery,false,true);
  }
  async function openMessage(item:GuestMessage){
    const requestId=messageRequestRef.current+1;messageRequestRef.current=requestId;
    setMessageError("");setMessageLoading(true);setSelectedMessage({...item,recipient:mailbox?.address||"",contentType:"",bodyText:""});
    try{const response=await fetch(`/api/guest/messages/${encodeURIComponent(item.id)}`,{headers:{accept:"application/json"}});const result=await response.json().catch(()=>null);if(!response.ok||!result?.ok)throw new Error(result?.message||t.loadFailed);if(messageRequestRef.current!==requestId)return;setSelectedMessage(result.message);setMailItems((items)=>items.map((message)=>message.id===item.id?{...message,isRead:true}:message));}
    catch(error){if(messageRequestRef.current===requestId)setMessageError(error instanceof Error?error.message:t.loadFailed);}finally{if(messageRequestRef.current===requestId)setMessageLoading(false);}
  }

  return <div className="guest-mailer-content">
    <section className={`guest-mailbox-card${mailbox?" is-active":" is-empty"}`} aria-label={t.title}><div className="guest-console-shell">
      <div className="guest-mailbox-copy"><h1>{t.title}</h1><p>{mailbox?t.activeDescription:t.description}</p></div>
      <div className="guest-address-field"><div className="guest-address-label"><span>{mailbox?(locale==="en-US"?"Suffix for your next mailbox":locale==="zh-TW"?"下次產生的郵箱後綴":"下次生成的邮箱后缀"):t.mailboxName}</span>{!mailbox&&<a href={LOGIN_URL}>{t.custom}</a>}</div>
        <div className={`guest-address-composer${mailbox?" guest-suffix-composer":""}`}>{!mailbox&&<><input className="guest-prefix-preview" type="text" readOnly value={t.waiting} aria-label={t.mailboxName}/><span aria-hidden="true">@</span></>}
          <div className={`guest-domain-picker${domainOpen?" is-open":""}`} ref={pickerRef}>
            <button className="guest-domain-toggle" type="button" disabled={!domains.length||loading} aria-haspopup="listbox" aria-expanded={domainOpen} onClick={()=>setDomainOpen((value)=>!value)}><span>{domain||t.noDomain}</span><i aria-hidden="true"></i></button>
            <div className="guest-domain-options" role="listbox" aria-label={t.mailboxName} hidden={!domainOpen}>{domains.map((item)=>{
              const access=item.kind==="MEMBER"?t.memberOnly:item.kind==="LOGIN"?t.loginRequired:t.freeMailbox;const tone=item.kind==="MEMBER"?"member":item.kind==="LOGIN"?"login":"free";
              return <button type="button" role="option" aria-selected={domain===item.domain} key={item.domain} onClick={()=>chooseDomain(item)}><span className="guest-domain-option-copy"><strong>{item.domain}</strong><small className={`domain-access-${tone}`}>{access}</small></span><i aria-hidden="true"></i></button>;
            })}</div>
          </div>
        </div>
      </div>
      {!mailbox&&<button className="guest-primary-action" type="button" disabled={!usableDomains.length||loading||attempt.remaining>0} onClick={openVerification}><span>{t.random}</span><i aria-hidden="true">→</i></button>}
      {mailbox&&<div className="guest-current-mailbox"><small className="guest-current-label">{t.currentAddress}</small><div className="guest-current-row"><strong title={mailbox.address}>{mailbox.address}</strong><div className="guest-current-actions"><button type="button" disabled={!usableDomains.length||loading||attempt.remaining>0} aria-label={t.change} title={t.change} onClick={openVerification}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg></button><button className="guest-copy-action" type="button" aria-label={copied?t.copied:t.copy} title={copied?t.copied:t.copy} onClick={()=>void copyMailboxAddress()}>{copied?<span aria-hidden="true">✓</span>:<img src="/openapi/assets/images/icons/copy.svg" alt=""/>}</button></div></div></div>}
      <div className="guest-status-line"><span><i aria-hidden="true"></i><b>{mailbox?(mailbox.available===false?unavailableMessage:t.receiving):t.guestIntro}</b></span><span>{mailbox?validityLabel:t.validity}</span><span className={!usableDomains.length?"is-empty":""}>{usableDomains.length?t.stockReady:t.stockEmpty}</span>{mailbox&&<span className="guest-expiry">{t.validUntil} {formatTime(mailbox.expiresAt)}</span>}</div>
      {mailbox&&mailbox.available!==false&&mailbox.domain!==domain&&<p className="guest-form-status">{locale==="en-US"?"Your current inbox remains available. Changing the mailbox will use the suffix selected above and expire the old address.":locale==="zh-TW"?"目前郵箱仍可收信。換郵箱時將使用上方選擇的後綴，舊地址會到期。":"当前邮箱仍可收信。换邮箱时将使用上方选择的后缀，旧地址会到期。"}</p>}
      {attempt.remaining>0&&<p role="status">{locale==="en-US"?"Retry in":locale==="zh-TW"?"請稍候":"请稍候"} {attempt.remaining}s</p>}{(status||mailbox)&&<p className="guest-form-status" role="status">{mailbox?.available===false?unavailableMessage:status||t.created}</p>}
    </div></section>

    <section className="guest-inbox-preview" aria-label={t.inbox}>
      <div className="guest-inbox-header"><div><span className="guest-section-kicker">{t.inbox}</span><h2>{t.inbox}</h2><p>{t.inboxDescription}</p></div><div className="guest-inbox-actions"><span><i aria-hidden="true"></i>{t.waitingMail}</span><button type="button" disabled={!mailbox||loading||refreshCooldown>0} onClick={refreshInbox}>{refreshCooldown>0?`${refreshCooldown}s`:<><b aria-hidden="true"></b>{t.refresh}</>}</button></div></div>
      <div className="guest-inbox-tools"><form role="search" onSubmit={searchInbox}><input type="search" maxLength={100} placeholder={t.searchPlaceholder} value={query} aria-label={t.searchPlaceholder} onChange={(event)=>setQuery(event.target.value)}/><button type="submit" disabled={!mailbox||loading}>{t.search}</button></form></div>
      {mailbox&&<div className="app-mail-table-head" aria-hidden="true"><span>{t.sender}</span><span>{t.subject}</span><span>{t.keyInfo}</span><span>{t.receivedAt}</span><span>{t.action}</span></div>}{mailItems.map((item)=><button className="app-mail-row" type="button" key={item.id} onClick={()=>void openMessage(item)}><span title={item.sender}>{item.sender}</span><span title={item.subject}>{item.subject}</span><span>{item.isRead?"—":"●"}</span><span>{formatTime(item.receivedAt)}</span><span>{t.openMail}</span></button>)}{!mailItems.length&&<div className="guest-inbox-empty">{loading?`${t.refresh}…`:t.noData}</div>}
      <nav className="guest-inbox-pagination" aria-label={t.inbox}><span>{locale==="en-US"?`${total} items, 10 per page`:locale==="zh-TW"?`共 ${total} 條，每頁 10 條`:`共 ${total} 条，每页 10 条`}</span><button type="button" disabled={!mailbox||loading||page<=1} onClick={()=>void loadMessages(page-1,submittedQuery)}>{t.previous}</button><span>{locale==="en-US"?`Page ${page} / ${pages}`:`第 ${page} / ${pages} 页`}</span><button type="button" disabled={!mailbox||loading||page>=pages} onClick={()=>void loadMessages(page+1,submittedQuery)}>{t.next}</button></nav>
    </section>

    {captchaOpen&&<div className="guest-recaptcha-dialog" role="dialog" aria-modal="true" aria-labelledby="guestCaptchaTitle"><button className="guest-recaptcha-backdrop" type="button" aria-label={t.cancel} onClick={closeCaptcha}></button><section className="guest-recaptcha-card">
      <header><div><span>{t.human}</span><h2 id="guestCaptchaTitle">{t.confirm}</h2></div><button type="button" aria-label={t.close} onClick={closeCaptcha}>×</button></header>
      <fieldset className="guest-duration-field"><legend>{t.validTime}</legend><div className="guest-duration-grid">{plans.map((item)=><label className="guest-duration-option" key={item.id}><input type="radio" name="guestDuration" checked={selectedPlan===item.id} onChange={()=>choosePlan(item)}/><span className="duration-card"><strong className="duration-name">{planLabel(item)}</strong><small className="duration-price-stack">{item.points?<><b className="duration-standard-price">{item.points} {t.points}</b><em className="duration-member-price">{t.memberPrice} {discountedMailboxPrice(item.points, memberDiscountPercent)} {t.points}</em></>:<><b className="duration-free-price">{t.free}</b><i className="duration-price-placeholder" aria-hidden="true"></i></>}</small></span></label>)}</div></fieldset>
      {turnstileConfigured&&!attempt.failed&&<div className="guest-recaptcha-widget"><TurnstileWidget siteKey={turnstileSiteKey} action="guest_mailbox" theme="light" size="normal" responsive language={locale==="en-US"?"en":locale==="zh-TW"?"zh-tw":"zh-cn"} resetKey={attempt.id} ariaLabel={t.captchaAction} onVerify={(token)=>void createMailbox(token,attempt.id)} onExpire={()=>setCaptchaMessage(captchaExpiredMessage)} onError={()=>setCaptchaMessage(captchaUnavailableMessage)}/></div>}{captchaMessage&&<p className="guest-captcha-message" role="status">{captchaMessage}</p>}{attempt.failed&&<button className="guest-recaptcha-cancel" type="button" disabled={loading||attempt.remaining>0} onClick={openVerification}>{attempt.remaining>0?`${attempt.remaining}s`:locale==="en-US"?"Retry verification":locale==="zh-TW"?"重新驗證":"重新验证"}</button>}<button className="guest-recaptcha-cancel" type="button" disabled={loading} onClick={closeCaptcha}>{t.cancel}</button>
    </section></div>}

    {selectedMessage && <MailReader key={selectedMessage.id} message={selectedMessage} loading={messageLoading} error={messageError} onClose={closeMessage}/>}
  </div>;
}
