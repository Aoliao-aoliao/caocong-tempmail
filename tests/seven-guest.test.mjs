import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { apiError } from '../server/http/api.mjs';

async function loadModule(path, overrides = {}, globals = {}) {
  const url = new URL(path, import.meta.url);
  const source = await readFile(url, 'utf8');
  const imports = {};
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
    const name = node.moduleSpecifier.text;
    imports[name] = overrides[name] || await import(name.startsWith('.') ? new URL(name, url) : name);
  }
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  runInNewContext(compiled, { exports, require: name => imports[name] || overrides[name], process, Buffer, Date, Error, Response, Request, URL, URLSearchParams, console, ...globals });
  return exports;
}

// The service and cookie crypto are real; the in-memory SQL substitute makes
// time boundaries deterministic. Real SQL/maintenance coverage is in the
// separately guarded seven-guest-integration suite.
async function fixture() {
  let now = Date.now(), snapshot;
  const data = { sessions: [], boxes: [], minutes: 60, domainActive: true };
  const connection = {
    async beginTransaction() { snapshot = structuredClone(data); },
    async commit() { snapshot = undefined; },
    async rollback() { Object.assign(data, snapshot); snapshot = undefined; },
    release() {},
    async execute(sql, args = []) {
      sql = sql.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT id, user_agent_hash, expires_at')) return [data.sessions.filter(s => s.id === args[0] && s.token_hash === args[1] && +s.expires_at > now)];
      if (sql.startsWith('INSERT INTO guest_sessions')) { data.sessions.push({ id: args[0], token_hash: args[1], user_agent_hash: args[3], expires_at: args[4] }); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE guest_sessions SET expires_at=')) { data.sessions.find(s => s.id === args[1]).expires_at = args[0]; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE guest_sessions SET last_seen_at=')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT id, domain FROM domains')) return [data.domainActive ? [{ id: 1, domain: 'example.test' }] : []];
      if (sql.startsWith('SELECT value FROM system_settings')) return [[{ value: data.minutes }]];
      if (sql.startsWith('UPDATE mailboxes SET')) { for (const b of data.boxes) if (b.guest_session_id === args[0]) b.status = 'EXPIRED'; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO mailboxes')) { data.boxes.push({ id: args[0], public_id: args[0], guest_session_id: args[1], address: args[3], domain: 'example.test', duration_minutes: args[4], expires_at: args[5], created_at: new Date(now), status: 'ACTIVE' }); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE domains SET mailbox_count=')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT mb.id AS internal_id')) return [[...data.boxes].reverse().filter(b => b.guest_session_id === args[0] && b.status === 'ACTIVE' && +b.expires_at > now).slice(0, 1)];
      if (sql.startsWith('SELECT mb.public_id, mb.address')) return [data.boxes.filter(b => b.public_id === args[0] && b.guest_session_id === args[1] && b.status === 'ACTIVE' && +b.expires_at > now)];
      throw new Error(`Unexpected synthetic SQL: ${sql}`);
    },
  };
  const Clock = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  const service = await loadModule('../server/guest/service.mjs', { '../db/database.mjs': { openDatabase: async () => connection } }, { Date: Clock });
  const params = { userAgent: 'synthetic-seven-guest', ipAddress: '127.0.0.1' };
  const issued = await service.ensureGuestSession(params);
  const cookie = issued.issuedCookie.cookieValue;
  return { data, service, params, cookie, id: issued.id, advance(ms) { now += ms; }, get now() { return now; } };
}

test('new normal inbox renews the same session and browser cookie beyond its old boundary, including a 24-hour inbox', async () => {
  for (const minutes of [60, 1440]) {
    const f = await fixture();
    f.data.minutes = minutes;
    f.data.sessions[0].expires_at = new Date(f.now + 30_000);
    const result = await f.service.createOrRotateGuestMailbox({ ...f.params, cookieValue: f.cookie, domain: 'example.test' });
    assert.equal(result.issuedCookie.cookieValue, f.cookie);
    assert.equal(result.issuedCookie.id, f.id);
    assert.equal(result.issuedCookie.cookieMaxAge, 86400);
    const expiry = +f.data.sessions[0].expires_at;
    assert.ok(expiry >= +new Date(result.mailbox.expiresAt));
    f.advance(35_000);
    assert.equal((await f.service.getGuestMailbox({ ...f.params, cookieValue: f.cookie })).id, result.mailbox.id);
    assert.equal(+f.data.sessions[0].expires_at, expiry, 'read polling must not prolong the session');
  }
});

test('address-tool session renewal keeps ownership and sends a refreshed cookie, but expired or wrong-agent sessions are never resurrected', async () => {
  const f = await fixture();
  f.data.sessions[0].expires_at = new Date(f.now + 30_000);
  const renewed = await f.service.ensureGuestSession({ ...f.params, cookieValue: f.cookie });
  assert.equal(renewed.id, f.id);
  assert.equal(renewed.issuedCookie.cookieValue, f.cookie);
  assert.equal(renewed.issuedCookie.cookieMaxAge, 86400);
  const other = await f.service.ensureGuestSession({ ...f.params, userAgent: 'different-agent', cookieValue: f.cookie });
  assert.notEqual(other.id, f.id);
  f.data.sessions.find(s => s.id === f.id).expires_at = new Date(f.now - 1);
  const expired = await f.service.ensureGuestSession({ ...f.params, cookieValue: f.cookie });
  assert.notEqual(expired.id, f.id);
  assert.equal(await f.service.getGuestMailbox({ ...f.params, cookieValue: f.cookie }), null);
});

test('failed allocation rolls back session renewal and preserves the previous inbox', async () => {
  const f = await fixture();
  const prior = await f.service.createOrRotateGuestMailbox({ ...f.params, cookieValue: f.cookie, domain: 'example.test' });
  f.data.sessions[0].expires_at = new Date(f.now + 30_000);
  const originalExpiry = +f.data.sessions[0].expires_at;
  f.data.domainActive = false;
  await assert.rejects(f.service.createOrRotateGuestMailbox({ ...f.params, cookieValue: f.cookie, domain: 'example.test' }), e => e.status === 409);
  assert.equal(+f.data.sessions[0].expires_at, originalExpiry);
  assert.equal(f.data.boxes[0].status, 'ACTIVE');
  assert.equal(f.data.boxes[0].id, prior.mailbox.id);
});

test('idempotent address claim renews the session without extending its mailbox or accepting another session', async () => {
  const f = await fixture();
  const request = { ...f.params, cookieValue: f.cookie, domain: 'example.test', localPart: 'synthetic', claimId: 'a'.repeat(22), requiredSessionId: f.id };
  const first = await f.service.createOrRotateGuestMailbox(request);
  f.advance(5_000);
  f.data.sessions[0].expires_at = new Date(f.now + 30_000);
  const again = await f.service.createOrRotateGuestMailbox(request);
  assert.equal(again.mailbox.id, first.mailbox.id);
  assert.equal(again.mailbox.expiresAt, first.mailbox.expiresAt);
  assert.equal(again.issuedCookie.cookieValue, f.cookie);
  assert.equal(again.issuedCookie.cookieMaxAge, 86400);
  assert.equal(f.data.boxes.length, 1);
  await assert.rejects(f.service.createOrRotateGuestMailbox({ ...request, cookieValue: 'invalid' }), e => e.status === 401);
});

test('guest read identity verifies signatures and bounds input without authorizing expired sessions', async () => {
  const f = await fixture();
  assert.equal(f.service.guestReadIdentity(f.cookie), `${f.id}:${f.data.sessions[0].token_hash}`);
  for (const input of [undefined, null, 123, '', 'x'.repeat(513), `${f.cookie}x`, f.cookie.replace(/.$/, '!')]) assert.equal(f.service.guestReadIdentity(input), null);
  f.data.sessions[0].expires_at = new Date(f.now - 1);
  assert.ok(f.service.guestReadIdentity(f.cookie));
  assert.equal(await f.service.getGuestMailbox({ ...f.params, cookieValue: f.cookie }), null);
});

async function expiredEndpoint(status) {
  const f = await fixture();
  if (status === 401) f.data.sessions[0].expires_at = new Date(f.now - 1);
  const handler = await loadModule('../src/pages/api/guest/messages/index.ts', {
    '../../../../../server/guest/service.mjs': f.service,
    '../../../../../server/guest/read-limit.mjs': { consumeGuestReadLimit: async () => ({ allowed: true }) },
  });
  return () => handler.GET({ request: new Request('https://example.test/api/guest/messages', { headers: { 'user-agent': f.params.userAgent } }), url: new URL('https://example.test/api/guest/messages'), cookies: { get: () => ({ value: f.cookie }) }, clientAddress: '127.0.0.1' });
}

test('real service errors preserve 410 and 401 through the messages route while unexpected errors remain private', async () => {
  for (const status of [401, 410]) {
    const response = await (await expiredEndpoint(status))();
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  const response = apiError(Object.assign(new Error('synthetic database detail'), { code: 'ER_PARSE_ERROR' }), '收件箱读取失败。');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).message, '收件箱读取失败。');
});

async function mountMailbox(kind, expired) {
  let cursor = 0, dirty = true, tree, isExpired = false;
  const slots = [], effects = [], timers = new Map(); let timerId = 0;
  const mailbox = { id: 'synthetic-box', address: 'synthetic@example.test', domain: 'example.test', durationMinutes: 60, expiresAt: '2099-01-01T00:00:00Z' };
  const message = { id: 'synthetic-message', sender: 'sender@example.test', subject: 'synthetic mail', receivedAt: '2026-01-01T00:00:00Z', isRead: false };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((v, n) => v !== previous.deps[n])) effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const globals = {
    document: { body: { classList: { add() {}, remove() {}, toggle() {} } }, addEventListener() {}, removeEventListener() {} },
    window: { setInterval(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearInterval(id) { timers.delete(id); }, setTimeout() {} },
    clearInterval: id => timers.delete(id),
    fetch: async url => url === '/api/guest/mailbox' ? Response.json({ ok: true, mailbox })
      : String(url).includes('/messages/') ? Response.json({ ok: true, message: { ...message, bodyText: 'synthetic body' } })
        : isExpired ? expired() : Response.json({ ok: true, mailbox, messages: [message], pagination: { total: 1, page: 1, pages: 1 } }),
  };
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    './ui/MailReader': { __esModule: true, default: 'mail-reader' }, './TurnstileWidget': { __esModule: true, default: 'captcha' },
    '../lib/useTranslator': { useTranslator: () => text => text }, './ui/ChoicePicker': { __esModule: true, default: 'picker' },
    '../lib/clipboard': { copyText: async () => true }, './ui/useDialog': { useDialog() {} },
  };
  imports['./ui/useGuestAttempt'] = await loadModule('../src/components/ui/useGuestAttempt.ts', imports, globals);
  const component = await loadModule(`../src/components/${kind === 'relay' ? 'RelayMailbox' : 'GuestMailbox'}.tsx`, imports, globals);
  const props = { authenticated: false, initialMailbox: mailbox, initialMessages: [message], suffixes: [{ suffix: 'example.test', provider: 'test' }], domains: [{ domain: 'example.test', kind: 'PUBLIC' }], plans: [{ id: 'free', minutes: 60, points: 0, label: '1 小时' }], memberDiscountPercent: 100, turnstileSiteKey: 'synthetic', turnstileConfigured: true };
  async function flush() { for (let i = 0; i < 50; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) { dirty = false; cursor = 0; tree = component.default(props); while (effects.length) effects.shift()(); } } }
  function nodes(value = tree) { if (!value || typeof value !== 'object') return []; if (Array.isArray(value)) return value.flatMap(v => nodes(v ?? null)); return [value, ...nodes(value.props?.children ?? null)]; }
  await flush();
  return {
    nodes, get text() { return JSON.stringify(tree); },
    async open() { const row = nodes().find(n => ['inbox-message-row', 'app-mail-row'].includes(n.props?.className)); assert.ok(row); await row.props.onClick(); await flush(); },
    async expire() { isExpired = true; const timer = [...timers.values()].find(t => t.ms === 8000); assert.ok(timer); timer.fn(); await flush(); },
  };
}

for (const kind of ['ordinary', 'relay']) for (const status of [401, 410]) test(`${kind} inbox and open reader are cleared by a real ${status} service/route response`, async () => {
  const app = await mountMailbox(kind, await expiredEndpoint(status));
  await app.open();
  assert.ok(app.nodes().some(n => n.type === 'mail-reader'));
  await app.expire();
  assert.ok(!app.nodes().some(n => n.type === 'mail-reader'));
  assert.ok(!app.nodes().some(n => n.props?.className === 'guest-current-row'));
  assert.ok(!app.nodes().some(n => ['inbox-message-row', 'app-mail-row'].includes(n.props?.className)));
  assert.match(app.text, /过期|失效/);
});
