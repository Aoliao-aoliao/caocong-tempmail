import AuditRetentionControls from './AuditRetentionControls';
import AdminUpdates from './AdminUpdates';
import TransactionReceipt from './TransactionReceipt';
import TelegramSettings from './TelegramSettings';
import NodelocOAuthSettings from './NodelocOAuthSettings';
import { AdminTabNav, AdminTabPanel, useAdminTabs } from "./AdminTabs";
import PasswordMailSettings from "./PasswordMailSettings";
import GmpayPaymentStatus from './GmpayPaymentStatus';
import NodelocPaymentSettings from './NodelocPaymentSettings';
import '../styles/nodeloc-payment.css';
import { serializeCsv } from "../lib/csv.mjs";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import TurnstileWidget from "./TurnstileWidget";
import AdminServiceStatus from "./AdminServiceStatus";

export type AdminView =
  | "overview"
  | "users"
  | "memberships"
  | "mailboxes"
  | "messages"
  | "domains"
  | "orders"
  | "commerce"
  | "transactions"
  | "api"
  | "security"
  | "settings"
  | "audit";

type TurnstileSecurity = {
  turnstileCanManage: boolean;
  turnstileConfigured: boolean;
  turnstileSource: "database" | "environment" | "none" | "invalid";
  turnstileSiteKey: string;
  turnstileAllowedHostnames: string[];
  turnstileSecretConfigured: boolean;
  turnstileTimeoutMs: number;
  turnstileEnvironmentOverride: boolean;
  turnstileReadyForTest: boolean;
  turnstileVerifiedAt: string | null;
};
type AdminSecurityData = Pick<TurnstileSecurity, "turnstileConfigured"> &
  Partial<Omit<TurnstileSecurity, "turnstileConfigured">>;

type AdminData = {
  pagination?: Record<string,{page:number;pages:number;total:number;pageSize:number}>;
  security: AdminSecurityData;
  counts: Record<string, number>;
  users: any[];
  mailboxes: any[];
  messages: any[];
  domains: any[];
  domainDns?: { expectedMx: string; intervalMinutes: number };
  orders: any[];
  transactions: any[];
  plans: any[];
  apiKeys: any[];
  rechargePlans: any[];
  paymentChannels: any[];
  audit: any[];
  settings: Record<string, string>;
};
const emptySecurity: TurnstileSecurity = {
  turnstileCanManage: false,
  turnstileConfigured: false,
  turnstileSource: "none",
  turnstileSiteKey: "",
  turnstileAllowedHostnames: [],
  turnstileSecretConfigured: false,
  turnstileTimeoutMs: 6000,
  turnstileEnvironmentOverride: false,
  turnstileReadyForTest: false,
  turnstileVerifiedAt: null,
};
const emptyData: AdminData = {
  security: emptySecurity,
  counts: {},
  users: [],
  mailboxes: [],
  messages: [],
  domains: [],
  domainDns: { expectedMx: "mx.example.com", intervalMinutes: 15 },
  orders: [],
  transactions: [],
  plans: [],
  apiKeys: [],
  rechargePlans: [],
  paymentChannels: [],
  audit: [],
  settings: {},
};
const n = (value: number | undefined) =>
  Number(value || 0).toLocaleString("zh-CN");
const money = (cents: number | undefined) =>
  `$${(Number(cents || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const appAlert = (message: string, title = "操作提示") =>
  (window as any).NodeMailDialog?.alert(message, { title }) ?? Promise.resolve();
const appConfirm = (message: string, options: Record<string, string> = {}) =>
  (window as any).NodeMailDialog?.confirm(message, options) ?? Promise.resolve(false);
const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "—";
const size = (bytes: number | undefined) =>
  Number(bytes || 0) < 1024
    ? `${n(bytes)} B`
    : `${(Number(bytes) / 1024).toFixed(1)} KB`;
const emptyRow = (columns: number, text = "暂无真实数据") => (
  <tr>
    <td colSpan={columns}>
      <div className="admin-table-empty">{text}</div>
    </td>
  </tr>
);
const roleText = (row: any) =>
  row.role === "SUPER_ADMIN"
    ? "超级管理员"
    : row.role === "ADMIN"
      ? "管理员"
      : row.is_member
        ? "VIP 会员"
        : "普通用户";
const userState = (value: string) =>
  value === "ACTIVE" ? "正常" : value === "RESTRICTED" ? "限制" : "停用";
const mailboxState = (value: string) =>
  value === "ACTIVE"
    ? "收信中"
    : value === "PAUSED"
      ? "已暂停"
      : value === "EXPIRED"
        ? "已过期"
        : "已隐藏";
const domainKind = (value: string) =>
  value === "RELAY"
    ? "中继邮箱域名"
    : value === "PRIVATE"
    ? "用户私有域名"
    : value === "MEMBER"
      ? "会员域名"
      : value === "LOGIN"
        ? "登录域名"
        : "公共域名";
const domainState = (value: string) =>
  value === "ACTIVE"
    ? "启用"
    : value === "PENDING"
      ? "审核中"
      : value === "REJECTED"
        ? "已拒绝"
        : "停用";
const mxState = (value: string) =>
  value === "ACTIVE"
    ? "正常"
    : value === "PENDING"
      ? "待检测"
      : value === "MISMATCH"
        ? "指向错误"
        : value === "NOT_FOUND"
          ? "未找到记录"
          : "查询暂不可用";
const orderState = (value: string) =>
  value === "PAID"
    ? "已完成"
    : value === "PENDING"
      ? "待确认"
      : value === "FAILED"
        ? "失败"
        : value === "EXPIRED"
          ? "已过期"
          : "已关闭";
const transactionType = (value: string) =>
  ({
    REGISTER_BONUS: "注册赠送",
    RECHARGE: "充值到账",
    MAILBOX_PURCHASE: "购买邮箱",
    MEMBERSHIP_PURCHASE: "购买会员",
    REFUND: "退款",
    ADMIN_ADJUSTMENT: "人工调整",
  })[value] || value;

function PageHead({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <header className="admin-page-head">
      <div>
        <small>{eyebrow}</small>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}
function Badge({
  children,
  tone = "good",
}: {
  children: ReactNode;
  tone?: "good" | "warn" | "bad" | "muted" | "info";
}) {
  return <span className={`admin-badge ${tone}`}>{children}</span>;
}
function Stats({ items }: { items: Array<[string, string, string, string]> }) {
  return (
    <section className="admin-stats">
      {items.map(([label, value, note, mark]) => (
        <article key={label}>
          <div>
            <span>{label}</span>
            <i>{mark}</i>
          </div>
          <strong>{value}</strong>
          <small>{note}</small>
        </article>
      ))}
    </section>
  );
}
function Toolbar({
  query,
  setQuery,
  children,
}: {
  query: string;
  setQuery: (v: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="admin-toolbar">
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索关键词"
          aria-label="搜索关键词"
        />
        <button type="submit">搜索</button>
      </form>
      {children}
    </div>
  );
}
function Table({ heads, children }: { heads: string[]; children: ReactNode }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function useAdminPage(section: string, data: AdminData, query = "", status = "全部", mapRow: (row:any)=>any = row=>row) {
  const mapper=useRef(mapRow);mapper.current=mapRow;
  const [rows,setRows]=useState<any[]>(()=>((data as any)[section]||[]).map(mapRow));
  const [page,setPage]=useState(1);
  const [revision,setRevision]=useState(0);
  const normalizedQuery=query.trim();
  const [meta,setMeta]=useState(data.pagination?.[section]||{page:1,pages:1,total:rows.length,pageSize:20});
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>setPage(1),[normalizedQuery,status]);
  useEffect(()=>{
    const controller=new AbortController();
    setBusy(true);setError("");
    const timer=window.setTimeout(async()=>{
      try {
        const response=await fetch(`/api/admin/list?${new URLSearchParams({section,page:String(page),q:normalizedQuery,status})}`,{credentials:"same-origin",signal:controller.signal,cache:"no-store"});
        const result=await response.json();
        if(!response.ok||!result.ok) throw new Error(result.message||"列表读取失败。");
        if(controller.signal.aborted)return;
        setRows(result.rows.map(mapper.current));setMeta(result.pagination);
        if(result.pagination.page!==page)setPage(result.pagination.page);
      }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"列表读取失败。");}
      finally{if(!controller.signal.aborted)setBusy(false);}
    },200);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[section,page,normalizedQuery,status,revision]);
  return {rows,setRows,refresh:()=>setRevision(value=>value+1),pagination:{count:meta.total,page:meta.page,pages:meta.pages,onPage:setPage,busy,error}};
}
function Pagination({ count, page, pages, onPage, busy, error }: {count:number;page:number;pages:number;onPage:(page:number)=>void;busy:boolean;error:string}) {
  return <footer className="admin-pagination">
    <span>共 {count} 条，每页 20 条</span>
    <button type="button" disabled={busy||page<=1} onClick={()=>onPage(page-1)}>上一页</button>
    <b>第 {page} / {pages} 页</b>
    <button type="button" disabled={busy||page>=pages} onClick={()=>onPage(page+1)}>下一页</button>
    {error&&<span role="alert">{error}</span>}
  </footer>;
}

function Panel({
  title,
  copy,
  action,
  children,
}: {
  title: string;
  copy?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="admin-panel">
      <header>
        <div>
          <h2>{title}</h2>
          {copy && <p>{copy}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Commerce({ data }: { data: AdminData }) {
  const [section,setSection] = useState("nodeloc");
  const [recharge, setRecharge] = useState(data.rechargePlans);
  const [savedRecharge,setSavedRecharge] = useState(data.rechargePlans);
  const [channels, setChannels] = useState(data.paymentChannels);
  async function savePlan(plan: any) {
    try {
      await postJson("/api/admin/control", {
        action: "recharge-plan",
        code: plan.code,
        points: Number(plan.points),
        amountUsdCents: Number(plan.amount_usd_cents),
        enabled: Boolean(plan.enabled),
      });
      setSavedRecharge(items=>items.map(item=>item.code===plan.code?{...plan}:item));
      void appAlert("充值档位已保存。", "保存成功");
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  async function saveChannel(channel: any) {
    try {
      await postJson("/api/admin/control", {
        action: "payment-channel",
        code: channel.code,
        label: channel.label,
        enabled: Boolean(channel.enabled),
      });
      void appAlert("支付渠道已保存。", "保存成功");
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="RECHARGE CONFIG"
        title="充值配置"
        copy="充值档位和支付渠道与用户端实时同步。"
      />
      <nav className="admin-recharge-tabs" aria-label="充值配置分区">
        {[["nodeloc","NodeLoc 支付"],["gmpay","USDT 支付"],["plans","充值档位"],["channels","其他渠道"]].map(([key,label])=><button key={key} type="button" aria-pressed={section===key} onClick={()=>setSection(key)}>{label}</button>)}
        <a href="/admin/orders.cgi">查询充值订单 →</a>
      </nav>
      <div hidden={section!=="plans"}>
      <Panel title="充值档位" copy="修改积分或美元价格后，请保存对应档位；NodeLoc 能量价格在支付分区设置。">
        <div className="admin-config-list">
          {recharge.map((item, index) => (
            <div className="admin-config-row" key={item.code}>
              <strong>{item.code}</strong>
              <label>
                积分
                <input
                  type="number"
                  min="1"
                  value={item.points}
                  onChange={(e) =>
                    setRecharge((v) =>
                      v.map((x, i) =>
                        i === index
                          ? { ...x, points: Number(e.target.value) }
                          : x,
                      ),
                    )
                  }
                />
              </label>
              <label>
                美分
                <input
                  type="number"
                  min="1"
                  value={item.amount_usd_cents}
                  onChange={(e) =>
                    setRecharge((v) =>
                      v.map((x, i) =>
                        i === index
                          ? { ...x, amount_usd_cents: Number(e.target.value) }
                          : x,
                      ),
                    )
                  }
                />
              </label>
              <label className="admin-mini-switch">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(e) =>
                    setRecharge((v) =>
                      v.map((x, i) =>
                        i === index ? { ...x, enabled: e.target.checked } : x,
                      ),
                    )
                  }
                />
                启用
              </label>
              <button type="button" onClick={() => savePlan(item)}>
                保存
              </button>
            </div>
          ))}
        </div>
      </Panel>
      </div>
      <div hidden={section!=="nodeloc"}><NodelocPaymentSettings plans={savedRecharge} /></div>
      <div hidden={section!=="gmpay"}><GmpayPaymentStatus /></div>
      <div hidden={section!=="channels"}>
      <Panel title="其他支付接口" copy="支付宝、微信及其他加密渠道尚未接入；USDT / TRC20 在专用分区配置">
        <div className="admin-payment-notice"><strong>暂不支持在线付款与自动到账</strong><p>下方设置只控制充值档位和渠道展示，不是商户接口配置。接入支付平台后，才可生成真实支付链接或二维码并自动核验到账。</p><p>接口接入需要平台名称、接口文档和商户配置；请勿把商户密钥填入渠道名称。现有订单仍可在订单管理中核对处理。</p></div>
      </Panel>
      <Panel title="支付渠道" copy="仅控制渠道展示；关闭后用户端隐藏，不代表支付接口已接通">
        <div className="admin-config-list">
          {channels.map((item, index) => ({item,index})).filter(({item})=>!(item.mode==='CRYPTO'&&item.token==='USDT'&&(item.code==='USDT_TRC20'||['TRC20','TRON'].includes(String(item.network).toUpperCase())))).map(({item,index}) => (
            <div className="admin-config-row" key={item.code}>
              <code>{item.code}</code>
              <input
                value={item.label}
                onChange={(e) =>
                  setChannels((v) =>
                    v.map((x, i) =>
                      i === index ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
              />
              <label className="admin-mini-switch">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(e) =>
                    setChannels((v) =>
                      v.map((x, i) =>
                        i === index ? { ...x, enabled: e.target.checked } : x,
                      ),
                    )
                  }
                />
                启用
              </label>
              <button type="button" onClick={() => saveChannel(item)}>
                保存
              </button>
            </div>
          ))}
        </div>
      </Panel>
      </div>
    </>
  );
}

async function postJson(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok)
    throw new Error(result.message || "操作失败，请稍后重试。");
  return result;
}

function UserPointsEditor({
  user,
  plans,
  onClose,
  onSaved,
}: {
  user: any;
  plans: any[];
  onClose: () => void;
  onSaved: (change: any) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [role, setRole] = useState(user.role);
  const [accountStatus, setAccountStatus] = useState(user.status);
  const [planCode, setPlanCode] = useState(plans[0]?.code || "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function points(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const response = await postJson("/api/admin/users/points", {
        publicId: user.id,
        amount: Number(amount),
        reason,
      });
      onSaved({ score: response.result.pointsBalance });
      setStatus("积分调整成功。");
      setAmount("");
      setReason("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "积分调整失败。");
    } finally {
      setBusy(false);
    }
  }
  async function access() {
    setBusy(true);
    setStatus("");
    try {
      const response = await postJson("/api/admin/control", {
        action: "user-access",
        publicId: user.id,
        role,
        status: accountStatus,
      });
      onSaved({
        role: response.result.role,
        status: response.result.status,
        roleText: roleText({ ...user, ...response.result }),
        state: userState(response.result.status),
      });
      setStatus("账户权限与状态已保存。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  async function membership(mode: "GRANT" | "CANCEL") {
    if (mode === "CANCEL" && !(await appConfirm("确定取消该用户当前会员吗？", { title: "取消会员", confirmText: "确认取消", tone: "danger" }))) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await postJson("/api/admin/control", {
        action: "user-membership",
        publicId: user.id,
        planCode,
        mode,
      });
      onSaved({
        is_member: response.result.is_member,
        roleText: roleText({ ...user, is_member: response.result.is_member }),
      });
      setStatus(mode === "GRANT" ? `会员已开通，剩余时长已保留，到期时间 ${new Date(response.result.membership_expires_at).toLocaleString()}。` : "会员已取消。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "会员操作失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-drawer">
      <button className="admin-drawer-backdrop" onClick={onClose}></button>
      <aside>
        <header>
          <div>
            <small>USER CONTROL</small>
            <h2>{user.email}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <dl>
          <div>
            <dt>用户 ID</dt>
            <dd>{user.id}</dd>
          </div>
          <div>
            <dt>当前积分</dt>
            <dd>{n(user.score)}</dd>
          </div>
        </dl>
        <div className="admin-edit-form">
          <div className="admin-inline-fields">
            <label>
              账户角色
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="USER">普通用户</option>
                <option value="ADMIN">管理员</option>
                <option value="SUPER_ADMIN">超级管理员</option>
              </select>
            </label>
            <label>
              账户状态
              <select
                value={accountStatus}
                onChange={(e) => setAccountStatus(e.target.value)}
              >
                <option value="ACTIVE">正常</option>
                <option value="RESTRICTED">限制</option>
                <option value="DISABLED">停用</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className="admin-secondary"
            disabled={busy}
            onClick={access}
          >
            保存账户权限
          </button>
        </div>
        <div className="admin-edit-form">
          <label>
            会员套餐
            <select
              value={planCode}
              onChange={(e) => setPlanCode(e.target.value)}
            >
              {plans.map((plan) => (
                <option value={plan.code}>{plan.name}</option>
              ))}
            </select>
          </label>
          <div className="admin-inline-fields">
            <button
              type="button"
              className="admin-primary"
              disabled={busy || !planCode}
              onClick={() => membership("GRANT")}
            >
              开通/续设会员
            </button>
            <button
              type="button"
              className="admin-secondary"
              disabled={busy || !user.is_member}
              onClick={() => membership("CANCEL")}
            >
              取消会员
            </button>
          </div>
        </div>
        <form className="admin-edit-form" onSubmit={points}>
          <label>
            积分变动
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="增加填正数，扣除填负数"
              required
            />
          </label>
          <label>
            调整原因
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={2}
              maxLength={500}
              required
            />
          </label>
          {status && <output className="admin-form-status">{status}</output>}
          <div className="admin-drawer-actions">
            <button type="button" className="admin-secondary" onClick={onClose}>
              关闭
            </button>
            <button type="submit" className="admin-primary" disabled={busy}>
              {busy ? "保存中…" : "确认调整积分"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function MembershipPlanEditor({
  plan,
  onClose,
  onSaved,
}: {
  plan: any;
  onClose: () => void;
  onSaved: (plan: any) => void;
}) {
  const [form, setForm] = useState({
    durationDays: String(plan.duration_days),
    pricePoints: String(plan.price_points),
    discountPercent: String(plan.mailbox_discount_percent),
    apiLimitMultiplier: String(plan.api_limit_multiplier),
    enabled: Boolean(plan.enabled),
  });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form) => (event: any) =>
    setForm((value) => ({
      ...value,
      [key]: key === "enabled" ? event.target.checked : event.target.value,
    }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const response = await postJson("/api/admin/membership-plans/update", {
        code: plan.code,
        durationDays: Number(form.durationDays),
        pricePoints: Number(form.pricePoints),
        discountPercent: Number(form.discountPercent),
        retentionDays: Number(plan.message_retention_days),
        apiLimitMultiplier: Number(form.apiLimitMultiplier),
        enabled: form.enabled,
      });
      onSaved({ ...plan, ...response.result });
      setStatus("套餐已保存并立即生效。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "套餐保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-drawer">
      <button
        className="admin-drawer-backdrop"
        onClick={onClose}
        aria-label="关闭"
      ></button>
      <aside>
        <header>
          <div>
            <small>MEMBERSHIP PLAN</small>
            <h2>{plan.name}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <form className="admin-edit-form" onSubmit={submit}>
          <div className="admin-inline-fields">
            <label>
              有效期（天）
              <input
                type="number"
                min="1"
                max="3650"
                value={form.durationDays}
                onChange={field("durationDays")}
                required
              />
            </label>
            <label>
              所需积分
              <input
                type="number"
                min="1"
                value={form.pricePoints}
                onChange={field("pricePoints")}
                required
              />
            </label>
          </div>
          <div className="admin-inline-fields">
            <label>
              邮箱折扣（%）
              <input
                type="number"
                min="1"
                max="100"
                value={form.discountPercent}
                onChange={field("discountPercent")}
                required
              />
            </label>
            <p className="admin-retention-note">邮件跟随邮箱有效期保存；邮箱到期后，网站邮件会清理。套餐中的旧保留天数字段不参与清理。</p>
          </div>
          <label>
            API 限额倍数
            <input
              type="number"
              min="1"
              max="1000"
              value={form.apiLimitMultiplier}
              onChange={field("apiLimitMultiplier")}
              required
            />
          </label>
          <label className="admin-switch-field">
            <span>
              <strong>允许销售</strong>
              <small>关闭后前台不得购买此套餐</small>
            </span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={field("enabled")}
            />
          </label>
          {status && <output className="admin-form-status">{status}</output>}
          <div className="admin-drawer-actions">
            <button type="button" className="admin-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="admin-primary" disabled={busy}>
              {busy ? "保存中…" : "保存套餐"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function Overview({ data }: { data: AdminData }) {
  const [active, setActive] = useAdminTabs("service");

  const c = data.counts;
  return (
    <>
      <PageHead
        eyebrow="ADMIN OVERVIEW"
        title="运营概览"
        copy="集中查看账户、邮箱、邮件、收入与系统状态。"
        action={
          <a className="admin-primary" href="/admin/settings.cgi">
            系统配置 <span>→</span>
          </a>
        }
      />
      <Stats
        items={[
          ["注册用户", n(c.users_total), `今日新增 ${n(c.users_today)}`, "↗"],
          [
            "有效邮箱",
            n(c.mailboxes_active),
            `邮箱总数 ${n(c.mailboxes_total)}`,
            "@",
          ],
          [
            "今日邮件",
            n(c.messages_today),
            `待检查 ${n(c.messages_risk)}`,
            "✉",
          ],
          [
            "今日收入",
            money(c.revenue_cents_today),
            `成功订单 ${n(c.orders_paid_today)}`,
            "$",
          ],
        ]}
      />
      <AdminTabNav
        scope="overview"
        tabs={[
          { id: "service", label: "服务状态" },
          { id: "pending", label: "待处理事项" },
          { id: "activity", label: "最近操作" },
        ]}
        active={active}
        onChange={setActive}
      />
      <AdminTabPanel scope="overview" id="service" active={active}>
        <Panel title="服务状态" copy="打开页面时检测，显示本次结果">
          <AdminServiceStatus />
        </Panel>
      </AdminTabPanel>
      <AdminTabPanel scope="overview" id="pending" active={active}>
        <Panel title="待处理事项" copy="来自数据库的实时数量">
          <div className="admin-task-list">
            <a href="/admin/domains.cgi">
              <span>{n(c.domains_pending)}</span>
              <strong>私有域名等待审核</strong>
              <b>处理 →</b>
            </a>
            <a href="/admin/messages.cgi">
              <span>{n(c.messages_risk)}</span>
              <strong>风险邮件等待检查</strong>
              <b>处理 →</b>
            </a>
            <a href="/admin/orders.cgi">
              <span>{n(c.orders_pending)}</span>
              <strong>充值订单等待确认</strong>
              <b>处理 →</b>
            </a>
          </div>
        </Panel>
      </AdminTabPanel>
      <AdminTabPanel scope="overview" id="activity" active={active}>
        <Panel title="最近操作" copy="管理员与系统关键事件">
          <div className="admin-activity">
            {data.audit.length ? (
              data.audit.slice(0, 5).map((item: any) => (
                <div key={item.id}>
                  <i>{item.actor === "system" ? "S" : "A"}</i>
                  <span>
                    <strong>{item.action}</strong>
                    <small>
                      {item.actor} · {item.entity_type}
                      {item.entity_id ? ` / ${item.entity_id}` : ""}
                    </small>
                  </span>
                  <time>{dateTime(item.created_at)}</time>
                </div>
              ))
            ) : (
              <div className="admin-empty-compact">暂无操作记录</div>
            )}
          </div>
        </Panel>
      </AdminTabPanel>
    </>
  );
}

function Users({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("全部");
  const [selected, setSelected] = useState<any | null>(null);
  const { rows: users, setRows: setUsers, pagination, refresh } = useAdminPage("users", data, query, status, (u: any) => ({
      ...u,
      roleText: roleText(u),
      state: userState(u.status),
      joined: dateTime(u.created_at),
    }));
  const list = users;
  return (
    <>
      <PageHead
        eyebrow="ACCOUNT MANAGEMENT"
        title="用户管理"
        copy="查询用户、账户状态、积分、会员和邮箱归属。"
      />
      <Stats
        items={[
          [
            "用户总数",
            n(data.counts.users_total),
            `今日新增 ${n(data.counts.users_today)}`,
            "人",
          ],
          ["VIP 会员", n(data.counts.members_active), "当前有效会员", "VIP"],
          ["受限账户", n(data.counts.users_restricted), "非正常状态账户", "!"],
          ["用户积分", n(data.counts.points_total), "全站可用余额", "分"],
        ]}
      />
      <Panel title="用户列表" copy="账户资料与使用情况">
        <Toolbar query={query} setQuery={setQuery}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>全部</option>
            <option>正常</option>
            <option>限制</option>
            <option>停用</option>
          </select>
        </Toolbar>
        <Table
          heads={[
            "用户 ID",
            "账户邮箱",
            "账户类型",
            "积分",
            "邮箱数",
            "状态",
            "注册时间",
            "操作",
          ]}
        >
          {list.length
            ? list.map((u) => (
                <tr key={u.id}>
                  <td>
                    <code>{u.id}</code>
                  </td>
                  <td>
                    <strong>{u.email}</strong>
                  </td>
                  <td>{u.roleText}</td>
                  <td>{n(u.score)}</td>
                  <td>{n(u.mailboxes)}</td>
                  <td>
                    <Badge tone={u.state === "正常" ? "good" : "bad"}>
                      {u.state}
                    </Badge>
                  </td>
                  <td>{u.joined}</td>
                  <td>
                    <div className="admin-row-actions">
                      <button onClick={() => setSelected(u)}>详情</button>
                    </div>
                  </td>
                </tr>
              ))
            : emptyRow(8)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
      {selected && (
        <UserPointsEditor
          user={selected}
          plans={data.plans}
          onClose={() => setSelected(null)}
          onSaved={(change) => {
            setUsers((items) =>
              items.map((item) =>
                item.id === selected.id ? { ...item, ...change } : item,
              ),
            );
            setSelected((item: any) => (item ? { ...item, ...change } : item));
            refresh();
          }}
        />
      )}
    </>
  );
}

function Mailboxes({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("全部");
  const { rows: rows, setRows: setRows, pagination, refresh } = useAdminPage("mailboxes", data, query, state, (x: any) => ({
      ...x,
      state: mailboxState(x.status),
      term: x.duration_minutes ? `${x.duration_minutes} 分钟` : "长期",
      expires: dateTime(x.expires_at),
    }));
  const [deletingId, setDeletingId] = useState("");
  const list = rows;
  async function change(x: any, status: string) {
    if (status === "EXPIRED" && x.status !== "EXPIRED" && !(await appConfirm(
      `将立即结束邮箱 ${x.address} 的有效期，并按到期规则清理邮件和附件。召回仅恢复地址，不恢复旧邮件。确定继续吗？`,
      { title: "立即到期", confirmText: "确认到期", tone: "danger" },
    ))) return;
    try {
      const r = await postJson("/api/admin/control", {
        action: "mailbox-status",
        publicId: x.id,
        status,
      });
      setRows((items) =>
        items.map((item) =>
          item.id === x.id
            ? { ...item, ...r.result, state: mailboxState(status), expires: dateTime(r.result.expires_at) }
            : item,
        ),
      );
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  async function removePermanently(x: any) {
    const confirmed = await appConfirm(
      `即将永久删除邮箱 ${x.address}。该邮箱、全部邮件和附件都会被清除，且无法通过召回恢复。确定继续吗？`,
      { title: "永久删除邮箱", confirmText: "永久删除", cancelText: "取消", tone: "danger" },
    );
    if (!confirmed) return;
    setDeletingId(x.id);
    try {
      await postJson("/api/admin/control", {
        action: "mailbox-delete-permanently",
        publicId: x.id,
      });
      setRows((items) => items.filter((item) => item.id !== x.id));
      void appAlert(`邮箱 ${x.address} 已永久删除。`, "删除完成");
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "永久删除失败。");
    } finally {
      setDeletingId("");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="MAILBOX SERVICE"
        title="邮箱管理"
        copy="状态修改会立即同步到用户端。"
      />
      <Stats
        items={[
          ["邮箱总数", n(data.counts.mailboxes_total), "数据库全部邮箱", "@"],
          ["正在收信", n(data.counts.mailboxes_active), "当前有效", "●"],
          ["即将到期", n(data.counts.mailboxes_expiring), "未来 24 小时", "⌛"],
          [
            "今日失效",
            n(data.counts.mailboxes_closed_today),
            "今日过期或隐藏",
            "✓",
          ],
        ]}
      />
      <Panel title="邮箱列表" copy="停用并隐藏可恢复；永久删除会清除邮箱、邮件和附件，仅超级管理员可执行">
        <Toolbar query={query} setQuery={setQuery}>
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option>全部</option>
            <option>收信中</option>
            <option>已暂停</option>
            <option>已过期</option>
            <option>已隐藏</option>
          </select>
        </Toolbar>
        <Table
          heads={[
            "邮箱 ID",
            "邮箱地址",
            "所属用户",
            "有效期",
            "收信数",
            "到期时间",
            "状态管理",
          ]}
        >
          {list.length
            ? list.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>
                    <strong>{x.address}</strong>
                  </td>
                  <td>{x.owner}</td>
                  <td>{x.term}</td>
                  <td>{n(x.received)}</td>
                  <td>{x.expires}</td>
                  <td>
                    <div className="admin-row-actions mailbox-admin-actions">
                      <select
                        value={x.status}
                        onChange={(e) => change(x, e.target.value)}
                        aria-label={`管理 ${x.address} 的状态`}
                      >
                        <option value="ACTIVE">收信中</option>
                        <option value="PAUSED">暂停收信</option>
                        <option value="EXPIRED">立即到期并清理</option>
                        <option value="DELETED">停用并隐藏</option>
                      </select>
                      <button
                        type="button"
                        className="admin-permanent-delete"
                        disabled={deletingId === x.id}
                        onClick={() => removePermanently(x)}
                      >
                        {deletingId === x.id ? "删除中…" : "永久删除"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            : emptyRow(7)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

function Messages({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState("全部");
  const { rows: rows, setRows: setRows, pagination, refresh } = useAdminPage("messages", data, query, risk, (x: any) => ({
      ...x,
      to: x.recipient,
      from: x.sender,
      size: size(x.size_bytes),
      risk:
        x.risk_status === "SAFE"
          ? "安全"
          : x.risk_status === "REVIEW"
            ? "待检查"
            : "已隔离",
      time: dateTime(x.received_at),
    }));
  const list = rows;
  const average = data.counts.messages_today
    ? data.counts.message_bytes_today / data.counts.messages_today
    : 0;
  async function change(x: any, riskStatus: string) {
    try {
      await postJson("/api/admin/control", {
        action: "message-risk",
        publicId: x.id,
        riskStatus,
      });
      setRows((items) =>
        items.map((item) =>
          item.id === x.id
            ? {
                ...item,
                risk_status: riskStatus,
                risk:
                  riskStatus === "SAFE"
                    ? "安全"
                    : riskStatus === "REVIEW"
                      ? "待检查"
                      : "已隔离",
              }
            : item,
        ),
      );
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="MESSAGE OPERATIONS"
        title="邮件管理"
        copy="风险状态会决定用户端是否可见。"
      />
      <Stats
        items={[
          ["今日接收", n(data.counts.messages_today), "今日实际入库", "封"],
          ["安全邮件", n(data.counts.messages_safe_today), "今日安全记录", "✓"],
          ["风险邮件", n(data.counts.messages_risk), "当前待检查或隔离", "!"],
          ["平均大小", size(average), "今日邮件平均值", "KB"],
        ]}
      />
      <Panel title="邮件记录" copy="仅展示必要摘要，不在列表暴露正文">
        <Toolbar query={query} setQuery={setQuery}>
          <select value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option>全部</option>
            <option>安全</option>
            <option>待检查</option>
            <option>已隔离</option>
          </select>
        </Toolbar>
        <Table
          heads={[
            "邮件 ID",
            "收件邮箱",
            "发件人",
            "主题",
            "大小",
            "风险管理",
            "收信时间",
          ]}
        >
          {list.length
            ? list.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>{x.to}</td>
                  <td>{x.from}</td>
                  <td className="admin-subject">{x.subject || "（无主题）"}</td>
                  <td>{x.size}</td>
                  <td>
                    <select
                      value={x.risk_status}
                      onChange={(e) => change(x, e.target.value)}
                    >
                      <option value="SAFE">安全</option>
                      <option value="REVIEW">待检查</option>
                      <option value="QUARANTINED">隔离</option>
                    </select>
                  </td>
                  <td>{x.time}</td>
                </tr>
              ))
            : emptyRow(7)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

function Domains({ data }: { data: AdminData }) {
  const [active, setActive] = useAdminTabs("list");

  const [query, setQuery] = useState("");
  const {
    rows: rows,
    setRows: setRows,
    pagination,
    refresh,
  } = useAdminPage("domains", data, query, "全部", (x: any) => ({
    ...x,
    kindText: domainKind(x.kind),
    mx: mxState(x.mx_status),
    mailboxes: x.mailbox_count,
    state: domainState(x.status),
  }));
  const [domain, setDomain] = useState("");
  const [kind, setKind] = useState("PUBLIC");
  const [checking, setChecking] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const expectedMx = data.domainDns?.expectedMx || "mx.example.com";
  const intervalMinutes = data.domainDns?.intervalMinutes || 15;
  const list = rows;
  async function change(x: any, field: string, value: string) {
    const next = {
      status: x.status,
      mxStatus: x.mx_status,
      kind: x.kind,
      [field]: value,
    };
    let ownershipVerified = false;
    if (
      next.kind === "PRIVATE" &&
      next.status === "ACTIVE" &&
      (x.kind !== "PRIVATE" || x.status !== "ACTIVE")
    ) {
      ownershipVerified = await appConfirm(
        "请先通过独立的域名控制证明核实所属用户，不能仅凭 MX 指向本站判断。已核实该用户确实拥有此域名，并批准启用？",
      );
      if (!ownershipVerified) return;
    }
    try {
      const r = await postJson("/api/admin/control", {
        action: "domain-update",
        ownershipVerified,
        domain: x.domain,
        ...next,
      });
      setRows((items) =>
        items.map((item) =>
          item.domain === x.domain
            ? {
                ...item,
                ...r.result,
                kindText: domainKind(r.result.kind),
                mx: mxState(r.result.mx_status),
                state: domainState(r.result.status),
              }
            : item,
        ),
      );
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await postJson("/api/admin/control", {
        action: "domain-create",
        domain,
        kind,
      });
      setRows((items) => [
        {
          ...r.result,
          kindText: domainKind(r.result.kind),
          mx: mxState(r.result.mx_status),
          mailboxes: 0,
          state: domainState(r.result.status),
        },
        ...items,
      ]);
      setDomain("");
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "添加失败。");
    }
  }
  function mergeResult(result: any) {
    setRows((items) =>
      items.map((item) =>
        item.domain === result.domain
          ? {
              ...item,
              ...result,
              mx: mxState(result.mx_status),
              state: domainState(result.status),
            }
          : item,
      ),
    );
  }
  async function checkDomain(value: string) {
    setChecking(value);
    try {
      const r = await postJson("/api/admin/control", {
        action: "domain-dns-check",
        domain: value,
      });
      mergeResult(r.result);
      void appAlert(
        r.result.mx_status === "ACTIVE"
          ? `${value} 的 MX 解析正确，系统已同步状态。`
          : `${value}：${r.result.mx_error || mxState(r.result.mx_status)}`,
        "DNS 检测结果",
      );
      refresh();
    } catch (error) {
      void appAlert(
        error instanceof Error ? error.message : "检测失败，请稍后重试。",
      );
    } finally {
      setChecking(null);
    }
  }
  async function checkAll() {
    setCheckingAll(true);
    try {
      const r = await postJson("/api/admin/control", {
        action: "domain-dns-check-all",
      });
      for (const result of r.result.results || []) mergeResult(result);
      const normal = (r.result.results || []).filter(
        (x: any) => x.mx_status === "ACTIVE",
      ).length;
      void appAlert(
        `已检测 ${r.result.checked} 个域名，其中 ${normal} 个解析正常。异常项已在列表中标明。`,
        "批量检测完成",
      );
      refresh();
    } catch (error) {
      void appAlert(
        error instanceof Error ? error.message : "批量检测失败，请稍后重试。",
      );
    } finally {
      setCheckingAll(false);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="DOMAIN CONTROL"
        title="域名管理"
        copy={`系统每 ${intervalMinutes} 分钟自动检查一次真实 MX，只有解析正常的域名才能提供收信。`}
        action={
          <button
            className="admin-secondary"
            disabled={checkingAll}
            onClick={checkAll}
          >
            {checkingAll ? "检测中…" : "检测全部域名"}
          </button>
        }
      />
      <Stats
        items={[
          ["公共域名", n(data.counts.domains_public), "已录入公共域名", "域"],
          ["私有域名", n(data.counts.domains_private), "用户绑定域名", "域"],
          ["待审核", n(data.counts.domains_pending), "需要人工确认", "!"],
          ["DNS 异常", n(data.counts.domains_dns_error), "解析状态异常", "MX"],
        ]}
      />
      <AdminTabNav
        scope="domains"
        tabs={[
          { id: "list", label: "域名列表" },
          { id: "add", label: "添加域名" },
          { id: "guide", label: "解析指南" },
        ]}
        active={active}
        onChange={setActive}
      />
      <AdminTabPanel scope="domains" id="list" active={active}>
        <Panel
          title="域名列表"
          copy="记录数包含已到期邮箱；中继域名请到“中继邮箱”维护。"
        >
          <Toolbar query={query} setQuery={setQuery} />
          <Table
            heads={[
              "域名",
              "类型",
              "所属用户",
              "MX 状态",
              "邮箱记录数",
              "服务状态",
            ]}
          >
            {list.length
              ? list.map((x) => (
                  <tr key={x.domain}>
                    <td>
                      <strong>{x.domain}</strong>
                    </td>
                    <td>
                      {x.kind === "RELAY" ? (
                        <Badge tone="good">中继</Badge>
                      ) : x.kind === "PRIVATE" ? (
                        <Badge tone={x.owner ? "info" : "bad"}>
                          {x.owner ? "私有" : "私有（缺少所属用户）"}
                        </Badge>
                      ) : (
                        <select
                          value={x.kind}
                          onChange={(e) => change(x, "kind", e.target.value)}
                        >
                          <option value="PUBLIC">免费</option>
                          <option value="LOGIN">登录用户</option>
                          <option value="MEMBER">会员</option>
                          {x.owner && <option value="PRIVATE">私有</option>}
                        </select>
                      )}
                    </td>
                    <td>
                      {x.owner ||
                        (x.kind === "PRIVATE" ? "未分配，不可启用" : "平台")}
                    </td>
                    <td>
                      {x.kind === "RELAY" ? (
                        <Badge tone="info">由中继服务管理</Badge>
                      ) : (
                        <div className="admin-domain-dns-cell">
                          <Badge
                            tone={
                              x.mx_status === "ACTIVE"
                                ? "good"
                                : x.mx_status === "PENDING" ||
                                    x.mx_status === "UNAVAILABLE"
                                  ? "warn"
                                  : "bad"
                            }
                          >
                            {mxState(x.mx_status)}
                          </Badge>
                          {x.status === "ACTIVE" &&
                            x.mx_status !== "ACTIVE" && (
                              <small className="bad">解析异常 / 暂停收信</small>
                            )}
                          <button
                            type="button"
                            disabled={checking === x.domain || checkingAll}
                            onClick={() => checkDomain(x.domain)}
                          >
                            {checking === x.domain ? "检测中…" : "立即检测"}
                          </button>
                          <small>上次检测：{dateTime(x.mx_checked_at)}</small>
                          {x.mx_records?.length > 0 && (
                            <small>
                              当前：
                              {x.mx_records
                                .map(
                                  (record: any) =>
                                    `${record.exchange} (${record.priority})`,
                                )
                                .join("、")}
                            </small>
                          )}
                          {x.mx_error && (
                            <small className="bad">{x.mx_error}</small>
                          )}
                        </div>
                      )}
                    </td>
                    <td>{n(x.mailboxes)}</td>
                    <td>
                      <select
                        value={x.status}
                        disabled={x.kind === "RELAY"}
                        title={
                          x.kind === "RELAY"
                            ? "请在中继邮箱管理中维护"
                            : undefined
                        }
                        onChange={(e) => change(x, "status", e.target.value)}
                      >
                        <option value="PENDING">审核中</option>
                        <option value="ACTIVE">启用</option>
                        <option value="DISABLED">停用</option>
                        <option value="REJECTED">拒绝</option>
                      </select>
                    </td>
                  </tr>
                ))
              : emptyRow(6)}
          </Table>
          <Pagination {...pagination} />
        </Panel>
      </AdminTabPanel>
      <AdminTabPanel scope="domains" id="add" active={active}>
        <Panel
          title="添加平台收信域名"
          copy="添加后系统会立即查询真实 MX；解析正确后自动启用并同步到用户端"
        >
          <form className="admin-quick-form" onSubmit={add}>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="mail.example.com"
              required
            />
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="PUBLIC">免费域名</option>
              <option value="LOGIN">登录用户域名</option>
              <option value="MEMBER">会员域名</option>
            </select>
            <button className="admin-primary">添加域名</button>
          </form>
        </Panel>
      </AdminTabPanel>
      <AdminTabPanel scope="domains" id="guide" active={active}>
        <section className="admin-domain-guide">
          <div className="admin-domain-guide-title">
            <span>DNS</span>
            <div>
              <strong>添加域名后怎么操作</strong>
              <small>系统会自动检测，不需要手工修改 MX 状态</small>
            </div>
          </div>
          <ol>
            <li>
              <b>添加域名</b>
              <span>先在下方录入需要用于收信的域名。</span>
            </li>
            <li>
              <b>添加 MX 记录</b>
              <span>
                在该域名的 DNS 服务商处添加：主机记录 <code>@</code>，记录值{" "}
                <code>{expectedMx}</code>，优先级 <code>10</code>。
              </span>
            </li>
            <li>
              <b>等待自动启用</b>
              <span>
                平台新域名会立即检测，并每 {intervalMinutes}{" "}
                分钟复检；私有域名须人工核实归属后启用。手动停用的域名不会自动恢复。
              </span>
            </li>
            <li>
              <b>异常保护</b>
              <span>
                已启用域名若 MX
                被删除或改错，会暂停收信；解析恢复后自动恢复收信，管理员手动停用的域名不会被恢复。DNS
                临时超时保留上次检测结果，不改变收信状态。
              </span>
            </li>
          </ol>
          <div className="admin-domain-target">
            <span>正确的 MX 目标</span>
            <code>{expectedMx}</code>
            <button
              type="button"
              onClick={() =>
                navigator.clipboard
                  .writeText(expectedMx)
                  .then(() => appAlert("MX 目标已复制。"))
              }
            >
              复制
            </button>
          </div>
          <p>
            使用 Cloudflare 时，MX 指向的主机必须能公开解析；
            <code>{expectedMx}</code> 对应的 A 记录应设为“仅
            DNS”，不要开启橙色代理。
          </p>
        </section>
      </AdminTabPanel>
    </>
  );
}

function Orders({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("全部");
  const { rows: orders, setRows: setOrders, pagination, refresh } = useAdminPage("orders", data, query, status, (x: any) => ({
      ...x,
      amount: x.order_type==='NODELOC'?`${n(x.energy)} 能量`:x.order_type==='GMPAY'&&x.actual_amount?`${x.actual_amount} USDT（${money(x.amount_usd_cents)}）`:money(x.amount_usd_cents),
      score: n(x.points),
      state: orderState(x.status),
      time: dateTime(x.created_at),
    }));
  const list = orders;
  const paid = data.counts.orders_paid_today;
  const rate = data.counts.orders_today
    ? `${((paid / data.counts.orders_today) * 100).toFixed(1)}%`
    : "0%";
  async function change(x: any, next: string) {
    if (
      next === "PAID" &&
      !(await appConfirm("确认到账会立即给用户增加积分，确定继续吗？", { title: "确认充值到账", confirmText: "确认到账" }))
    )
      return;
    try {
      await postJson("/api/admin/control", {
        action: "recharge-order",
        publicId: x.id,
        status: next,
      });
      setOrders((items) =>
        items.map((item) =>
          item.id === x.id
            ? { ...item, status: next, state: orderState(next) }
            : item,
        ),
      );
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="PAYMENT ORDERS"
        title="充值订单"
        copy="NodeLoc / USDT 订单由支付网关核验自动到账；其他订单可人工确认。"
      />
      <Stats
        items={[
          ["今日订单", n(data.counts.orders_today), `成功 ${n(paid)}`, "单"],
          [
            "今日收入",
            money(data.counts.revenue_cents_today),
            "其他渠道已支付美元，NodeLoc 能量另计",
            "$",
          ],
          ["待确认", n(data.counts.orders_pending), "等待支付确认", "!"],
          ["今日 NodeLoc", n(data.counts.nodeloc_energy_today), "已到账能量，单独统计", "能量"],
          ["到账率", rate, "按今日订单计算", "%"],
        ]}
      />
      <Panel title="订单列表" copy="支付与积分发放记录">
        <Toolbar query={query} setQuery={setQuery}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>全部</option>
            <option>待确认</option>
            <option>已完成</option>
            <option>已关闭</option>
            <option>已过期</option>
            <option>失败</option>
          </select>
        </Toolbar>
        <Table
          heads={[
            "订单号",
            "用户",
            "支付金额",
            "积分",
            "渠道",
            "状态管理",
            "创建时间",
          ]}
        >
          {list.length
            ? list.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>{x.user}</td>
                  <td>
                    <strong>{x.amount}</strong>
                  </td>
                  <td>{x.score}</td>
                  <td>{x.channel}</td>
                  <td>
                    <select
                      value={x.status}
                      disabled={x.status === "PAID" || ["NODELOC","GMPAY"].includes(x.order_type)}
                      onChange={(e) => change(x, e.target.value)}
                    >
                      <option value="PENDING">待确认</option>
                      <option value="PAID">确认到账</option>
                      <option value="CANCELLED">关闭</option>
                      <option value="EXPIRED">过期</option>
                      <option value="FAILED">失败</option>
                    </select>
                  </td>
                  <td>{x.time}</td>
                </tr>
              ))
            : emptyRow(7)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

function Transactions({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const {rows: serverRows,pagination}=useAdminPage("transactions",data,query);
  const all = serverRows.map((x) => [
    x.id,
    x.user,
    transactionType(x.type),
    `${x.amount > 0 ? "+" : ""}${n(x.amount)}`,
    [x.reference_id, x.note].filter(Boolean).join(" · ") || "系统",
    dateTime(x.created_at),
  ]);
  const rows = all;
  const issued = serverRows
    .filter((x) => x.amount > 0)
    .reduce((sum, x) => sum + x.amount, 0);
  const spent = Math.abs(
    serverRows
      .filter((x) => x.amount < 0)
      .reduce((sum, x) => sum + x.amount, 0),
  );
  const adjusted = serverRows.filter(
    (x) => x.type === "ADMIN_ADJUSTMENT",
  ).length;
  function exportCsv() {
    const content = serializeCsv([
      ["流水号","用户","类型","变动","关联对象","时间"],
      ...rows,
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
    a.download = "transactions-current-page.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <>
      <PageHead
        eyebrow="POINTS LEDGER"
        title="积分流水"
        copy="追踪积分增加、消费与人工调整；统计和导出为当前页范围。"
        action={
          <button
            className="admin-secondary"
            onClick={exportCsv}
            disabled={!rows.length}
          >
            导出流水
          </button>
        }
      />
      <Stats
        items={[
          [
            "流通积分",
            n(data.counts.points_total),
            `${n(data.counts.users_total)} 个账户`,
            "分",
          ],
          ["累计发放", n(issued), "当前读取记录", "+"],
          ["累计消费", n(spent), "当前读取记录", "−"],
          ["人工调整", n(adjusted), "已记录操作", "笔"],
        ]}
      />
      <Panel title="全站积分流水" copy="所有变动均保留来源">
        <Toolbar query={query} setQuery={setQuery} />
        <Table
          heads={["流水号", "用户", "变动类型", "积分变动", "关联对象", "时间", "处理详情"]}
        >
          {rows.length
            ? rows.map((r) => (
                <tr key={r[0]}>
                  <td>
                    <code>{r[0]}</code>
                  </td>
                  <td>{r[1]}</td>
                  <td>{r[2]}</td>
                  <td>
                    <strong
                      className={
                        r[3].startsWith("+")
                          ? "admin-positive"
                          : "admin-negative"
                      }
                    >
                      {r[3]}
                    </strong>
                  </td>
                  <td>{r[4]}</td>
                  <td>{r[5]}</td><td><TransactionReceipt id={r[0]} /></td>
                </tr>
              ))
            : emptyRow(7)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

function Memberships({ data }: { data: AdminData }) {
  const [active, setActive] = useAdminTabs("members");

  const [plans, setPlans] = useState(data.plans);
  const [selected, setSelected] = useState<any | null>(null);
  return (
    <>
      <PageHead
        eyebrow="MEMBERSHIP CONTROL"
        title="会员管理"
        copy="编辑会员套餐、折扣和有效状态。"
      />
      <Stats
        items={[
          ["有效会员", n(data.counts.members_active), "当前有效账户", "VIP"],
          ["即将到期", n(data.counts.members_expiring), "未来 7 天", "⌛"],
          [
            "累计收入",
            money(data.counts.revenue_cents_total),
            "全部已支付订单",
            "$",
          ],
          ["套餐数量", n(plans.length), "数据库套餐配置", "项"],
        ]}
      />
      <AdminTabNav
        scope="memberships"
        tabs={[
          { id: "members", label: "会员用户" },
          { id: "plans", label: "会员套餐" },
        ]}
        active={active}
        onChange={setActive}
      />
      <AdminTabPanel scope="memberships" id="members" active={active}>
        <Panel title="会员用户" copy="查看开通时间与到期状态">
          <div className="admin-empty-compact">
            当前有效会员：{n(data.counts.members_active)}{" "}
            位。可在“用户管理”中查询具体账户。
          </div>
        </Panel>
      </AdminTabPanel>
      <AdminTabPanel scope="memberships" id="plans" active={active}>
        <div className="admin-plan-grid">
          {plans.map((p: any, i: number) => (
            <article key={p.code} className={!p.enabled ? "disabled" : ""}>
              <header>
                <span>PLAN {String(i + 1).padStart(2, "0")}</span>
                <Badge tone={p.enabled ? "good" : "muted"}>
                  {p.enabled ? "销售中" : "已停用"}
                </Badge>
              </header>
              <h2>{p.name}</h2>
              <strong>
                {n(p.price_points)} <small>积分</small>
              </strong>
              <dl>
                <div>
                  <dt>有效期</dt>
                  <dd>{p.duration_days} 天</dd>
                </div>
                <div>
                  <dt>邮箱价格</dt>
                  <dd>{p.mailbox_discount_percent}%</dd>
                </div>
                <div>
                  <dt>邮件清理</dt>
                  <dd>邮箱到期时</dd>
                </div>
                <div>
                  <dt>API 限额</dt>
                  <dd>提升 {p.api_limit_multiplier} 倍</dd>
                </div>
              </dl>
              <button type="button" onClick={() => setSelected(p)}>
                编辑套餐
              </button>
            </article>
          ))}
        </div>
      </AdminTabPanel>
      {selected && (
        <MembershipPlanEditor
          plan={selected}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setPlans((items) =>
              items.map((item) =>
                item.code === updated.code ? updated : item,
              ),
            );
            setSelected(updated);
          }}
        />
      )}
    </>
  );
}

function Api({ data }: { data: AdminData }) {
  const { rows: keys, setRows: setKeys, pagination, refresh } = useAdminPage("apiKeys", data, "", "全部", (x: any) => ({
      ...x,
      prefix: `${x.key_prefix}••••`,
      state:
        x.status === "ACTIVE"
          ? "启用"
          : x.status === "DISABLED"
            ? "停用"
            : "已撤销",
    }));
  async function change(x: any, patch: any) {
    const next = {
      status: x.status,
      rateLimit: x.rate_limit_per_minute,
      ...patch,
    };
    try {
      const r = await postJson("/api/admin/control", {
        action: "api-key",
        publicId: x.id,
        ...next,
      });
      setKeys((items) =>
        items.map((item) =>
          item.id === x.id
            ? {
                ...item,
                ...r.result,
                state:
                  r.result.status === "ACTIVE"
                    ? "启用"
                    : r.result.status === "DISABLED"
                      ? "停用"
                      : "已撤销",
              }
            : item,
        ),
      );
      refresh();
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : "保存失败。");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="OPENAPI OPERATIONS"
        title="OpenAPI"
        copy="管理真实访问密钥与请求限额。"
        action={
          <a className="admin-secondary" href="/openapi/docs.cgi">
            查看接口文档 ↗
          </a>
        }
      />
      <Stats
        items={[
          ["有效密钥", n(data.counts.api_keys_active), "当前可用", "KEY"],
          ["密钥总数", n(keys.length), "数据库现有记录", "API"],
          ["今日请求", n(data.counts.api_requests_today), "数据库调用日志", "次"],
          ["限流请求", n(data.counts.api_limited_today), "今日返回 429", "次"],
        ]}
      />
      <Panel title="API 密钥" copy="密钥仅显示前缀，不暴露完整值">
        <Table
          heads={[
            "密钥 ID",
            "所属用户",
            "密钥前缀",
            "每分钟限额",
            "最后使用",
            "状态管理",
          ]}
        >
          {keys.length
            ? keys.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>{x.owner}</td>
                  <td>
                    <code>{x.prefix}</code>
                  </td>
                  <td>
                    <input
                      className="admin-small-input"
                      type="number"
                      min="1"
                      value={x.rate_limit_per_minute}
                      onChange={(e) =>
                        setKeys((items) =>
                          items.map((item) =>
                            item.id === x.id
                              ? {
                                  ...item,
                                  rate_limit_per_minute: Number(e.target.value),
                                }
                              : item,
                          ),
                        )
                      }
                      onBlur={() =>
                        change(x, { rateLimit: x.rate_limit_per_minute })
                      }
                    />
                  </td>
                  <td>{dateTime(x.last_used_at)}</td>
                  <td>
                    <select
                      value={x.status}
                      disabled={x.status === "REVOKED"}
                      onChange={(e) => change(x, { status: e.target.value })}
                      title={x.status === "REVOKED" ? "已撤销的密钥不能重新启用" : "修改密钥状态"}
                    >
                      {x.status === "REVOKED" ? (
                        <option value="REVOKED">已撤销</option>
                      ) : (
                        <>
                          <option value="ACTIVE">启用</option>
                          <option value="DISABLED">停用</option>
                          <option value="REVOKED">撤销</option>
                        </>
                      )}
                    </select>
                  </td>
                </tr>
              ))
            : emptyRow(6)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

function Security({ data }: { data: AdminData }) {
  const [active, setActive] = useAdminTabs("config");

  const initialSecurity: TurnstileSecurity = {
    ...emptySecurity,
    ...data.security,
  };
  const [security, setSecurity] = useState<TurnstileSecurity>(initialSecurity);
  const [form, setForm] = useState(() => ({
    siteKey: initialSecurity.turnstileSiteKey,
    secretKey: "",
    allowedHostnames: initialSecurity.turnstileAllowedHostnames.join("\n"),
    timeoutMs: String(initialSecurity.turnstileTimeoutMs),
  }));
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"good" | "bad">("good");
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const [testFailed, setTestFailed] = useState(false);
  const [widgetResetKey, setWidgetResetKey] = useState(0);
  const environmentReadOnly = security.turnstileEnvironmentOverride;
  const permissionReadOnly = !security.turnstileCanManage;
  const readOnly = environmentReadOnly || permissionReadOnly;
  const invalidEnvironment =
    environmentReadOnly && security.turnstileSource === "invalid";

  const sourceText = {
    database: "数据库",
    environment: "环境变量",
    none: "未设置",
    invalid: "配置异常",
  }[security.turnstileSource];
  const stateText = security.turnstileConfigured
    ? "已启用"
    : security.turnstileSource === "invalid"
      ? "配置异常"
      : security.turnstileReadyForTest
        ? "待验证"
        : "未启用";
  const stateTone = security.turnstileConfigured
    ? "good"
    : security.turnstileSource === "invalid"
      ? "bad"
      : security.turnstileReadyForTest
        ? "warn"
        : "muted";

  function applySecurity(next: TurnstileSecurity) {
    const normalized = {
      ...emptySecurity,
      ...next,
      turnstileCanManage: security.turnstileCanManage,
    };
    setSecurity(normalized);
    setForm({
      siteKey: normalized.turnstileSiteKey,
      secretKey: "",
      allowedHostnames: normalized.turnstileAllowedHostnames.join("\n"),
      timeoutMs: String(normalized.turnstileTimeoutMs),
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    setBusy(true);
    setStatus("");
    setTestStatus("");
    setTestFailed(false);
    try {
      const response = await postJson("/api/admin/control", {
        action: "turnstile-config",
        siteKey: form.siteKey.trim(),
        secretKey: form.secretKey,
        allowedHostnames: form.allowedHostnames
          .split(/[\n,]+/)
          .map((hostname) => hostname.trim())
          .filter(Boolean),
        timeoutMs: Number(form.timeoutMs),
      });
      const nextSecurity = response.result as TurnstileSecurity;
      applySecurity(nextSecurity);
      setStatusTone("good");
      setStatus(
        nextSecurity.turnstileReadyForTest
          ? "配置已安全保存。请在下方完成一次真实验证后启用。"
          : "配置已保存；Turnstile 当前未启用。",
      );
      setWidgetResetKey((value) => value + 1);
    } catch (error) {
      setStatusTone("bad");
      setStatus(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function testTurnstile(turnstileToken: string) {
    setTestBusy(true);
    setTestStatus("正在核验 Turnstile 响应…");
    setTestFailed(false);
    try {
      const response = await postJson("/api/admin/control", {
        action: "turnstile-test",
        turnstileToken,
      });
      applySecurity(response.result as TurnstileSecurity);
      setStatusTone("good");
      setStatus("人机验证测试成功，Turnstile 已启用。");
      setTestStatus("真实验证已通过，当前配置已启用。");
    } catch (error) {
      setTestFailed(true);
      setTestStatus(
        error instanceof Error ? error.message : "验证失败，请重新尝试。",
      );
      setWidgetResetKey((value) => value + 1);
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="HUMAN VERIFICATION"
        title="人机验证"
        copy="集中管理 Cloudflare Turnstile 密钥、允许域名和验证状态。"
      />
      <Stats
        items={[
          [
            "运行状态",
            stateText,
            security.turnstileConfigured
              ? "请求将执行人机校验"
              : "尚未用于用户请求",
            "BOT",
          ],
          [
            "配置来源",
            sourceText,
            invalidEnvironment
              ? "环境变量配置不完整"
              : environmentReadOnly
                ? "环境变量完整覆盖"
                : permissionReadOnly
                  ? "仅超级管理员可维护"
                  : "可在当前页面维护",
            "CFG",
          ],
          [
            "允许域名",
            n(security.turnstileAllowedHostnames.length),
            "Turnstile 响应域名白名单",
            "DNS",
          ],
          [
            "请求超时",
            `${n(security.turnstileTimeoutMs)} ms`,
            "服务端验证等待上限",
            "TTL",
          ],
        ]}
      />
      {environmentReadOnly && (
        <div className="admin-security-notice" role="note">
          <Badge tone={security.turnstileConfigured ? "good" : "bad"}>
            {invalidEnvironment ? "环境变量异常" : "环境变量配置"}
          </Badge>
          <div>
            <strong>
              {invalidEnvironment
                ? "服务器中的 Turnstile 环境变量不完整"
                : "当前 Turnstile 配置由环境变量完整覆盖"}
            </strong>
            <p>
              {invalidEnvironment
                ? "Site Key 与 Secret Key 必须同时设置或同时移除。移除后即可改用本页面的数据库配置。"
                : "为避免数据库设置产生歧义，此页面仅供查看。请在部署环境中修改站点密钥、私钥、允许域名或超时时间。"}
            </p>
          </div>
        </div>
      )}
      {permissionReadOnly && (
        <div className="admin-security-notice" role="note">
          <Badge tone="warn">只读权限</Badge>
          <div>
            <strong>只有超级管理员可以修改人机验证配置</strong>
            <p>
              当前管理员可以查看公开配置状态，但无法查看私钥、保存配置或执行启用测试。
            </p>
          </div>
        </div>
      )}
      <AdminTabNav
        scope="security"
        tabs={[
          { id: "config", label: "验证配置" },
          { id: "test", label: "验证测试" },
        ]}
        active={active}
        onChange={setActive}
      />
      <AdminTabPanel scope="security" id="config" active={active}>
        <form className="admin-settings" onSubmit={save}>
          <Panel
            title="Turnstile 配置"
            copy="Secret Key 只写入服务端，保存后不会回显"
            action={<Badge tone={stateTone}>{stateText}</Badge>}
          >
            <div className="admin-security-form">
              <label>
                Site Key（站点密钥）
                <input
                  value={form.siteKey}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      siteKey: event.target.value,
                    }))
                  }
                  readOnly={readOnly}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0x4AAAA..."
                />
                <small>可公开使用，由浏览器加载 Turnstile 控件。</small>
              </label>
              <label>
                Secret Key（私钥）
                <input
                  type="password"
                  name="turnstile-secret-key"
                  value={form.secretKey}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      secretKey: event.target.value,
                    }))
                  }
                  readOnly={readOnly}
                  spellCheck={false}
                  autoComplete="new-password"
                  placeholder={
                    security.turnstileSecretConfigured
                      ? "已安全保存；留空保持当前私钥"
                      : "请输入 Turnstile Secret Key"
                  }
                />
                <small>
                  {security.turnstileSecretConfigured
                    ? "私钥已配置；只有输入新值时才会替换。"
                    : "私钥未配置，保存完整配置后才可测试。"}
                </small>
              </label>
              <label className="admin-security-wide">
                允许的主机名
                <textarea
                  value={form.allowedHostnames}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      allowedHostnames: event.target.value,
                    }))
                  }
                  readOnly={readOnly}
                  spellCheck={false}
                  placeholder={"app.example.com\nwww.example.com"}
                />
                <small>
                  每行一个主机名，也可用英文逗号分隔；无需填写协议、端口或路径。
                </small>
              </label>
              <label>
                服务端验证超时（毫秒）
                <input
                  type="number"
                  min="10"
                  max="15000"
                  step="1"
                  value={form.timeoutMs}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      timeoutMs: event.target.value,
                    }))
                  }
                  readOnly={readOnly}
                />
                <small>允许范围 10–15000 毫秒，建议保留默认 6000 毫秒。</small>
              </label>
            </div>
          </Panel>
          <div className="admin-save-bar">
            <span
              className={statusTone === "bad" ? "admin-negative" : ""}
              role="status"
            >
              {status ||
                (permissionReadOnly
                  ? "当前账户没有修改权限"
                  : environmentReadOnly
                    ? "环境变量配置不可在后台修改"
                    : "保存后需要完成一次真实验证")}
            </span>
            <button
              className="admin-primary"
              type="submit"
              disabled={busy || readOnly}
            >
              {busy
                ? "保存中…"
                : permissionReadOnly
                  ? "仅超级管理员可保存"
                  : environmentReadOnly
                    ? "由环境变量管理"
                    : "保存 Turnstile 配置"}
            </button>
          </div>
        </form>
      </AdminTabPanel>
      <AdminTabPanel scope="security" id="test" active={active}>
        <Panel
          title="真实验证测试"
          copy="数据库配置只有通过一次服务端校验后才会正式启用"
          action={
            security.turnstileConfigured ? (
              <Badge>已启用</Badge>
            ) : security.turnstileReadyForTest ? (
              <Badge tone="warn">待验证</Badge>
            ) : (
              <Badge tone="muted">未就绪</Badge>
            )
          }
        >
          <div className="admin-security-test">
            <div>
              <strong>
                {permissionReadOnly
                  ? "当前页面为只读状态"
                  : environmentReadOnly
                    ? "环境变量配置已直接生效"
                    : security.turnstileVerifiedAt
                      ? "当前配置已通过真实验证"
                      : security.turnstileReadyForTest
                        ? "请完成下方 Turnstile 验证"
                        : "请先保存完整配置"}
              </strong>
              <p>
                {permissionReadOnly
                  ? "请使用超级管理员账户完成配置保存和真实验证。"
                  : environmentReadOnly
                    ? "环境变量来源无需写入数据库验证状态，部署配置有效时将直接启用。"
                    : security.turnstileVerifiedAt
                      ? `最近验证时间：${dateTime(security.turnstileVerifiedAt)}。重新保存配置后需要再次验证。`
                      : security.turnstileReadyForTest
                        ? "控件返回的临时令牌会立即发送到服务端核验，不会存储。"
                        : "需要有效的站点密钥、私钥和至少一个允许域名。"}
              </p>
            </div>
            {!readOnly && security.turnstileReadyForTest && (
              <div className="admin-security-widget">
                <TurnstileWidget
                  siteKey={security.turnstileSiteKey}
                  action="turnstile_admin_test"
                  theme="light"
                  size="normal"
                  responsive
                  language="zh-cn"
                  resetKey={widgetResetKey}
                  ariaLabel="测试 Turnstile 人机验证配置"
                  onVerify={(token) => void testTurnstile(token)}
                  onExpire={() => {
                    setTestFailed(true);
                    setTestStatus("验证已过期，请重新完成验证。");
                  }}
                  onError={() => {
                    setTestFailed(true);
                    setTestStatus(
                      "Turnstile 控件暂时不可用，请检查站点密钥与当前域名。",
                    );
                  }}
                />
                <small
                  className={testFailed && !testBusy ? "admin-negative" : ""}
                  role="status"
                >
                  {testStatus ||
                    (testBusy ? "正在验证…" : "完成控件验证后将自动提交测试。")}
                </small>
              </div>
            )}
          </div>
        </Panel>
      </AdminTabPanel>
    </>
  );
}

function Settings({
  data,
  canConfigureMail,
}: {
  data: AdminData;
  canConfigureMail: boolean;
}) {
  const [active, setActive] = useAdminTabs("lifecycle");
  useEffect(() => {
    const openUpdates = () => { if (window.location.hash === '#updates') setActive('updates'); };
    const navigateUpdates = () => setActive('updates');
    openUpdates();
    window.addEventListener('hashchange', openUpdates);
    window.addEventListener('nodemail:open-updates', navigateUpdates);
    return () => {
      window.removeEventListener('hashchange', openUpdates);
      window.removeEventListener('nodemail:open-updates', navigateUpdates);
    };
  }, []);

  useEffect(() => {
    if (active !== 'updates') return;
    const tab = document.getElementById('admin-tab-settings-updates');
    const nav = tab?.parentElement;
    if (tab && nav && nav.scrollWidth > nav.clientWidth) {
      // Reveal the selected tab horizontally without scrolling the whole page.
      nav.scrollLeft += tab.getBoundingClientRect().left - nav.getBoundingClientRect().left - 12;
    }
  }, [active]);

  const s = data.settings;
  let initialPlans: any[] = [];
  try {
    initialPlans = JSON.parse(s.mailbox_duration_plans || "[]");
  } catch {}
  const [form, setForm] = useState({
    free_mailbox_minutes: s.free_mailbox_minutes || "60",
    pending_order_limit: s.pending_order_limit || "3",
    active_mailbox_limit_per_user: s.active_mailbox_limit_per_user || "20",
    registration_bonus_points: s.registration_bonus_points || "100",
    captcha_before_mailbox_create: s.captcha_before_mailbox_create === "true",
    openapi_rate_limit_enabled: s.openapi_rate_limit_enabled === "true",
  });
  const [plans, setPlans] = useState(initialPlans);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form) => (e: any) =>
    setForm((v) => ({
      ...v,
      [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await postJson("/api/admin/control", {
        action: "settings",
        values: { ...form, mailbox_duration_plans: JSON.stringify(plans) },
      });
      setStatus("系统配置已保存，用户端刷新后立即生效。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="SYSTEM SETTINGS"
        title="系统配置"
        copy="这些设置与用户端实时对应。"
      />
      <AdminTabNav
        scope="settings"
        tabs={[
          ...[
            { id: "lifecycle", label: "邮箱与生命周期" },
            { id: "durations", label: "申请档位" },
            { id: "security", label: "积分与安全" },
            { id: "updates", label: "版本更新" },
          ],
          ...(canConfigureMail ? [{ id: "smtp", label: "密码找回发信" }, {id:"telegram",label:"Telegram 绑定"}, {id:"nodeloc-login",label:"NodeLoc 登录"}] : []),
        ]}
        active={active}
        onChange={setActive}
      />
      <form className="admin-settings" onSubmit={save}>
        <AdminTabPanel scope="settings" id="lifecycle" active={active}>
          <Panel title="邮箱与生命周期" copy="控制邮箱时长和待支付订单">
            <p className="admin-retention-note">
              邮件跟随各自邮箱的有效期保存。邮箱到期后，网站中的邮件和附件会清理；中继邮箱对应的上游原件会在确认关联且不被其他有效邮箱使用后移至
              Gmail 垃圾箱。旧的“默认/会员邮件保留天数”配置不参与当前清理规则。
            </p>
            <div className="admin-form-grid">
              <label>
                免费邮箱时长（分钟）
                <input
                  type="number"
                  min="5"
                  max="1440"
                  value={form.free_mailbox_minutes}
                  onChange={field("free_mailbox_minutes")}
                />
              </label>
              <label>
                单用户待支付订单上限
                <input
                  type="number"
                  min="1"
                  value={form.pending_order_limit}
                  onChange={field("pending_order_limit")}
                />
              </label>
              <label>
                单用户活动邮箱上限
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={form.active_mailbox_limit_per_user}
                  onChange={field("active_mailbox_limit_per_user")}
                />
              </label>
            </div>
          </Panel>
        </AdminTabPanel>
        <AdminTabPanel scope="settings" id="durations" active={active}>
          <Panel title="邮箱申请档位" copy="控制用户端可选择的时长与价格">
            <div className="admin-config-list">
              {plans.map((plan, index) => (
                <div className="admin-config-row" key={plan.id}>
                  <input
                    aria-label="档位名称"
                    value={plan.label}
                    onChange={(e) =>
                      setPlans((items) =>
                        items.map((x, i) =>
                          i === index ? { ...x, label: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <label>
                    分钟
                    <input
                      type="number"
                      min="1"
                      value={plan.minutes}
                      onChange={(e) =>
                        setPlans((items) =>
                          items.map((x, i) =>
                            i === index
                              ? { ...x, minutes: Number(e.target.value) }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    积分
                    <input
                      type="number"
                      min="0"
                      value={plan.points}
                      onChange={(e) =>
                        setPlans((items) =>
                          items.map((x, i) =>
                            i === index
                              ? { ...x, points: Number(e.target.value) }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
          </Panel>
        </AdminTabPanel>
        <AdminTabPanel scope="settings" id="security" active={active}>
          <Panel title="积分与安全" copy="注册奖励和功能开关">
            <div className="admin-form-grid">
              <label>
                注册赠送积分
                <input
                  type="number"
                  min="0"
                  value={form.registration_bonus_points}
                  onChange={field("registration_bonus_points")}
                />
              </label>
              <label>
                会员邮箱折扣
                <input
                  value={`${data.plans[0]?.mailbox_discount_percent || 0}%（在会员管理修改）`}
                  readOnly
                />
              </label>
            </div>
            <div className="admin-switch-list">
              <label>
                <span>
                  <strong>创建邮箱前人机验证</strong>
                  <small>
                    {data.security.turnstileConfigured
                      ? "Turnstile 已就绪；密钥与允许域名请前往“人机验证”菜单配置"
                      : "Turnstile 未就绪；请前往“人机验证”菜单完成配置与测试"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={form.captcha_before_mailbox_create}
                  onChange={field("captcha_before_mailbox_create")}
                  disabled={
                    !data.security.turnstileConfigured &&
                    !form.captcha_before_mailbox_create
                  }
                />
              </label>
              <label>
                <span>
                  <strong>OpenAPI 自动限流</strong>
                  <small>控制接口限流策略开关</small>
                </span>
                <input
                  type="checkbox"
                  checked={form.openapi_rate_limit_enabled}
                  onChange={field("openapi_rate_limit_enabled")}
                />
              </label>
            </div>
          </Panel>
        </AdminTabPanel>
        <div hidden={active === "smtp" || active === "telegram" || active === "nodeloc-login" || active === "updates"}>
          <div className="admin-save-bar">
            <span>{status || "所有修改将写入 MySQL 并记录审计日志"}</span>
            <button className="admin-primary" type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存全部配置"}
            </button>
          </div>
        </div>
      </form>
      <AdminTabPanel scope="settings" id="updates" active={active}><AdminUpdates /></AdminTabPanel>
      {canConfigureMail && <AdminTabPanel scope="settings" id="telegram" active={active}><TelegramSettings /></AdminTabPanel>}
      {canConfigureMail && <AdminTabPanel scope="settings" id="nodeloc-login" active={active}><NodelocOAuthSettings /></AdminTabPanel>}
      {canConfigureMail && (
        <AdminTabPanel scope="settings" id="smtp" active={active}>
          <PasswordMailSettings />
        </AdminTabPanel>
      )}
    </>
  );
}

function Audit({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const {rows: serverRows,pagination,refresh}=useAdminPage("audit",data,query);
  const rows = serverRows;
  return (
    <>
      <PageHead
        eyebrow="AUDIT LOG"
        title="审计日志"
        copy="记录管理员与系统的关键操作，便于追踪和复核。"
      />
      <AuditRetentionControls onChange={refresh} />
      <Panel title="操作记录" copy="关键操作按保留期限清理，业务凭据独立保存">
        <Toolbar query={query} setQuery={setQuery} />
        <Table
          heads={["日志 ID", "操作者", "操作", "对象与说明", "结果", "时间"]}
        >
          {rows.length
            ? rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>{x.actor}</td>
                  <td>
                    <strong>{x.action}</strong>
                  </td>
                  <td>
                    {x.entity_type}
                    {x.entity_id ? ` · ${x.entity_id}` : ""}
                  </td>
                  <td>
                    <Badge tone={x.status === "SUCCESS" ? "good" : "bad"}>
                      {x.status === "SUCCESS" ? "成功" : "失败"}
                    </Badge>
                  </td>
                  <td>{dateTime(x.created_at)}</td>
                </tr>
              ))
            : emptyRow(6)}
        </Table>
        <Pagination {...pagination} />
      </Panel>
    </>
  );
}

export default function AdminConsole({
  view,
  data = emptyData,
  canConfigureMail = false,
}: {
  view: AdminView;
  data?: AdminData;
  canConfigureMail?: boolean;
}) {
  const views: Record<AdminView, ReactNode> = {
    overview: <Overview data={data} />,
    users: <Users data={data} />,
    memberships: <Memberships data={data} />,
    mailboxes: <Mailboxes data={data} />,
    messages: <Messages data={data} />,
    domains: <Domains data={data} />,
    orders: <Orders data={data} />,
    commerce: <Commerce data={data} />,
    transactions: <Transactions data={data} />,
    api: <Api data={data} />,
    security: <Security data={data} />,
    settings: <Settings data={data} canConfigureMail={canConfigureMail} />,
    audit: <Audit data={data} />,
  };
  return <div className="admin-page">{views[view]}</div>;
}
