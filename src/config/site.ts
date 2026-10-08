import defaults from '../../shared/deployment-defaults.json';

// Only public settings enter client bundles. Secrets must never be added here.
const env = import.meta.env.SSR ? process.env : {};
export const site = {
  name: 'NodeMail',
  shortName: 'NM',
  tagline: '把真实身份留在库里。',
  publicOrigin: env.NODEMAIL_PUBLIC_ORIGIN || defaults.publicOrigin,
  appOrigin: env.NODEMAIL_SITE_ORIGIN || defaults.siteOrigin,
  appPath: (env.NODEMAIL_SITE_ORIGIN || defaults.siteOrigin) + '/tools/mail.cgi',
  contactEmail: env.NODEMAIL_CONTACT_EMAIL || defaults.contactEmail,
  emailDomain: env.NODEMAIL_EMAIL_DOMAIN || defaults.emailDomain,
  inboxDomains: [env.NODEMAIL_EMAIL_DOMAIN || defaults.emailDomain],
} as const;
