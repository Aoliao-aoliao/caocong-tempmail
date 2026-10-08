import { useEffect, useState } from 'react';
import { createCountryIdentity, type CountryCode } from '../lib/random';

interface Props {
  country?: CountryCode;
  locale?: 'zh' | 'en';
}

const countryNames: Record<CountryCode, string> = {
  us: '美国', uk: '英国', ca: '加拿大', au: '澳大利亚', de: '德国', jp: '日本', sg: '新加坡', hk: '香港',
};

export default function IdentityGenerator({ country = 'us', locale = 'zh' }: Props) {
  const [identity, setIdentity] = useState<ReturnType<typeof createCountryIdentity> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setIdentity(createCountryIdentity(country)), [country]);

  const labels = locale === 'en' ? ['Name', 'Address', 'Phone', 'Anonymous email'] : ['姓名', '地址', '电话', '匿名 Email'];
  const rows = identity ? [
    [labels[0], identity.name],
    [labels[1], identity.address],
    [labels[2], identity.phone],
    [labels[3], identity.email],
  ] : labels.map((label) => [label, '...']);

  function copyAll() {
    if (!identity) return;
    const value = rows.map(([label, text]) => `${label}: ${text}`).join('\n');
    navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  return (
    <div className="generator-card">
      <div className="generator-head"><span>NODEMAIL · {locale === 'en' ? 'IDENTITY ISSUE' : '身份签发'}</span><i title={locale === 'en' ? 'Country format ready' : `${countryNames[country]}格式已就绪`} /></div>
      <div className="generator-rows">
        {rows.map(([label, value]) => (
          <div className="generator-row" key={label}>
            <span>{label}</span><strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="generator-actions">
        <button className="btn btn-primary" type="button" disabled={!identity} onClick={() => setIdentity(createCountryIdentity(country))}>{locale === 'en' ? 'Regenerate' : '换一套'}</button>
        <button className="btn btn-secondary" type="button" disabled={!identity} onClick={copyAll}>{copied ? (locale === 'en' ? 'Copied' : '已复制') : (locale === 'en' ? 'Copy all' : '复制全部')}</button>
      </div>
      <p>{locale === 'en' ? 'Everything is generated locally in your browser and is not sent to a server.' : '所有资料在浏览器本地生成，不会发送到服务器。'}</p>
    </div>
  );
}
