import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// This test writes disposable accounts. It must never target an existing service/database.
test('built application: health, CAPTCHA fail-closed, session and SMTP greeting', { timeout: 90000 }, async () => {
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1');
  assert.equal(process.env.MYSQL_DATABASE, 'nodemail_ci');
  // Import only after the disposable-database guards. Never bypass production CAPTCHA.
  const { registerUser, createSession, sessionCookieName } = await import('../server/auth/service.mjs');
  const { closeDatabasePool } = await import('../server/db/database.mjs');
  let fixtureUserId;
  const port = 14321;
  const smtpPort = 12525;
  // The built server only answers its configured site host (421 otherwise),
  // so every request reaches loopback while presenting the fictional site.
  const origin = process.env.NODEMAIL_SITE_ORIGIN;
  const siteHost = new URL(origin).host;
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host = siteHost; headers['x-forwarded-proto'] = 'https';
    const req = httpRequest({ host: '127.0.0.1', port, method: init.method || 'GET', path: target.pathname + target.search, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) for (const item of [].concat(value)) responseHeaders.append(key, item);
        const body = [204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status: res.statusCode, headers: responseHeaders }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(init.signal.reason), { once: true });
    (async () => {
      const body = init.body;
      if (body instanceof ReadableStream) { for await (const chunk of body) req.write(chunk); }
      else if (body !== undefined && body !== null) req.write(body);
      req.end();
    })().catch(reject);
  });
  const child = spawn(process.execPath, ['server/mail/process-manager.mjs'], {
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), MAIL_ATTACHMENT_DIR: 'data/ci-attachments' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`Application exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
        healthy = response.ok && (await response.json()).ok === true;
      } catch {}
      if (healthy) break;
      await delay(500);
    }
    assert.equal(healthy, true, `Database health did not become ready: ${output}`);
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /NodeMail/);
    const headers = { origin, 'content-type': 'application/json' };
    for (const endpoint of ['login', 'register']) {
      const oversizedBody = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ padding:'x'.repeat(8192) })));
        controller.close();
      } });
      const oversized = await fetch(`${origin}/api/auth/${endpoint}`, {
        method:'POST', headers, body:oversizedBody, duplex:'half',
      });
      assert.equal(oversized.status, 413, await oversized.text());
      assert.equal(oversized.headers.get('set-cookie'), null);
    }
    const rejectedNotify = await fetch(`${origin}/api/payment/gmpay-notify`, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({signature:'0'.repeat(64)}),
    });
    assert.equal(rejectedNotify.status,400);
    assert.equal(await rejectedNotify.text(),'fail');
    assert.match(rejectedNotify.headers.get('content-type'),/^text\/plain/);
    assert.equal(rejectedNotify.headers.get('set-cookie'),null);
    const gmpayReturn = await fetch(`${origin}/api/payment/gmpay-return?status=2&order_id=synthetic`,{redirect:'manual'});
    assert.equal(gmpayReturn.status,303);
    assert.equal(gmpayReturn.headers.get('location'),'/user/recharge.cgi');
    assert.equal(gmpayReturn.headers.get('referrer-policy'),'no-referrer');
    assert.equal((await fetch(`${origin}/api/user/recharge/gmpay`,{headers:{origin}})).status,401);
    const email = `ci-${Date.now()}@example.com`;
    const registered = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers, body: JSON.stringify({ email, password: 'disposable-ci-password' }),
    });
    assert.equal(registered.status, 503, await registered.text());
    assert.equal(registered.headers.get('set-cookie'), null);
    // Session fixture is created in the isolated CI database, not through a CAPTCHA bypass.
    const fixture = await registerUser({ email, password: 'disposable-ci-password' });
    assert.equal(fixture.ok, true);
    fixtureUserId = fixture.userId;
    const session = await createSession({ userId: fixture.userId, ipAddress: '127.0.0.1', userAgent: 'CI smoke' });
    const cookie = `${sessionCookieName}=${session.token}`;
    const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, email);
    for (const path of ['/tools/mail.cgi', '/tools/real_mail.cgi']) {
      for (const pageHeaders of [{}, { cookie }]) {
        const page = await fetch(`${origin}${path}`, { headers:pageHeaders });
        assert.equal(page.status, 200, `${path}: ${await page.clone().text()}`);
        assert.match(page.headers.get('cache-control') || '', /no-store/,
          'personalized member and guest pages must not be stored by shared caches');
      }
    }
    const inbox=await fetch(`${origin}/api/user/messages/list?page=1`,{headers:{cookie,origin}});
    assert.equal(inbox.status,200,await inbox.clone().text());
    assert.deepEqual((await inbox.json()).pagination,{page:1,pages:1,total:0,pageSize:10});
    const invalidPage=await fetch(`${origin}/api/user/messages/list?page=1x`,{headers:{cookie,origin}});
    assert.equal(invalidPage.status,400);
    for (const section of ['transactions','domains','orders']) {
      const history = await fetch(`${origin}/api/user/history?section=${section}&page=1`, {headers:{cookie,origin}});
      assert.equal(history.status,200,await history.clone().text());
      assert.equal((await history.json()).pagination.pageSize,10);
      assert.match(history.headers.get('cache-control') || '', /no-store/);
    }
    for (const query of ['section=users','section=orders&page=1x','section=orders&userId=1',
      'section=orders&page=1&page=2','section=orders&q='+'x'.repeat(101)]) {
      const invalid = await fetch(`${origin}/api/user/history?${query}`, {headers:{cookie,origin}});
      assert.equal(invalid.status,400,query);
    }
    const anonymousHistory = await fetch(`${origin}/api/user/history?section=orders`,{headers:{origin}});
    assert.equal(anonymousHistory.status,401);
    const crossOriginHistory = await fetch(`${origin}/api/user/history?section=orders`,{headers:{cookie,origin:'https://untrusted.example'}});
    assert.equal(crossOriginHistory.status,403);
    // Real built routes: no session or forged bot header can change bindings.
    assert.equal((await fetch(`${origin}/api/user/telegram`,{headers:{origin}})).status,401);
    assert.equal((await fetch(`${origin}/api/admin/telegram`,{headers:{origin,cookie}})).status,403);
    const telegramState=await fetch(`${origin}/api/user/telegram`,{headers:{origin,cookie}});
    assert.equal(telegramState.status,200);assert.equal((await telegramState.json()).result.bound,false);
    assert.match(telegramState.headers.get('cache-control')||'',/no-store/);
    assert.equal((await fetch(`${origin}/api/user/telegram`,{method:'POST',headers:{...headers,cookie,origin:'https://evil.example'},body:'{"action":"begin"}'})).status,403);
    for(const extra of [{},{'x-telegram-bot-api-secret-token':'0'.repeat(64)}]){
      const rejected=await fetch(`${origin}/api/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json',...extra},body:'{}'});
      assert.equal(rejected.status,403);assert.equal(rejected.headers.get('set-cookie'),null);
    }
    assert.equal((await fetch(`${origin}/api/admin/health`, {headers:{origin}})).status,401);
    assert.equal((await fetch(`${origin}/api/admin/health`, {headers:{origin,cookie}})).status,403);
    assert.equal((await fetch(`${origin}/api/admin/nodeloc-payment`,{headers:{origin,cookie}})).status,403);
    assert.equal((await fetch(`${origin}/api/user/recharge/nodeloc`,{headers:{origin}})).status,401);
    assert.equal((await fetch(`${origin}/api/user/recharge/nodeloc`,{headers:{origin,cookie}})).status,200);
    assert.equal((await fetch(`${origin}/api/user/recharge/nodeloc`,{method:'POST',headers:{...headers,cookie,origin:'https://attacker.example'},body:'{}'})).status,403);
    assert.equal((await fetch(`${origin}/api/payment/nodeloc-notify?out_trade_no=invalid`)).status,400);
    const paymentReturn=await fetch(`${origin}/api/payment/nodeloc-return?out_trade_no=invalid`,{redirect:'manual'});
    assert.equal(paymentReturn.status,303);assert.equal(paymentReturn.headers.get('location'),'/user/recharge.cgi');assert.equal(paymentReturn.headers.get('referrer-policy'),'no-referrer');
    const adminList=await fetch(`${origin}/api/admin/list?section=users`,{headers:{cookie,origin}});
    assert.equal(adminList.status,403,'ordinary users must not access admin pagination');
    const {openDatabase}=await import('../server/db/database.mjs');
    const adminFixture=await openDatabase();
    try {
      await adminFixture.execute("UPDATE users SET role='ADMIN' WHERE id=?",[fixture.userId]);
      const adminPage=await fetch(`${origin}/api/admin/list?section=users&page=1`,{headers:{cookie,origin}});
      assert.equal(adminPage.status,200,await adminPage.clone().text());
      assert.equal((await adminPage.json()).pagination.pageSize,20);
      assert.equal((await fetch(`${origin}/api/admin/nodeloc-payment`,{headers:{origin,cookie}})).status,403);
      const gpView=await fetch(`${origin}/api/admin/gmpay-payment`,{headers:{origin,cookie}});assert.equal(gpView.status,200);assert.equal((await gpView.json()).config.canEdit,false);
      assert.equal((await fetch(`${origin}/api/admin/gmpay-payment`,{method:'POST',headers:{...headers,cookie},body:JSON.stringify({pid:'test',enabled:true})})).status,403);
      await adminFixture.execute("UPDATE users SET role='SUPER_ADMIN' WHERE id=?",[fixture.userId]);
      assert.equal((await fetch(`${origin}/api/admin/gmpay-payment`,{method:'POST',headers:{...headers,cookie,origin:'https://attacker.example'},body:'{}'})).status,403);
      const gpSuper=await fetch(`${origin}/api/admin/gmpay-payment`,{headers:{origin,cookie}});assert.equal(gpSuper.status,200);assert.equal((await gpSuper.json()).config.canEdit,true);
      const paymentConfig=await fetch(`${origin}/api/admin/nodeloc-payment`,{headers:{origin,cookie}});assert.equal(paymentConfig.status,200);assert.equal((await paymentConfig.json()).config.keyConfigured,false);
      await adminFixture.execute("UPDATE users SET role='ADMIN' WHERE id=?",[fixture.userId]);
      const serviceHealth=await fetch(`${origin}/api/admin/health`, {headers:{origin,cookie}});
      assert.equal(serviceHealth.status,200);
      const serviceResult=await serviceHealth.json();
      assert.equal(serviceResult.ok,true);
      assert.equal(serviceResult.smtp,true);
      assert.ok(Number.isFinite(Date.parse(serviceResult.checkedAt)));
      assert.match(serviceHealth.headers.get('cache-control'),/no-store/);
      assert.equal((await fetch(`${origin}/api/admin/health`, {headers:{cookie,origin:'https://attacker.example'}})).status,403);
    } finally {
      await adminFixture.execute("UPDATE users SET role='USER' WHERE id=?",[fixture.userId]);
      adminFixture.release();
    }
    const anonymousList=await fetch(`${origin}/api/user/messages/list`,{headers:{origin}});
    assert.equal(anonymousList.status,401);
    const crossOriginList=await fetch(`${origin}/api/user/messages/list`,{headers:{cookie,origin:'https://untrusted.example'}});
    assert.equal(crossOriginList.status,403);
    const renewBody=JSON.stringify({mailboxId:'MB-00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000002',durationHours:24,expectedPrice:3,turnstileToken:''});
    const renew=(extra={})=>fetch(`${origin}/api/user/mailboxes/renew`,{method:'POST',headers:{...headers,...extra},body:renewBody});
    assert.equal((await renew()).status,401);
    assert.equal((await renew({cookie,origin:'https://untrusted.example'})).status,403);
    // Renewal follows the admin mailbox CAPTCHA switch: enabled fails closed
    // before any mutation; disabled reaches ownership checks (no such mailbox).
    const captchaFixture=await openDatabase();
    try{
      const [[captchaSetting]]=await captchaFixture.execute("SELECT value FROM system_settings WHERE `key`='captcha_before_mailbox_create'");
      try{
        await captchaFixture.execute("UPDATE system_settings SET value='true' WHERE `key`='captcha_before_mailbox_create'");
        const noCaptcha=await renew({cookie});assert.ok([403,503].includes(noCaptcha.status),'renewal requires CAPTCHA before mutation');
        await captchaFixture.execute("UPDATE system_settings SET value='false' WHERE `key`='captcha_before_mailbox_create'");
        assert.equal((await renew({cookie})).status,404,'renewal without the CAPTCHA switch still checks ownership');
      }finally{await captchaFixture.execute("UPDATE system_settings SET value=? WHERE `key`='captcha_before_mailbox_create'",[captchaSetting?.value??'false']);}
    }finally{captchaFixture.release();}
    const badOrigin = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST', headers: { cookie, origin: 'https://untrusted.example' },
    });
    assert.equal(badOrigin.status, 403);
    const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie } });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401);
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: smtpPort });
      socket.setTimeout(3000);
      socket.once('error', reject);
      socket.once('timeout', () => { socket.destroy(); reject(new Error('SMTP timeout')); });
      socket.once('data', data => {
        socket.destroy();
        try { assert.match(data.toString(), /^220[ -]/); resolve(); } catch (error) { reject(error); }
      });
    });
  } finally {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try { await exited; } finally {
      clearTimeout(killTimer);
      try {
        if (fixtureUserId) {
          const { openDatabase } = await import('../server/db/database.mjs');
          const cleanup = await openDatabase();
          try {
            await cleanup.execute('DELETE FROM point_transactions WHERE user_id=? OR operator_user_id=?',[fixtureUserId,fixtureUserId]);
            await cleanup.execute('DELETE FROM users WHERE id=?',[fixtureUserId]);
          } finally { cleanup.release(); }
        }
      } finally { await closeDatabasePool(); }
    }
  }
});
