import MailReader from './ui/MailReader';
import { useGuestAttempt } from './ui/useGuestAttempt';
import {useTranslator} from '../lib/useTranslator';
import ChoicePicker from './ui/ChoicePicker';
import {copyText} from '../lib/clipboard';
import {useDialog} from './ui/useDialog';
import { discountedMailboxPrice } from "../../server/member/mailbox-price.mjs";
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import TurnstileWidget from './TurnstileWidget';

type Suffix = { suffix: string; provider: string };
type Plan = { id: string; label: string; minutes: number; points: number };
type Box = { id: string; address: string; domain?: string; available?: boolean; duration_minutes?: number; durationMinutes?: number; received_count?: number; receivedCount?: number; expires_at?: string | null; expiresAt?: string | null; created_at?: string | null; createdAt?: string | null };
type Msg = { id: string; sender: string; subject: string; is_read?: boolean; isRead?: boolean; received_at?: string; receivedAt?: string; recipient?: string; content_type?: string; contentType?: string; body_text?: string; bodyText?: string };
type Props = { initialError?:string; authenticated: boolean; suffixes: Suffix[]; plans: Plan[]; currentPoints?: number; isMember?: boolean; discountPercent?: number; memberPreviewDiscountPercent?: number; captchaEnabled?: boolean; turnstileSiteKey: string; turnstileConfigured: boolean; initialMailbox?: Box | null; initialMessages?: Msg[]; initialPagination?: { page?: number; pages?: number; total?: number } };

export default function RelayMailbox({ initialError="", authenticated, suffixes, plans, currentPoints = 0, isMember = false, discountPercent = 100, memberPreviewDiscountPercent = discountPercent, captchaEnabled = true, turnstileSiteKey, turnstileConfigured, initialMailbox = null, initialMessages = [], initialPagination = { page: 1, pages: 1, total: 0 } }: Props) {
  const t=useTranslator();
  const initialSuffix = initialMailbox?.domain || initialMailbox?.address?.split('@')[1] || '';
  const [suffix, setSuffix] = useState(initialSuffix || suffixes[0]?.suffix || '');
  const [plan, setPlan] = useState(plans[0]?.id || '');
  const selected = useMemo(() => plans.find((item) => item.id === plan) || plans[0], [plan, plans]);
  const price = selected ? (isMember ? discountedMailboxPrice(selected.points, discountPercent) : selected.points) : 0;
  const [box, setBox] = useState<Box | null>(initialMailbox);
  const [items, setItems] = useState<Msg[]>(initialMessages);
  const [page, setPage] = useState(initialPagination.page || 1);
  const [pages, setPages] = useState(initialPagination.pages || 1);
  const [total, setTotal] = useState(initialPagination.total || 0);
  const [points, setPoints] = useState(currentPoints);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [copied,setCopied]=useState(false);
  async function copyAddress(){if(!box)return;if(await copyText(box.address)){setStatus('');setCopied(true);window.setTimeout(()=>setCopied(false),3000);}else setStatus(t("复制失败，请手动选择并复制。"));}
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [selectionError,setSelectionError]=useState(initialError);
  const [detail, setDetail] = useState<Msg | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reset, setReset] = useState(0);
  const attempt=useGuestAttempt();
  const requestRef = useRef('');
  const requestsByIntent = useRef(new Map<string,string>());
  const creatingRef = useRef(false);
  const inboxRequest = useRef(0);
  const detailRequest = useRef(0);
  const closeMessage = () => { detailRequest.current += 1; setDetail(null); setLoading(false); setError(''); };
  useEffect(() => () => { detailRequest.current += 1; inboxRequest.current += 1; }, []);
  useEffect(() => { closeMessage(); }, [box?.id]);
  const closeConfirm=()=>{if(creatingRef.current)return;attempt.close();setModal(false);};
  useDialog(modal,closeConfirm,authenticated?'.score-confirm-card':'.guest-recaptcha-card');
  useEffect(()=>{if(!modal&&!detail)return;document.body.classList.add('recaptcha-dialog-open');return()=>document.body.classList.remove('recaptcha-dialog-open');},[modal,Boolean(detail)]);
  const currentDuration = Number(box?.duration_minutes || box?.durationMinutes || 0);
  const currentBoxSuffix = box?.domain || box?.address?.split('@')[1] || '';
  const suffixAvailable = suffixes.some((item) => item.suffix === suffix);
  const suffixOptions = currentBoxSuffix && !suffixes.some((item) => item.suffix === currentBoxSuffix)
    ? [{ suffix: currentBoxSuffix, provider: t("当前邮箱") }, ...suffixes]
    : suffixes;
  const date = (value: unknown) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(value as string)) : '—';
  const expiry = (value: unknown) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(value as string)) : '—';

  async function load(next = 1, nextQuery = submitted, manual = false) {
    if (!box || creatingRef.current) return false;
    const request = ++inboxRequest.current;
    try {
      const params = new URLSearchParams({ page: String(next) });
      if (nextQuery) params.set('q', nextQuery);
      if (manual) params.set('manual', '1');
      if (authenticated) params.set('mailboxId', box.id);
      else params.set('scope', 'relay');
      const response = await fetch(`${authenticated ? '/api/user/mailboxes/inbox' : '/api/guest/messages'}?${params}`, { cache: 'no-store' });
      const result = await response.json().catch(() => null);
      if (request !== inboxRequest.current) return false;
      if ([401, 404, 410].includes(response.status)) {
        setBox(null); setItems([]); setPage(1); setPages(1); setTotal(0);
        setStatus(response.status === 410 ? t("邮箱已经过期，请重新生成。") : t("当前邮箱已失效，请重新生成。"));
        return false;
      }
      if (!response.ok || !result?.ok) throw new Error(result?.message || t("收件箱读取失败。"));
      setBox(result.mailbox); if(result.mailbox?.available===false)setStatus(t("暂停收信，请联系管理员")); else setStatus(previous=>previous===t("暂停收信，请联系管理员")?"":previous); setItems(result.messages || []); setPage(result.pagination?.page || 1); setPages(result.pagination?.pages || 1); setTotal(result.pagination?.total || 0);
      return true;
    } catch (error) {
      if (request !== inboxRequest.current) return false;
      throw error;
    }
  }

  useEffect(() => { if (!box) return undefined; const timer = window.setInterval(() => void load(page, submitted).catch(() => {}), 8000); return () => clearInterval(timer); }, [box?.id, page, submitted]);
  useEffect(() => { if (cooldown <= 0) return undefined; const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, [cooldown]);
  useEffect(() => { const current = box?.domain || box?.address?.split('@')[1]; if (current && suffixes.some((item) => item.suffix === current)) setSuffix(current); }, [box?.id, box?.domain, box?.address, suffixes]);

  const refresh = async () => { if (cooldown || !box || creatingRef.current) return; setCooldown(10); try { if (await load(page, submitted, true)) setStatus(t("收件箱已刷新。")); } catch (error) { setStatus(error instanceof Error ? error.message : t("刷新失败。")); } };
  const openConfirm = () => { if (creatingRef.current) return; if (!suffix || !suffixAvailable) { setStatus(t("该邮箱后缀当前不可用，请联系管理员。")); return; } if (captchaEnabled && !turnstileConfigured) { setStatus(t("人机验证尚未配置，请联系管理员。")); return; } if(!authenticated&&!attempt.open())return;setToken(''); setStatus(''); setReset((value) => value + 1); setModal(true); };

  const create = async (verifiedToken = token, attemptId = attempt.id) => {
    if (creatingRef.current) return;
    if (!authenticated && selected?.points) { location.assign('/user/login.cgi?next=%2Ftools%2Freal_mail.cgi'); return; }
    if (captchaEnabled && turnstileConfigured && !verifiedToken) return;
    if(!authenticated&&!attempt.take(attemptId))return;
    creatingRef.current = true;
    // Ignore old inbox responses even when they arrive after creation finishes.
    inboxRequest.current += 1;
    setBusy(true); setStatus(t("正在生成…"));
    let creationResponse:Response|undefined;
    try {
      const intent=JSON.stringify([suffix,selected?.minutes,price]);
      if(!requestsByIntent.current.has(intent))requestsByIntent.current.set(intent,crypto.randomUUID());
      requestRef.current=requestsByIntent.current.get(intent)!;
      const endpoint = authenticated ? '/api/user/relay/mailbox' : '/api/guest/relay/mailbox';
      const body = authenticated ? { suffix, durationMinutes: selected?.minutes, expectedPrice: price, requestId: requestRef.current, turnstileToken: verifiedToken } : { suffix, turnstileToken: verifiedToken };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      creationResponse=response;
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.message || t("中继邮箱创建失败。"));
      const next = result.result || result.mailbox;
      if (!next?.id || !next?.address || (!authenticated && (next.id === box?.id || next.address === box?.address))) {
        throw new Error(t("邮箱地址未更换，请重新验证后再试。"));
      }
      requestsByIntent.current.delete(intent); setSelectionError('');
      setBox(next); setItems([]); setTotal(0); setPage(1); setPages(1); setQuery(''); setSubmitted(''); setCopied(false); closeMessage(); if (authenticated) setPoints(Number(next.pointsBalance ?? points)); setModal(false); setStatus(t(box && !authenticated ? "邮箱已更换，请复制上方新地址。" : "中继邮箱已启用，可以开始收信。")); requestRef.current = '';
    } catch (error) { setStatus(error instanceof Error ? error.message : t("创建失败。")); setToken(''); if(authenticated)setReset((value) => value + 1);else attempt.fail(creationResponse); } finally { creatingRef.current = false; setBusy(false); }
  };

  const search = (event: FormEvent) => { event.preventDefault(); const nextQuery = query.trim(); setSubmitted(nextQuery); void load(1, nextQuery).catch((error) => setStatus(error.message)); };
  const openMessage = async (item: Msg) => {
    const request = ++detailRequest.current;
    setDetail(item);
    setLoading(true);
    setError('');
    try {
      const response = authenticated
        ? await fetch('/api/user/messages/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) })
        : await fetch(`/api/guest/messages/${encodeURIComponent(item.id)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || t("邮件读取失败。"));
      if (request !== detailRequest.current) return;
      setDetail(authenticated ? result.result : result.message);
    } catch (cause) {
      if (request !== detailRequest.current) return;
      setError(cause instanceof Error ? cause.message : t("邮件读取失败。"));
    } finally {
      if (request === detailRequest.current) setLoading(false);
    }
  };

  const durationOptions = (guest = false) => <div className={guest ? 'guest-duration-grid' : 'duration-grid'}>{plans.map((item) => <label className={guest ? 'guest-duration-option' : 'duration-option'} key={item.id}><input type="radio" name={guest ? 'guest-relay-duration' : 'relay-duration'} checked={plan === item.id} onChange={() => setPlan(item.id)} /><span className="duration-card"><strong className="duration-name">{t(item.label)}</strong><span className="duration-price-stack"><b className={item.points ? 'duration-standard-price' : 'duration-free-price'}>{item.points ? t("{0} 积分",item.points) : t("免费")}</b>{item.points ? <em className="duration-member-price">{t("会员价")}{discountedMailboxPrice(item.points, memberPreviewDiscountPercent)}{t("积分")}</em> : <i className="duration-price-placeholder" />}</span></span></label>)}</div>;

  const inbox = <section className="inbox-preview"><div className="inbox-header"><div><span className="section-kicker">{t("收件箱")}</span><h2>{t("收件箱")}</h2><p>{t("创建邮箱后，收到的邮件会自动显示在这里。")}</p></div><div className="inbox-waiting"><i />{t("等待新邮件")}</div><button className="refresh-button" disabled={!box || busy || cooldown > 0} onClick={refresh}>{cooldown ? `${cooldown}s` : <><i aria-hidden="true"/>{t("刷新")}</>}</button></div><div className="inbox-tools"><form className="inbox-search" onSubmit={search}><div className="inbox-search-field"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索发件人或主题")} /><button disabled={!box}>{t("搜索")}</button></div></form></div>{box && <div className="inbox-columns"><span>{t("发件人")}</span><span>{t("主题")}</span><span>{t("关键信息")}</span><span>{t("收信时间")}</span><span>{t("操作")}</span></div>}<div className="inbox-list">{items.map((item) => <button className="inbox-message-row" key={item.id} onClick={() => openMessage(item)}><span className="inbox-message-sender"><i>{item.sender?.[0] || t("邮")}</i><b>{item.sender}</b></span><span className="inbox-message-subject"><b>{item.subject || t("（无主题）")}</b><small>{item.is_read || item.isRead ? t("已读") : t("未读")}</small></span><span>—</span><time>{date(item.received_at || item.receivedAt)}</time><span className="inbox-message-open">{t("查阅邮件")}</span></button>)}</div>{!items.length && <div className="inbox-empty">{t("暂无数据")}</div>}<nav className="inbox-pagination" aria-label={t("收件箱")}><span className="inbox-count">{t("共")}{total}{t("条，每页 10 条")}</span><button disabled={!box || page <= 1} onClick={() => load(page - 1)}>{t("上一页")}</button><span>{t("第")}{page} / {pages}{t("页")}</span><button disabled={!box || page >= pages} onClick={() => load(page + 1)}>{t("下一页")}</button></nav></section>;

  const guestView = <div className="guest-mailer-content mailer-content relay-guest-page">{attempt.remaining>0&&<p role="status">{t("请稍候")} {attempt.remaining}s</p>}<section className={`guest-mailbox-card ${box ? 'is-active' : 'is-empty'}`}><div className="guest-console-shell"><div className="guest-mailbox-copy"><h1>{t("主流邮箱")}</h1><p>{t("生成专属收信地址，在此查阅收到的邮件。")}</p></div><div className="guest-address-field"><div className="guest-address-label"><span>{t("邮箱后缀")}</span></div><div className="guest-address-composer relay-suffix-composer"><div className="guest-domain-picker domain-picker"><ChoicePicker value={suffix} onChange={setSuffix} label={t("邮箱后缀")} disabled={!suffixes.length} options={suffixOptions.map(item=>({value:item.suffix,label:item.suffix}))}/></div></div></div>{!box && <button className="guest-primary-action" type="button" disabled={!suffixes.length || busy || attempt.remaining>0} onClick={openConfirm}><span>{t("生成主流邮箱")}</span><i aria-hidden="true">→</i></button>}{box && <div className="guest-current-mailbox"><small className="guest-current-label">{t("当前收信地址")}</small><div className="guest-current-row"><strong>{box.address}</strong><div className="guest-current-actions"><button type="button" disabled={!suffixAvailable || busy || attempt.remaining>0} onClick={openConfirm} aria-label={t("更换邮箱")} title={t("更换邮箱")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11l-3-3m3 3-3 3M20 17H9l3 3m-3-3 3-3" /></svg></button><button type="button" onClick={copyAddress} title={copied?t("已复制"):t("复制")} aria-label={t("复制完整邮箱地址")}>{copied?<span className="copy-success-mark">✓</span>:<img src="/openapi/assets/images/icons/copy.svg" alt="" />}</button></div></div></div>}<div className="guest-status-line"><span className={!suffixes.length && !box ? 'is-empty' : ''}><i aria-hidden="true" /><b>{status || (!suffixes.length && !box ? t("暂无可用邮箱，请稍后再试。") : box ? t(box.available===false?"暂停收信，请联系管理员":"邮箱正在接收邮件") : t("选择邮箱后缀，生成您的收信地址。"))}</b></span>{box && <span className="guest-expiry">{t("有效至")}{expiry(box.expires_at || box.expiresAt)}</span>}</div>{box && <p className={`guest-availability ${box.available === false ? 'is-unavailable' : ''}`}>{box.available === false ? t("该邮箱当前不可用") : t("邮箱已启用，可以开始收信")}</p>}</div></section>{inbox}</div>;

  const memberView = <div className="relay-mailer is-member"><section className="relay-application"><form onSubmit={(event) => { event.preventDefault(); openConfirm(); }}><h2>{t("生成主流邮箱")}</h2><label className="relay-suffix-label">{t("邮箱后缀")}</label><div className="relay-suffix-select"><ChoicePicker value={suffix} onChange={setSuffix} label={t("邮箱后缀")} disabled={!suffixes.length} options={suffixOptions.map(item=>({value:item.suffix,label:item.suffix}))}/></div><fieldset className="duration-field"><legend>{t("有效时长")}</legend>{durationOptions()}</fieldset><button className="primary-action relay-create" disabled={!suffixes.length}>{t("生成主流邮箱")}<i>→</i></button><p className="form-status" role="status">{status || (!suffixes.length ? t("管理员尚未配置可用中继账号") : box ? t(box.available===false?"暂停收信，请联系管理员":"邮箱已启用，可以开始收信") : t("请选择后缀并生成邮箱"))}</p></form><aside className="preview-panel"><div className="preview-topline"><span>{t("申请预览")}</span><i>{box ? t(box.available===false?"暂停收信":"收信中") : t("预览")}</i></div><p>{box ? t("当前收信地址") : t("待申请邮箱地址")}</p><div className="preview-address"><strong>{box?.address || t("随机别名@{0}",suffix || '—')}</strong>{box && <button type="button" onClick={copyAddress} title={copied?t("已复制"):t("复制")} aria-label={copied?t("已复制"):t("复制")}>{copied&&"✓"}</button>}</div><dl><div><dt>{t("有效时长")}</dt><dd>{box ? plans.find((item) => item.minutes === currentDuration)?.label || t("{0} 分钟",currentDuration) : (selected?.label?t(selected.label):'—')}</dd></div><div><dt>{t("收信状态")}</dt><dd><span className="ready-dot" />{box ? t(box.available===false?"暂停收信":"收信中") : t("申请后启用")}</dd></div><div><dt>{t(box?"下次申请积分":"所需积分")}</dt><dd>{price}{t("积分")}</dd></div><div><dt>{t("当前积分")}</dt><dd>{points}{t("积分")}</dd></div></dl><a className="recharge-mini" href="/user/recharge.cgi">{t("积分充值")}</a></aside></section>{inbox}</div>;

  return <>{selectionError&&<p className="mailbox-list-notice" role="alert">{t(selectionError)} <a href="/user/mailboxes.cgi">{t("返回邮箱列表")}</a></p>}{authenticated ? memberView : guestView}{modal && !authenticated && <div className="guest-recaptcha-dialog"><button className="guest-recaptcha-backdrop" onClick={closeConfirm} aria-label={t("取消")} /><section className="guest-recaptcha-card" role="dialog" aria-modal="true" aria-labelledby="guestRelayCaptchaTitle"><header><div><span>{t("人机验证")}</span><h2 id="guestRelayCaptchaTitle">{t("生成主流邮箱")}</h2></div><button disabled={busy} onClick={closeConfirm} aria-label={t("关闭")}>×</button></header>{status&&<p role="status" className="guest-captcha-message">{status}</p>}<fieldset className="guest-duration-field"><legend>{t("有效时长")}</legend>{durationOptions(true)}</fieldset>{captchaEnabled && turnstileConfigured && !attempt.failed && <div className="guest-recaptcha-widget"><TurnstileWidget siteKey={turnstileSiteKey} action="guest_relay_mailbox" theme="light" size="normal" responsive language="zh-cn" resetKey={attempt.id} ariaLabel={t("人机验证")} onVerify={(value) => { setToken(value); if (!selected?.points) void create(value,attempt.id); }} onExpire={() => setToken('')} onError={() => setStatus(t("人机验证暂时不可用，请稍后重试。"))} /></div>}{attempt.failed&&<button className="guest-recaptcha-cancel" type="button" disabled={busy||attempt.remaining>0} onClick={openConfirm}>{attempt.remaining>0?`${attempt.remaining}s`:t("重新验证")}</button>}{selected?.points ? <button className="guest-recaptcha-cancel guest-relay-login" type="button" onClick={() => create(token)}>{t("登录后继续")}</button> : <button className="guest-recaptcha-cancel" type="button" disabled={busy} onClick={closeConfirm}>{busy ? t("正在生成…") : t("取消")}</button>}</section></div>}{modal && authenticated && <div className="score-confirm"><button className="score-confirm-backdrop" onClick={closeConfirm} /><section className="score-confirm-card" role="dialog" aria-modal="true" aria-label={t("确认生成主流邮箱")}><div className="score-confirm-head"><div><p>{t("人机验证")}</p><h2>{t("确认生成中继邮箱")}</h2></div><button className="score-confirm-close" disabled={busy} onClick={closeConfirm}>×</button></div><div className="relay-confirm-summary"><span>{suffix}</span><b>{selected?.label}</b><strong>{price}{t("积分")}</strong></div>{captchaEnabled && turnstileConfigured && <div className="score-confirm-captcha"><TurnstileWidget siteKey={turnstileSiteKey} action="member_relay_mailbox" theme="light" size="normal" responsive language="zh-cn" resetKey={reset} ariaLabel={t("人机验证")} onVerify={setToken} onExpire={() => setToken('')} onError={() => setStatus(t("人机验证暂时不可用，请稍后重试。"))} /></div>}{status&&<p role="status">{status}</p>}<div className="score-confirm-actions"><button className="score-confirm-cancel" disabled={busy} onClick={closeConfirm}>{t("取消")}</button><button className="score-confirm-submit" disabled={busy || (captchaEnabled && turnstileConfigured && !token)} onClick={() => create()}>{busy ? t("正在生成…") : t("确认生成")}</button></div></section></div>}{detail && <MailReader key={detail.id} message={detail} loading={loading} error={error} onClose={closeMessage} recipient={box?.address}/>}</>;
}
