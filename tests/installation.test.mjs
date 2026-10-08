import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('standalone fresh installation, concurrent bootstrap and data-preserving release checks', { timeout: 120000 }, async t => {
  // This suite must run BEFORE ordinary db:init, in its own empty disposable database.
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS, '1');
  assert.equal(process.env.NODEMAIL_DISTRIBUTION_FRESH_TEST, '1');
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE, 'nodemail_ci');
  const root = process.env.NODEMAIL_DISTRIBUTION_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
  assert.ok(isAbsolute(root), 'The unpacked release root must be an absolute local filesystem path.');
  const releaseImport = relative => import(pathToFileURL(resolve(root, relative)).href);
  const { openDatabase, closeDatabasePool } = await releaseImport('server/db/database.mjs');
  const { initializeInstallation, checkInstallation, schemaManifest } = await releaseImport('distribution/runtime/setup.mjs');
  const { bootstrapAdministrator } = await releaseImport('distribution/runtime/bootstrap.mjs');
  const { authenticateUser } = await releaseImport('server/auth/service.mjs');
  const { apiKeyPublicValue } = await releaseImport('server/member/api-key.mjs');
  const db = await openDatabase(), marker = randomUUID(), password = `Synthetic-${randomUUID()}`, email = `install-${marker}@example.test`;
  const directory = await mkdtemp(join(tmpdir(), 'nodemail-distribution-data-'));
  let userId, domainId, oldMinutes;
  try {
    const [[tables]] = await db.execute('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(Number(tables.count), 0, 'Refuse to run fresh-install tests against any existing schema.');
    await t.test('two concurrent init calls create one schema and reject the other without reset', async () => {
      const results = await Promise.allSettled([initializeInstallation(), initializeInstallation()]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.match(results.find(result => result.status === 'rejected').reason.message, /completely empty/);
      await checkInstallation();
      const [[ready]] = await db.execute("SELECT value FROM system_settings WHERE `key`='audit_retention_ready'");
      assert.equal(ready.value, 'true');
      for (const table of ['users', 'domains', 'mailboxes', 'messages', 'relay_accounts', 'recharge_orders', 'telegram_bindings']) {
        const [[row]] = await db.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
        assert.equal(Number(row.count), 0, `${table} must not contain real or demo business data`);
      }
    });
    await t.test('concurrent bootstrap creates only one administrator with no preset password or bonus', async () => {
      const results = await Promise.allSettled([bootstrapAdministrator(email, password), bootstrapAdministrator(`other-${email}`, password)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      userId = results.find(result => result.status === 'fulfilled').value;
      const [[user]] = await db.execute('SELECT email,role,points_balance FROM users WHERE id=?', [userId]);
      assert.equal(user.role, 'SUPER_ADMIN');
      assert.equal(Number(user.points_balance), 0);
      assert.equal((await authenticateUser({ email: user.email, password })).ok, true);
      await assert.rejects(bootstrapAdministrator(`third-${email}`, password), /only allowed once/);
    });
    await t.test('candidate verification preserves accounts, mail, receipts, settings and encrypted API keys', async () => {
      oldMinutes = (await db.execute("SELECT value FROM system_settings WHERE `key`='free_mailbox_minutes'"))[0][0].value;
      await db.execute("UPDATE system_settings SET value='121' WHERE `key`='free_mailbox_minutes'");
      await db.execute('UPDATE users SET points_balance=123 WHERE id=?', [userId]);
      await db.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,note) VALUES (?,?,'ADMIN_ADJUSTMENT',123,123,'isolated install fixture')", [`PT-${marker}`, userId]);
      await db.execute("INSERT INTO business_receipts(public_id,user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,'isolated fixture','TEST',?,'{\"preserve\":true}')", [`BR-${marker}`, userId, marker]);
      const [domain] = await db.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'PUBLIC','DISABLED','PENDING')", [`install-${marker}.example.test`]);
      domainId = domain.insertId;
      const [box] = await db.execute("INSERT INTO mailboxes(public_id,user_id,domain_id,address,status,expires_at) VALUES (?,?,?,?,'ACTIVE',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))", [`MB-${marker}`, userId, domainId, `fixture@install-${marker}.example.test`]);
      const [message] = await db.execute("INSERT INTO messages(public_id,mailbox_id,from_address,subject,text_content,received_at) VALUES (?,?,'synthetic@example.test','fixture','preserve this synthetic message',UTC_TIMESTAMP(3))", [`MSG-${marker}`, box.insertId]);
      await db.execute("INSERT INTO message_attachments(message_id,file_name,storage_key,size_bytes) VALUES (?,'fixture.txt',?,7)", [message.insertId, marker]);
      await writeFile(join(directory, marker), 'fixture');
      const tables = ['users', 'api_keys', 'point_transactions', 'business_receipts', 'domains', 'mailboxes', 'messages', 'message_attachments', 'system_settings'];
      const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, JSON.stringify((await db.query(`SELECT * FROM \`${table}\``))[0])])));
      const before = await snapshot();
      const [[key]] = await db.execute('SELECT * FROM api_keys WHERE user_id=?', [userId]);
      const clearKey = apiKeyPublicValue(key).key;
      assert.ok(clearKey);
      await checkInstallation(); await checkInstallation();
      assert.deepEqual(await snapshot(), before);
      const [[afterKey]] = await db.execute('SELECT * FROM api_keys WHERE user_id=?', [userId]);
      assert.equal(apiKeyPublicValue(afterKey).key, clearKey);
      assert.equal(createHash('sha256').update(await readFile(join(directory, marker))).digest('hex'), createHash('sha256').update('fixture').digest('hex'));
    });
    await t.test('changed schema, changed master secret and repeated initialization are rejected without mutation', async () => {
      const manifest = await schemaManifest();
      await assert.rejects(checkInstallation({ manifest: [...manifest, { name: '999_unreviewed.sql', sha256: '0'.repeat(64) }] }), /reviewed upgrade/);
      await assert.rejects(checkInstallation({ manifest: manifest.map((item, index) => index ? item : { ...item, sha256: '0'.repeat(64) }) }), /reviewed upgrade/);
      await assert.rejects(checkInstallation({ env: { ...process.env, GUEST_SESSION_SECRET: 'different-installation-secret-at-least-32-bytes' } }), /master secret changed/);
      await assert.rejects(initializeInstallation(), /completely empty/);
      const [[user]] = await db.execute('SELECT points_balance FROM users WHERE id=?', [userId]);
      assert.equal(Number(user.points_balance), 123);
      await checkInstallation();
    });
  } finally {
    if (userId) {
      await db.execute('DELETE FROM point_transactions WHERE user_id=?', [userId]);
      await db.execute('DELETE FROM users WHERE id=?', [userId]);
    }
    if (domainId) await db.execute('DELETE FROM domains WHERE id=?', [domainId]);
    if (oldMinutes !== undefined) await db.execute("UPDATE system_settings SET value=? WHERE `key`='free_mailbox_minutes'", [oldMinutes]);
    db.release(); await closeDatabasePool();
    await rm(directory, { recursive: true, force: true });
  }
});
