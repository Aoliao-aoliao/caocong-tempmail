import test from "node:test";
import assert from "node:assert/strict";
import { recoverJunkMail, pollAccount } from "../server/relay/poller.mjs";
import { validateAlias } from "../server/relay/alias-settings.mjs";
const alias = {
  id: 1,
  address: "owner+test@outlook.com",
  activated_at: new Date("2026-10-06T12:00:00Z"),
};
const raw = (headers, body = "content") =>
  Buffer.from(
    `From: sender@example.test\r\n${headers}\r\nSubject: test\r\n\r\n${body}`,
  );
const store=new Map();
const cursorDeps={now:()=>new Date("2026-10-06T13:00:00Z").getTime(),readCursor:async key=>store.get(key)||{uid:0,previous:null},writeCursor:async(key,validity,uid)=>store.set(key,{uid,previous:JSON.stringify({validity,uid})})};
const config = {
  maxMessageBytes: 10000,
  maxAttachments: 10,
  maxAttachmentBytes: 1000,
  mailboxMaxMessages: 100,
  mailboxMaxBytes: 100000,
};
test('durable Junk scan never wraps, handles new UIDs and resets only on UIDVALIDITY change', async () => {
  let saved = null, validity = 10;
  const fetched = [], moved = [], searches = [];
  const now = Date.parse('2026-10-06T13:00:00Z');
  const items = new Map([[1, alias.address], [2, 'unrelated@example.test']]);
  const dependencies = {
    now: () => now,
    readCursor: async () => ({uid:saved?.validity === String(validity) ? saved.uid : 0,previous:JSON.stringify(saved)}),
    writeCursor: async (key, namespace, uid) => { saved = {validity:namespace,uid}; },
  };
  const client = {
    get mailbox() { return {uidValidity:validity}; },
    list: async () => [{path:'Junk',specialUse:'\\Junk'}],
    getMailboxLock: async () => ({release(){}}),
    search: async (query) => { searches.push(query); return [...items.keys()]; }, // IMAP * can include an older last UID
    async *fetch(uids, query) {
      assert.equal(query.source, undefined);
      assert.equal(query.envelope, true);
      fetched.push([...uids]);
      for (const uid of [...uids].reverse()) yield {uid,envelope:{to:[{address:items.get(uid)}]},internalDate:new Date(now-1000),size:100};
    },
    messageMove: async uid => { moved.push(Number(uid)); return {}; },
  };
  assert.equal(await recoverJunkMail(client,[alias],config,77,dependencies),1);
  assert.equal(await recoverJunkMail(client,[alias],config,77,dependencies),0);
  assert.deepEqual(fetched,[[1,2]]);
  items.set(3,alias.address);
  assert.equal(await recoverJunkMail(client,[alias],config,77,dependencies),1);
  assert.deepEqual(fetched,[[1,2],[3]]);
  validity=11;
  assert.equal(await recoverJunkMail(client,[alias],config,77,dependencies),2);
  assert.deepEqual(moved,[1,3,3,1]);
  assert.equal(searches[1].uid,'3:*');
  assert.equal(searches[3].uid,'1:*');
});
test('Junk scans at most 100 headers per round within an exact 24-hour window and never commits failures', async () => {
  const now=Date.parse('2026-10-06T13:00:00Z');
  let saved=0, failFetch=true, failMove=false;
  const batches=[], moved=[];
  const oldAlias={...alias,activated_at:new Date(now-3*86400000)};
  const dependencies={now:()=>now,readCursor:async()=>({uid:saved,previous:null}),writeCursor:async(k,v,uid)=>{saved=uid;}};
  const client={mailbox:{uidValidity:2},list:async()=>[{path:'Spam',specialUse:'\\Junk'}],getMailboxLock:async()=>({release(){}}),
    search:async query=>{assert.equal(query.since.getTime(),now-86400000);return Array.from({length:205},(_,i)=>i+1);},
    async *fetch(uids){batches.push(uids);if(failFetch)throw Error('fetch interrupted');for(const uid of uids)yield{uid,envelope:{bcc:[{address:oldAlias.address}]},internalDate:new Date(uid===1?now-86400001:now-1000),size:10};},
    messageMove:async uid=>{if(failMove)return false;moved.push(Number(uid));return {};}};
  await assert.rejects(recoverJunkMail(client,[oldAlias],config,88,dependencies));
  assert.equal(saved,0);
  failFetch=false;failMove=true;
  await assert.rejects(recoverJunkMail(client,[oldAlias],config,88,dependencies));
  assert.equal(saved,0);
  failMove=false;
  assert.equal(await recoverJunkMail(client,[oldAlias],config,88,dependencies),99);
  assert.equal(saved,100);
  assert.equal(await recoverJunkMail(client,[oldAlias],config,88,dependencies),100);
  assert.equal(await recoverJunkMail(client,[oldAlias],config,88,dependencies),5);
  assert.ok(batches.every(b=>b.length<=100));
  assert.equal(moved.includes(1),false);
  assert.equal(saved,205);
});
function junkClient(items, { moveFailure = false } = {}) {
  const moved = [],
    calls = [];
  return {
    moved,
    calls,
    mailbox: { uidValidity: 10 },
    async list() {
      return [{ path: "Junk", specialUse: "\\Junk" }];
    },
    async getMailboxLock(path) {
      calls.push("lock:" + path);
      return {
        release() {
          calls.push("release:" + path);
        },
      };
    },
    async search() {
      return items.map((x) => x.uid);
    },
    async *fetch(uids, query) {
      assert.equal(query.source, undefined);
      assert.equal(query.envelope, true);
      calls.push("fetch");
      for (const item of items.filter(x => uids.includes(x.uid))) {
        const parsed = await (await import('mailparser')).simpleParser(item.source);
        yield {...item, source:undefined, size:item.source.length, envelope:Object.fromEntries(['to','cc','bcc'].map(k => [k,parsed[k]?.value||[]]))};
      }
      calls.push("fetched");
    },
    async messageMove(uid, destination) {
      assert.equal(calls.includes("fetched"), true);
      moved.push([uid, destination]);
      return !moveFailure;
    },
  };
}
test("Junk recovery routes exact To/Cc/Bcc after activation, not subject/body/old/oversized mail", async () => {
  const headers = [
    "To: Owner <owner+test@outlook.com>",
    "Cc: owner+test@outlook.com",
    "Bcc: owner+test@outlook.com",
    "To: other@outlook.com\r\nSubject: owner+test@outlook.com",
  ];
  const items = headers.map((h, i) => ({
    uid: i + 1,
    source: raw(h, "owner+test@outlook.com"),
    internalDate: new Date("2026-10-06T12:01:00Z"),
  }));
  items.push(
    {
      uid: 5,
      source: raw(headers[0]),
      internalDate: new Date("2026-10-06T11:59:59Z"),
    },
    { uid: 6, source: Buffer.alloc(10001), internalDate: new Date() },
  );
  const client = junkClient(items);
  assert.equal(await recoverJunkMail(client, [alias], config, 1, cursorDeps), 3);
  assert.deepEqual(client.moved, [
    ["1", "INBOX"],
    ["2", "INBOX"],
    ["3", "INBOX"],
  ]);
  assert.equal(client.calls.at(-1), "release:Junk");
});
test("Junk scan avoids empty/invalid aliases and absent special folder", async () => {
  const client = {
    list() {
      throw Error("should not scan");
    },
  };
  assert.equal(await recoverJunkMail(client, [], config, 1), 0);
  assert.equal(
    await recoverJunkMail(
      client,
      [{ ...alias, activated_at: "invalid" }],
      config,
      1,
    ),
    0,
  );
  assert.equal(
    await recoverJunkMail({ list: async () => [] }, [alias], config, 1),
    0,
  );
});
test("Junk move failure releases the mailbox lock and is retryable", async () => {
  const client = junkClient(
    [{ uid: 1, source: raw("To: " + alias.address), internalDate: new Date() }],
    { moveFailure: true },
  );
  await assert.rejects(recoverJunkMail(client, [alias], config, 3, cursorDeps));
  assert.equal(client.calls.at(-1), "release:Junk");
});
test("new UID namespace snapshots tail before moving Junk, then delivers recovered UID", async () => {
  const delivered = [],
    states = [];
  let moved = false;
  const client = {
    mailbox: {},
    connect: async () => {},
    logout: async () => {},
    async getMailboxLock() {
      this.mailbox = { uidValidity: 20, uidNext: moved ? 7 : 6 };
      return { release() {} };
    },
    search: async () => [6],
    async *fetch() {
      yield {
        uid: 6,
        source: raw("To: " + alias.address),
        internalDate: new Date(),
      };
    },
  };
  await pollAccount(
    {
      id: 8,
      public_id: "RA-test",
      last_uid: 99,
      uid_validity: 10,
      updated_at: new Date(),
    },
    {
      config,
      dependencies: {
        client,
        aliasesFor: async () => [alias],
        recoverJunkMail: async () => {
          moved = true;
        },
        saveDelivery: async (mail) => delivered.push(mail),
        readInboxProgress: async () => [],
        updateState: async (id, state) => states.push(state),
      },
    },
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].relaySource.uid, 6);
  assert.equal(states[0].uid, 6);
  assert.equal(states[0].uidValidity, 20);
});
test("Junk recovery failure does not stop INBOX delivery and writes retry diagnostic", async () => {
  const states = [],
    delivered = [];
  const client = {
    mailbox: { uidValidity: 1 },
    connect: async () => {},
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [1],
    async *fetch() {
      yield {
        uid: 1,
        source: raw("To: " + alias.address),
        internalDate: new Date(),
      };
    },
    logout: async () => {},
  };
  await pollAccount(
    { id: 9, last_uid: 0, uid_validity: 1 },
    {
      config,
      dependencies: {
        client,
        recoverJunkMail: async () => {
          throw Error("move failed");
        },
        aliasesFor: async () => [alias],
        saveDelivery: async (mail) => delivered.push(mail),
        readInboxProgress: async () => [],
        updateState: async (id, state) => states.push(state),
      },
    },
  );
  assert.equal(delivered.length, 1);
  assert.match(states[0].retryError, /部分邮件暂未保存/);
});
test("Gmail aliases require same exact username; Microsoft enabling requires confirmation", () => {
  const gmail = { provider: "GMAIL", email: "owner@gmail.com" };
  assert.equal(
    validateAlias(gmail, { address: "OWNER@googlemail.com", enabled: true }),
    "owner@googlemail.com",
  );
  for (const address of [
    "other@googlemail.com",
    "owner+test@googlemail.com",
    "owner@gmail.com",
  ])
    assert.throws(() => validateAlias(gmail, { address, enabled: true }));
  const ms = { provider: "OUTLOOK", email: "owner@hotmail.com" };
  assert.throws(() =>
    validateAlias(ms, {
      address: "alias@outlook.com",
      enabled: true,
      confirmed: false,
    }),
  );
  assert.equal(
    validateAlias(ms, {
      address: "alias@outlook.com",
      enabled: true,
      confirmed: true,
    }),
    "alias@outlook.com",
  );
  assert.equal(
    validateAlias(ms, { address: "alias@outlook.com", enabled: false }),
    "alias@outlook.com",
  );
  assert.throws(() =>
    validateAlias(ms, {
      address: "alias@gmail.com",
      enabled: true,
      confirmed: true,
    }),
  );
});

// Run the actual TS endpoint with protocol dependencies substituted, so the
// original {url} contract bug would fail before any external authorization.
test("native OAuth entry consumes begin().url, redirects safely and escapes failure text", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const ts = (await import("typescript")).default;
  let beginCalls = 0,
    rateAllowed = true;
  const imports = {
    "../../../../../server/http/api.mjs": {
      requireApiUser: async (ctx, options) => {
        assert.equal(options.admin, true);
        if (ctx.request.headers.get("origin") !== "https://site.example.test")
          throw Object.assign(new Error("请求来源无效。"), { status: 403 });
        return { user: { id: 1, role: "ADMIN" }, ipAddress: "127.0.0.1" };
      },
      apiError: (error) =>
        Response.json(
          { message: error.message || "failure" },
          { status: error.status || 500 },
        ),
    },
    "../../../../../server/auth/service.mjs": { sessionCookieName: "session" },
    "../../../../../server/auth/request-security.mjs": {
      consumeAuthRateLimit: async () => ({
        allowed: rateAllowed,
        retryAfter: 3,
      }),
    },
    "../../../../../server/relay/microsoft-oauth.mjs": {
      microsoftOAuth: {
        begin: async (input) => {
          beginCalls++;
          assert.equal(input.session, "synthetic-session");
          return {
            url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?state=fixture",
          };
        },
      },
    },
  };
  const source = await readFile(
    new URL("../src/pages/api/admin/microsoft/authorize.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name) => imports[name],
    URL,
    Response,
    Error,
  });
  const context = (
    query = "?id=RA-test",
    origin = "https://site.example.test",
  ) => ({
    url: new URL(
      "https://site.example.test/api/admin/microsoft/authorize" + query,
    ),
    request: new Request("https://site.example.test", { headers: { origin } }),
    cookies: { get: () => ({ value: "synthetic-session" }) },
  });
  const response = await exports.GET(context());
  assert.equal(response.status, 303);
  assert.match(
    response.headers.get("location"),
    /^https:\/\/login.microsoftonline.com\/consumers\//,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await exports.GET(context("?id=a&id=b"))).status, 400);
  assert.equal(
    (await exports.GET(context("?id=RA-test", "https://other.example.test")))
      .status,
    403,
  );
  rateAllowed = false;
  assert.equal((await exports.GET(context())).status, 429);
  assert.equal(beginCalls, 1);
  rateAllowed = true;
  imports[
    "../../../../../server/relay/microsoft-oauth.mjs"
  ].microsoftOAuth.begin = async () => {
    throw Object.assign(new Error("请求 <script>alert(1)</script>"), {
      status: 409,
    });
  };
  const error = await exports.GET(context());
  assert.equal(error.status, 409);
  assert.doesNotMatch(await error.text(), /<script>/);
});
