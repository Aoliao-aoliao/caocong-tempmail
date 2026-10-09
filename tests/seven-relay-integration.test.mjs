import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

test('cleanup authentication and routing capacity on disposable MySQL only', { timeout: 90000 }, async t => {
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS, '1');
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE, 'nodemail_ci');
  const { openDatabase, closeDatabasePool } = await import('../server/db/database.mjs');
  const { encryptRelayCredential, encryptMicrosoft } = await import('../server/security/secret-box.mjs');
  const { createRelayClient } = await import('../server/relay/connection.mjs');
  const { runRelayRemoteCleanup } = await import('../server/relay/cleanup.mjs');
  const { createMicrosoftOAuthService } = await import('../server/relay/microsoft-oauth.mjs');
  const { chooseRoutedAccount, relayPublicRoutes } = await import('../server/relay/address-routes.mjs');
  const c = await openDatabase();
  const prefix = `seven-${randomUUID()}`;
  const suffix = `${prefix}.example.test`;
  const accountIds = [], settingsBefore = new Map(), tokenKeys = [];
  let userId, domainId;
  const pack = value => Object.fromEntries(Object.entries(encryptMicrosoft(JSON.stringify(value))).map(([k, v]) => [k, v.toString('base64')]));
  const writeSetting = (key, value) => c.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)", [key, JSON.stringify(value)]);
  const addAccount = async (provider = 'CUSTOM', maxAliases = 1, accountSuffix = suffix) => {
    const email = `${randomUUID()}@${accountSuffix}`, publicId = `RA-${randomUUID()}`;
    const credential = encryptRelayCredential(provider === 'OUTLOOK' ? 'MICROSOFT_OAUTH_PENDING' : 'synthetic-password');
    const [row] = await c.execute(`INSERT INTO relay_accounts(public_id,provider,email,suffix,imap_host,username,max_aliases,status,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`, [publicId, provider, email, accountSuffix, provider === 'OUTLOOK' ? 'outlook.office365.com' : '127.0.0.1', email, maxAliases, credential.ciphertext, credential.kdfSalt, credential.iv, credential.authTag]);
    accountIds.push(row.insertId);
    return (await c.execute('SELECT * FROM relay_accounts WHERE id=?', [row.insertId]))[0][0];
  };
  const addBox = (db, account) => db.execute(`INSERT INTO mailboxes(public_id,user_id,domain_id,relay_account_id,address,duration_minutes,expires_at)
    VALUES (?,?,?,?,?,60,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))`, [`MB-${randomUUID()}`, userId, domainId, account.id, `${randomUUID()}@${suffix}`]);
  const route = async () => {
    const db = await openDatabase();
    try { await db.beginTransaction(); return await chooseRoutedAccount(db, suffix); }
    finally { await db.rollback(); db.release(); }
  };
  try {
    for (const key of ['relay_remote_cleanup_enabled', 'microsoft_relay_config']) {
      settingsBefore.set(key, (await c.execute('SELECT value,value_type FROM system_settings WHERE `key`=?', [key]))[0][0]);
    }
    userId = (await c.execute("INSERT INTO users(public_id,email,password_hash) VALUES (?,?,'synthetic-unusable')", [`U-${randomUUID()}`, `${prefix}@example.test`]))[0].insertId;
    domainId = (await c.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'RELAY','ACTIVE','ACTIVE')", [suffix]))[0].insertId;

    await t.test('ten full small accounts cannot hide the eleventh available physical account or its mapped route', async () => {
      for (let index = 0; index < 10; index++) await addBox(c, await addAccount());
      const available = await addAccount('CUSTOM', 500, `${prefix}-other.example.test`);
      await c.execute('INSERT INTO relay_account_addresses(relay_account_id,address) VALUES (?,?)', [available.id, `mapped@${suffix}`]);
      await addBox(c, available); await addBox(c, available);
      assert.ok((await relayPublicRoutes()).some(row => row.suffix === suffix));
      assert.equal((await route()).id, available.id);
      assert.equal((await route()).routing_email, `mapped@${suffix}`);
      await c.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?", [available.id]);
      await assert.rejects(route(), error => error.status === 409);
      await c.execute('DELETE FROM mailboxes WHERE relay_account_id=?', [available.id]);
      await c.execute("UPDATE relay_accounts SET status='ACTIVE',max_aliases=1 WHERE id=?", [available.id]);

      // B takes a stale candidate snapshot while A owns the same account lock.
      // After A consumes the last slot, B must observe the committed usage.
      const first = await openDatabase(), second = await openDatabase();
      let pending;
      try {
        await first.beginTransaction(); await second.beginTransaction();
        const selected = await chooseRoutedAccount(first, suffix);
        let selectedCandidates;
        const seen = new Promise(resolve => { selectedCandidates = resolve; });
        pending = chooseRoutedAccount({ execute: async (sql, parameters) => {
          const result = await second.execute(sql, parameters);
          if (sql.startsWith('SELECT DISTINCT')) selectedCandidates();
          return result;
        } }, suffix).then(value => ({ value }), error => ({ error }));
        await Promise.race([seen, pending.then(outcome => { throw outcome.error || Error('Second allocation completed before the locked-capacity check'); })]);
        await addBox(first, selected); await first.commit();
        assert.equal((await pending).error?.status, 409);
        assert.equal(Number((await c.execute('SELECT COUNT(*) n FROM mailboxes WHERE relay_account_id=?', [available.id]))[0][0].n), 1);
      } finally {
        await first.rollback();
        if (pending) await pending;
        await second.rollback(); first.release(); second.release();
      }
    });

    await t.test('actual due-job projection authenticates Outlook via stored OAuth and Gmail via password', async () => {
      const [[existing]] = await c.execute("SELECT COUNT(*) n FROM relay_remote_cleanup_jobs WHERE status IN ('PENDING','RETRY') AND next_attempt_at<=UTC_TIMESTAMP(3)");
      assert.equal(Number(existing.n), 0, 'cleanup fixture requires no unrelated due jobs');
      await writeSetting('relay_remote_cleanup_enabled', true);
      const revision = randomUUID(), clientId = '12345678-1234-1234-1234-123456789012';
      await writeSetting('microsoft_relay_config', { clientId, revision, secret: pack({ clientSecret: 'synthetic-client-secret' }) });
      const outlook = await addAccount('OUTLOOK', 1, 'hotmail.com'), gmail = await addAccount('GMAIL', 1, 'gmail.com');
      const key = `microsoft_relay_token:${outlook.public_id}`; tokenKeys.push(key);
      await writeSetting(key, { clientId, configRevision: revision, reauthRequired: false, secret: pack({ email: outlook.email, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000 }) });
      for (const account of [outlook, gmail]) await c.execute('INSERT INTO relay_remote_cleanup_jobs(relay_account_id,uid_validity,imap_uid) VALUES (?,7,42)', [account.id]);
      const auth = [], moves = [], observed = [];
      const oauth = createMicrosoftOAuthService({ fetcher: async () => { throw Error('No network permitted in cleanup fixture'); } });
      const result = await runRelayRemoteCleanup({ batchSize: 200 }, { createClient: async account => {
        observed.push(account);
        assert.ok([outlook.id, gmail.id].includes(Number(account.relay_account_id)), 'fixture cannot handle unrelated cleanup jobs');
        return createRelayClient(account, {
          resolveTarget: async host => ({ address: '192.0.2.1', hostname: host }),
          getAccessToken: value => oauth.accessToken(value),
          Client: class extends EventEmitter {
            constructor(options) { super(); auth.push(options.auth); this.mailbox = { uidValidity: 7 }; }
            async connect() {} async list() { return [{ specialUse: '\\Trash', path: 'Trash' }]; }
            async getMailboxLock() { return { release() {} }; } async search() { return [42]; }
            async messageMove(uid, path) { moves.push([account.relay_account_id, uid, path]); return true; }
            async logout() {}
          },
        });
      } });
      assert.equal(result.processed, 2);
      assert.equal(observed.find(row => row.provider === 'OUTLOOK').public_id, outlook.public_id);
      assert.deepEqual(auth.find(value => value.user === outlook.email), { user: outlook.email, accessToken: 'synthetic-access' });
      assert.deepEqual(auth.find(value => value.user === gmail.email), { user: gmail.email, pass: 'synthetic-password' });
      assert.equal(moves.length, 2);
      const [jobs] = await c.execute('SELECT status FROM relay_remote_cleanup_jobs WHERE relay_account_id IN (?,?)', [outlook.id, gmail.id]);
      assert.deepEqual(jobs.map(job => job.status), ['DONE', 'DONE']);
    });
  } finally {
    for (const key of tokenKeys) await c.execute('DELETE FROM system_settings WHERE `key`=?', [key]);
    for (const [key, previous] of settingsBefore) {
      if (previous) await c.execute('INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=VALUES(value),value_type=VALUES(value_type)', [key, previous.value, previous.value_type]);
      else await c.execute('DELETE FROM system_settings WHERE `key`=?', [key]);
    }
    if (userId) await c.execute('DELETE FROM users WHERE id=?', [userId]);
    for (const id of accountIds) await c.execute('DELETE FROM relay_accounts WHERE id=?', [id]);
    if (domainId) await c.execute('DELETE FROM domains WHERE id=?', [domainId]);
    c.release(); await closeDatabasePool();
  }
});
