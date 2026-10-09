import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('relay recall generation and source protection against disposable MySQL', { timeout: 90000 }, async t => {
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS, '1');
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE, 'nodemail_ci');
  const { openDatabase, closeDatabasePool } = await import('../server/db/database.mjs');
  const { saveDelivery } = await import('../server/mail/repository.mjs');
  const { recallMailbox } = await import('../server/member/mailbox-recall.mjs');
  const { resolveMailboxRecallPlan } = await import('../server/member/mailbox-recall-policy.mjs');
  const { hasProtectedRelayReference } = await import('../server/relay/cleanup.mjs');
  const { runMailboxMaintenance } = await import('../server/mail/maintenance.mjs');
  const { AttachmentStore } = await import('../server/mail/attachment-store.mjs');
  const { encryptRelayCredential } = await import('../server/security/secret-box.mjs');
  const connection = await openDatabase();
  const suffix = randomUUID();
  const storage = await mkdtemp(join(tmpdir(), 'nodemail-relay-regression-'));
  const previousStorage = process.env.MAIL_ATTACHMENT_DIR;
  process.env.MAIL_ATTACHMENT_DIR = storage;
  const attachmentStore = new AttachmentStore(storage);
  await attachmentStore.initialize();
  let userId, domainId, accountId, previousCleanup;
  try {
    const [[cleanupSetting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='relay_remote_cleanup_enabled'");
    previousCleanup = cleanupSetting?.value;
    await connection.execute("INSERT INTO system_settings (`key`,value,value_type) VALUES ('relay_remote_cleanup_enabled','true','boolean') ON DUPLICATE KEY UPDATE value='true'");
    const [[durationSetting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'");
    const plan = resolveMailboxRecallPlan({ rawPlans: durationSetting.value, durationHours: 24 });
    const [user] = await connection.execute("INSERT INTO users(public_id,email,password_hash,points_balance) VALUES (?,?,'synthetic-unusable-hash',10000)", [`U-${randomUUID()}`, `relay-review-${suffix}@example.com`]);
    userId = user.insertId;
    const domain = `relay-review-${suffix}.example.com`;
    const [domainRow] = await connection.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,'PUBLIC','ACTIVE','ACTIVE')", [domain]);
    domainId = domainRow.insertId;
    const encrypted = encryptRelayCredential('synthetic-never-used-credential');
    // Loopback is intentionally rejected by the IMAP guard. A broken cleanup
    // assertion must never accidentally open a connection to a real provider.
    const [account] = await connection.execute(`
      INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status)
      VALUES (?,?,?,'127.0.0.1','synthetic',?,?,?,?,'ACTIVE')
    `, [`RA-${randomUUID()}`, `relay-review-${suffix}@example.com`, 'example.com', encrypted.ciphertext, encrypted.kdfSalt, encrypted.iv, encrypted.authTag]);
    accountId = account.insertId;

    const makeBox = async name => {
      const publicId = `MB-${randomUUID()}`;
      const [result] = await connection.execute(`
        INSERT INTO mailboxes(public_id,user_id,domain_id,relay_account_id,address,duration_minutes,expires_at,created_at)
        VALUES (?,?,?,?,?,60,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),'2020-01-01 00:00:00.000')
      `, [publicId, userId, domainId, accountId, `${name}@${domain}`]);
      return { id: result.insertId, publicId };
    };
    const source = uid => ({ relay_account_id: accountId, uid_validity: 1, imap_uid: uid });
    const link = (box, uid) => connection.execute('INSERT INTO relay_message_links(relay_account_id,uid_validity,imap_uid,mailbox_id) VALUES (?,1,?,?)', [accountId, uid, box.id]);
    const expire = box => connection.execute("UPDATE mailboxes SET status='EXPIRED',expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?", [box.id]);
    const recall = box => recallMailbox({ userId, mailboxId: box.publicId, durationHours: 24, expectedPrice: plan.price, requestId: randomUUID(), captchaVerified: true });
    const first = await makeBox('first');
    const shared = await makeBox('shared');

    await t.test('ERROR account can really poll, persist delivery and recover to ACTIVE',async()=>{
      const {pollAccount}=await import('../server/relay/poller.mjs');
      await connection.execute("UPDATE relay_accounts SET status='ERROR',last_error='部分邮件暂未保存',last_uid=0,uid_validity=1 WHERE id=?",[accountId]);
      const [[account]]=await connection.execute('SELECT * FROM relay_accounts WHERE id=?',[accountId]);
      const raw=Buffer.from(`From: sender@example.test\r\nTo: first@${domain}\r\nSubject: recovery\r\n\r\nrecovered`);
      const client={mailbox:{uidValidity:1},connect:async()=>{},getMailboxLock:async()=>({release(){}}),search:async()=>[1],async *fetch(){yield {uid:1,source:raw,internalDate:new Date()};},logout:async()=>{}};
      await pollAccount(account,{attachmentStore,config:{maxMessageBytes:10000,maxAttachments:10,maxAttachmentBytes:10000,mailboxMaxMessages:10,mailboxMaxBytes:100000},dependencies:{client}});
      const [[updated]]=await connection.execute('SELECT status,last_error,last_uid FROM relay_accounts WHERE id=?',[accountId]);
      assert.equal(updated.status,'ACTIVE');assert.equal(updated.last_error,null);assert.equal(Number(updated.last_uid),1);
      assert.equal(Number((await connection.execute('SELECT COUNT(*) total FROM messages WHERE mailbox_id=?',[first.id]))[0][0].total),1);
      await connection.execute('DELETE FROM messages WHERE mailbox_id=?',[first.id]);await connection.execute('DELETE FROM relay_message_links WHERE mailbox_id=?',[first.id]);
    });
    await t.test('DISABLED account rejects delivery and stale successful poll cannot re-enable it',async()=>{
      const {updateState}=await import('../server/relay/poller.mjs');
      await connection.execute("UPDATE relay_accounts SET status='DISABLED' WHERE id=?",[accountId]);
      await assert.rejects(saveDelivery({recipients:[{id:first.id}],message:{messageId:'disabled',fromAddress:'sender@example.test',subject:'disabled',textContent:'test',htmlContent:'',sizeBytes:4,riskStatus:'SAFE',receivedAt:new Date()},attachments:[],attachmentStore,mailboxQuota:{maxMessages:10,maxBytes:10000},relaySource:{accountId,uidValidity:1,uid:2}}),e=>e.responseCode===451);
      assert.equal(await updateState(accountId,{uid:2,uidValidity:1}),false);
      assert.equal((await connection.execute('SELECT status FROM relay_accounts WHERE id=?',[accountId]))[0][0].status,'DISABLED');
      assert.equal(Number((await connection.execute('SELECT COUNT(*) total FROM messages WHERE mailbox_id=?',[first.id]))[0][0].total),0);
      await connection.execute("UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",[accountId]);
    });
    await t.test('stale alias snapshot cannot recreate mail after a completed recall', async () => {
      const stale = { id: first.id, activated_at: new Date('2020-01-01T00:00:00.000Z'), activation_id: 0 };
      await expire(first);
      await recall(first);
      const delivery = {
        recipients: [stale],
        message: { messageId: `old-source-${suffix}`, fromAddress: 'sender@example.com', subject: 'synthetic', textContent: 'synthetic', htmlContent: '', sizeBytes: 10, riskStatus: 'SAFE', receivedAt: new Date() },
        attachments: [], attachmentStore, mailboxQuota: { maxMessages: 10, maxBytes: 10000 },
        relaySource: { accountId, uidValidity: 1, uid: 50 },
      };
      await assert.rejects(saveDelivery(delivery), /activation changed/);
      const [[messages]] = await connection.execute('SELECT COUNT(*) AS total FROM messages WHERE mailbox_id=?', [first.id]);
      const [[links]] = await connection.execute('SELECT COUNT(*) AS total FROM relay_message_links WHERE mailbox_id=?', [first.id]);
      assert.equal(Number(messages.total), 0);
      assert.equal(Number(links.total), 0);

      const [[generation]] = await connection.execute('SELECT MAX(id) AS id,MAX(created_at) AS activated_at FROM mailbox_recall_requests WHERE mailbox_id=?', [first.id]);
      // Even a timestamp that happens to match must not accept an old generation.
      await assert.rejects(saveDelivery({ ...delivery, recipients: [{ ...stale, activated_at: generation.activated_at }] }), /activation changed/);
      const fresh = { id: first.id, activated_at: generation.activated_at, activation_id: generation.id };
      assert.equal((await saveDelivery({ ...delivery, recipients: [fresh] })).inserted, 1);
      await connection.execute('DELETE FROM messages WHERE mailbox_id=?', [first.id]);
      await connection.execute('DELETE FROM relay_message_links WHERE mailbox_id=?', [first.id]);
    });

    await t.test('fresh source reference lookup protects active, paused and hidden until expiry', async () => {
      await link(shared, 51);
      for (const status of ['ACTIVE', 'PAUSED', 'DELETED']) {
        await connection.execute('UPDATE mailboxes SET status=?,expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [status, shared.id]);
        assert.equal(await hasProtectedRelayReference(source(51)), true, status);
      }
      await connection.execute("UPDATE mailboxes SET status='EXPIRED' WHERE id=?", [shared.id]);
      assert.equal(await hasProtectedRelayReference(source(51)), false);
      await connection.execute("UPDATE mailboxes SET status='PAUSED',expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?", [shared.id]);
      assert.equal(await hasProtectedRelayReference(source(51)), false);
    });

    await t.test('recall does not queue shared originals belonging to paused or hidden mailboxes', async () => {
      let uid = 60;
      for (const status of ['PAUSED', 'DELETED']) {
        uid += 1;
        await connection.execute('UPDATE mailboxes SET status=?,expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [status, shared.id]);
        await link(first, uid);
        await link(shared, uid);
        await expire(first);
        await recall(first);
        const [[jobs]] = await connection.execute('SELECT COUNT(*) AS total FROM relay_remote_cleanup_jobs WHERE relay_account_id=? AND imap_uid=?', [accountId, uid]);
        assert.equal(Number(jobs.total), 0, status);
      }
    });

    await t.test('maintenance preserves paused and hidden shared references at enqueue time', async () => {
      let uid = 70;
      for (const status of ['PAUSED', 'DELETED']) {
        uid += 1;
        await connection.execute('UPDATE mailboxes SET status=?,expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [status, shared.id]);
        await link(first, uid);
        await link(shared, uid);
        await expire(first);
        const [[pending]] = await connection.execute("SELECT COUNT(*) AS total FROM relay_remote_cleanup_jobs WHERE status IN ('PENDING','RETRY')");
        assert.equal(Number(pending.total), 0, 'isolated test must not run unrelated queued work');
        const result = await runMailboxMaintenance({ attachmentStore });
        assert.equal(result.remoteCleanup.processed, 0);
        const [[jobs]] = await connection.execute('SELECT COUNT(*) AS total FROM relay_remote_cleanup_jobs WHERE relay_account_id=? AND imap_uid=?', [accountId, uid]);
        assert.equal(Number(jobs.total), 0, status);
      }
    });

    await t.test('super admin permanent delete queues unshared upstream originals before links cascade', async () => {
      const { permanentlyDeleteMailbox } = await import('../server/admin/mutations.mjs');
      const jobs = async uid => Number((await connection.execute('SELECT COUNT(*) AS total FROM relay_remote_cleanup_jobs WHERE relay_account_id=? AND imap_uid=?', [accountId, uid]))[0][0].total);
      await connection.execute("UPDATE users SET role='SUPER_ADMIN' WHERE id=?", [userId]);
      try {
        await connection.execute("UPDATE mailboxes SET status='ACTIVE',expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?", [shared.id]);
        const doomed = await makeBox('doomed');
        await link(doomed, 81);
        await link(doomed, 82); await link(shared, 82);
        await permanentlyDeleteMailbox({ publicId: doomed.publicId, actorUserId: userId });
        assert.equal(await jobs(81), 1, 'unshared original is queued for the provider trash');
        assert.equal(await jobs(82), 0, 'a live shared reference keeps the original');
        assert.equal(Number((await connection.execute('SELECT COUNT(*) AS total FROM relay_message_links WHERE mailbox_id=?', [doomed.id]))[0][0].total), 0);
        await connection.execute("UPDATE system_settings SET value='false' WHERE `key`='relay_remote_cleanup_enabled'");
        const kept = await makeBox('kept-upstream');
        await link(kept, 83);
        await permanentlyDeleteMailbox({ publicId: kept.publicId, actorUserId: userId });
        assert.equal(await jobs(83), 0, 'disabled upstream cleanup never queues work');
      } finally {
        await connection.execute("UPDATE system_settings SET value='true' WHERE `key`='relay_remote_cleanup_enabled'");
        await connection.execute("UPDATE users SET role='USER' WHERE id=?", [userId]);
      }
    });
  } finally {
    if (userId) {
      await connection.execute('DELETE FROM audit_logs WHERE actor_user_id=?', [userId]);
      await connection.execute('DELETE FROM point_transactions WHERE user_id=? OR operator_user_id=?', [userId, userId]);
      await connection.execute('DELETE FROM users WHERE id=?', [userId]);
    }
    if (accountId) await connection.execute('DELETE FROM relay_accounts WHERE id=?', [accountId]);
    if (domainId) await connection.execute('DELETE FROM domains WHERE id=?', [domainId]);
    if (previousCleanup === undefined) await connection.execute("DELETE FROM system_settings WHERE `key`='relay_remote_cleanup_enabled'");
    else await connection.execute("UPDATE system_settings SET value=? WHERE `key`='relay_remote_cleanup_enabled'", [previousCleanup]);
    connection.release();
    await closeDatabasePool();
    await rm(storage, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.MAIL_ATTACHMENT_DIR;
    else process.env.MAIL_ATTACHMENT_DIR = previousStorage;
  }
});
