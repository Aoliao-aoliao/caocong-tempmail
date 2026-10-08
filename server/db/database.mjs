import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const databaseConfig = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE || 'nodemail',
  user: process.env.MYSQL_USER || 'nodemail',
  password: process.env.MYSQL_PASSWORD || '',
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
};

export const databaseLabel = `${databaseConfig.host}:${databaseConfig.port}/${databaseConfig.database}`;

let pool;

function validateDatabaseConfig() {
  if (!Number.isInteger(databaseConfig.port) || databaseConfig.port < 1 || databaseConfig.port > 65535) {
    throw new Error('MYSQL_PORT 必须是有效端口。');
  }
  if (!Number.isInteger(databaseConfig.connectionLimit) || databaseConfig.connectionLimit < 1 || databaseConfig.connectionLimit > 100) {
    throw new Error('MYSQL_CONNECTION_LIMIT 必须是 1–100 之间的整数。');
  }
  if (!databaseConfig.host || !databaseConfig.database || !databaseConfig.user) {
    throw new Error('MYSQL_HOST、MYSQL_DATABASE 和 MYSQL_USER 不能为空。');
  }
  if (process.env.NODE_ENV === 'production' && !databaseConfig.password) {
    throw new Error('生产环境必须设置 MYSQL_PASSWORD。');
  }
}

export function getDatabasePool() {
  if (!pool) {
    validateDatabaseConfig();
    pool = mysql.createPool({
      ...databaseConfig,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      timezone: 'Z',
      charset: 'utf8mb4',
      decimalNumbers: true,
    });
  }
  return pool;
}

export async function openDatabase() {
  return getDatabasePool().getConnection();
}

export async function closeDatabasePool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const recoverableMigrationSchemas = new Map([
  ['006_api_key_secret.sql', {
    table:'api_keys',
    columns:new Map([
      ['key_ciphertext', { type:'varbinary', length:512, nullable:true }],
      ['key_kdf_salt', { type:'binary', length:16, nullable:true }],
      ['key_iv', { type:'binary', length:12, nullable:true }],
      ['key_auth_tag', { type:'binary', length:16, nullable:true }],
    ]),
  }],
  ['007_mailbox_idempotency.sql', {
    table:'mailboxes',
    columns:new Map([
      ['request_id', { type:'char', length:36, nullable:true }],
    ]),
    indexes:new Map([
      ['uq_mailboxes_user_request', { unique:true, columns:['user_id', 'request_id'] }],
    ]),
  }],
  ['008_mailbox_recall.sql', {
    table:'mailbox_recall_requests',
    columns:new Map([
      ['public_id', { type:'varchar', length:64, nullable:false }],
      ['request_id', { type:'char', length:36, nullable:false }],
      ['user_id', { type:'bigint', length:null, nullable:false }],
      ['mailbox_id', { type:'bigint', length:null, nullable:false }],
      ['duration_minutes', { type:'int', length:null, nullable:false }],
      ['price_points', { type:'bigint', length:null, nullable:false }],
      ['points_balance_after', { type:'bigint', length:null, nullable:false }],
      ['expires_at', { type:'datetime', length:null, nullable:false }],
    ]),
    indexes:new Map([
      ['uq_mailbox_recall_public_id', { unique:true, columns:['public_id'] }],
      ['uq_mailbox_recall_user_request', { unique:true, columns:['user_id', 'request_id'] }],
      ['idx_mailbox_recall_mailbox_created', { unique:false, columns:['mailbox_id', 'created_at'] }],
    ]),
  }],
  ['011_domain_dns_monitor.sql', {
    table:'domains',
    columns:new Map([
      ['mx_checked_at', { type:'datetime', length:null, nullable:true }],
      ['mx_records_json', { type:'json', length:null, nullable:true }],
      ['mx_error', { type:'varchar', length:500, nullable:true }],
    ]),
  }],
]);

export function migrationLockName(databaseName) {
  const databaseHash = createHash('sha256').update(String(databaseName || '')).digest('hex').slice(0, 40);
  return `nodemail:migrate:${databaseHash}`;
}

export async function isRecoverableMigrationComplete(connection, version) {
  const schema = recoverableMigrationSchemas.get(version);
  if (!schema) return false;

  const [columnRows] = await connection.execute(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
  `, [schema.table]);
  const actualColumns = new Map(columnRows.map((row) => [String(row.COLUMN_NAME).toLowerCase(), row]));
  for (const [name, expected] of schema.columns) {
    const actual = actualColumns.get(name);
    if (!actual) return false;
    if (String(actual.DATA_TYPE).toLowerCase() !== expected.type) return false;
    if (expected.length !== null && Number(actual.CHARACTER_MAXIMUM_LENGTH) !== expected.length) return false;
    if ((String(actual.IS_NULLABLE).toUpperCase() === 'YES') !== expected.nullable) return false;
  }

  if (!schema.indexes) return true;
  const [indexRows] = await connection.execute(`
    SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
    ORDER BY INDEX_NAME, SEQ_IN_INDEX
  `, [schema.table]);
  for (const [name, expected] of schema.indexes) {
    const actual = indexRows
      .filter((row) => String(row.INDEX_NAME) === name)
      .sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX));
    if (actual.length !== expected.columns.length) return false;
    if ((Number(actual[0]?.NON_UNIQUE) === 0) !== expected.unique) return false;
    if (!expected.columns.every((column, index) => String(actual[index]?.COLUMN_NAME).toLowerCase() === column)) return false;
  }
  return true;
}

export async function migrateDatabase(connection) {
  const lockName = migrationLockName(databaseConfig.database);
  const [[lockResult]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
  if (Number(lockResult?.acquired) !== 1) {
    throw new Error('无法获取数据库迁移锁，请稍后重试。');
  }

  let migrationError;
  try {
    await connection.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    const migrationDir = resolve(moduleDir, 'migrations');
    const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();

    for (const file of files) {
      const [applied] = await connection.execute('SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1', [file]);
      if (applied.length) continue;

      if (await isRecoverableMigrationComplete(connection, file)) {
        await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
        continue;
      }

      const sql = await readFile(resolve(migrationDir, file), 'utf8');
      try {
        for (const statement of splitSqlStatements(sql)) await connection.query(statement);
      } catch (error) {
        if (!await isRecoverableMigrationComplete(connection, file)) throw error;
      }
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
    }
  } catch (error) {
    migrationError = error;
    throw error;
  } finally {
    try {
      await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
    } catch (releaseError) {
      if (!migrationError) throw releaseError;
    }
  }
}
