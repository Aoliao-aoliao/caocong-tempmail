import { useState, type FormEvent } from "react";
export type AliasAccount = {
  id: string;
  provider: string;
  email: string;
  status: string;
  extraAddresses?: string[];
};
export default function RelayAliasSettings({
  accounts,
  busy,
  onChange,
}: {
  accounts: AliasAccount[];
  busy: string;
  onChange: (
    account: AliasAccount,
    address: string,
    enabled: boolean,
    confirmed: boolean,
  ) => Promise<void>;
}) {
  const usable = accounts.filter((a) =>
    ["GMAIL", "OUTLOOK"].includes(a.provider),
  );
  const [id, setId] = useState(usable[0]?.id || "");
  const account = usable.find((a) => a.id === id) || usable[0];
  const preset = (a?: AliasAccount) =>
    a?.provider === "GMAIL"
      ? a.email.split("@")[0] +
        "@" +
        (a.email.endsWith("@gmail.com") ? "googlemail.com" : "gmail.com")
      : "";
  const [address, setAddress] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const selectedAddress =
    account?.provider === "GMAIL" ? preset(account) : address;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (account) await onChange(account, selectedAddress, true, confirmed);
  };
  return (
    <section className="admin-panel relay-alias-settings">
      <header>
        <div>
          <h2>别名邮箱配置</h2>
          <p>
            别名与原账号共用收信连接、授权和容量。停止分配不会删除已经生成的邮箱或邮件。
          </p>
        </div>
      </header>
      <form onSubmit={submit}>
        <label>
          所属真实邮箱
          <select
            value={account?.id || ""}
            disabled={!usable.length}
            onChange={(event) => {
              setId(event.target.value);
              setAddress("");
              setConfirmed(false);
            }}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          别名邮箱地址
          <input
            type="email"
            required
            value={selectedAddress}
            readOnly={account?.provider === "GMAIL"}
            placeholder="填写已添加到 Microsoft 账号的完整别名"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        {account?.provider === "OUTLOOK" ? (
          <label className="relay-alias-confirm">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已在同一个 Microsoft 账号中添加并确认该别名。
          </label>
        ) : (
          <p className="relay-alias-hint">
            Googlemail 使用相同用户名，无需另建 Google
            账号、重新填写应用密码或重新授权。
          </p>
        )}
        <button
          type="submit"
          className="primary-action"
          disabled={Boolean(busy) || !account}
        >
          {busy.startsWith("alias:") ? "正在保存…" : "启用别名"}
        </button>
      </form>
      <h3>已启用的别名</h3>
      <div className="relay-alias-list">
        {accounts.flatMap((a) =>
          (a.extraAddresses || []).map((value) => (
            <article key={a.id + value}>
              <div>
                <strong>{value}</strong>
                <small>收信账号：{a.email}</small>
              </div>
              <span>{a.status === "ACTIVE" ? "已启用" : "账号尚未启用"}</span>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onChange(a, value, false, false)}
              >
                停止新分配
              </button>
            </article>
          )),
        )}
      </div>
      {!accounts.some((a) => a.extraAddresses?.length) && (
        <p>暂未启用任何别名。</p>
      )}
    </section>
  );
}
