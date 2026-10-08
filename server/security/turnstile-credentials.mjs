const CLOUDFLARE_TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
]);

const CLOUDFLARE_TEST_SECRET_KEYS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export function isCloudflareTurnstileTestCredential({ siteKey, secretKey } = {}) {
  return CLOUDFLARE_TEST_SITE_KEYS.has(String(siteKey || '').trim())
    || CLOUDFLARE_TEST_SECRET_KEYS.has(String(secretKey || '').trim());
}

export function assertProductionTurnstileCredentials(credentials, env = process.env) {
  if (env?.NODE_ENV !== 'production') return;
  if (isCloudflareTurnstileTestCredential(credentials)) {
    throw Object.assign(new Error('生产环境不能使用 Cloudflare Turnstile 官方测试密钥。'), {
      code:'TURNSTILE_TEST_CREDENTIAL',
    });
  }
}
