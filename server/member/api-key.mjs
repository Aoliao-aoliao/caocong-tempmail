import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { decryptApiKey, encryptApiKey } from '../security/secret-box.mjs';

const BASE_RATE_LIMIT = 30;

// Explicit overrides are durable settings, not audit history.
export async function resolveApiRateLimit(connection, { publicId, userId, multiplier }) {
  if (multiplier === undefined) {
    const [[membership]] = await connection.execute(`
      SELECT mp.api_limit_multiplier FROM memberships ms
      JOIN membership_plans mp ON mp.id=ms.plan_id
      WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
      ORDER BY ms.expires_at DESC LIMIT 1
    `,[userId]);
    multiplier=Number(membership?.api_limit_multiplier || 1);
  }
  const [[stored]]=await connection.execute('SELECT o.rate_limit,o.source_audit_id FROM api_rate_overrides o JOIN api_keys k ON k.id=o.api_key_id WHERE k.public_id=?',[publicId]);
  const [[override]] = await connection.execute(`
    SELECT id,JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.after.rateLimit')) AS rate_limit
    FROM audit_logs WHERE entity_type='API_KEY' AND entity_id=? AND action='更新 API 密钥'
      AND JSON_EXTRACT(detail_json,'$.after.rateLimit') IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `,[publicId]);
  if(stored&&(!override||Number(stored.source_audit_id)>=Number(override.id)))return normalizedRateLimit(Number(stored.rate_limit));
  return normalizedRateLimit(override ? Number(override.rate_limit) : BASE_RATE_LIMIT * Number(multiplier));
}


function normalizedRateLimit(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 100000) : BASE_RATE_LIMIT;
}

function encryptedFields(row) {
  return {
    ciphertext:row?.key_ciphertext,
    kdfSalt:row?.key_kdf_salt,
    iv:row?.key_iv,
    authTag:row?.key_auth_tag,
  };
}

function hasEncryptedKey(row) {
  const fields = encryptedFields(row);
  return Buffer.isBuffer(fields.ciphertext)
    && fields.ciphertext.length > 0
    && Buffer.isBuffer(fields.kdfSalt)
    && fields.kdfSalt.length === 16
    && Buffer.isBuffer(fields.iv)
    && fields.iv.length === 12
    && Buffer.isBuffer(fields.authTag)
    && fields.authTag.length === 16;
}

export function apiKeyPublicValue(row) {
  if (!row) return null;
  let key = null;
  let requiresReset = !hasEncryptedKey(row);
  if (!requiresReset) {
    try {
      key = decryptApiKey(encryptedFields(row));
    } catch (error) {
      if (error?.code !== 'SECRET_BOX_INVALID_DATA') throw error;
      requiresReset = true;
    }
  }
  return {
    id:row.public_id,
    key,
    key_prefix:row.key_prefix,
    status:row.status,
    rate_limit_per_minute:Number(row.rate_limit_per_minute || BASE_RATE_LIMIT),
    last_used_at:row.last_used_at instanceof Date ? row.last_used_at.toISOString() : row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    created_at:row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ? new Date(row.created_at).toISOString() : null,
    requires_reset:requiresReset,
  };
}

export async function insertApiKey(connection, { userId, rateLimit = BASE_RATE_LIMIT }) {
  const key = randomBytes(16).toString('hex');
  const prefix = key.slice(0, 12);
  const hash = createHash('sha256').update(key).digest('hex');
  const encrypted = encryptApiKey(key);
  const publicId = `AK-${randomUUID()}`;
  const limit = normalizedRateLimit(rateLimit);
  await connection.execute(`
    INSERT INTO api_keys(
      public_id,user_id,key_prefix,key_hash,key_ciphertext,key_kdf_salt,key_iv,key_auth_tag,
      status,rate_limit_per_minute
    ) VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?)
  `, [
    publicId,userId,prefix,hash,encrypted.ciphertext,encrypted.kdfSalt,encrypted.iv,
    encrypted.authTag,limit,
  ]);
  return {
    id:publicId,
    key,
    key_prefix:prefix,
    status:'ACTIVE',
    rate_limit_per_minute:limit,
    last_used_at:null,
    created_at:new Date().toISOString(),
    requires_reset:false,
  };
}

export async function ensureUserApiKey(userId) {
  const connection = await openDatabase();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!user) throw Object.assign(new Error('账户不存在。'), { status:404 });
    const [[row]] = await connection.execute(`
      SELECT public_id,key_prefix,status,rate_limit_per_minute,last_used_at,created_at,
             key_ciphertext,key_kdf_salt,key_iv,key_auth_tag
      FROM api_keys
      WHERE user_id=? AND status IN ('ACTIVE','DISABLED')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `, [userId]);
    if (row) {
      const current = apiKeyPublicValue(row);
      current.rate_limit_per_minute=await resolveApiRateLimit(connection,{publicId:row.public_id,userId});
      if (current.status === 'DISABLED' || !current.requires_reset) {
        await connection.commit();
        return current;
      }

      // A hash-only legacy key cannot be shown again. Keep it active for backwards
      // compatibility, but issue one recoverable replacement so existing accounts
      // receive the same ready-to-use default API Key as newly registered accounts.
      // The user row lock serializes simultaneous overview/docs requests, so this
      // creates at most one replacement.
      const [[membership]] = await connection.execute(`
        SELECT mp.api_limit_multiplier
        FROM memberships ms
        JOIN membership_plans mp ON mp.id=ms.plan_id
        WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
        ORDER BY ms.expires_at DESC
        LIMIT 1
      `, [userId]);
      const result = await insertApiKey(connection, {
        userId,
        rateLimit:BASE_RATE_LIMIT * Number(membership?.api_limit_multiplier || 1),
      });
      await connection.execute(`
        INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json)
        VALUES (?,?,'系统补发 API Key','API_KEY',?,?)
      `, [
        `AL-${randomUUID()}`,
        userId,
        result.id,
        JSON.stringify({ preservedLegacyKeyId:row.public_id }),
      ]);
      await connection.commit();
      return result;
    }

    const [[membership]] = await connection.execute(`
      SELECT mp.api_limit_multiplier
      FROM memberships ms
      JOIN membership_plans mp ON mp.id=ms.plan_id
      WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
      ORDER BY ms.expires_at DESC
      LIMIT 1
    `, [userId]);
    const result = await insertApiKey(connection, {
      userId,
      rateLimit:BASE_RATE_LIMIT * Number(membership?.api_limit_multiplier || 1),
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export const defaultApiRateLimit = BASE_RATE_LIMIT;
