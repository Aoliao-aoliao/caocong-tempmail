import MailReader from './ui/MailReader';
import {copyText} from '../lib/clipboard';
import {useTranslator} from '../lib/useTranslator';
import { discountedMailboxPrice } from "../../server/member/mailbox-price.mjs";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import TurnstileWidget from "./TurnstileWidget";

type Domain = { domain: string; kind: "PUBLIC" | "LOGIN" | "MEMBER" | "PRIVATE" };
type Plan = { id: string; label: string; minutes: number; points: number };
type Mailbox = {
  id: string;
  address: string;
  duration_minutes: number;
  received_count: number;
  status: string;
  available?: boolean;
  expires_at: string | null;
  created_at: string | null;
};
type MailItem = {
  id: string;
  recipient: string;
  sender: string;
  subject: string;
  size_bytes: number;
  is_read: boolean;
  received_at: string;
};
type MailDetail = MailItem & {
  content_type: string;
  body_text: string;
};
type Pagination = { page: number; pages: number; total: number; pageSize: number };

const splitAddress = (address: string) => {
  const splitAt = address.lastIndexOf("@");
  return splitAt > 0
    ? { name: address.slice(0, splitAt), domain: address.slice(splitAt + 1) }
    : { name: "", domain: "" };
};

export default function MailApply({
  domains,
  plans,
  currentPoints,
  isMember,
  discountPercent,
  memberPreviewDiscountPercent = discountPercent,
  captchaEnabled,
  turnstileSiteKey,
  turnstileConfigured,
  initialMailbox,
  initialMessages,
  initialPagination,
  initialError = "",
  requestedAddress = "",
}: {
  initialError?: string;
  requestedAddress?: string;
  domains: Domain[];
  plans: Plan[];
  currentPoints: number;
  isMember: boolean;
  discountPercent: number;
  memberPreviewDiscountPercent?: number;
  captchaEnabled: boolean;
  turnstileSiteKey: string;
  turnstileConfigured: boolean;
  initialMailbox: Mailbox | null;
  initialMessages: MailItem[];
  initialPagination: Pagination;
}) {
  const t=useTranslator();
  const requested = splitAddress(requestedAddress);
  const validRequested = /^[a-z0-9][a-z0-9._-]{4,31}$/.test(requested.name) && domains.some(d => d.domain === requested.domain);
  const initialAddress = validRequested ? requested : splitAddress(initialMailbox?.address || "");
  const initialPlan = plans.find((item) => item.minutes === initialMailbox?.duration_minutes);
  const [name, setName] = useState(initialAddress.name);
  const [domain, setDomain] = useState(initialAddress.domain || domains[0]?.domain || "");
  const [plan, setPlan] = useState(initialPlan?.id || plans[0]?.id || "");
  const [domainOpen, setDomainOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [randomError, setRandomError] = useState("");
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [mailbox, setMailbox] = useState<Mailbox | null>(initialMailbox);
  const [pointsBalance, setPointsBalance] = useState(currentPoints);
  const [mailItems, setMailItems] = useState<MailItem[]>(initialMessages);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [page, setPage] = useState(initialPagination.page || 1);
  const [pages, setPages] = useState(initialPagination.pages || 1);
  const [total, setTotal] = useState(initialPagination.total || 0);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [inboxStatus, setInboxStatus] = useState("");
  const [selectionError,setSelectionError]=useState(initialError);
  const [selectedMessage, setSelectedMessage] = useState<MailDetail | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const createRequestIdRef = useRef("");
  const inboxRequestRef = useRef(0);
  const messageRequestRef = useRef(0);
  const randomClicksRef = useRef<number[]>([]);
  const randomErrorTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const selected = useMemo(
    () => plans.find((item) => item.id === plan) ?? plans[0],
    [plan, plans],
  );
  const actualPoints = selected
    ? isMember
      ? discountedMailboxPrice(selected.points, discountPercent)
      : selected.points
    : 0;
  const address = name ? `${name}@${domain}` : "";
  const showingCurrentMailbox = Boolean(
    mailbox && mailbox.address === address,
  );
  const displayAddress = showingCurrentMailbox ? mailbox!.address : address;

  const formatTime = (value: string) => {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value));
    } catch {
      return value;
    }
  };

  useEffect(() => {
    const close = (event: MouseEvent) =>
      !pickerRef.current?.contains(event.target as Node) &&
      setDomainOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDomainOpen(false);
        if (!submittingRef.current) setConfirmOpen(false);
        closeMessage();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (!mailbox) return;
    const timer = window.setInterval(
      () => void loadMessages(page, submittedQuery, true),
      8000,
    );
    return () => window.clearInterval(timer);
  }, [mailbox?.id, page, submittedQuery]);

  useEffect(() => {
    document.body.classList.toggle("mc-mail-reader-open", Boolean(selectedMessage));
    return () => document.body.classList.remove("mc-mail-reader-open");
  }, [selectedMessage]);

  useEffect(() => () => {
    if (randomErrorTimerRef.current !== null) {
      window.clearTimeout(randomErrorTimerRef.current);
    }
  }, []);

  useEffect(() => () => {
    if (refreshTimerRef.current !== null) {
      window.clearInterval(refreshTimerRef.current);
    }
  }, []);

  function randomize() {
    const now = Date.now();
    const windowMs = 10_000;
    const recentClicks = randomClicksRef.current.filter((time) => now - time < windowMs);
    if (recentClicks.length >= 6) {
      randomClicksRef.current = recentClicks;
      setRandomError(t("操作频繁，请稍后再试"));
      if (randomErrorTimerRef.current !== null) window.clearTimeout(randomErrorTimerRef.current);
      const waitMs = Math.max(500, windowMs - (now - recentClicks[0]));
      randomErrorTimerRef.current = window.setTimeout(() => {
        randomClicksRef.current = [];
        setRandomError("");
        randomErrorTimerRef.current = null;
      }, waitMs);
      return;
    }
    randomClicksRef.current = [...recentClicks, now];
    setRandomError("");
    setSubmitError("");
    setName(Math.random().toString(36).slice(2, 7));
  }
  function requestConfirm(event: FormEvent) {
    event.preventDefault();
    if (!name) randomize();
    else {
      setSubmitError("");
      setTurnstileToken("");
      setCaptchaError(
        captchaEnabled && !turnstileConfigured
          ? t("人机验证尚未配置，请联系管理员。")
          : "",
      );
      setCaptchaResetKey((value) => value + 1);
      createRequestIdRef.current = crypto.randomUUID();
      setConfirmOpen(true);
    }
  }

  async function loadMessages(nextPage = 1, search = submittedQuery, silent = false, targetMailbox = mailbox, manual = false, afterCreation = false) {
    if (!targetMailbox || (submittingRef.current && !afterCreation)) return;
    const requestId = inboxRequestRef.current + 1;
    inboxRequestRef.current = requestId;
    if (!silent) setInboxLoading(true);
    if (!silent) setInboxStatus("");
    try {
      const params = new URLSearchParams({ mailboxId: targetMailbox.id, page: String(nextPage) });
      if (search) params.set("q", search);
      if (manual) params.set("manual", "1");
      const response = await fetch(`/api/user/mailboxes/inbox?${params}`, {
        headers: { accept: "application/json" },
      });
      const result = await response.json().catch(() => null);
      if (inboxRequestRef.current !== requestId) return;
      if ([401,404,410].includes(response.status)) {
        setMailbox(null); setMailItems([]); setPage(1); setPages(1); setTotal(0); closeMessage();
        setInboxStatus(t("当前邮箱已失效，请重新生成。"));
        return;
      }
      if (!response.ok || !result?.ok) throw new Error(result?.message || t("收件箱读取失败。"));
      if (!result.mailbox) {
        setMailbox(null);
        setMailItems([]);
        setPage(1);
        setPages(1);
        setTotal(0);
        return;
      }
      setMailbox(result.mailbox);
      setMailItems(result.messages || []);
      setPage(Number(result.pagination?.page || 1));
      setPages(Number(result.pagination?.pages || 1));
      setTotal(Number(result.pagination?.total || 0));
    } catch (error) {
      if (inboxRequestRef.current === requestId && !silent) {
        setInboxStatus(error instanceof Error ? error.message : t("收件箱读取失败。"));
      }
    } finally {
      if (inboxRequestRef.current === requestId) setInboxLoading(false);
    }
  }

  function refreshInbox() {
    if (!mailbox || inboxLoading || refreshCooldown > 0) return;
    setRefreshCooldown(10);
    if (refreshTimerRef.current !== null) window.clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = window.setInterval(() => {
      setRefreshCooldown((seconds) => {
        if (seconds <= 1) {
          if (refreshTimerRef.current !== null) window.clearInterval(refreshTimerRef.current);
          refreshTimerRef.current = null;
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    void loadMessages(page, submittedQuery, false, mailbox, true);
  }

  async function finish() {
    if (
      submittingRef.current ||
      (captchaEnabled && (!turnstileConfigured || !turnstileToken)) ||
      !selected ||
      !domain
    ) return;
    submittingRef.current = true;
    inboxRequestRef.current += 1;
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await fetch("/api/user/mailboxes/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          localPart: name,
          domain,
          durationMinutes: selected.minutes,
          expectedPrice: actualPoints,
          requestId: createRequestIdRef.current,
          turnstileToken,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.message || t("创建失败"));
      const nextMailbox = result.result as Mailbox & { pointsBalance: number };
      setMailbox(nextMailbox);
      setSelectionError("");
      setPointsBalance(Number(nextMailbox.pointsBalance));
      const parts = splitAddress(nextMailbox.address);
      setName(parts.name);
      setDomain(parts.domain);
      const nextPlan = plans.find((item) => item.minutes === nextMailbox.duration_minutes);
      if (nextPlan) setPlan(nextPlan.id);
      setQuery("");
      setSubmittedQuery("");
      setMailItems([]);
      setPage(1);
      setPages(1);
      setTotal(0);
      setInboxStatus("");
      setSubmitError("");
      setConfirmOpen(false);
      closeMessage();
      await loadMessages(1, "", true, nextMailbox, false, true);
    } catch (error) {
      if (captchaEnabled) {
        setTurnstileToken("");
        setCaptchaResetKey((value) => value + 1);
      }
      setSubmitError(error instanceof Error ? error.message : t("创建失败。"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  async function copyAddress() {
    if (!displayAddress) return;
    if(!await copyText(displayAddress)){setSubmitError(t("复制失败，请手动选择复制。"));return;}
    setSubmitError("");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function searchInbox(event: FormEvent) {
    event.preventDefault();
    if (!mailbox) return;
    const normalized = query.trim();
    setSubmittedQuery(normalized);
    void loadMessages(1, normalized);
  }

  function closeMessage() {
    messageRequestRef.current += 1;
    setSelectedMessage(null);
    setMessageLoading(false);
    setMessageError("");
  }

  async function openMessage(item: MailItem) {
    const requestId = messageRequestRef.current + 1;
    messageRequestRef.current = requestId;
    setSelectedMessage({ ...item, content_type: "", body_text: "" });
    setMessageLoading(true);
    setMessageError("");
    try {
      const response = await fetch("/api/user/messages/read", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.message || t("邮件读取失败。"));
      if (messageRequestRef.current !== requestId) return;
      setSelectedMessage(result.result);
      setMailItems((items) => items.map((message) => message.id === item.id ? { ...message, is_read: true } : message));
    } catch (error) {
      if (messageRequestRef.current === requestId) {
        setMessageError(error instanceof Error ? error.message : t("邮件读取失败。"));
      }
    } finally {
      if (messageRequestRef.current === requestId) setMessageLoading(false);
    }
  }

  return (
    <>
      {selectionError&&<p className="mailbox-list-notice" role="alert">{t(selectionError)} <a href="/user/mailboxes.cgi">{t("返回邮箱列表")}</a></p>}
      <section className="mailer-builder" aria-label={t("申请信息")}>
        <form
          className="application-panel"
          noValidate
          onSubmit={requestConfirm}
        >
          <div className="section-heading">
            <span>{t("申请信息")}</span>
          </div>
          <div className="field-block">
            <div className="field-label">
              <label htmlFor="mailboxPrefix">{t("邮箱名称")}</label>
              <a
                className="random-address-link"
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  randomize();
                }}
              >{t("随机生成")}</a>
            </div>
            <div className="address-input">
              <input
                id="mailboxPrefix"
                name="mailboxPrefix"
                type="text"
                placeholder={t("等待生成")}
                value={name}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setName(event.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))
                }
              />
              <span>@</span>
              <div
                className={`domain-picker${domainOpen ? " is-open" : ""}`}
                ref={pickerRef}
              >
                <button
                  className="domain-toggle"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={domainOpen}
                  onClick={() => setDomainOpen(!domainOpen)}
                >
                  <span>{domain}</span>
                  <i aria-hidden="true"></i>
                </button>
                <div
                  className="domain-options"
                  role="listbox"
                  hidden={!domainOpen}
                  aria-label={t("收信域名")}
                >
                  {domains.map((item) => {
                    const type =
                      item.kind === "MEMBER"
                        ? "member"
                        : item.kind === "LOGIN" || item.kind === "PRIVATE"
                          ? "login"
                          : "free";
                    const access =
                      item.kind === "MEMBER"
                        ? t("会员专用")
                        : item.kind === "PRIVATE"
                          ? t("我的私有域名")
                          : item.kind === "LOGIN"
                            ? t("可用域名")
                            : t("免费邮箱");
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={domain === item.domain}
                        key={item.domain}
                        onClick={() => {
                          if (item.kind === "MEMBER" && !isMember) {
                            setDomainOpen(false);
                            (
                              document.querySelector(
                                "[data-vip-open]",
                              ) as HTMLButtonElement
                            )?.click();
                            return;
                          }
                          setDomain(item.domain);
                          setDomainOpen(false);
                        }}
                      >
                        <span className="domain-option-copy">
                          <strong>{item.domain}</strong>
                          <small className={`domain-access-${type}`}>
                            {access}
                          </small>
                        </span>
                        <i aria-hidden="true"></i>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <fieldset className="duration-field">
            <legend>{t("有效时长")}</legend>
            <div className="duration-grid">
              {plans.map((item) => (
                <label className="duration-option" key={item.id}>
                  <input
                    type="radio"
                    name="duration"
                    checked={plan === item.id}
                    onChange={() => setPlan(item.id)}
                  />
                  <span className="duration-card">
                    <strong className="duration-name">{t(item.label)}</strong>
                    <span className="duration-price-stack">
                      <span
                        className={
                          item.points
                            ? "duration-standard-price"
                            : "duration-free-price"
                        }
                      >
                        {item.points ? t("{0} 积分",item.points) : t("免费")}
                      </span>
                      {item.points ? (
                        <em className="duration-member-price">{t("会员价")}{" "}
                          {discountedMailboxPrice(item.points, memberPreviewDiscountPercent)}{" "}{t("积分")}</em>
                      ) : (
                        <span className="duration-price-placeholder"></span>
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="application-actions">
            <button
              type="button"
              className="random-application"
              onClick={randomize}
            >
              <span
                className="random-application-icon"
                aria-hidden="true"
              ></span>{t("随机生成邮箱")}</button>
            <button
              type="submit"
              className="primary-action"
              disabled={!domains.length}
            >
              <span>{t("确认申请")}</span>
              <i aria-hidden="true">→</i>
            </button>
          </div>
          <p className={`form-status${randomError ? " is-error" : ""}`} role="status">
            {randomError
              ? randomError
              : !domains.length
              ? t("管理员尚未启用可收信域名")
              : showingCurrentMailbox
                ? t(mailbox?.available===false?"暂停收信，请联系管理员":"邮箱已启用，可以开始收信")
                : address
                  ? ""
                : t("请点击随机生成邮箱")}
          </p>
        </form>
        <aside className="preview-panel">
          <div className="preview-topline">
            <span>{t("申请预览")}</span>
            <i>{showingCurrentMailbox ? t(mailbox?.available===false?"暂停收信":"收信中") : t("预览")}</i>
          </div>
          <p>{showingCurrentMailbox ? t("当前收信地址") : t("待申请邮箱地址")}</p>
          <div className="preview-address">
            <strong>{displayAddress || t("请点击随机生成邮箱")}</strong>
            <button
              type="button"
              disabled={!displayAddress}
              aria-label={t("复制完整邮箱地址")}
              onClick={copyAddress}
            >
              <span className={copied ? "copy-success-mark" : ""}>
                {copied ? "✓" : ""}
              </span>
            </button>
          </div>
          <dl>
            <div>
              <dt>{t("有效时长")}</dt>
              <dd>{showingCurrentMailbox ? t("{0} 分钟",mailbox!.duration_minutes) : selected?.label || t("未配置")}</dd>
            </div>
            <div>
              <dt>{t("收信状态")}</dt>
              <dd>
                <span className="ready-dot"></span>{showingCurrentMailbox ? t(mailbox?.available===false?"暂停收信":"收信中") : t("申请后启用")}
              </dd>
            </div>
            <div>
              <dt>{t(showingCurrentMailbox?"下次申请积分":"所需积分")}</dt>
              <dd>{actualPoints}{t("积分")}</dd>
            </div>
            <div>
              <dt>{t("当前积分")}</dt>
              <dd>{pointsBalance}{t("积分")}</dd>
            </div>
          </dl>
          <div className="preview-recharge">
            <a className="recharge-mini" href="/user/recharge.cgi">{t("积分充值")}</a>
          </div>
        </aside>
      </section>

      <section className="inbox-preview">
        <div className="inbox-header">
          <div>
            <span className="section-kicker">{t("收件箱")}</span>
            <h2>{t("收件箱")}</h2>
            <p>{t("创建邮箱后，收到的邮件会自动显示在这里。")}</p>
          </div>
          <div className="inbox-waiting">
            <i aria-hidden="true"></i>
            <span>{t("等待新邮件")}</span>
          </div>
          <button
            type="button"
            className="refresh-button"
            disabled={!mailbox || inboxLoading || refreshCooldown > 0}
            aria-label={t("刷新")}
            onClick={refreshInbox}
          >
            {refreshCooldown > 0 ? `${refreshCooldown}s` : <><span aria-hidden="true"></span>{t("刷新")}</>}
          </button>
        </div>
        <div className="inbox-tools">
          <form
            className="inbox-search"
            role="search"
            onSubmit={searchInbox}
          >
            <div className="inbox-search-field">
              <input
                id="inboxKeyword"
                type="search"
                maxLength={100}
                placeholder={t("搜索发件人或主题")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t("搜索发件人或主题")}
              />
              <button type="submit" disabled={!mailbox || inboxLoading}>{t("搜索")}</button>
            </div>
          </form>
        </div>
        {mailbox && <div className="inbox-columns">
          <span>{t("发件人")}</span><span>{t("主题")}</span><span>{t("关键信息")}</span><span>{t("收信时间")}</span><span>{t("操作")}</span>
        </div>}
        {mailItems.length > 0 && <div className="inbox-list">
          {mailItems.map((item) => <button className="inbox-message-row" type="button" key={item.id} onClick={() => void openMessage(item)}>
            <span className="inbox-message-sender" title={item.sender}><i aria-hidden="true">{String(item.sender || t("邮")).trim().charAt(0).toUpperCase()}</i><b>{item.sender}</b></span>
            <span className="inbox-message-subject" title={item.subject || t("（无主题）")}><b>{item.subject || t("（无主题）")}</b><small>{item.is_read ? t("已读") : t("未读")}</small></span>
            <span>—</span><time>{formatTime(item.received_at)}</time><span className="inbox-message-open">{t("查阅邮件")}</span>
          </button>)}
        </div>}
        {!mailItems.length && <div className="inbox-empty">{inboxLoading ? t("正在刷新…") : inboxStatus || t("暂无数据")}</div>}
        <nav className="inbox-pagination" aria-label={t("收件箱")}>
          <span className="inbox-count">{t("共")}{total}{t("条，每页 10 条")}</span>
          <button type="button" disabled={!mailbox || inboxLoading || page <= 1} onClick={() => void loadMessages(page - 1, submittedQuery)}>{t("上一页")}</button>
          <span>{t("第")}{page} / {pages}{t("页")}</span>
          <button type="button" disabled={!mailbox || inboxLoading || page >= pages} onClick={() => void loadMessages(page + 1, submittedQuery)}>{t("下一页")}</button>
        </nav>
      </section>

      {selectedMessage && <MailReader key={selectedMessage.id} message={selectedMessage} loading={messageLoading} error={messageError} onClose={closeMessage}/>}

      {confirmOpen && selected && (
        <div className="score-confirm">
          <button
            className="score-confirm-backdrop"
            type="button"
            disabled={submitting}
            onClick={() => setConfirmOpen(false)}
            aria-label={t("关闭")}
          ></button>
          <section
            className="score-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scoreConfirmTitle"
          >
            <div className="score-confirm-head">
              <div>
                <p>{t("人机验证")}</p>
                <h2 id="scoreConfirmTitle">{t("确认申请")}</h2>
              </div>
              <button
                className="score-confirm-close"
                type="button"
                disabled={submitting}
                onClick={() => setConfirmOpen(false)}
                aria-label={t("关闭")}
              >
                ×
              </button>
            </div>
            {captchaEnabled && turnstileConfigured && (
              <div className="score-confirm-captcha">
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="member_mailbox"
                  theme="light"
                  size="normal"
                  responsive
                  language="zh-cn"
                  resetKey={captchaResetKey}
                  ariaLabel={t("人机验证")}
                  onVerify={(token) => {
                    setTurnstileToken(token);
                    setCaptchaError("");
                  }}
                  onExpire={() => {
                    setTurnstileToken("");
                    setCaptchaError(t("验证已过期，请重新完成验证。"));
                  }}
                  onError={() => {
                    setTurnstileToken("");
                    setCaptchaError(t("人机验证暂时不可用，请稍后重试。"));
                  }}
                />
              </div>
            )}
            {captchaError && <p className="turnstile-inline-error" role="status">{captchaError}</p>}
            {submitError && <p className="score-confirm-error" role="alert">{submitError}</p>}
            <div className={`score-confirm-actions${captchaEnabled && !turnstileToken ? " is-waiting" : ""}`}>
              <button
                type="button"
                className="score-confirm-cancel"
                disabled={submitting}
                onClick={() => setConfirmOpen(false)}
              >{t("取消")}</button>
              {(!captchaEnabled || turnstileToken) && (
                <button
                  type="button"
                  className="score-confirm-submit"
                  disabled={submitting}
                  onClick={finish}
                >
                  {submitting ? t("正在申请…") : t("确认申请")}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
