import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('member history pagination against disposable MySQL', { timeout:90000 }, async t => {
  // Refuse DB imports/access unless explicitly configured for the disposable DB.
  assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
  const { openDatabase,closeDatabasePool } = await import('../server/db/database.mjs');
  const { getMemberHistoryPage } = await import('../server/member/history.mjs');
  const { getMemberData,getPublicToolData } = await import('../server/member/read-model.mjs');
  const connection = await openDatabase();
  const suffix = randomUUID(), users = [];
  try {
    for (const label of ['owner','other']) {
      const [row] = await connection.execute("INSERT INTO users(public_id,email,password_hash) VALUES (?,?,'test-only-unusable-hash')",[`U-${randomUUID()}`,`${label}-${suffix}@example.com`]);
      users.push(row.insertId);
    }
    const [owner,other] = users;
    const [[plan]] = await connection.execute("SELECT id FROM recharge_plans WHERE code='POINTS_100'");
    const [[channel]] = await connection.execute("SELECT id FROM payment_channels WHERE code='USDT_TRC20'");
    const oldestTransaction = `PT-${randomUUID()}`, oldestOrder = `RO-${randomUUID()}`;
    const oldestDomain = `oldest-${suffix}.example.com`;
    for (let i=0;i<205;i++) await connection.execute(`INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,note)
      VALUES (?,?,'ADMIN_ADJUSTMENT',1,100,?)`,[i===0?oldestTransaction:`PT-${randomUUID()}`,owner,i===0?'oldest-visible-note':`history-${i}`]);
    for (let i=0;i<105;i++) await connection.execute("INSERT INTO domains(domain,kind,owner_user_id,status,mx_status) VALUES (?,'PRIVATE',?,'ACTIVE','ACTIVE')",[i===0?oldestDomain:`history-${i}-${suffix}.example.com`,owner]);
    for (let i=0;i<55;i++) await connection.execute(`INSERT INTO recharge_orders(public_id,user_id,recharge_plan_id,payment_channel_id,amount_usd_cents,points,status,expires_at)
      VALUES (?,?,?,?,100,100,?,?)`,[i===0?oldestOrder:`RO-${randomUUID()}`,owner,plan.id,channel.id,i<2?'PENDING':'PAID',new Date(Date.now()+(i===1?-3600000:3600000))]);
    await connection.execute("INSERT INTO point_transactions(public_id,user_id,type,amount,balance_after,note) VALUES (?,?,'ADMIN_ADJUSTMENT',1,100,'other-owner-private-record')",[`PT-${randomUUID()}`,other]);
    await connection.execute("INSERT INTO domains(domain,kind,owner_user_id,status) VALUES (?,'PRIVATE',?,'ACTIVE')",[`other-owner-private-record-${suffix}.example.com`,other]);
    await connection.execute(`INSERT INTO recharge_orders(public_id,user_id,recharge_plan_id,payment_channel_id,amount_usd_cents,points,status,expires_at)
      VALUES (?,?,?,?,100,100,'PENDING',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))`,[`other-owner-private-record-${suffix}`,other,plan.id,channel.id]);

    await t.test('old transactions and Chinese type searches remain accessible beyond 200', async () => {
      const page = await getMemberHistoryPage({ userId:owner,section:'transactions',page:21 });
      assert.deepEqual(page.pagination,{ page:21,pages:21,total:205,pageSize:10 });
      assert.equal(page.items.length,5);
      assert.equal(page.items.some(item => item.id===oldestTransaction),true);
      const searched = await getMemberHistoryPage({ userId:owner,section:'transactions',query:' oldest-visible-note ' });
      assert.equal(searched.pagination.total,1);
      assert.equal(searched.items[0].id,oldestTransaction);
      assert.equal((await getMemberHistoryPage({ userId:owner,section:'transactions',query:'管理员调整' })).pagination.total,205);
    });

    await t.test('private domain pages and search cover beyond 100', async () => {
      const page = await getMemberHistoryPage({ userId:owner,section:'domains',page:11 });
      assert.deepEqual(page.pagination,{ page:11,pages:11,total:105,pageSize:10 });
      assert.equal(page.items.some(item => item.domain===oldestDomain),true);
      const searched = await getMemberHistoryPage({ userId:owner,section:'domains',query:oldestDomain.toUpperCase() });
      assert.equal(searched.items[0].domain,oldestDomain);
      assert.equal((await getMemberHistoryPage({ userId:owner,section:'domains',query:'已启用' })).pagination.total,105);
    });

    await t.test('all order history and older pending orders remain available independently', async () => {
      const page = await getMemberHistoryPage({ userId:owner,section:'orders',page:6 });
      assert.deepEqual(page.pagination,{ page:6,pages:6,total:55,pageSize:10 });
      assert.equal(page.items.some(item => item.id===oldestOrder),true);
      const pending = await getMemberHistoryPage({ userId:owner,section:'orders',query:'待支付' });
      assert.equal(pending.pagination.total,1);
      assert.equal(pending.items[0].id,oldestOrder);
      const expired = await getMemberHistoryPage({ userId:owner,section:'orders',query:'已过期' });
      assert.equal(expired.pagination.total,1);
      assert.equal(expired.items[0].status,'EXPIRED');
      const data = await getMemberData(owner);
      assert.equal(data.transactions.length,10);
      assert.equal(data.transactionPagination.total,205);
      assert.equal(data.domains.length,10);
      assert.equal(data.domainPagination.total,105);
      assert.equal(data.orders.length,10);
      assert.equal(data.orderPagination.total,55);
      assert.deepEqual(data.pendingOrders.map(order => order.id),[oldestOrder]);
    });

    await t.test('exact pending filter is independent of newest history, expiry and ownership', async () => {
      const pending=await getMemberHistoryPage({userId:owner,section:'orders',status:'PENDING'});
      assert.equal(pending.pagination.total,1);
      assert.deepEqual(pending.items.map(o=>o.id),[oldestOrder]);
      assert.equal((await getMemberHistoryPage({userId:other,section:'orders',status:'PENDING'})).pagination.total,1);
      assert.equal((await getMemberHistoryPage({userId:owner,section:'orders',status:'PENDING',query:'other-owner-private-record'})).pagination.total,0);
      for(const status of ['INVALID',"PENDING' OR 1=1 --"])await assert.rejects(getMemberHistoryPage({userId:owner,section:'orders',status}),e=>e.status===400);
      await assert.rejects(getMemberHistoryPage({userId:owner,section:'domains',status:'PENDING'}),e=>e.status===400);
    });

    await t.test('all sections isolate owners and bound invalid/out-of-range pages', async () => {
      for (const section of ['transactions','domains','orders']) {
        assert.equal((await getMemberHistoryPage({ userId:owner,section,query:'other-owner-private-record' })).pagination.total,0);
        assert.equal((await getMemberHistoryPage({ userId:other,section })).pagination.total,1);
        const empty = await getMemberHistoryPage({ userId:owner,section,query:'no-such-history',page:100000 });
        assert.deepEqual(empty.pagination,{ page:1,pages:1,total:0,pageSize:10 });
        const last = await getMemberHistoryPage({ userId:owner,section,page:100000 });
        assert.equal(last.pagination.page,last.pagination.pages);
        for (const page of [0,-1,'1.5','1x',100001]) await assert.rejects(getMemberHistoryPage({ userId:owner,section,page }),error => error.status===400);
        for (const query of ['x'.repeat(101),'bad\u0000query']) await assert.rejects(getMemberHistoryPage({ userId:owner,section,query }),error => error.status===400);
      }
      for (const section of ['users','__proto__','constructor',null]) await assert.rejects(getMemberHistoryPage({ userId:owner,section }),error => error.status===400);
    });

    await t.test('mailbox selector includes only owner private domains that are active with working MX', async () => {
      const ownerOptions = (await getMemberData(owner)).mailboxDomains.filter(row => row.kind==='PRIVATE');
      assert.equal(ownerOptions.length,105,'selector is independent of the paginated management table');
      assert.equal(ownerOptions.some(row => row.domain===oldestDomain),true);
      assert.equal(ownerOptions.some(row => row.domain.startsWith('other-owner-private-record')),false);
      assert.equal((await getPublicToolData()).publicDomains.some(row => row.kind==='PRIVATE'),false);
      await connection.execute("UPDATE domains SET mx_status='MISMATCH' WHERE domain=?",[oldestDomain]);
      assert.equal((await getMemberData(owner)).mailboxDomains.some(row => row.domain===oldestDomain),false);
      await connection.execute("UPDATE domains SET mx_status='ACTIVE',status='DISABLED' WHERE domain=?",[oldestDomain]);
      assert.equal((await getMemberData(owner)).mailboxDomains.some(row => row.domain===oldestDomain),false);
    });
  } finally {
    for (const userId of users) {
      await connection.execute('DELETE FROM point_transactions WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM recharge_orders WHERE user_id=?',[userId]);
      await connection.execute('DELETE FROM users WHERE id=?',[userId]);
    }
    connection.release();
    await closeDatabasePool();
  }
});
