import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { consumeGuestReadLimit } from '../server/guest/read-limit.mjs';
import { guestReadIdentity } from '../server/guest/service.mjs';
import { guestRequestIp } from '../server/guest/http.mjs';

process.env.GUEST_SESSION_SECRET = 'disposable-read-limit-unit-secret-32-chars';
const cookie = () => {
  const payload = randomUUID() + '.' + 'x'.repeat(43);
  return payload + '.' + createHmac('sha256', process.env.GUEST_SESSION_SECRET).update(payload).digest('base64url');
};
function limiter() {
  const rows = new Map(), calls = [];
  return { rows, calls, async consume(options) {
    calls.push(options);
    const key = options.action + ':' + options.identifier;
    const count = rows.get(key) || 0, allowed = count < options.limit;
    if (allowed) rows.set(key, count + 1);
    return { allowed, remaining: Math.max(0, options.limit - count - 1), retryAfter: 37 };
  } };
}
async function route(file, limits) {
  const url = new URL('../src/pages/api/guest/' + file, import.meta.url);
  const source = await readFile(url, 'utf8'), imports = {}, calls = { reads: 0, manual: 0 };
  for (const node of ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const name = node.moduleSpecifier.text;
    imports[name] = await import(new URL(name, url));
    if (name.endsWith('/read-limit.mjs')) imports[name] = {
      consumeGuestReadLimit: args => consumeGuestReadLimit(args, {consume: limits.consume}),
    };
    if (name.endsWith('/guest/service.mjs')) imports[name] = {
      ...imports[name],
      getGuestMailbox: async () => { calls.reads++; return null; },
      listGuestMessages: async () => { calls.reads++; throw Object.assign(new Error('临时邮箱会话不存在或已经失效。'), {status: 401}); },
      getGuestMessage: async () => { calls.reads++; throw Object.assign(new Error('临时邮箱会话不存在或已经失效。'), {status: 401}); },
    };
    if (name.endsWith('/request-security.mjs')) imports[name] = {
      ...imports[name], consumeRefreshCooldown: async () => { calls.manual++; return {allowed:true}; },
    };
  }
  const exports = {};
  runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {
    exports, require:name=>imports[name], Response, Request, URL, Buffer, Error, console,
  });
  return { calls, get: (cookieValue, ip = '192.0.2.80') => {
    const url = new URL('https://example.test/api/guest/' + file + '?manual=1');
    return exports.GET({url, request:new Request(url), clientAddress:ip,
      params:{id:'synthetic-id'}, cookies:{get:()=>({value:cookieValue})}});
  }};
}

test('guest read identity rejects unsigned, tampered and oversized values; signed identity is stable', () => {
  const value = cookie();
  assert.equal(guestReadIdentity(value), guestReadIdentity(value));
  assert.ok(guestReadIdentity(value));
  for (const invalid of [null, '', 'random', value.slice(0,-1)+'!', 'x'.repeat(513)])
    assert.equal(guestReadIdentity(invalid), null);
});

test('rotating invalid cookies across all real read handlers shares one IP allowance and creates no session/manual rows', async () => {
  const limits = limiter();
  const handlers = await Promise.all(['mailbox.ts','messages/index.ts','messages/[id].ts'].map(file=>route(file,limits)));
  for (let i=0;i<650;i++) {
    const handler = handlers[i%3], response = await handler.get('invalid-'+i);
    assert.equal(response.status, i<600 ? (i%3===0?200:401) : 429);
    if (i>=600) {
      assert.equal(response.headers.get('retry-after'),'37');
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
  }
  assert.equal(limits.rows.size,1);
  assert.equal([...limits.rows.values()][0],600);
  assert.equal(handlers.reduce((n,h)=>n+h.calls.reads,0),600);
  assert.equal(handlers.reduce((n,h)=>n+h.calls.manual,0),0);
  assert.equal((await handlers[0].get('different-invalid','192.0.2.81')).status,200);
});

test('signed sessions retain their own endpoint quotas and share the IP ceiling', async () => {
  const limits=limiter(), first=cookie(), second=cookie();
  const run=(kind,value)=>consumeGuestReadLimit({kind,ipAddress:'192.0.2.82',cookieValue:value},{consume:limits.consume});
  const results=await Promise.all(Array.from({length:130},()=>run('detail',first)));
  assert.equal(results.filter(r=>r.allowed).length,120);
  assert.equal((await run('detail',second)).allowed,true);
  assert.equal((await run('list',first)).allowed,true);
  assert.equal(limits.rows.size,4);
  assert.ok(limits.calls.every(call=>!String(call.identifier).includes(first)));
  for(let i=132;i<600;i++)await run('mailbox',cookie());
  const before=limits.rows.size;
  const rejected=await run('list',cookie());
  assert.equal(rejected.allowed,false);
  assert.equal(rejected.sessionIdentifier,null);
  assert.equal(limits.rows.size,before);
});

test('trusted proxy IP stays stable; public callers cannot rotate forwarding headers to bypass it', () => {
  const request=new Request('https://example.test/',{headers:{'x-real-ip':'198.51.100.2','x-forwarded-for':'198.51.100.3','cf-connecting-ip':'198.51.100.4'}});
  assert.equal(guestRequestIp(request,'192.0.2.82'),'192.0.2.82');
  assert.equal(guestRequestIp(request,'127.0.0.1'),'198.51.100.2');
  assert.equal(guestRequestIp(new Request('https://example.test/'),'127.0.0.1'),'127.0.0.1');
});
