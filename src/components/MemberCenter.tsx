import TelegramBinding from './TelegramBinding';
import NodelocBinding from './NodelocBinding';
import {purchaseIntent,completePurchaseIntent} from '../lib/purchase-intent';
import MailReader from './ui/MailReader';
import {copyText} from '../lib/clipboard';
import {useDialog} from './ui/useDialog';
import {useTranslator} from '../lib/useTranslator';
import { isValidRecallDuration } from "../../server/member/mailbox-recall-policy.mjs";
import { discountedMailboxPrice } from "../../server/member/mailbox-price.mjs";
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import TurnstileWidget from "./TurnstileWidget";
import { useMemberHistory, MemberHistorySearch, MemberHistoryPagination, type HistoryPagination } from "./MemberHistory";

export type MemberView =
  | "overview"
  | "mailboxes"
  | "messages"
  | "points"
  | "membership"
  | "domains"
  | "api"
  | "account";
export type MemberData = {
  user: any;
  selectedMailbox?:{id:string;address?:string};
  mailboxError?:string;
  membership: any | null;
  mailboxes: any[];
  messagePagination?: { page: number; pages: number; total: number; pageSize: number };
  mailboxPagination?: { page: number; pages: number; total: number; pageSize: number };
  messages: any[];
  transactions: any[];
  transactionPagination?: HistoryPagination;
  domains: any[];
  domainPagination?: HistoryPagination;
  publicDomains: any[];
  plans: any[];
  apiKey: any | null;
  rechargePlans: any[];
  paymentChannels: any[];
  orders: any[];
  settings: Record<string, string>;
  counts: { mailboxes: number; messages: number; received: number };
};
const dt = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "长期";
const txName = (type: string) =>
  (
    ({
      REGISTER_BONUS: "注册赠送",
      RECHARGE: "积分充值",
      MAILBOX_PURCHASE: "邮箱消费",
      MEMBERSHIP_PURCHASE: "会员消费",
      REFUND: "退款",
      ADMIN_ADJUSTMENT: "管理员调整",
    }) as Record<string, string>
  )[type] || type;
const mailboxState = (v: string) =>
  (
    ({ ACTIVE: "收信中", PAUSED: "已暂停", EXPIRED: "已过期" }) as Record<
      string,
      string
    >
  )[v] || v;
const domainState = (v: string) =>
  (
    ({
      PENDING: "待审核",
      ACTIVE: "已启用",
      DISABLED: "已停用",
      REJECTED: "已拒绝",
    }) as Record<string, string>
  )[v] || v;
const mxState = (v: string) =>
  (
    ({
      PENDING: "待检测",
      ACTIVE: "正常",
      MISMATCH: "配置错误",
      NOT_FOUND: "未找到",
      UNAVAILABLE: "不可用",
    }) as Record<string, string>
  )[v] || v;
async function postJson(path: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok)
    throw new Error(result.message || "操作失败。");
  return result.result;
}
const appConfirm = (message: string, options: Record<string, string> = {}) =>
  (window as any).NodeMailDialog?.confirm(message, options) ?? Promise.resolve(false);
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="mc-icon" aria-hidden="true">
      {children}
    </span>
  );
}
function Modal({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t=useTranslator();
  useDialog(true,onClose,'.mc-modal > section');
  return (
    <div
      className="mc-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section>
        <button type="button" className="mc-modal-close" onClick={onClose}>
          ×
        </button>
        <small>{eyebrow}</small>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}
function Header({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: React.ReactNode;
}) {
  const t=useTranslator();
  return (
    <header className="mc-page-head">
      <div>
        <small>{eyebrow}</small>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}
function Empty({
  title = "暂无数据",
  copy = "当前没有可显示的真实记录。",
}: {
  title?: string;
  copy?: string;
}) {
  const t=useTranslator();
  return (
    <div className="empty-state">
      <strong>{t(title)}</strong>
      <span>{t(copy)}</span>
    </div>
  );
}

function VipDialog({ data, onClose }: { data: MemberData; onClose: () => void }) {
  const t=useTranslator();
  const [code, setCode] = useState(data.plans[0]?.code || "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = data.plans.find((item) => item.code === code);
  useEffect(() => {
    document.body.classList.add("mc-vip-dialog-open");
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", close);
    return () => {
      document.body.classList.remove("mc-vip-dialog-open");
      document.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const purchasingRef = useRef(false);
  async function purchase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if(purchasingRef.current || !selected)return;
    purchasingRef.current=true;
    setBusy(true);
    setStatus("");
    try {
      const expectedPrice=Number(selected.price_points);
      const parameters={code,expectedPrice};
      await postJson("/api/user/membership/purchase", {...parameters,requestId:purchaseIntent(data.user.email,"membership",parameters)});
      completePurchaseIntent(data.user.email,"membership",parameters);
      location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("开通失败。"));
    } finally {
      purchasingRef.current=false;
      setBusy(false);
    }
  }
  return (
    <div className="mc-vip-dialog" role="presentation">
      <button className="mc-vip-backdrop" type="button" aria-label={t("关闭")} onClick={onClose} />
      <section className="mc-vip-card" role="dialog" aria-modal="true" aria-labelledby="mcVipTitle">
        <button className="mc-vip-close" type="button" aria-label={t("关闭")} onClick={onClose}>×</button>
        <header className="mc-vip-head">
          <div className="mc-vip-crown">VIP</div>
          <div><small>{t("NODEMAIL 会员服务")}</small><h2 id="mcVipTitle">{t("开通 NodeMail 会员")}</h2><p>{t("解锁更低价格与更多邮箱能力")}</p></div>
        </header>
        <section className="mc-vip-benefits">
          <h3>{t("会员权益")}</h3>
          <ul><li><i>✓</i>{t("邮箱创建、召回和续期享套餐折扣")}</li><li><i>✓</i>{t("可使用 OpenAPI 接口")}</li><li><i>✓</i>{t("召回对所有用户开放；会员可召回会员专属域名邮箱")}</li><li><i>✓</i>{t("可绑定个人域名邮箱")}</li></ul>
        </section>
        <form className="mc-vip-form" onSubmit={purchase}>
          <fieldset><legend>{t("选择会员时长")}</legend><div className="mc-vip-plans">
            {data.plans.map((plan) => <label key={plan.code}><input type="radio" name="vip-plan" checked={code === plan.code} onChange={() => setCode(plan.code)} /><span><strong>{plan.duration_days}{t("天")}</strong><small>{plan.price_points}{t("积分")}</small></span></label>)}
          </div></fieldset>
          <div className="mc-vip-summary"><div>{t("当前积分")}<b>{data.user.points_balance}</b> <a href="/user/recharge.cgi">{t("积分充值")}</a></div><span>{t("本次支付")}<strong>{selected?.price_points || 0}{t("积分")}</strong></span></div>
          <button className="mc-vip-submit" type="submit" disabled={busy || !selected}>{busy ? t("处理中…") : t("确认开通")}</button>
          {status && <output className="mc-vip-status">{status}</output>}
        </form>
      </section>
    </div>
  );
}

function Overview({ data }: { data: MemberData }) {
  const t=useTranslator();
  const recent = data.messages.slice(0, 5);
  const [selectedMessage, setSelectedMessage] = useState<any | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [copiedRecipient, setCopiedRecipient] = useState("");
  const [apiKey, setApiKey] = useState(data.apiKey);
  const [apiNotice, setApiNotice] = useState(
    data.apiKey?.status === "DISABLED"
      ? t("API Key 已被管理员停用，如需恢复请联系管理员。")
      : data.apiKey?.requires_reset
      ? t("历史 API Key 仍然有效，但无法再次显示；需要查看完整 Key 时请点击重置。")
      : "",
  );
  const [apiBusy, setApiBusy] = useState(false);
  const apiResetBusyRef = useRef(false);
  const apiResetSequenceRef = useRef(0);
  const apiKeyChannelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel("nodemail-api-key");
    channel.onmessage = (event) => {
      const nextKey = typeof event.data?.key === "string" ? event.data.key : "";
      if (!/^[0-9a-f]{32}$/i.test(nextKey)) return;
      setApiKey((current: any) => ({ ...current, key: nextKey, key_prefix: nextKey.slice(0, 12), requires_reset:false }));
      setApiNotice(t("API Key 已在另一个页面重置并同步"));
    };
    apiKeyChannelRef.current = channel;
    return () => {
      apiKeyChannelRef.current = null;
      channel.close();
    };
  }, []);
  async function copyApiKey() {
    if (!apiKey?.key) return;
    if(!await copyText(apiKey.key)){setApiNotice(t("复制失败，请手动选择复制。"));return;}
    setApiNotice(t("API Key 已复制"));
    window.setTimeout(() => setApiNotice(""), 1600);
  }
  async function resetApiKey() {
    if (apiResetBusyRef.current) return;
    apiResetBusyRef.current = true;
    const sequence = apiResetSequenceRef.current + 1;
    apiResetSequenceRef.current = sequence;
    setApiBusy(true);
    setApiNotice("");
    try {
      const response = await fetch("/api/user/api_key/reset.cgi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.code !== 0 || !result.data)
        throw new Error(result.msg || t("API Key 重置失败。"));
      if (apiResetSequenceRef.current !== sequence) return;
      setApiKey((current: any) => ({ ...current, key: result.data, key_prefix: result.data.slice(0, 12), requires_reset:false }));
      apiKeyChannelRef.current?.postMessage({ key:result.data });
      setApiNotice(t("API Key 已重置"));
    } catch (error) {
      if (apiResetSequenceRef.current !== sequence) return;
      setApiNotice(error instanceof Error ? error.message : t("API Key 重置失败。"));
    } finally {
      if (apiResetSequenceRef.current === sequence) {
        apiResetBusyRef.current = false;
        setApiBusy(false);
      }
    }
  }
  async function copyRecipient(value: string) {
    if(!await copyText(value)){setApiNotice(t("复制失败，请手动选择复制。"));return;}
    setCopiedRecipient(value);
    window.setTimeout(() => setCopiedRecipient(""), 1400);
  }
  const recentRequest=useRef(0);
  const closeRecentMessage=()=>{recentRequest.current+=1;setSelectedMessage(null);setMessageLoading(false);setMessageError('');};
  useEffect(()=>()=>{recentRequest.current+=1;},[]);
  async function openRecentMessage(message:any) {
    const request=++recentRequest.current;
    setSelectedMessage(message);setMessageLoading(true);setMessageError('');
    try {
      const detail=await postJson('/api/user/messages/read',{id:message.id});
      if(request===recentRequest.current)setSelectedMessage(detail);
    } catch(cause) {
      if(request===recentRequest.current)setMessageError(cause instanceof Error?cause.message:t('邮件读取失败。'));
    } finally {if(request===recentRequest.current)setMessageLoading(false);}
  }
  const recentTime = (value: string | null) => {
    if (!value) return { date: "—", time: "—" };
    const date = new Date(value);
    return {
      date: date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replaceAll("/", "-"),
      time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  };
  return (
    <>
      <section className="welcome-card">
        <div className="welcome-copy">
          <small>{t("欢迎回来")}</small>
          <h2>{data.user.email}</h2>
          <p>{t("管理您的邮箱、邮件与账户权益。")}</p>
        </div>
        <dl className="account-config-grid">
          <div className="account-config-item api-key-item">
            <dt>API Key</dt>
            <dd>
              <code title={apiKey?.key || ""}>{apiKey?.key || (apiKey?.key_prefix ? `${apiKey.key_prefix}••••••••••••` : t("正在生成…"))}</code>
              <button className="config-icon-button" type="button" onClick={copyApiKey} disabled={!apiKey?.key} aria-label={t("复制 API Key")} title={t("复制 API Key")}><img src="/openapi/assets/images/icons/copy.svg" alt="" /></button>
              <button className={`config-icon-button${apiBusy ? " is-loading" : ""}`} type="button" onClick={resetApiKey} disabled={apiBusy || apiKey?.status === "DISABLED"} aria-label={t("重置 API Key")} title={apiKey?.status === "DISABLED" ? t("API Key 已被管理员停用") : t("重置 API Key")}><span className="refresh-icon" aria-hidden="true" /></button>
              <a className="api-doc-link" href="/openapi/docs.cgi">{t("API 使用文档")}<span>↗</span>
              </a>
            </dd>
            {apiNotice && <small className="api-key-inline-notice" role="status">{apiNotice}</small>}
          </div>
          <div className="account-config-item telegram-item">
            <dt>Telegram</dt>
            <TelegramBinding />
          </div>
          <NodelocBinding />
        </dl>
        <div
          className={`welcome-membership ${data.membership ? "" : "regular"}`}
        >
          <div className="vip-crown">{data.membership ? "VIP" : "USER"}</div>
        </div>
      </section>
      <section className="metric-grid">
        <article className="metric-card score-card">
          <span>{t("积分资产")}</span>
          <a className="recharge-mini" href="/user/recharge.cgi">{t("积分充值")}</a>
          <strong>{data.user.points_balance}</strong>
          <small>{t("当前可用积分")}</small>
        </article>
        <article className="metric-card">
          <span>{t("会员状态")}</span>
          <strong>
            {data.membership ? data.membership.name : t("会员未开通")}
          </strong>
          <small>
            {data.membership
              ? t("有效期至 {0}",dt(data.membership.expires_at))
              : t("升级后解锁更多权益")}
          </small>
        </article>
        <article className="metric-card">
          <span>{t("邮箱数量")}</span>
          <strong>{data.counts.mailboxes}</strong>
          <small>{t("数据库中的邮箱记录")}</small>
        </article>
        <article className="metric-card">
          <span>{t("累计收信")}</span>
          <strong>{data.counts.received}</strong>
          <small>{t("所有邮箱累计邮件数")}</small>
        </article>
      </section>
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2>{t("最近邮件")}</h2>
            <p>{t("查看各邮箱最近收到的邮件")}</p>
          </div>
          <a href="/user/mails.cgi">{t("查看全部邮件")}</a>
        </header>
        {recent.length ? (
          <>
            <div className="recent-mail-columns" aria-hidden="true">
              <span>{t("邮件摘要")}</span><span>{t("收信邮箱")}</span><span>{t("关键信息")}</span><span>{t("收信时间")}</span><span>{t("操作")}</span>
            </div>
            <div className="recent-mail-list">
            {recent.map((m) => {
              const received = recentTime(m.received_at);
              return (
              <article className={`mail-item${m.is_read ? " is-read" : ""}`} key={m.id}>
                <span className={`read-dot${m.is_read ? " read" : ""}`} aria-hidden="true" />
                <div className="item-main">
                  <strong>{m.subject || t("（无主题）")}</strong>
                  <span>{m.sender}</span>
                </div>
                <div className="mail-recipient">
                  <strong title={m.recipient}>{m.recipient}</strong>
                  <button className={copiedRecipient === m.recipient ? "is-copied" : ""} type="button" aria-label={t("复制 {0}",m.recipient)} title={copiedRecipient === m.recipient ? t("已复制") : t("复制邮箱地址")} onClick={() => copyRecipient(m.recipient)}>
                    <img src="/openapi/assets/images/icons/copy.svg" alt="" />
                  </button>
                </div>
                <div className="mail-keyword"><span>—</span></div>
                <time className="recent-mail-time"><span>{received.date}</span><span>{received.time}</span></time>
                <button className="mail-open-button" type="button" onClick={() => openRecentMessage(m)}>{t("查阅邮件")}</button>
              </article>
              );
            })}
            </div>
          </>
        ) : (
          <Empty title={t("暂无邮件")} copy={t("收到新邮件后会显示在这里")} />
        )}
      </section>
      {selectedMessage && <MailReader key={selectedMessage.id} message={selectedMessage} loading={messageLoading} error={messageError} onClose={closeRecentMessage}/>}
    </>
  );
}

type RecallPlan = {
  id: string;
  label: string;
  minutes: number;
  points: number;
  durationHours: number;
  actualPoints: number;
  enabled: boolean;
};


function Mailboxes({
  data,
  turnstileSiteKey,
  turnstileConfigured,
}: {
  data: MemberData;
  turnstileSiteKey: string;
  turnstileConfigured: boolean;
}) {
  const t=useTranslator();
  // Recall and renewal follow the same admin switch as mailbox creation.
  const captchaRequired=data.settings.captcha_before_mailbox_create==="true";
  const captchaBlocked=captchaRequired&&!turnstileConfigured;
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30000);return()=>window.clearInterval(timer);},[]);
  const [lifecycle,setLifecycle]=useState<"recall"|"renew">("recall");
  const [q, setQ] = useState("");
  const initialMailboxPagination = data.mailboxPagination || {
    page: 1,
    pages: Math.max(1, Math.ceil(data.mailboxes.length / 10)),
    total: data.mailboxes.length,
    pageSize: 10,
  };
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [mailboxPage, setMailboxPage] = useState(initialMailboxPagination.page);
  const [mailboxPageCount, setMailboxPageCount] = useState(
    initialMailboxPagination.pages,
  );
  const [mailboxTotal, setMailboxTotal] = useState(initialMailboxPagination.total);
  const [mailboxLoading, setMailboxLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [mailboxes, setMailboxes] = useState(data.mailboxes);
  const [pointsBalance, setPointsBalance] = useState(
    Number(data.user.points_balance || 0),
  );
  const [recallMailbox, setRecallMailbox] = useState<any | null>(null);
  const [recallPlanId, setRecallPlanId] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [recallStatus, setRecallStatus] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [recallBusy, setRecallBusy] = useState(false);
  const recallBusyRef = useRef(false);
  const recallRequestIdRef = useRef("");
  const mailboxListRequestRef = useRef(0);
  const recallPlans = useMemo<RecallPlan[]>(() => {
    let configuredPlans: any[] = [];
    try {
      const parsed = JSON.parse(data.settings.mailbox_duration_plans || "[]");
      if (Array.isArray(parsed)) configuredPlans = parsed;
    } catch {
      configuredPlans = [];
    }
    const discount = data.membership
      ? Number(data.membership.mailbox_discount_percent ?? 100)
      : 100;
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > 100) return [];
    const seenDurations = new Set<number>();
    return configuredPlans
      .map((item) => {
        const minutes = Number(item?.minutes);
        const points = Number(item?.points);
        const durationHours = minutes / 60;
        return {
          id: `${String(item?.id || durationHours)}:${durationHours}`,
          label: String(item?.label || t("{0} 天",durationHours / 24)),
          minutes,
          points,
          durationHours,
          enabled: item?.enabled !== false,
        };
      })
      .filter((item) => {
        if (
          !item.enabled ||
          !isValidRecallDuration(item.durationHours) ||
          !Number.isSafeInteger(item.points) ||
          item.points < 0 ||
          seenDurations.has(item.durationHours)
        ) return false;
        seenDurations.add(item.durationHours);
        return true;
      })
      .map((item) => ({ ...item, actualPoints: discountedMailboxPrice(item.points, discount) }))
      .sort((left, right) => left.durationHours - right.durationHours);
  }, [data.membership, data.settings.mailbox_duration_plans,t]);
  const selectedRecallPlan =
    recallPlans.find((item) => item.id === recallPlanId) || recallPlans[0];
  const isExpired = (mailbox: any) =>
    mailbox.status === "EXPIRED" ||
    Boolean(mailbox.expires_at && new Date(mailbox.expires_at).getTime() <= now);
  const canRecall = (mailbox: any) =>
    ["ACTIVE", "EXPIRED"].includes(mailbox.status) &&
    Boolean(mailbox.expires_at && new Date(mailbox.expires_at).getTime() <= now);

  useEffect(() => {
    if (!recallMailbox) return;
    document.body.classList.add("mailbox-purchase-dialog-open");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !recallBusyRef.current) closeRecall();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("mailbox-purchase-dialog-open");
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [recallMailbox]);

  async function copy(x: any) {
    if(!await copyText(x.address)){setPageNotice(t("复制失败，请手动选择复制。"));return;}
    setCopied(x.id);
    setTimeout(() => setCopied(""), 1400);
  }

  async function loadMailboxPage(nextPage: number, nextQuery = submittedQuery) {
    if (mailboxLoading) return;
    const requestNumber = mailboxListRequestRef.current + 1;
    mailboxListRequestRef.current = requestNumber;
    setMailboxLoading(true);
    try {
      const params = new URLSearchParams({
        page:String(nextPage),
        q:nextQuery,
      });
      const response = await fetch(`/api/user/mailboxes/list?${params}`, {
        method:"GET",
        headers:{ accept:"application/json" },
        cache:"no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !Array.isArray(payload.mailboxes)) {
        throw new Error(payload?.message || t("邮箱列表读取失败，请稍后重试。"));
      }
      if (mailboxListRequestRef.current !== requestNumber) return;
      const pagination = payload.pagination || {};
      setMailboxes(payload.mailboxes);
      setMailboxPage(Number(pagination.page || 1));
      setMailboxPageCount(Math.max(1,Number(pagination.pages || 1)));
      setMailboxTotal(Math.max(0,Number(pagination.total || 0)));
      setSubmittedQuery(nextQuery);
      setPageNotice("");
    } catch (error) {
      if (mailboxListRequestRef.current !== requestNumber) return;
      setPageNotice(
        error instanceof Error ? error.message : t("邮箱列表读取失败，请稍后重试。"),
      );
    } finally {
      if (mailboxListRequestRef.current === requestNumber) setMailboxLoading(false);
    }
  }

  function openRecall(mailbox: any) {
    const renew=mailbox.status === "ACTIVE" && Boolean(mailbox.expires_at) && !isExpired(mailbox);
    if (!renew && !canRecall(mailbox)) return;
    setLifecycle(renew?"renew":"recall");
    setRecallMailbox(mailbox);
    setRecallPlanId(recallPlans[0]?.id || "");
    setTurnstileToken("");
    setCaptchaResetKey((value) => value + 1);
    setRecallStatus(
      captchaBlocked
        ? t("人机验证尚未配置，暂时无法操作，请联系管理员。")
        : "",
    );
    recallRequestIdRef.current = crypto.randomUUID();
  }

  function closeRecall() {
    if (recallBusyRef.current) return;
    setRecallMailbox(null);
    setTurnstileToken("");
    setRecallStatus("");
  }

  async function submitRecall(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      recallBusyRef.current ||
      !recallMailbox ||
      !selectedRecallPlan ||
      captchaBlocked ||
      (captchaRequired && !turnstileToken)
    )
      return;
    if (pointsBalance < selectedRecallPlan.actualPoints) {
      setRecallStatus(t("当前积分不足，请先充值。"));
      return;
    }
    recallBusyRef.current = true;
    setRecallBusy(true);
    setRecallStatus(t("正在处理…"));
    try {
      const response = await fetch(`/api/user/mailboxes/${lifecycle}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          mailboxId: recallMailbox.id,
          durationHours: selectedRecallPlan.durationHours,
          expectedPrice: selectedRecallPlan.actualPoints,
          turnstileToken: captchaRequired ? turnstileToken : "",
          requestId: recallRequestIdRef.current,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload.result?.mailbox) {
        throw new Error(payload?.message || t("邮箱操作失败，请稍后重试。"));
      }
      const nextMailbox = payload.result.mailbox;
      setMailboxes((current) =>
        current.map((item) =>
          item.id === nextMailbox.id ? { ...item, ...nextMailbox } : item,
        ),
      );
      const nextPointsBalance = Number(payload.result.pointsBalance);
      setPointsBalance(nextPointsBalance);
      document.body.dataset.accountPoints = String(nextPointsBalance);
      const vipBalance = document.querySelector<HTMLElement>(".vip-current-balance b");
      if (vipBalance) vipBalance.textContent = String(nextPointsBalance);
      setPageNotice(lifecycle==="renew"?t("{0} 已续期，已有邮件保持不变。",nextMailbox.address):t("{0} 已成功召回，正在恢复收信。",nextMailbox.address));
      setRecallMailbox(null);
      setTurnstileToken("");
      window.setTimeout(() => setPageNotice(""), 4500);
    } catch (error) {
      setTurnstileToken("");
      setCaptchaResetKey((value) => value + 1);
      setRecallStatus(
        error instanceof Error ? error.message : t("邮箱操作失败，请稍后重试。"),
      );
    } finally {
      recallBusyRef.current = false;
      setRecallBusy(false);
    }
  }

  return (
    <>
      <section className="panel page-panel mailbox-list-panel">
        <header className="panel-header">
          <div>
            <h2>{t("我的邮箱")}</h2>
            <p>{t("共")}{mailboxTotal}{t("个真实邮箱记录")}</p>
          </div>
        </header>
        {pageNotice && (
          <output className="mailbox-list-notice" role="status">
            {pageNotice}
          </output>
        )}
        <div className="list-tools">
          <form
            className="list-search"
            onSubmit={(event) => {
              event.preventDefault();
              void loadMailboxPage(1,q.trim());
            }}
          >
            <div className="list-search-control">
              <div className="list-search-field">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("搜索")}
                  maxLength={100}
                />
                <button type="submit" disabled={mailboxLoading}>{t("搜索")}</button>
              </div>
            </div>
          </form>
        </div>
        <div className="table-wrap" aria-busy={mailboxLoading}>
          <table>
            <thead>
              <tr>
                <th>{t("邮箱地址")}</th>
                <th>{t("累计收信")}</th>
                <th>{t("到期时间")}</th>
                <th>{t("创建时间")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((x) => {
                const expired = isExpired(x);
                const recallable = canRecall(x);
                return (
                  <tr
                    className={`mailbox-row ${expired ? "expired" : ""}`}
                    key={x.id}
                  >
                    <td data-label={t("邮箱地址")}>
                      <div className="mailbox-address-cell">
                        <strong>{x.address}</strong>
                        <button
                          className={`mailbox-address-copy${copied === x.id ? " is-copied" : ""}`}
                          type="button"
                          onClick={() => copy(x)}
                          aria-label={t("复制 {0}",x.address)}
                        >
                          <img src="/openapi/assets/images/icons/copy.svg" alt="" />
                        </button>
                      </div>
                    </td>
                    <td data-label={t("累计收信")}>{x.received_count}</td>
                    <td data-label={t("到期时间")}>
                      <div className="mailbox-expiry-cell">
                        <span className="mailbox-expiry" title={dt(x.expires_at)}>
                          {expired?t("已过期"):x.expires_at&&new Date(x.expires_at).getTime()-now<86400000?t("{0} 分钟后到期",Math.max(1,Math.ceil((new Date(x.expires_at).getTime()-now)/60000))):dt(x.expires_at)}
                        </span>
                        {(recallable || (x.status === "ACTIVE" && Boolean(x.expires_at) && !expired)) && (
                          <button
                            className="mailbox-lifecycle-action"
                            type="button"
                            onClick={() => openRecall(x)}
                          >{t(expired?"召回":"续期")}</button>
                        )}
                      </div>
                    </td>
                    <td data-label={t("创建时间")}>{dt(x.created_at)}</td>
                    <td data-label={t("操作")}>
                      {!expired && x.status==='ACTIVE'?<a className="mailbox-open-link" href={`/user/mailbox.cgi?id=${encodeURIComponent(x.id)}`}>{t('进入收信')}</a>:<span className="mailbox-open-disabled">{expired?t('已过期'):mailboxState(x.status)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!mailboxes.length && (
          <Empty
            title={t("暂无邮箱")}
            copy={submittedQuery ? t("没有找到匹配的邮箱") : t("请先在“邮箱申请”创建邮箱")}
          />
        )}
        <footer className="list-pagination">
          <span className="list-page-summary">{t("共")}<strong>{mailboxTotal}</strong>{t("条，每页 10 条")}</span>
          <button
            type="button"
            disabled={mailboxLoading || mailboxPage <= 1}
            onClick={() => void loadMailboxPage(Math.max(1,mailboxPage - 1))}
          >{t("上一页")}</button>
          <span className="list-page-current">{t("第")}<strong>{mailboxPage}</strong> / {mailboxPageCount}{t("页")}</span>
          <button
            type="button"
            disabled={mailboxLoading || mailboxPage >= mailboxPageCount}
            onClick={() => void loadMailboxPage(Math.min(mailboxPageCount,mailboxPage + 1))}
          >{t("下一页")}</button>
        </footer>
      </section>

      {recallMailbox && (
        <div className="mailbox-purchase-dialog">
          <button
            className="mailbox-purchase-backdrop"
            type="button"
            aria-label={t("关闭召回窗口")}
            disabled={recallBusy}
            onClick={closeRecall}
          />
          <section
            className="mailbox-purchase-card mailbox-recall-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mailboxRecallTitle"
          >
            <button
              className="mailbox-purchase-close"
              type="button"
              aria-label={t("关闭")}
              disabled={recallBusy}
              onClick={closeRecall}
            >
              ×
            </button>
            <header>
              <span>{t("有效时长")}</span>
              <h2 id="mailboxRecallTitle">{t(lifecycle==="renew"?"续期":"召回")}</h2>
              <p>{t(lifecycle==="renew"?(captchaRequired?"选择时长并完成人机验证。续期将在当前有效期后顺延。":"选择时长。续期将在当前有效期后顺延。"):"召回从现在重新计时，不恢复已清理的旧邮件。")}</p>
            </header>
            <form onSubmit={submitRecall}>
              <div className="mailbox-purchase-address">
                <span>{t("邮箱地址")}</span>
                <strong>{recallMailbox.address}</strong>
              </div>
              <fieldset>
                <legend>{t("有效时长")}</legend>
                <div className="mailbox-purchase-plans">
                  {recallPlans.map((item) => (
                    <label key={item.id}>
                      <input
                        type="radio"
                        name="recall-duration"
                        value={item.id}
                        checked={selectedRecallPlan?.id === item.id}
                        disabled={recallBusy}
                        onChange={() => {
                          setRecallPlanId(item.id);
                          recallRequestIdRef.current=crypto.randomUUID();
                          setRecallStatus("");
                        }}
                      />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.actualPoints}{t("积分")}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="mailbox-purchase-summary">
                <span>{t("当前积分")}<b>{pointsBalance}{t("积分")}</b>
                </span>
                <span>{t("本次支付")}<strong>{selectedRecallPlan?.actualPoints || 0}{t("积分")}</strong>
                </span>
              </div>
              {captchaRequired && <div className="mailbox-purchase-captcha">
                {turnstileConfigured ? (
                  <TurnstileWidget
                    siteKey={turnstileSiteKey}
                    action={lifecycle==="renew"?"member_mailbox_renew":"member_mailbox_recall"}
                    theme="light"
                    size="normal"
                    responsive
                    language="zh-cn"
                    resetKey={captchaResetKey}
                    ariaLabel={t("进行人机身份验证")}
                    onVerify={(token) => {
                      setTurnstileToken(token);
                      setRecallStatus("");
                    }}
                    onExpire={() => {
                      setTurnstileToken("");
                      setRecallStatus(t("验证已过期，请重新完成人机验证。"));
                    }}
                    onError={() => {
                      setTurnstileToken("");
                      setRecallStatus(t("人机验证暂时不可用，请稍后重试。"));
                    }}
                  />
                ) : (
                  <span>{t("人机验证尚未配置，请联系管理员。")}</span>
                )}
              </div>}
              {!recallPlans.length && (
                <p className="mailbox-purchase-status" role="status">{t("管理员尚未配置可用的召回时长。")}</p>
              )}
              {selectedRecallPlan && pointsBalance < selectedRecallPlan.actualPoints && (
                <p className="mailbox-purchase-status" role="status">{t("当前积分不足，请先充值。")}</p>
              )}
              {recallStatus && (
                <p className="mailbox-purchase-status" role="status" aria-live="polite">
                  {recallStatus}
                </p>
              )}
              <footer>
                <button type="button" disabled={recallBusy} onClick={closeRecall}>{t("取消")}</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    recallBusy ||
                    !selectedRecallPlan ||
                    captchaBlocked ||
                    (captchaRequired && !turnstileToken) ||
                    pointsBalance < (selectedRecallPlan?.actualPoints || 0)
                  }
                >
                  {recallBusy?t("正在处理…"):t(lifecycle==="renew"?"续期":"召回")}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function Messages({ data }: { data: MemberData }) {
  const t=useTranslator();
  const mailboxId=data.selectedMailbox?.id||"";
  const [mailboxError,setMailboxError]=useState(data.mailboxError||"");
  const [q, setQ] = useState("");
  const [messages, setMessages] = useState(data.messages);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pagination,setPagination]=useState(data.messagePagination||{page:1,pages:1,total:data.counts.messages,pageSize:10});
  const [listError,setListError]=useState("");
  const [listBusy,setListBusy]=useState(false);
  const [cooldown,setCooldown]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const manualRef=useRef(false);
  const detailRequest = useRef(0);
  const closeMessage = () => { detailRequest.current += 1; setSelected(null); setLoading(false); setError(""); };
  useEffect(() => () => { detailRequest.current += 1; }, []);
  const list=messages;
  const pageRows=messages;
  const currentPage=pagination.page,pageCount=pagination.pages;
  useEffect(()=>setPage(1),[q]);
  useEffect(()=>{
    if(!cooldown)return;
    const timer=window.setInterval(()=>setCooldown(value=>Math.max(0,value-1)),1000);
    return()=>window.clearInterval(timer);
  },[cooldown>0]);
  useEffect(()=>{
    if(data.mailboxError)return;
    const controller=new AbortController();let running=false;
    const load=async()=>{
      if(running)return;running=true;setListBusy(true);
      try{
        const manual=manualRef.current;manualRef.current=false;
        const response=await fetch(`/api/user/messages/list?${new URLSearchParams({page:String(page),q,...(mailboxId?{mailboxId}:{}),...(manual?{manual:"1"}:{})})}`,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
        const result=await response.json();
        if(controller.signal.aborted)return;
        if(!response.ok||!result.ok){if(response.status===404&&mailboxId){setMessages([]);setPagination({page:1,pages:1,total:0,pageSize:10});setMailboxError(result.message);closeMessage();}throw new Error(result.message||t("收件箱读取失败。"));}
        if(controller.signal.aborted)return;
        setMessages(result.messages);setPagination(result.pagination);setListError("");setMailboxError("");
        if(result.pagination.page!==page)setPage(result.pagination.page);
      }catch(cause){if(!controller.signal.aborted)setListError(cause instanceof Error?cause.message:t("收件箱读取失败。"));}
      finally{running=false;if(!controller.signal.aborted)setListBusy(false);}
    };
    const timer=window.setTimeout(()=>void load(),200);
    const polling=window.setInterval(()=>void load(),10000);
    return()=>{controller.abort();window.clearTimeout(timer);window.clearInterval(polling);};
  },[page,q,refresh,mailboxId]);
  const openMessage = async (message: any) => {
    const request = ++detailRequest.current;
    setSelected(message);
    setLoading(true);
    setError("");
    try {
      const detail = await postJson("/api/user/messages/read", { id: message.id });
      if (request !== detailRequest.current) return;
      setSelected(detail);
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id ? { ...item, is_read: true } : item,
        ),
      );
    } catch (cause) {
      if (request !== detailRequest.current) return;
      setError(cause instanceof Error ? cause.message : t("邮件读取失败。"));
    } finally {
      if (request === detailRequest.current) setLoading(false);
    }
  };
  return (
    <section className="panel page-panel">
      <div className="panel-header">
        <div>
          <h2>{data.selectedMailbox?.address||t("收件箱")}</h2>
          {data.selectedMailbox&&<a href="/user/mailboxes.cgi">{t("返回邮箱列表")}</a>}
          <p>{t("列表每 10 秒自动检查新邮件。")}</p>
        </div>
        <button className="mc-mail-refresh" type="button" disabled={listBusy||cooldown>0} onClick={() => {manualRef.current=true;setCooldown(10);setRefresh(value=>value+1);}}>{cooldown?`${cooldown}s`:t("↻ 刷新")}</button>
      </div>
      {(mailboxError||listError)&&<p role="alert">{mailboxError||listError}</p>}
      <div className="mc-mail-tools">
        <form className="mc-mail-search" onSubmit={(e) => e.preventDefault()}>
          <div>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("搜索发件人或主题")}
              />
              <button type="submit">{t("搜索")}</button>
          </div>
        </form>
      </div>
      {list.length ? (
        <>
          <div className="mc-mail-columns"><span>{t("邮件摘要")}</span><span>{t("关键信息")}</span><span>{t("状态")}</span><span>{t("收信时间")}</span><span>{t("操作")}</span></div>
          <div className="mc-mail-page-list">
          {pageRows.map((m) => (
            <article className={`mc-mail-item${m.is_read ? " is-read" : ""}`} key={m.id}>
              <span className={`mc-read-dot${m.is_read ? " read" : ""}`} aria-hidden="true" />
              <div className="mc-mail-main">
                <strong>{m.subject || t("（无主题）")}</strong>
                <span>{m.sender} → {m.recipient}</span>
              </div>
              <div className="mc-mail-keyword"><span>—</span></div>
              <span className="mc-mail-status">{m.is_read ? t("已读") : t("未读")}</span>
              <time>{dt(m.received_at)}</time>
              <button className="mc-mail-open" type="button" onClick={() => openMessage(m)}>{t("查阅邮件")}</button>
            </article>
          ))}
          </div>
        </>
      ) : (
        <Empty
          title={t("暂无邮件")}
          copy={q ? t("没有找到匹配的邮件") : t("当前邮箱尚未收到邮件")}
        />
      )}
      <nav className="mc-mail-pagination">
        <div>{t("共")}<strong>{pagination.total}</strong>{t("条，每页 10 条")}</div>
        <button type="button" disabled={listBusy||currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t("上一页")}</button>
        <span>{t("第")}<strong>{currentPage}</strong> / {pageCount}{t("页")}</span>
        <button type="button" disabled={listBusy||currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一页")}</button>
      </nav>
      {selected && <MailReader key={selected.id} message={selected} loading={loading} error={error} onClose={closeMessage}/>}
    </section>
  );
}

function Points({ data }: { data: MemberData }) {
  const t=useTranslator();
  const history = useMemberHistory('transactions',data.transactions,data.transactionPagination);
  const list = history.items;
  return (
    <section className="panel page-panel" aria-busy={history.loading}>
      <div className="panel-header">
        <div>
          <h2>{t("积分流水")}</h2>
          <p>{t("当前可用积分")}{data.user.points_balance}</p>
        </div>
        <a className="panel-action" href="/user/recharge.cgi">{t("积分充值")}</a>
      </div>
      <MemberHistorySearch history={history} placeholder={t("搜索流水类型、备注或积分")} />
      {list.length ? (
        <div className="transaction-list">
          {list.map((x) => (
            <article className="transaction-item" key={x.id}>
              <div
                className={`transaction-mark ${x.amount > 0 ? "income" : "expense"}`}
              ></div>
              <div className="item-main">
                <strong>{t(txName(x.type))}</strong>
                <span>{t("备注：")}{x.note || t("系统记录")}{t("· 余额")}{x.balance_after}
                </span>
              </div>
              <strong
                className={`score-change ${x.amount > 0 ? "income" : "expense"}`}
              >
                {x.amount > 0 ? "+" : ""}
                {x.amount}
              </strong>
              <time>{dt(x.created_at)}</time>
            </article>
          ))}
        </div>
      ) : (
        !history.loading && !history.error && <Empty title={t("暂无匹配的积分流水")} />
      )}
      <MemberHistoryPagination history={history} />
    </section>
  );
}

function Membership({ data }: { data: MemberData }) {
  const t=useTranslator();
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <Header
        eyebrow="MEMBERSHIP"
        title={t("会员服务")}
        copy={t("套餐价格和权益均由管理员后台实时配置。")}
        action={
          !data.membership && (
            <button className="mc-primary" onClick={() => setDialog(true)}>{t("开通会员")}</button>
          )
        }
      />
      <section className="mc-membership-hero">
        <div>
          <small>{t("当前方案")}</small>
          <h2>{data.membership ? data.membership.name : t("标准账户")}</h2>
          <p>
            {data.membership
              ? t("有效期至 {0}",dt(data.membership.expires_at))
              : t("现有邮箱与积分均正常可用。")}
          </p>
          {!data.membership && (
            <button className="mc-primary" onClick={() => setDialog(true)}>{t("查看开通方案")}</button>
          )}
        </div>
        <div>
          <span>{t("会员权益")}</span>
          <ul>
            <li>{t("创建邮箱享会员积分价")}</li>
            <li>{t("申请私有域名（需审核归属）")}</li>
            <li>{t("更高 API 请求额度")}</li>
            <li>{t("邮件随各自邮箱有效期保留")}</li>
          </ul>
        </div>
      </section>
      <div className="mc-benefit-grid">
        <article>
          <Icon>％</Icon>
          <h3>{t("会员价格")}</h3>
          <p>{t("折扣比例由后台套餐设置决定。")}</p>
        </article>
        <article>
          <Icon>∞</Icon>
          <h3>{t("长期管理")}</h3>
          <p>{t("集中查看更多邮箱、状态和历史收件记录。")}</p>
        </article>
        <article>
          <Icon>◎</Icon>
          <h3>{t("私有域名")}</h3>
          <p>{t("验证自己的域名后创建专属后缀邮箱。")}</p>
        </article>
      </div>
      {dialog && <VipDialog data={data} onClose={() => setDialog(false)} />}
    </>
  );
}

function Domains({ data }: { data: MemberData }) {
  const t=useTranslator();
  const history = useMemberHistory('domains',data.domains,data.domainPagination);
  const [dialog, setDialog] = useState<"domain" | "vip" | null>(null),
    [domain, setDomain] = useState(""),
    [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const list = history.items;
  async function add(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult("");
    try {
      await postJson("/api/user/domains/create", { domain });
      setResult(t("域名已提交，等待管理员审核和 MX 检测。"));
      setDomain("");
      await history.reset();
    } catch (error) {
      setResult(error instanceof Error ? error.message : t("添加失败。"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel page-panel" aria-busy={history.loading}>
        <div className="panel-header">
          <div>
            <h2>{t("我的私有域名")}</h2>
            <p>{t("域名状态由管理员后台审核并同步显示")}</p>
          </div>
          <button className="domain-add-button" onClick={() => setDialog(data.membership ? "domain" : "vip")}>{t("添加域名")}</button>
        </div>
        <MemberHistorySearch history={history} placeholder={t("搜索私有域名或服务状态")} />
        {list.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("域名")}</th>
                  <th>{t("MX 状态")}</th>
                  <th>{t("服务状态")}</th>
                  <th>{t("邮箱数")}</th>
                  <th>{t("添加时间")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.domain}>
                    <td data-label={t("域名")}>
                      <strong>{x.domain}</strong>
                    </td>
                    <td data-label={t("MX 状态")}>{t(mxState(x.mx_status))}</td>
                    <td data-label={t("服务状态")}>{t(domainState(x.status))}</td>
                    <td data-label={t("邮箱数")}>{x.mailbox_count}</td>
                    <td data-label={t("添加时间")}>{dt(x.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !history.loading && !history.error && <Empty
            title={t("暂无匹配的私有域名")}
            copy={
              history.query ? t("没有找到匹配的私有域名") : t("有效会员可以添加自己的收信域名")
            }
          />
        )}
        <MemberHistoryPagination history={history} />
      </section>
      {dialog === "domain" && (
        <Modal
          eyebrow="PRIVATE DOMAIN"
          title={t("添加私有域名")}
          onClose={() => setDialog(null)}
        >
          <form className="mc-dialog-form" onSubmit={add}>
            <label>{t("域名")}<input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                required
              />
            </label>
            <p className="mc-dialog-note">{t("请输入根域名，不包含协议和路径。")}</p>
            {result && <output>{result}</output>}
            <div className="mc-dialog-actions">
              <button
                type="button"
                className="mc-secondary"
                onClick={() => setDialog(null)}
              >{t("取消")}</button>
              <button type="submit" className="mc-primary" disabled={busy}>
                {busy ? t("提交中…") : t("添加域名")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "vip" && <VipDialog data={data} onClose={() => setDialog(null)} />}
    </>
  );
}

function Api({ data }: { data: MemberData }) {
  const t=useTranslator();
  const [key, setKey] = useState(data.apiKey),
    [secret, setSecret] = useState(data.apiKey?.key || ""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function rotate() {
    if (key?.status === "DISABLED") {
      setNotice(t("API Key 已被管理员停用，如需恢复请联系管理员。"));
      return;
    }
    if (
      !(await appConfirm(
        key ? t("重置后旧密钥会立即失效，确定继续吗？") : t("确定创建 API 密钥吗？"),
        { title: key ? t("重置 API Key") : t("创建 API Key"), confirmText: key ? t("确认重置") : t("确认创建"), tone: key ? "danger" : "" },
      ))
    )
      return;
    setBusy(true);
    setNotice("");
    try {
      const result = await postJson("/api/user/api-key/rotate");
      setKey(result);
      setSecret(result.key);
      setNotice(t("新密钥只显示这一次，请立即复制并妥善保存。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("操作失败。"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header
        eyebrow="DEVELOPER API"
        title={t("API 接口")}
        copy={t("密钥状态和请求限额与账户实时同步。")}
        action={
          <a className="mc-secondary" href="/openapi/docs.cgi">{t("阅读接口文档 ↗")}</a>
        }
      />
      <section className="mc-panel mc-api-card">
        <header>
          <div>
            <small>{t("访问密钥")}</small>
            <h2>API Key</h2>
          </div>
          <span className={`mc-status ${key?.status === "ACTIVE" ? "ready" : ""}`}>
            {key?.status === "DISABLED" ? t("已停用") : key ? t("已启用") : t("未创建")}
          </span>
        </header>
        <div className="mc-api-key">
          <code>
            {secret || (key ? `${key.key_prefix}••••••••••••` : t("尚未创建密钥"))}
          </code>
          {secret && (
            <button
              onClick={async () => {
                setNotice(await copyText(secret)?t("密钥已复制。"):t("复制失败，请手动选择复制。"));
              }}
            >{t("复制")}</button>
          )}
        </div>
        <div className="mc-api-meta">
          <span>{t("每分钟请求上限")}<strong>{key?.rate_limit_per_minute || 0}</strong>
          </span>
          <span>{t("最近使用")}{" "}
            <strong>
              {key?.last_used_at ? dt(key.last_used_at) : t("从未使用")}
            </strong>
          </span>
        </div>
        {notice && <output>{notice}</output>}
        <footer>
          <p>
            {key?.status === "DISABLED"
              ? t("管理员已停用当前 API Key，接口调用和密钥重置均已关闭。")
              : key
              ? t("重置后旧密钥会立即失效；接口调用仅对有效会员开放。")
              : t("账户会自动分配 API Key，接口调用仅对有效会员开放。")}
          </p>
          <button onClick={rotate} disabled={busy || key?.status === "DISABLED"}>
            {busy ? t("处理中…") : key?.status === "DISABLED" ? t("密钥已停用") : key ? t("重置密钥") : t("创建密钥")}
          </button>
        </footer>
      </section>
      <section className="mc-panel mc-code-card">
        <small>{t("快速开始")}</small>
        <h2>{t("创建邮箱")}</h2>
        <pre>
          <code>{`curl -X POST https://YOUR_DOMAIN/openapi/v1/mailbox/create.cgi \\\n  -H "apiKey: YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  --data '{}'`}</code>
        </pre>
      </section>
    </>
  );
}

function Account({ data }: { data: MemberData }) {
  const t=useTranslator();
  const [notice, setNotice] = useState("");
  async function logout(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    try {
      const r = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!r.ok) throw new Error();
      location.replace("/user/login.cgi");
    } catch {
      setNotice(t("退出失败，请稍后重试。"));
    }
  }
  return (
    <>
      <Header
        eyebrow="ACCOUNT SETTINGS"
        title={t("账户设置")}
        copy={t("只显示数据库中的真实账户资料。")}
      />
      <div className="mc-settings-grid">
        <section className="mc-panel mc-settings">
          <header>
            <small>{t("基本信息")}</small>
            <h2>{t("账户资料")}</h2>
          </header>
          <label>{t("账户邮箱")}<input value={data.user.email} readOnly />
          </label>
          <label>{t("界面语言")}<input
              value={
                data.user.locale === "zh-CN" ? t("简体中文") : data.user.locale
              }
              readOnly
            />
          </label>
          <div className="mc-setting-row">
            <span>
              <strong>{t("账户状态")}</strong>
              <small>
                {data.user.status === "ACTIVE" ? t("正常") : t("已被管理员限制")}
              </small>
            </span>
          </div>
        </section>
        <section className="mc-panel mc-settings">
          <header>
            <small>{t("账户安全")}</small>
            <h2>{t("登录与密码")}</h2>
          </header>
          <div className="mc-setting-row">
            <span>
              <strong>{t("登录密码")}</strong>
              <small>{t("密码经过安全哈希保存")}</small>
            </span>
            <a href="/user/password/recover.cgi">{t("修改")}</a>
          </div>
          <div className="mc-setting-row">
            <span>
              <strong>{t("注册时间")}</strong>
              <small>{dt(data.user.created_at)}</small>
            </span>
          </div>
          {notice && <output>{notice}</output>}
          <a className="mc-danger-link" href="/user/login.cgi" onClick={logout}>{t("退出当前账户")}</a>
        </section>
      </div>
    </>
  );
}
export default function MemberCenter({
  view,
  data,
  turnstileSiteKey = "",
  turnstileConfigured = false,
}: {
  view: MemberView;
  data: MemberData;
  turnstileSiteKey?: string;
  turnstileConfigured?: boolean;
}) {
  const t=useTranslator();
  const views: Record<MemberView, React.ReactNode> = {
    overview: <Overview data={data} />,
    mailboxes: (
      <Mailboxes
        data={data}
        turnstileSiteKey={turnstileSiteKey}
        turnstileConfigured={turnstileConfigured}
      />
    ),
    messages: <Messages data={data} />,
    points: <Points data={data} />,
    membership: <Membership data={data} />,
    domains: <Domains data={data} />,
    api: <Api data={data} />,
    account: <Account data={data} />,
  };
  return <div className="member-page">{views[view]}</div>;
}
