import { useEffect, useState } from 'react';
import { createIdentity, type Identity } from '../lib/random';

const USE_CASE = {
  zh: 'AI 注册专用',
  en: 'AI sign-ups',
};

export default function IdentityCard({ locale = 'zh', initialIdentity }: { locale?: 'zh' | 'en'; initialIdentity: Identity }) {
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeScene, setActiveScene] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIdentity(createIdentity('en'));
      setActiveScene((current) => (current + 1) % 5);
    }, 4400);
    return () => window.clearInterval(timer);
  }, [locale]);

  function copy(key: string, value: string) {
    navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
  }

  const rows = locale === 'en' ? [
    { key: 'name', label: 'Name', en: 'Identity', value: identity.name },
    { key: 'address', label: 'Address', en: 'Location', value: identity.address },
    { key: 'phone', label: 'Phone', en: 'Contact', value: identity.phone },
    { key: 'email', label: 'Anonymous email', en: 'Inbox', value: identity.email },
  ] : [
    { key: 'name', label: '姓名', en: 'Name', value: identity.name },
    { key: 'address', label: '地址', en: 'Address', value: identity.address },
    { key: 'phone', label: '手机号', en: 'Phone', value: identity.phone },
    { key: 'email', label: '匿名 Email', en: 'Email', value: identity.email },
  ];

  return (
    <div className="issue-card" aria-live="polite">
      <div className="issue-head">
        <span className="issue-plate">NODEMAIL · {locale === 'en' ? 'IDENTITY ISSUE' : '身份签发'}</span>
        <span className="issue-state">{locale === 'en' ? 'ISSUED' : '已签发'}</span>
      </div>
      <div className="issue-purpose">
        <span>{locale === 'en' ? 'Issued for' : '用途'}</span>
        <span className="purpose-pill">{USE_CASE[locale]}</span>
      </div>
      <div>
        {rows.map((row) => (
          <div className="issue-row" key={row.key}>
            <span className="issue-label">{row.label}<small>/ {row.en}</small></span>
            <span className="issue-value">{row.value}</span>
            <button className="issue-copy" type="button" onClick={() => copy(row.key, row.value)} title={locale === 'en' ? `Copy ${row.label}` : `复制${row.label}`}>
              {copied === row.key ? '✓' : '▣'}
            </button>
          </div>
        ))}
      </div>
      <div className="issue-foot">
        <a className="issue-action" href="/tools/mail.cgi">{locale === 'en' ? 'USE IT' : '立即使用'} <span aria-hidden="true">→</span></a>
        <span className="issue-pips" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => <span className={`issue-pip${index === activeScene ? ' is-on' : ''}`} key={index} />)}
        </span>
      </div>
    </div>
  );
}
