import defaults from '../../shared/deployment-defaults.json' with {type:'json'};

// Deployment settings are administrator-controlled process environment, never request fields.
export function httpsOrigin(value, {allowLocal = false} = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('站点配置必须为 HTTPS 根地址。'); }
  if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('站点配置必须为 HTTPS 根地址。');
  }
  return url.origin;
}

export const siteOrigin = () => httpsOrigin(process.env.NODEMAIL_SITE_ORIGIN || defaults.siteOrigin);
export const publicOrigin = () => httpsOrigin(process.env.NODEMAIL_PUBLIC_ORIGIN || defaults.publicOrigin);
export const smtpName = () => process.env.SMTP_NAME || defaults.smtpName;
export const gmpayOrigin = () => {
  const configured = process.env.NODEMAIL_GMPAY_ORIGIN ?? defaults.gmpayOrigin;
  return configured ? httpsOrigin(configured) : '';
};
