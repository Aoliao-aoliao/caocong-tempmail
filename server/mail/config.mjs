import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function integerSetting(env, key, fallback, minimum, maximum) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function loadSmtpConfig(env = process.env) {
  const tlsKeyFile = String(env.SMTP_TLS_KEY_FILE || '').trim();
  const tlsCertFile = String(env.SMTP_TLS_CERT_FILE || '').trim();
  if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) {
    throw new Error('SMTP_TLS_KEY_FILE and SMTP_TLS_CERT_FILE must be configured together.');
  }

  const configuredStorageRoot = String(env.MAIL_ATTACHMENT_DIR || '').trim();
  const storageRoot = configuredStorageRoot
    ? resolve(configuredStorageRoot)
    : resolve(process.cwd(), 'data', 'mail-attachments');

  return {
    host: String(env.SMTP_HOST || '0.0.0.0').trim(),
    port: integerSetting(env, 'SMTP_PORT', 2525, 1, 65535),
    name: String(env.SMTP_NAME || 'localhost').trim().toLowerCase(),
    maxMessageBytes: integerSetting(env, 'SMTP_MAX_MESSAGE_BYTES', 10 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
    maxAttachmentBytes: integerSetting(env, 'SMTP_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024, 1, 25 * 1024 * 1024),
    maxAttachments: integerSetting(env, 'SMTP_MAX_ATTACHMENTS', 20, 0, 100),
    maxRecipients: integerSetting(env, 'SMTP_MAX_RECIPIENTS', 10, 1, 100),
    maxMessagesPerConnection: integerSetting(env, 'SMTP_MAX_MESSAGES_PER_CONNECTION', 20, 1, 1000),
    maxConnections: integerSetting(env, 'SMTP_MAX_CONNECTIONS', 50, 1, 1000),
    maxConnectionsPerIp: integerSetting(env, 'SMTP_MAX_CONNECTIONS_PER_IP', 10, 1, 1000),
    connectionLifetimeMs: integerSetting(env, 'SMTP_CONNECTION_LIFETIME_MS', 600000, 10000, 3600000),
    dataTimeoutMs: integerSetting(env, 'SMTP_DATA_TIMEOUT_MS', 180000, 10000, 600000),
    maxConnectionsPerMinute: integerSetting(env, 'SMTP_MAX_CONNECTIONS_PER_MINUTE', 60, 1, 10000),
    mailboxMaxMessages: integerSetting(env, 'SMTP_MAILBOX_MAX_MESSAGES', 500, 1, 1000000),
    mailboxMaxBytes: integerSetting(env, 'SMTP_MAILBOX_MAX_BYTES', 100 * 1024 * 1024, 1024 * 1024, 10 * 1024 * 1024 * 1024),
    socketTimeoutMs: integerSetting(env, 'SMTP_SOCKET_TIMEOUT_MS', 120000, 10000, 600000),
    closeTimeoutMs: integerSetting(env, 'SMTP_CLOSE_TIMEOUT_MS', 10000, 1000, 60000),
    cleanupIntervalMs: integerSetting(env, 'MAIL_CLEANUP_INTERVAL_MS', 60000, 10000, 86400000),
    cleanupBatchSize: integerSetting(env, 'MAIL_CLEANUP_BATCH_SIZE', 500, 10, 5000),
    storageRoot,
    tlsKeyFile: tlsKeyFile ? resolve(tlsKeyFile) : '',
    tlsCertFile: tlsCertFile ? resolve(tlsCertFile) : '',
  };
}

export async function loadSmtpTlsOptions(config) {
  if (!config.tlsKeyFile) return { hideSTARTTLS: true };
  const [key, cert] = await Promise.all([
    readFile(config.tlsKeyFile),
    readFile(config.tlsCertFile),
  ]);
  return {
    key,
    cert,
    minVersion: 'TLSv1.2',
    hideSTARTTLS: false,
  };
}
