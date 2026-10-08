import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, databaseConfig, migrateDatabase, openDatabase } from '../../server/db/database.mjs';
import { seedDatabase } from '../../server/db/seed.mjs';

const markerKey = 'distribution_installation';
const migrationDirectory = new URL('../../server/db/migrations/', import.meta.url);
export const installationLock = () => `nodemail:install:${createHash('sha256').update(databaseConfig.database).digest('hex').slice(0, 40)}`;

export async function schemaManifest() {
  const files = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(files.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(new URL(name, migrationDirectory))).digest('hex') })));
}

function secretProof(env = process.env) {
  const secret = env.GUEST_SESSION_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('GUEST_SESSION_SECRET must contain at least 32 bytes and must be preserved across upgrades.');
  return createHmac('sha256', secret).update('nodemail:distribution:installation:v1').digest('hex');
}

export async function verifyInstallation(connection, { manifest, env = process.env } = {}) {
  const [[row]] = await connection.execute('SELECT value FROM system_settings WHERE `key`=?', [markerKey]);
  if (!row) throw new Error('This database was not initialized by the standalone installer. Existing installations require a separately reviewed migration.');
  let marker;
  try { marker = JSON.parse(row.value); } catch { throw new Error('Invalid standalone installation marker.'); }
  if (marker.format !== 1 || marker.secretProof !== secretProof(env)) throw new Error('Installation identity or master secret changed. Restore the original .env; do not reinitialize.');
  const expected = manifest || await schemaManifest();
  if (JSON.stringify(marker.schema) !== JSON.stringify(expected)) throw new Error('Schema changes require a reviewed upgrade; this installer will not migrate an existing database.');
  const [versions] = await connection.execute('SELECT version FROM schema_migrations ORDER BY version');
  if (JSON.stringify(versions.map(row => row.version)) !== JSON.stringify(expected.map(item => item.name))) throw new Error('Database migration registry does not match the release.');
  return marker;
}

export async function initializeInstallation({ env = process.env } = {}) {
  const proof = secretProof(env), manifest = await schemaManifest();
  const connection = await openDatabase(); let locked = false;
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [installationLock()]);
    if (Number(lock.acquired) !== 1) throw new Error('Another installation is running.');
    locked = true;
    const [[tables]] = await connection.execute('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (Number(tables.count) !== 0) throw new Error('Initialization requires a completely empty database. It never resets or repairs existing data.');
    await migrateDatabase(connection);
    await seedDatabase(connection);
    await connection.beginTransaction();
    await connection.execute("INSERT INTO system_settings(`key`,value,value_type) VALUES (?,?,'json')", [markerKey, JSON.stringify({ format: 1, schema: manifest, secretProof: proof })]);
    // Safe only here: this is a brand-new database with no legacy audit receipts to backfill.
    await connection.execute("INSERT INTO system_settings(`key`,value,value_type) VALUES ('audit_retention_ready','true','boolean')");
    await connection.commit();
    await verifyInstallation(connection, { manifest, env });
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [installationLock()]); }
    finally { connection.release(); }
  }
}

export async function checkInstallation(options) {
  const connection = await openDatabase();
  try { await verifyInstallation(connection, options); } finally { connection.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'init') await initializeInstallation();
    else if (process.argv[2] === 'check') await checkInstallation();
    else throw new Error('Usage: node distribution/runtime/setup.mjs init|check');
    console.info('Standalone database verification completed.');
  } catch (error) {
    // Do not print database errors, SQL, credentials or stack traces from failed initialization.
    console.error(error instanceof Error && !('sql' in error) ? error.message : 'Database initialization or verification failed. Existing data was not reset.');
    process.exitCode = 1;
  } finally { await closeDatabasePool(); }
}
