import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const KDF_SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MIN_PRODUCTION_SECRET_BYTES = 32;
const DEVELOPMENT_SECRET = 'nodemail-development-guest-session-secret-v1';
const HKDF_INFO = Buffer.from('nodemail:turnstile-config:key:v1', 'utf8');
const AAD = Buffer.from('nodemail:turnstile-config:secret-key:v1', 'utf8');
const API_KEY_HKDF_INFO = Buffer.from('nodemail:api-key:key:v1', 'utf8');
const API_KEY_AAD = Buffer.from('nodemail:api-key:secret:v1', 'utf8');
const RELAY_HKDF_INFO = Buffer.from('nodemail:relay-credential:key:v1', 'utf8');
const RELAY_AAD = Buffer.from('nodemail:relay-credential:secret:v1', 'utf8');

function secretBoxError(message, code) {
  return Object.assign(new Error(message), { code });
}

function masterSecret(env) {
  const configured = env?.GUEST_SESSION_SECRET;
  if (typeof configured === 'string' && configured.length > 0) {
    const value = Buffer.from(configured, 'utf8');
    if (env?.NODE_ENV === 'production' && value.byteLength < MIN_PRODUCTION_SECRET_BYTES) {
      throw secretBoxError(
        '生产环境的 GUEST_SESSION_SECRET 至少需要 32 bytes。',
        'SECRET_BOX_CONFIGURATION',
      );
    }
    return value;
  }

  if (env?.NODE_ENV === 'production') {
    throw secretBoxError(
      '生产环境必须显式设置 GUEST_SESSION_SECRET。',
      'SECRET_BOX_CONFIGURATION',
    );
  }
  return Buffer.from(DEVELOPMENT_SECRET, 'utf8');
}

function deriveKey(kdfSalt, env, info = HKDF_INFO) {
  return Buffer.from(hkdfSync(
    'sha256',
    masterSecret(env),
    kdfSalt,
    info,
    KEY_BYTES,
  ));
}

function encryptValue(value, { env = process.env, info = HKDF_INFO, aad = AAD } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw secretBoxError('待加密密钥不能为空。', 'SECRET_BOX_INVALID_DATA');
  }

  const kdfSalt = randomBytes(KDF_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(kdfSalt, env, info);

  try {
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext,
      kdfSalt,
      iv,
      authTag: cipher.getAuthTag(),
    };
  } finally {
    key.fill(0);
  }
}

function decryptValue(
  { ciphertext, kdfSalt, iv, authTag } = {},
  { env = process.env, info = HKDF_INFO, aad = AAD } = {},
) {
  const encrypted = binaryField(ciphertext, null, 'ciphertext');
  const salt = binaryField(kdfSalt, KDF_SALT_BYTES, 'KDF salt');
  const initializationVector = binaryField(iv, IV_BYTES, 'IV');
  const tag = binaryField(authTag, AUTH_TAG_BYTES, 'authentication tag');
  const key = deriveKey(salt, env, info);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, initializationVector, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw secretBoxError('加密密钥无法解密。', 'SECRET_BOX_INVALID_DATA');
  } finally {
    key.fill(0);
  }
}

function binaryField(value, expectedBytes, fieldName) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw secretBoxError(`加密密钥的 ${fieldName} 格式无效。`, 'SECRET_BOX_INVALID_DATA');
  }
  const buffer = Buffer.from(value);
  if (expectedBytes === null ? buffer.length === 0 : buffer.length !== expectedBytes) {
    throw secretBoxError(`加密密钥的 ${fieldName} 格式无效。`, 'SECRET_BOX_INVALID_DATA');
  }
  return buffer;
}

/**
 * Encrypt a value for the Turnstile configuration table. The returned binary
 * fields are intentionally separate so each cryptographic input has its own
 * database column.
 */
export function encryptSecret(value, { env = process.env } = {}) {
  return encryptValue(value, { env, info:HKDF_INFO, aad:AAD });
}

export function decryptSecret(
  { ciphertext, kdfSalt, iv, authTag } = {},
  { env = process.env } = {},
) {
  return decryptValue(
    { ciphertext, kdfSalt, iv, authTag },
    { env, info:HKDF_INFO, aad:AAD },
  );
}

export function encryptApiKey(value, { env = process.env } = {}) {
  return encryptValue(value, { env, info:API_KEY_HKDF_INFO, aad:API_KEY_AAD });
}

export function decryptApiKey(fields, { env = process.env } = {}) {
  return decryptValue(fields, { env, info:API_KEY_HKDF_INFO, aad:API_KEY_AAD });
}

export function encryptRelayCredential(value, { env = process.env } = {}) {
  return encryptValue(value, { env, info:RELAY_HKDF_INFO, aad:RELAY_AAD });
}

export function decryptRelayCredential(fields, { env = process.env } = {}) {
  return decryptValue(fields, { env, info:RELAY_HKDF_INFO, aad:RELAY_AAD });
}

export function encryptTelegramSecret(value, {env=process.env}={}) {
  return encryptValue(value,{env,info:Buffer.from('nodemail:telegram:key:v1'),aad:Buffer.from('nodemail:telegram:secret:v1')});
}
export function decryptTelegramSecret(fields, {env=process.env}={}) {
  return decryptValue(fields,{env,info:Buffer.from('nodemail:telegram:key:v1'),aad:Buffer.from('nodemail:telegram:secret:v1')});
}

const PASSWORD_MAIL_INFO = Buffer.from('nodemail:password-mail:key:v1');
const PASSWORD_MAIL_AAD = Buffer.from('nodemail:password-mail:secret:v1');
export function encryptPasswordMail(value, {env=process.env}={}) {
  return encryptValue(value,{env,info:PASSWORD_MAIL_INFO,aad:PASSWORD_MAIL_AAD});
}
export function decryptPasswordMail(fields, {env=process.env}={}) {
  return decryptValue(fields,{env,info:PASSWORD_MAIL_INFO,aad:PASSWORD_MAIL_AAD});
}

const PAYMENT_INFO = Buffer.from('nodemail:payment:key:v1');
const PAYMENT_AAD = Buffer.from('nodemail:payment:secret:v1');
export function encryptPayment(value) {return encryptValue(value,{info:PAYMENT_INFO,aad:PAYMENT_AAD});}
export function decryptPayment(fields) {return decryptValue(fields,{info:PAYMENT_INFO,aad:PAYMENT_AAD});}

const GMPAY_INFO = Buffer.from('nodemail:gmpay:key:v1');
const GMPAY_AAD = Buffer.from('nodemail:gmpay:secret:v1');
export function encryptGmpay(value,{env=process.env}={}) {return encryptValue(value,{env,info:GMPAY_INFO,aad:GMPAY_AAD});}
export function decryptGmpay(fields,{env=process.env}={}) {return decryptValue(fields,{env,info:GMPAY_INFO,aad:GMPAY_AAD});}

// Separate cryptographic domain from passwords and payment credentials.
const MICROSOFT_INFO=Buffer.from('nodemail:microsoft-oauth:key:v1');
const MICROSOFT_AAD=Buffer.from('nodemail:microsoft-oauth:secret:v1');
export function encryptMicrosoft(value,{env=process.env}={}) {return encryptValue(value,{env,info:MICROSOFT_INFO,aad:MICROSOFT_AAD});}
export function decryptMicrosoft(fields,{env=process.env}={}) {return decryptValue(fields,{env,info:MICROSOFT_INFO,aad:MICROSOFT_AAD});}

export function encryptNodelocOAuth(value,{env=process.env}={}) {return encryptValue(value,{env,info:Buffer.from('nodemail:nodeloc-oauth:key:v1'),aad:Buffer.from('nodemail:nodeloc-oauth:secret:v1')});}
export function decryptNodelocOAuth(fields,{env=process.env}={}) {return decryptValue(fields,{env,info:Buffer.from('nodemail:nodeloc-oauth:key:v1'),aad:Buffer.from('nodemail:nodeloc-oauth:secret:v1')});}
