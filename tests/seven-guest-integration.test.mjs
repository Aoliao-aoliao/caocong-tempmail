import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function createRoute(kind) {
  const url = new URL(kind === 'ordinary' ? '../src/pages/api/guest/mailbox.ts' : '../src/pages/api/guest/relay/mailbox.ts', import.meta.url);
  const source = await readFile(url, 'utf8'), imports = {};
  for (const node of ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const name = node.moduleSpecifier.text;
    imports[name] = await import(new URL(name, url));
    if (name.endsWith('/request-security.mjs')) imports[name] = { ...imports[name], consumeAuthRateLimit: async () => ({ allowed: true }) };
    if (name.endsWith('/creation-limit.mjs')) imports[name] = { ...imports[name], consumeGuestCreationLimit: async () => ({ allowed: true }) };
    if (name.endsWith('/turnstile.mjs')) imports[name] = { ...imports[name], requireTurnstileToken: async () => {} };
  }
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => imports[name], Request, Response, URL, Buffer, Error, console });
  return exports.POST;
}

test('guest lifecycle and cleanup use consistent expiry in isolated MySQL', { timeout: 60000 }, async t => {
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS, '1');
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE, 'nodemail_ci');
  const { openDatabase, closeDatabasePool } = await import('../server/db/database.mjs');
  const { ensureGuestSession, createOrRotateGuestMailbox, getGuestMailbox, listGuestMessages, guestCookieName } = await import('../server/guest/service.mjs');
  const { createGuestRelayMailbox } = await import('../server/relay/service.mjs');
  const { runMailboxMaintenance } = await import('../server/mail/maintenance.mjs');
  const db = await openDatabase(), marker = randomUUID(), sessions = [], domains = [];
  const params = { userAgent: `seven-guest-${marker}`, ipAddress: '127.0.0.1' };
  const keys = ['free_mailbox_minutes', 'relay_remote_cleanup_enabled'];
  const saved = new Map(); let accountId;
  const store = { retryPendingCleanup: async () => 0, removeStorageKeys: async () => 0 };
  const setting = async (key, value) => db.execute('INSERT INTO system_settings (`key`,value,value_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)', [key, value, key === 'free_mailbox_minutes' ? 'integer' : 'boolean']);
  const newSession = async () => { const result = await ensureGuestSession(params); sessions.push(result.id); return { id: result.id, cookieValue: result.issuedCookie.cookieValue }; };
  const sessionRow = async id => (await db.execute('SELECT * FROM guest_sessions WHERE id=?', [id]))[0][0];
  const makeNearExpiry = async session => { await db.execute('UPDATE guest_sessions SET expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 SECOND) WHERE id=?', [session.id]); return +(await sessionRow(session.id)).expires_at; };
  try {
    for (const key of keys) saved.set(key, (await db.execute('SELECT * FROM system_settings WHERE `key`=?', [key]))[0][0] || null);
    await setting('relay_remote_cleanup_enabled', 'false'); // Never connect to an upstream server.
    for (const kind of ['PUBLIC', 'RELAY']) {
      const domain = `${kind.toLowerCase()}-${marker}.example.test`;
      const [result] = await db.execute("INSERT INTO domains(domain,kind,status,mx_status) VALUES (?,?,'ACTIVE','ACTIVE')", [domain, kind]);
      domains.push({ id: result.insertId, domain });
    }
    const [ordinary, relay] = domains;
    const [account] = await db.execute(`INSERT INTO relay_accounts(public_id,email,suffix,imap_host,username,credential_ciphertext,credential_kdf_salt,credential_iv,credential_auth_tag,status,max_aliases)
      VALUES (?,?,?,'127.0.0.1','synthetic',?,?,?,?,'ACTIVE',100)`, [`RA-${marker}`, `synthetic@${relay.domain}`, relay.domain, randomBytes(32), randomBytes(16), randomBytes(12), randomBytes(16)]);
    accountId = account.insertId;
    const create = (kind, session) => kind === 'ordinary'
      ? createOrRotateGuestMailbox({ ...params, ...session, domain: ordinary.domain })
      : createGuestRelayMailbox({ ...params, ...session, suffix: relay.domain });

    for (const kind of ['ordinary', 'relay']) for (const minutes of [60, 1440]) {
      await t.test(`${kind} ${minutes}-minute mailbox survives the old session boundary and is cleaned only at its own expiry`, async () => {
        await setting('free_mailbox_minutes', String(minutes));
        const session = await newSession(), oldExpiry = await makeNearExpiry(session);
        const setCookies = [], handler = await createRoute(kind);
        const url = new URL(kind === 'ordinary' ? 'https://example.test/api/guest/mailbox' : 'https://example.test/api/guest/relay/mailbox');
        const response = await handler({ url, clientAddress: params.ipAddress,
          cookies: { get: name => name === guestCookieName ? { value: session.cookieValue } : undefined, set: (...args) => setCookies.push(args) },
          request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', 'user-agent': params.userAgent }, body: JSON.stringify(kind === 'ordinary' ? { domain: ordinary.domain } : { suffix: relay.domain }) }),
        });
        const payload = await response.json();
        assert.equal(response.status, 201, JSON.stringify(payload));
        assert.equal(setCookies.length, 1, 'actual route must refresh the browser cookie');
        assert.equal(setCookies[0][1], session.cookieValue, 'token/ownership must remain stable');
        assert.equal(setCookies[0][2].httpOnly, true);
        assert.equal(setCookies[0][2].sameSite, 'strict');
        assert.equal(setCookies[0][2].secure, true);
        assert.ok(setCookies[0][2].maxAge >= minutes * 60);
        const renewed = await sessionRow(session.id);
        assert.ok(+renewed.expires_at >= +new Date(payload.mailbox.expiresAt));
        assert.equal(payload.mailbox.durationMinutes, minutes);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, oldExpiry - Date.now()) + 100));
        await runMailboxMaintenance({ attachmentStore: store });
        assert.equal((await getGuestMailbox({ ...params, ...session })).id, payload.mailbox.id);
        assert.equal((await listGuestMessages({ ...params, ...session })).mailbox.id, payload.mailbox.id);
        assert.equal(+(await sessionRow(session.id)).expires_at, +renewed.expires_at, 'reads must not slide session expiry');
        await db.execute('UPDATE mailboxes SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE public_id=?', [payload.mailbox.id]);
        await assert.rejects(listGuestMessages({ ...params, ...session }), e => e.status === 410);
        await runMailboxMaintenance({ attachmentStore: store });
        assert.equal((await db.execute('SELECT id FROM mailboxes WHERE public_id=?', [payload.mailbox.id]))[0].length, 0);
        assert.ok(await sessionRow(session.id), 'a valid session remains usable for the next mailbox');
      });
    }

    await t.test('failed relay allocation rolls back both session renewal and previous inbox expiry', async () => {
      await setting('free_mailbox_minutes', '60');
      const session = await newSession(), first = await create('ordinary', session);
      const before = await makeNearExpiry(session);
      await assert.rejects(createGuestRelayMailbox({ ...params, ...session, suffix: `missing-${marker}.example.test` }), e => e.status === 409);
      assert.equal(+(await sessionRow(session.id)).expires_at, before);
      assert.equal((await getGuestMailbox({ ...params, ...session })).id, first.mailbox.id);
    });

    await t.test('concurrent normal/relay creation retains the same owner and exactly one active mailbox', async () => {
      const session = await newSession();
      const results = await Promise.all([create('ordinary', session), create('relay', session)]);
      assert.ok(results.every(r => r.issuedCookie.cookieValue === session.cookieValue));
      const [rows] = await db.execute("SELECT public_id FROM mailboxes WHERE guest_session_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP(3)", [session.id]);
      assert.equal(rows.length, 1);
      const other = await newSession();
      assert.equal(await getGuestMailbox({ ...params, ...other }), null);
      assert.equal(await getGuestMailbox({ ...params, ...session, userAgent: 'wrong-agent' }), null);
      await db.execute('UPDATE guest_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?', [session.id]);
      await assert.rejects(listGuestMessages({ ...params, ...session }), e => e.status === 401);
      await runMailboxMaintenance({ attachmentStore: store });
      assert.equal(await sessionRow(session.id), undefined);
    });

    await t.test('address generator renewal and idempotent activation preserve mailbox duration and reject expired claim ownership', async () => {
      const session = await newSession();
      await makeNearExpiry(session);
      const renewed = await ensureGuestSession({ ...params, ...session });
      assert.equal(renewed.id, session.id);
      assert.equal(renewed.issuedCookie.cookieValue, session.cookieValue);
      assert.equal(renewed.issuedCookie.cookieMaxAge, 86400);
      const claim = { ...params, ...session, domain: ordinary.domain, localPart: `claim-${randomBytes(5).toString('hex')}`, claimId: randomBytes(16).toString('base64url'), requiredSessionId: session.id };
      const first = await createOrRotateGuestMailbox(claim);
      await makeNearExpiry(session);
      const again = await createOrRotateGuestMailbox(claim);
      assert.equal(again.mailbox.id, first.mailbox.id);
      assert.equal(again.mailbox.expiresAt, first.mailbox.expiresAt);
      assert.equal(again.issuedCookie.cookieValue, session.cookieValue);
      await db.execute('UPDATE guest_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?', [session.id]);
      await assert.rejects(createOrRotateGuestMailbox(claim), e => e.status === 401);
    });
  } finally {
    for (const id of sessions) {
      await db.execute('DELETE FROM mailboxes WHERE guest_session_id=?', [id]);
      await db.execute('DELETE FROM guest_sessions WHERE id=?', [id]);
    }
    if (accountId) await db.execute('DELETE FROM relay_accounts WHERE id=?', [accountId]);
    for (const domain of domains) await db.execute('DELETE FROM domains WHERE id=?', [domain.id]);
    for (const [key, old] of saved) {
      if (old) await db.execute('UPDATE system_settings SET value=?,value_type=?,updated_by_user_id=?,updated_at=? WHERE `key`=?', [old.value, old.value_type, old.updated_by_user_id, old.updated_at, key]);
      else await db.execute('DELETE FROM system_settings WHERE `key`=?', [key]);
    }
    db.release();
    await closeDatabasePool();
  }
});
