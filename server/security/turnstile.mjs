import { readTurnstileDatabaseConfig } from './turnstile-config-store.mjs';
import { isCloudflareTurnstileTestCredential } from './turnstile-credentials.mjs';

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_TOKEN_LENGTH = 2048;

function failure(reason, errorCodes = []) {
  return {
    success: false,
    reason,
    errorCodes: [...new Set(errorCodes.filter((code) => typeof code === 'string' && code))],
  };
}

function integerSetting(env, key, fallback, minimum, maximum) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || hostname.includes('/') || hostname.includes(':')) return '';
  if (hostname === 'localhost') return hostname;
  const labels = hostname.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return '';
  }
  return hostname;
}

function normalizeAction(value) {
  const action = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{1,32}$/.test(action) ? action : '';
}

export function loadTurnstileConfig(env = process.env) {
  const secretKey = String(env.TURNSTILE_SECRET_KEY || '').trim();
  const rawHostnames = String(env.TURNSTILE_ALLOWED_HOSTNAMES || '').split(',');
  const allowedHostnames = [];

  for (const rawHostname of rawHostnames) {
    if (!rawHostname.trim()) continue;
    const hostname = normalizeHostname(rawHostname);
    if (!hostname) throw new Error('TURNSTILE_ALLOWED_HOSTNAMES contains an invalid hostname.');
    if (!allowedHostnames.includes(hostname)) allowedHostnames.push(hostname);
  }
  if (secretKey && !allowedHostnames.length) {
    throw new Error('TURNSTILE_ALLOWED_HOSTNAMES must contain at least one hostname.');
  }

  return {
    secretKey,
    allowedHostnames,
    timeoutMs: integerSetting(env, 'TURNSTILE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 10, 15000),
  };
}

export function getTurnstilePublicConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  let configured = false;
  try {
    const config = loadTurnstileConfig(env);
    configured = Boolean(siteKey && config.secretKey && config.allowedHostnames.length);
  } catch {
    configured = false;
  }
  return {
    siteKey,
    configured,
  };
}

function environmentRuntimeConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!siteKey && !secretKey) return { status:'absent' };
  try {
    const config = loadTurnstileConfig(env);
    if (!siteKey || !config.secretKey || !config.allowedHostnames.length) {
      return { status:'invalid' };
    }
    return {
      status:'configured',
      config:{ siteKey, ...config },
    };
  } catch {
    return { status:'invalid' };
  }
}

function publicRuntimeConfig(value) {
  return {
    siteKey:value.siteKey || '',
    configured:Boolean(value.configured),
    source:value.source || 'none',
    allowedHostnames:Array.isArray(value.allowedHostnames) ? value.allowedHostnames : [],
    secretConfigured:Boolean(value.secretConfigured),
    timeoutMs:Number(value.timeoutMs || DEFAULT_TIMEOUT_MS),
    readyForTest:Boolean(value.readyForTest),
    verifiedAt:value.verifiedAt || null,
    updatedAt:value.updatedAt || null,
    environmentOverride:Boolean(value.environmentOverride || value.source === 'environment'),
  };
}

export async function resolveTurnstileConfig({
  env = process.env,
  storeReader = readTurnstileDatabaseConfig,
  allowUnverifiedDatabase = false,
  connection,
} = {}) {
  const environment = environmentRuntimeConfig(env);
  if (environment.status === 'invalid') {
    return {
      configured:false,
      source:'invalid',
      environmentOverride:true,
      siteKey:String(env.TURNSTILE_SITE_KEY || '').trim(),
      secretKey:'',
      allowedHostnames:[],
      secretConfigured:Boolean(String(env.TURNSTILE_SECRET_KEY || '').trim()),
      timeoutMs:DEFAULT_TIMEOUT_MS,
      readyForTest:false,
      verifiedAt:null,
      updatedAt:null,
    };
  }
  if (environment.status === 'configured') {
    if (env.NODE_ENV === 'production' && isCloudflareTurnstileTestCredential(environment.config)) {
      return {
        configured:false,
        source:'invalid',
        environmentOverride:true,
        siteKey:environment.config.siteKey,
        secretKey:'',
        allowedHostnames:environment.config.allowedHostnames,
        secretConfigured:true,
        timeoutMs:environment.config.timeoutMs,
        readyForTest:false,
        verifiedAt:null,
        updatedAt:null,
      };
    }
    return {
      configured:true,
      source:'environment',
      ...environment.config,
      secretConfigured:true,
      readyForTest:false,
      verifiedAt:null,
      updatedAt:null,
    };
  }

  let stored;
  try {
    stored = await storeReader({ connection, env });
  } catch {
    stored = { status:'unavailable', metadata:{} };
  }
  const metadata = stored?.metadata || {};
  if (stored?.status !== 'configured' || !stored.config) {
    return {
      configured:false,
      source:stored?.status === 'not-configured' ? 'none' : 'invalid',
      siteKey:metadata.siteKey || '',
      secretKey:'',
      allowedHostnames:metadata.allowedHostnames || [],
      secretConfigured:Boolean(metadata.secretConfigured),
      timeoutMs:Number(metadata.timeoutMs || DEFAULT_TIMEOUT_MS),
      readyForTest:false,
      verifiedAt:metadata.verifiedAt || null,
      updatedAt:metadata.updatedAt || null,
    };
  }
  if (env.NODE_ENV === 'production' && isCloudflareTurnstileTestCredential(stored.config)) {
    return {
      configured:false,
      source:'invalid',
      siteKey:stored.config.siteKey,
      secretKey:'',
      allowedHostnames:stored.config.allowedHostnames,
      secretConfigured:true,
      timeoutMs:stored.config.timeoutMs,
      readyForTest:false,
      verifiedAt:stored.config.verifiedAt || null,
      updatedAt:stored.config.updatedAt || null,
    };
  }
  const verified = Boolean(stored.config.verifiedAt);
  return {
    configured:verified || allowUnverifiedDatabase,
    source:'database',
    ...stored.config,
    secretConfigured:true,
    readyForTest:true,
  };
}

export async function getResolvedTurnstilePublicConfig(options = {}) {
  try {
    return publicRuntimeConfig(await resolveTurnstileConfig(options));
  } catch {
    return publicRuntimeConfig({ source:'invalid' });
  }
}

/**
 * Validate a Turnstile response token. This helper always fails closed: provider,
 * network, timeout and configuration errors all return success=false.
 */
export async function verifyTurnstileToken(options = {}) {
  const {
    token,
    remoteIp,
    expectedAction,
    fetchImpl = globalThis.fetch,
  } = options;
  let config;
  try {
    if (options.config) {
      config = loadTurnstileConfig({
        TURNSTILE_SECRET_KEY:options.config.secretKey,
        TURNSTILE_ALLOWED_HOSTNAMES:(options.config.allowedHostnames || []).join(','),
        TURNSTILE_TIMEOUT_MS:String(options.config.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
    } else if (Object.prototype.hasOwnProperty.call(options, 'env')) {
      config = loadTurnstileConfig(options.env || {});
    } else {
      const runtime = await resolveTurnstileConfig();
      if (!runtime.configured) return failure('not-configured', ['missing-input-secret']);
      config = runtime;
    }
  } catch {
    return failure('configuration-error', ['internal-error']);
  }

  if (!config.secretKey) return failure('not-configured', ['missing-input-secret']);

  const responseToken = String(token || '').trim();
  if (!responseToken || responseToken.length > MAX_TOKEN_LENGTH) {
    return failure('invalid-token', ['missing-input-response']);
  }

  const action = expectedAction === undefined || expectedAction === null || expectedAction === ''
    ? ''
    : normalizeAction(expectedAction);
  if (expectedAction && !action) return failure('configuration-error', ['internal-error']);
  if (typeof fetchImpl !== 'function') return failure('configuration-error', ['internal-error']);

  const body = new URLSearchParams({
    secret: config.secretKey,
    response: responseToken,
  });
  const requestIp = String(remoteIp || '').trim();
  if (requestIp) body.set('remoteip', requestIp.slice(0, 64));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });

    if (!response?.ok) return failure('provider-error', ['internal-error']);

    let result;
    try {
      result = await response.json();
    } catch {
      return failure('invalid-response', ['internal-error']);
    }

    if (!result || typeof result !== 'object' || result.success !== true) {
      const providerCodes = Array.isArray(result?.['error-codes']) ? result['error-codes'] : [];
      return failure('rejected', providerCodes.length ? providerCodes : ['invalid-input-response']);
    }

    const hostname = normalizeHostname(result.hostname);
    if (config.allowedHostnames.length && (!hostname || !config.allowedHostnames.includes(hostname))) {
      return failure('hostname-mismatch', ['invalid-hostname']);
    }

    const responseAction = String(result.action || '').trim();
    if (action && responseAction !== action) return failure('action-mismatch', ['invalid-action']);

    return {
      success: true,
      reason: 'verified',
      hostname,
      action: responseAction,
      challengeTimestamp: typeof result.challenge_ts === 'string' ? result.challenge_ts : '',
    };
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      return failure('timeout', ['internal-error']);
    }
    return failure('network-error', ['internal-error']);
  } finally {
    clearTimeout(timeout);
  }
}

export async function requireTurnstileToken(options = {}) {
  const result = await verifyTurnstileToken(options);
  if (result.success) return result;

  const unavailableReasons = new Set([
    'not-configured',
    'configuration-error',
    'provider-error',
    'invalid-response',
    'timeout',
    'network-error',
  ]);
  const unavailable = unavailableReasons.has(result.reason);
  throw Object.assign(new Error(unavailable
    ? '人机验证服务暂时不可用，请稍后再试。'
    : '人机验证失败或已过期，请重新验证。'), {
    status: unavailable ? 503 : 403,
    code: unavailable ? 'TURNSTILE_UNAVAILABLE' : 'TURNSTILE_REJECTED',
  });
}
