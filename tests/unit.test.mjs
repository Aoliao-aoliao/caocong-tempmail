import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../server/auth/service.mjs';
import { normalizeMailboxAddress, safeAttachmentName, isRiskyAttachment } from '../server/mail/mail-utils.mjs';
import { resolvePublicImapHost } from '../server/relay/network-policy.mjs';
import { readBoundedText } from '../server/http/request-body.mjs';
import { readJsonBody } from '../server/http/api.mjs';
import { parseApiJson } from '../server/openapi/service.mjs';

test('password hashes verify only the correct password', () => {
  const hash = hashPassword('test-only-password');
  assert.equal(verifyPassword('test-only-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
  assert.equal(verifyPassword('test-only-password', 'malformed'), false);
});

test('mailbox normalization rejects invalid addresses', () => {
  assert.equal(normalizeMailboxAddress(' User@Example.COM '), 'user@example.com');
  for (const invalid of ['not-an-address', '../x@example.com', 'x@localhost', '@example.com']) {
    assert.equal(normalizeMailboxAddress(invalid), null);
  }
});

test('attachment filenames cannot carry paths and active content is rejected', () => {
  assert.equal(safeAttachmentName('../../evil.html').includes('/'), false);
  assert.ok(Buffer.byteLength(safeAttachmentName('邮'.repeat(100))) <= 180);
  assert.equal(isRiskyAttachment({ filename: 'payload.HTML', contentType: 'text/plain' }), true);
  assert.equal(isRiskyAttachment({ filename: 'safe.txt', contentType: 'image/svg+xml' }), true);
  assert.equal(isRiskyAttachment({ filename: 'safe.txt', contentType: 'text/plain' }), false);
});

test('relay cannot use private, loopback or Tailscale destination IPs', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.87.60.6', '::1']) {
    await assert.rejects(resolvePublicImapHost(ip), /公开访问/);
  }
});

test('malformed scrypt digests never authenticate arbitrary passwords', () => {
  const valid = hashPassword('test-only-password');
  for (const malformed of ['scrypt$salt$zz', 'scrypt$salt$0', valid.slice(0, -2), `${valid}$extra`, valid.replace(/.$/, 'g')]) {
    assert.equal(verifyPassword('test-only-password', malformed), false);
    assert.equal(verifyPassword('wrong-password', malformed), false);
  }
});

test('IPv6 aliases of restricted destinations are rejected without connecting', async () => {
  for (const ip of ['0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000',
    '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:10.0.0.1',
    '::ffff:100.87.60.6', '::ffff:c0a8:1', '2001:0db8::1', 'fe80:0:0:0:0:0:0:1']) {
    await assert.rejects(resolvePublicImapHost(ip), error => error.status === 400);
  }
  for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808']) {
    assert.equal((await resolvePublicImapHost(ip)).address, ip);
  }
});

function streamedRequest(chunks, { headers={}, cancel=() => {} }={}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
    cancel,
  }, { highWaterMark:0 });
  return new Request('https://example.com/', { method:'POST', headers, body, duplex:'half' });
}

test('bounded bodies preserve UTF-8 across chunks at the exact byte limit', async () => {
  const bytes = Buffer.from('{"name":"邮件"}');
  const request = streamedRequest([bytes.subarray(0, 10), bytes.subarray(10)], {
    headers:{ 'content-type':'application/json' },
  });
  assert.deepEqual(await readJsonBody(request, bytes.length), { name:'邮件' });
});

test('oversized streamed bodies stop before consuming the remainder', async () => {
  let cancelled = false;
  const request = streamedRequest([Buffer.alloc(4), Buffer.alloc(5), Buffer.alloc(1024)], {
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  await assert.rejects(readBoundedText(request, 8), error => error.status === 413);
  assert.equal(cancelled, true);
  assert.equal(request.body.locked, false);
});

test('JSON and OpenAPI parsers reject oversized bodies without declared length', async () => {
  for (const [parser, maximum] of [[readJsonBody, 4096], [parseApiJson, 16384]]) {
    const request = streamedRequest([Buffer.alloc(maximum + 1)], { headers:{ 'content-type':'application/json' } });
    await assert.rejects(parser(request), error => error.status === 413);
  }
});

test('declared oversized bodies are rejected without reading; invalid JSON remains rejected', async () => {
  let reads = 0;
  const request = new Request('https://example.com/', { method:'POST', duplex:'half', headers:{ 'content-length':'100' },
    body:new ReadableStream({ pull() { reads += 1; } }, { highWaterMark:0 }),
  });
  await assert.rejects(readBoundedText(request, 8), error => error.status === 413);
  assert.equal(reads, 0);
  for (const body of ['[1]', 'null', '{']) {
    await assert.rejects(readJsonBody(new Request('https://example.com/', {
      method:'POST', headers:{ 'content-type':'application/json' }, body,
    })), error => error.status === 400);
  }
});

// Read-only review findings: synthetic mail and internal scheduling only.
const { simpleParser } = await import('mailparser');
const { matchingRecipients, selectUidBatch, completedUidCursor, pollAccount } = await import('../server/relay/poller.mjs');
const { csvCell, serializeCsv } = await import('../src/lib/csv.mjs');
const { normalizePage, normalizeQuery } = await import('../server/http/pagination.mjs');
const { isValidMailboxDuration, discountedMailboxPrice } = await import('../server/member/mailbox-policy.mjs');

test('mailbox discounts keep integer precision across the allowed price range', () => {
  assert.equal(discountedMailboxPrice(10,70),7);
  assert.equal(discountedMailboxPrice(9007199254740971,7),630503947831867);
  assert.equal(discountedMailboxPrice(Number.MAX_SAFE_INTEGER,100),Number.MAX_SAFE_INTEGER);
  assert.equal(discountedMailboxPrice(10,0),0);
  for (const [points,discount] of [[-1,100],[1,101],[1,1.5],[Number.MAX_SAFE_INTEGER+1,100]]) {
    assert.throws(() => discountedMailboxPrice(points,discount));
  }
});

test('configured duration supports custom plans without overflowing SQL expiry', () => {
  const now = Date.UTC(2026, 9, 2);
  assert.equal(isValidMailboxDuration(120, now), true);
  const maximum = Math.floor((253402300799999 - now) / 60000);
  assert.equal(isValidMailboxDuration(maximum, now), true);
  for (const minutes of [0, -1, 1.5, Infinity, maximum + 1, 0xffffffff, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isValidMailboxDuration(minutes, now), false);
  }
});

test('relay routing ignores subject, sender, display names and arbitrary headers', async () => {
  const parsed=await simpleParser(Buffer.from('From: b@example.com\r\nTo: "b@example.com" <a@example.com>\r\nSubject: b@example.com\r\nX-Recipient: b@example.com\r\n\r\nb@example.com'));
  const aliases=[{id:1,address:'a@example.com'},{id:2,address:'b@example.com'}];
  assert.deepEqual(matchingRecipients(parsed,aliases).map(row=>row.id),[1]);
  const withCc=await simpleParser('To: A@EXAMPLE.COM\r\nCc: Team: b@example.com;\r\n\r\nbody');
  assert.deepEqual(matchingRecipients(withCc,aliases).map(row=>row.id),[1,2]);
});

test('failed UID retains durable cursor while scheduling later batches fairly', () => {
  const uids=Array.from({length:250},(_,i)=>i+10);
  assert.deepEqual(selectUidBatch(uids,109),uids.slice(100,200));
  assert.equal(completedUidCursor(uids,new Set(uids.slice(1)),9),9);
  assert.equal(completedUidCursor([10,11],new Set([10,11]),9),11);
  assert.equal(completedUidCursor([],new Set(),9),9);
});

test('poller retries full mailbox without blocking another recipient or later UID', async () => {
  const saved=[],states=[]; let progress=[];
  const account={id:991,uid_validity:1,last_uid:9,imap_host:'imap.example.com',imap_port:993,imap_secure:true};
  const client={mailbox:{uidValidity:1,uidNext:12},connect:async()=>{},logout:async()=>{},getMailboxLock:async()=>({release(){}}),search:async()=>[10,11],async *fetch(){
    yield {uid:10,internalDate:new Date(),source:Buffer.from('To: a@example.com, b@example.com\r\n\r\nfirst')};
    yield {uid:11,internalDate:new Date(),source:Buffer.from('To: b@example.com\r\n\r\nsecond')};
  }};
  const dependencies={client,resolveTarget:async()=>({address:'1.1.1.1',hostname:'imap.example.com'}),decryptCredential:()=>'',aliasesFor:async()=>[{id:1,address:'a@example.com',activated_at:'2020-01-01'},{id:2,address:'b@example.com',activated_at:'2020-01-01'}],readInboxProgress:async()=>progress,updateState:async(_,state)=>{states.push(state);progress=state.completedRanges;},saveDelivery:async({recipients,relaySource})=>{saved.push([recipients[0].id,relaySource.uid]);if(recipients[0].id===1)throw new Error('full');}};
  const config={maxMessageBytes:10000,maxAttachments:5,maxAttachmentBytes:1000,mailboxMaxMessages:1,mailboxMaxBytes:10000};
  await pollAccount(account,{config,attachmentStore:{},dependencies});
  await pollAccount(account,{config,attachmentStore:{},dependencies});
  assert.deepEqual(saved,[[1,10],[2,10],[2,11],[1,10],[2,10]]);
  assert.equal(states.filter(state=>'uid' in state).every(state=>state.uid===9),true);
});

test('CSV quotes delimiters/newlines and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('a,"b"\nc'),'"a,""b""\nc"');
  for(const value of ['=1+1',' +SUM(A1)','\t@cmd','-1+2'])assert.equal(csvCell(value).startsWith('"\''),true);
  assert.equal(serializeCsv([['id','note'],['1','safe']]),'\ufeff"id","note"\r\n"1","safe"');
});

test('pagination rejects ambiguous values and control-character queries', () => {
  assert.equal(normalizePage('11'),11);
  for(const value of ['1x','0','01','1.5','100001'])assert.throws(()=>normalizePage(value));
  assert.equal(normalizeQuery('  old@example.com  '),'old@example.com');
  assert.throws(()=>normalizeQuery('x\u0000y'));
});

test('server modules bundled into browser components never reach the database or Node built-ins', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { dirname, resolve, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const importsOf = source => [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] || m[2]);
  const queue = [];
  for (const dir of ['src/components', 'src/lib']) {
    for (const name of await readdir(join(root, dir))) {
      if (!/\.(tsx?|mjs)$/.test(name)) continue;
      const file = join(root, dir, name);
      for (const spec of importsOf(await readFile(file, 'utf8'))) if (spec.includes('/server/')) queue.push([resolve(dirname(file), spec), file]);
    }
  }
  assert.ok(queue.length > 0, 'expected browser components to share some server modules');
  const seen = new Set();
  while (queue.length) {
    const [file, from] = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(await readFile(file, 'utf8'))) {
      assert.ok(spec.startsWith('.'), `${file} (bundled via ${from}) imports ${spec}; browser-shared modules must stay pure`);
      assert.ok(!/\/db\//.test(spec), `${file} (bundled via ${from}) imports the database`);
      queue.push([resolve(dirname(file), spec), file]);
    }
  }
});
