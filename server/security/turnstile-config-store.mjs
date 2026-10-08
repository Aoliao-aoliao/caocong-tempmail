import { openDatabase } from '../db/database.mjs';
import { decryptSecret, encryptSecret } from './secret-box.mjs';
import { assertProductionTurnstileCredentials } from './turnstile-credentials.mjs';

const DEFAULT_TIMEOUT_MS = 6000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 15000;
const MAX_KEY_LENGTH = 255;
const MAX_HOSTNAMES = 100;

const SELECT_CONFIG_SQL = `
  SELECT
    site_key AS siteKey,
    secret_key_ciphertext AS secretCiphertext,
    secret_key_kdf_salt AS secretKdfSalt,
    secret_key_iv AS secretIv,
    secret_key_auth_tag AS secretAuthTag,
    allowed_hostnames AS allowedHostnames,
    timeout_ms AS timeoutMs,
    verified_at AS verifiedAt,
    updated_at AS updatedAt
  FROM turnstile_config
  WHERE id = 1
  LIMIT 1
`;

function emptyMetadata() {
  return {
    siteKey: '',
    allowedHostnames: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    secretConfigured: false,
    verifiedAt: null,
    updatedAt: null,
  };
}

function keyValue(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} 必须是字符串。`);
  const normalized = value.trim();
  if (!new RegExp(`^[A-Za-z0-9_-]{1,${MAX_KEY_LENGTH}}$`).test(normalized)) {
    throw new Error(`${label} 格式不正确。`);
  }
  return normalized;
}

function optionalSecretValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('secretKey 必须是字符串或空值。');
  if (!value.trim()) return null;
  return keyValue(value, 'secretKey');
}

function hostnameValue(value) {
  if (typeof value !== 'string') throw new TypeError('allowedHostnames 中的值必须是字符串。');
  const hostname = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!hostname || hostname.length > 253 || hostname.includes('/') || hostname.includes(':')) {
    throw new Error('allowedHostnames 包含无效主机名。');
  }
  if (hostname === 'localhost') return hostname;
  const labels = hostname.split('.');
  if (labels.some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new Error('allowedHostnames 包含无效主机名。');
  }
  return hostname;
}

function hostnameValues(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HOSTNAMES) {
    throw new Error(`allowedHostnames 必须包含 1–${MAX_HOSTNAMES} 个主机名。`);
  }
  const normalized = [];
  for (const candidate of value) {
    const hostname = hostnameValue(candidate);
    if (!normalized.includes(hostname)) normalized.push(hostname);
  }
  if (!normalized.length) throw new Error('allowedHostnames 不能为空。');
  return normalized;
}

function timeoutValue(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs 必须是 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数。`);
  }
  return value;
}

function actorValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('actorUserId 必须是正整数。');
  }
  return value;
}

function parseStoredHostnames(value) {
  let parsed = value;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error('stored-hostnames-invalid');
    }
  }
  return hostnameValues(parsed);
}

function timestampValue(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('stored-timestamp-missing');
    return null;
  }
  let input = value;
  if (typeof input === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(input)) {
    input = `${input.replace(' ', 'T')}Z`;
  }
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error('stored-timestamp-invalid');
  return date.toISOString();
}

function hasEncryptedSecret(row) {
  return (
    (Buffer.isBuffer(row?.secretCiphertext) || row?.secretCiphertext instanceof Uint8Array)
    && row.secretCiphertext.byteLength > 0
    && (Buffer.isBuffer(row?.secretKdfSalt) || row?.secretKdfSalt instanceof Uint8Array)
    && row.secretKdfSalt.byteLength === 16
    && (Buffer.isBuffer(row?.secretIv) || row?.secretIv instanceof Uint8Array)
    && row.secretIv.byteLength === 12
    && (Buffer.isBuffer(row?.secretAuthTag) || row?.secretAuthTag instanceof Uint8Array)
    && row.secretAuthTag.byteLength === 16
  );
}

function safeMetadata(row) {
  const result = emptyMetadata();
  try {
    result.siteKey = keyValue(row?.siteKey, 'siteKey');
  } catch {}
  try {
    result.allowedHostnames = parseStoredHostnames(row?.allowedHostnames);
  } catch {}
  try {
    result.timeoutMs = timeoutValue(Number(row?.timeoutMs));
  } catch {}
  try {
    result.verifiedAt = timestampValue(row?.verifiedAt);
  } catch {}
  try {
    result.updatedAt = timestampValue(row?.updatedAt, { required: true });
  } catch {}
  result.secretConfigured = hasEncryptedSecret(row);
  return result;
}

function storedSecret(row, env) {
  if (!hasEncryptedSecret(row)) throw new Error('stored-secret-incomplete');
  const secretKey = decryptSecret({
    ciphertext: row.secretCiphertext,
    kdfSalt: row.secretKdfSalt,
    iv: row.secretIv,
    authTag: row.secretAuthTag,
  }, { env });
  return keyValue(secretKey, 'secretKey');
}

function configuredRow(row, env) {
  const siteKey = keyValue(row.siteKey, 'siteKey');
  const allowedHostnames = parseStoredHostnames(row.allowedHostnames);
  const timeoutMs = timeoutValue(Number(row.timeoutMs));
  const verifiedAt = timestampValue(row.verifiedAt);
  const updatedAt = timestampValue(row.updatedAt, { required: true });
  const secretKey = storedSecret(row, env);

  return {
    config: {
      siteKey,
      secretKey,
      allowedHostnames,
      timeoutMs,
      verifiedAt,
      updatedAt,
    },
    metadata: {
      siteKey,
      allowedHostnames,
      timeoutMs,
      secretConfigured: true,
      verifiedAt,
      updatedAt,
    },
  };
}

async function acquireConnection(connection) {
  if (connection !== undefined && connection !== null) {
    if (typeof connection.execute !== 'function') throw new TypeError('connection 必须支持 execute。');
    return { connection, owned: false };
  }
  return { connection: await openDatabase(), owned: true };
}

function releaseOwned(connection, owned) {
  if (!owned) return;
  try {
    connection.release();
  } catch {
    // Releasing a failed pooled connection must not expose infrastructure details.
  }
}

export async function readTurnstileDatabaseConfig({ connection, env = process.env } = {}) {
  let handle;
  let row;
  try {
    handle = await acquireConnection(connection);
    const [rows] = await handle.connection.execute(SELECT_CONFIG_SQL);
    row = rows?.[0];
  } catch {
    return { status: 'unavailable', metadata: emptyMetadata() };
  } finally {
    if (handle) releaseOwned(handle.connection, handle.owned);
  }

  if (!row) return { status: 'not-configured', metadata: emptyMetadata() };

  try {
    const result = configuredRow(row, env);
    return { status: 'configured', ...result };
  } catch (error) {
    return {
      status: error?.code === 'SECRET_BOX_CONFIGURATION' ? 'unavailable' : 'invalid',
      metadata: safeMetadata(row),
    };
  }
}

export async function saveTurnstileDatabaseConfig({
  siteKey,
  secretKey,
  allowedHostnames,
  timeoutMs,
  actorUserId,
  connection,
  env = process.env,
} = {}) {
  const nextSiteKey = keyValue(siteKey, 'siteKey');
  const nextSecretKey = optionalSecretValue(secretKey);
  const nextHostnames = hostnameValues(allowedHostnames);
  const nextTimeoutMs = timeoutValue(timeoutMs);
  const nextActorUserId = actorValue(actorUserId);
  assertProductionTurnstileCredentials({ siteKey:nextSiteKey, secretKey:nextSecretKey }, env);
  const handle = await acquireConnection(connection);

  try {
    if (nextSecretKey === null) {
      const [rows] = await handle.connection.execute(SELECT_CONFIG_SQL);
      if (!rows?.[0] || !hasEncryptedSecret(rows[0])) {
        throw new Error('首次保存 Turnstile 配置时必须提供 secretKey。');
      }
      const existing = configuredRow(rows[0], env);
      assertProductionTurnstileCredentials({
        siteKey:nextSiteKey,
        secretKey:existing.config.secretKey,
      }, env);
      try {
        storedSecret(rows[0], env);
      } catch {
        throw new Error('现有 secretKey 无法安全保留，请重新输入。');
      }
      const [result] = await handle.connection.execute(`
        UPDATE turnstile_config
        SET site_key = ?,
            allowed_hostnames = ?,
            timeout_ms = ?,
            updated_by_user_id = ?,
            verified_at = NULL,
            updated_at = GREATEST(
              UTC_TIMESTAMP(3),
              TIMESTAMPADD(MICROSECOND, 1000, updated_at)
            )
        WHERE id = 1
      `, [
        nextSiteKey,
        JSON.stringify(nextHostnames),
        nextTimeoutMs,
        nextActorUserId,
      ]);
      if (Number(result?.affectedRows) !== 1) {
        throw new Error('Turnstile 配置已变化，请重试。');
      }
    } else {
      const encrypted = encryptSecret(nextSecretKey, { env });
      await handle.connection.execute(`
        INSERT INTO turnstile_config (
          id,
          site_key,
          secret_key_ciphertext,
          secret_key_kdf_salt,
          secret_key_iv,
          secret_key_auth_tag,
          allowed_hostnames,
          timeout_ms,
          updated_by_user_id,
          verified_at,
          created_at,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          site_key = VALUES(site_key),
          secret_key_ciphertext = VALUES(secret_key_ciphertext),
          secret_key_kdf_salt = VALUES(secret_key_kdf_salt),
          secret_key_iv = VALUES(secret_key_iv),
          secret_key_auth_tag = VALUES(secret_key_auth_tag),
          allowed_hostnames = VALUES(allowed_hostnames),
          timeout_ms = VALUES(timeout_ms),
          updated_by_user_id = VALUES(updated_by_user_id),
          verified_at = NULL,
          updated_at = GREATEST(
            UTC_TIMESTAMP(3),
            TIMESTAMPADD(MICROSECOND, 1000, updated_at)
          )
      `, [
        nextSiteKey,
        encrypted.ciphertext,
        encrypted.kdfSalt,
        encrypted.iv,
        encrypted.authTag,
        JSON.stringify(nextHostnames),
        nextTimeoutMs,
        nextActorUserId,
      ]);
    }

    const [rows] = await handle.connection.execute(SELECT_CONFIG_SQL);
    const row = rows?.[0];
    if (!row) throw new Error('Turnstile 配置保存失败。');
    const updatedAt = timestampValue(row.updatedAt, { required: true });
    return {
      siteKey: nextSiteKey,
      allowedHostnames: nextHostnames,
      timeoutMs: nextTimeoutMs,
      secretConfigured: hasEncryptedSecret(row),
      verifiedAt: null,
      updatedAt,
    };
  } finally {
    releaseOwned(handle.connection, handle.owned);
  }
}

export async function markTurnstileDatabaseVerified({
  expectedUpdatedAt,
  connection,
} = {}) {
  const normalizedExpected = timestampValue(expectedUpdatedAt, { required: true });
  const expectedDate = new Date(normalizedExpected);
  const handle = await acquireConnection(connection);

  try {
    const [result] = await handle.connection.execute(`
      UPDATE turnstile_config
      SET verified_at = UTC_TIMESTAMP(3),
          updated_at = updated_at
      WHERE id = 1
        AND updated_at = ?
    `, [expectedDate]);
    if (Number(result?.affectedRows) !== 1) {
      throw new Error('配置已变化，请重新验证。');
    }

    const [rows] = await handle.connection.execute(`
      SELECT verified_at AS verifiedAt, updated_at AS updatedAt
      FROM turnstile_config
      WHERE id = 1 AND updated_at = ?
      LIMIT 1
    `, [expectedDate]);
    if (!rows?.[0]) throw new Error('配置已变化，请重新验证。');
    return {
      verifiedAt: timestampValue(rows[0].verifiedAt, { required: true }),
      updatedAt: timestampValue(rows[0].updatedAt, { required: true }),
    };
  } finally {
    releaseOwned(handle.connection, handle.owned);
  }
}
