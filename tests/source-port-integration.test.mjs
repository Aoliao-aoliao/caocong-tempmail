import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  saveRelayAccount,
  createMemberRelayMailbox,
  listRelayAccounts,
  getRelayPublicData,
} from "../server/relay/service.mjs";
import { setRelayAlias } from "../server/relay/alias-settings.mjs";
import { chooseRoutedAccount } from "../server/relay/address-routes.mjs";
import { encryptMicrosoft } from "../server/security/secret-box.mjs";
import { pollAccount, recoverJunkMail } from "../server/relay/poller.mjs";
import { junkCursorKey, readJunkCursor, writeJunkCursor } from '../server/relay/junk-cursor.mjs';
import { AttachmentStore } from "../server/mail/attachment-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test(
  "production source port regressions on disposable MySQL only",
  { timeout: 90000 },
  async (t) => {
    assert.equal(process.env.NODEMAIL_ISOLATED_TESTS, "1");
    assert.equal(process.env.MYSQL_HOST, "127.0.0.1");
    assert.equal(process.env.MYSQL_DATABASE, "nodemail_ci");
    const { openDatabase, closeDatabasePool } = await import(
      "../server/db/database.mjs"
    );
    const c = await openDatabase();
    let userId, configBefore, dir;
    const ids = [],
      publicIds = [],
      domainsBefore = new Map();
    const tokenKeys = [];
    const name = "port-" + randomUUID().slice(0, 8);
    const input = (email, provider = "GMAIL") => ({
      provider,
      email,
      suffix: email.split("@")[1],
      imapHost:
        provider === "OUTLOOK" ? "outlook.office365.com" : "imap.gmail.com",
      imapPort: 993,
      imapSecure: true,
      username: email,
      maxAliases: 2,
      ...(provider === "GMAIL" ? { credential: "synthetic-unused" } : {}),
    });
    const add = async (email) => {
      const provider = email.endsWith("@hotmail.com") ? "OUTLOOK" : "GMAIL";
      const r = await saveRelayAccount(input(email, provider), {
        actorUserId: userId,
      });
      publicIds.push(r.id);
      const [[a]] = await c.execute(
        "SELECT * FROM relay_accounts WHERE public_id=?",
        [r.id],
      );
      ids.push(a.id);
      await c.execute(
        "UPDATE relay_accounts SET status='ACTIVE',last_uid=0,uid_validity=1 WHERE id=?",
        [a.id],
      );
      return { ...a, status: "ACTIVE", last_uid: 0, uid_validity: 1 };
    };
    const route = async (suffix) => {
      const db = await openDatabase();
      try {
        await db.beginTransaction();
        const a = await chooseRoutedAccount(db, suffix);
        await db.rollback();
        return a;
      } catch (e) {
        await db.rollback();
        throw e;
      } finally {
        db.release();
      }
    };
    try {
      for (const suffix of [
        "gmail.com",
        "googlemail.com",
        "hotmail.com",
        "outlook.com",
      ])
        domainsBefore.set(
          suffix,
          (
            await c.execute("SELECT * FROM domains WHERE domain=?", [suffix])
          )[0][0],
        );
      const [[old]] = await c.execute(
        "SELECT value FROM system_settings WHERE `key`='microsoft_relay_config'",
      );
      configBefore = old?.value;
      userId = (
        await c.execute(
          "INSERT INTO users(public_id,email,password_hash,points_balance,role) VALUES (?,?,'synthetic',1000,'SUPER_ADMIN')",
          ["U-" + randomUUID(), name + "@example.test"],
        )
      )[0].insertId;
      const gmail = await add(name + "@gmail.com");
      tokenKeys.push(junkCursorKey(gmail.id,'Junk'));
      await t.test('Junk checkpoints persist across connections and reject stale writers', async () => {
        const key=junkCursorKey(gmail.id,'checkpoint-fixture');
        tokenKeys.push(key);
        assert.notEqual(key,junkCursorKey(gmail.id,'Junk'));
        assert.notEqual(key,junkCursorKey(gmail.id+1,'checkpoint-fixture'));
        const initial=await readJunkCursor(key,'10');
        assert.deepEqual(initial,{uid:0,previous:null});
        await writeJunkCursor(key,'10',100,initial.previous);
        await writeJunkCursor(key,'10',5,initial.previous);
        const persisted=await readJunkCursor(key,'10');
        assert.equal(persisted.uid,100);
        await writeJunkCursor(key,'10',200,persisted.previous);
        await writeJunkCursor(key,'10',110,persisted.previous);
        assert.equal((await readJunkCursor(key,'10')).uid,200);
        const changed=await readJunkCursor(key,'11');
        assert.equal(changed.uid,0);
        await writeJunkCursor(key,'11',2,changed.previous);
        await writeJunkCursor(key,'10',300,persisted.previous);
        assert.equal((await readJunkCursor(key,'11')).uid,2);
      });
      await t.test(
        "enable Googlemail uses physical account and audit, never copies credentials",
        async () => {
          await setRelayAlias(
            {
              id: gmail.public_id,
              address: name + "@googlemail.com",
              enabled: true,
            },
            { actorUserId: userId },
          );
          const selected = await route("googlemail.com");
          assert.equal(selected.id, gmail.id);
          assert.equal(selected.routing_email, name + "@googlemail.com");
          assert.equal(selected.username, gmail.username);
          assert.equal(
            (await getRelayPublicData()).some(
              (x) => x.suffix === "googlemail.com",
            ),
            true,
          );
          const listed = (await listRelayAccounts()).find(
            (a) => a.id === gmail.public_id,
          );
          assert.deepEqual(listed.extraAddresses, [name + "@googlemail.com"]);
          assert.equal(
            JSON.stringify(listed).includes("synthetic-unused"),
            false,
          );
          assert.equal(
            (
              await c.execute(
                "SELECT COUNT(*) n FROM audit_logs WHERE actor_user_id=? AND action='启用中继收信别名'",
                [userId],
              )
            )[0][0].n,
            1,
          );
        },
      );
      const [[plans]] = await c.execute(
        "SELECT value FROM system_settings WHERE `key`='mailbox_duration_plans'",
      );
      const plan = JSON.parse(plans.value).find(
        (p) => p.enabled !== false && Number(p.points) === 0,
      );
      assert.ok(plan);
      const box = await createMemberRelayMailbox({
        userId,
        suffix: "googlemail.com",
        durationMinutes: plan.minutes,
        expectedPrice: 0,
        requestId: randomUUID(),
      });
      await t.test(
        "both suffixes share physical account capacity",
        async () => {
          assert.match(
            box.address,
            new RegExp("^" + name + "\\+[a-f0-9]{6}@googlemail\\.com$"),
          );
          await c.execute(
            "UPDATE relay_accounts SET max_aliases=1 WHERE id=?",
            [gmail.id],
          );
          await assert.rejects(route("gmail.com"), (e) => e.status === 409);
          await assert.rejects(
            route("googlemail.com"),
            (e) => e.status === 409,
          );
          await c.execute(
            "UPDATE relay_accounts SET max_aliases=2 WHERE id=?",
            [gmail.id],
          );
        },
      );
      await t.test(
        "stop mapping blocks new allocation; historical mailbox still receives Junk via original account",
        async () => {
          await setRelayAlias(
            {
              id: gmail.public_id,
              address: name + "@googlemail.com",
              enabled: false,
            },
            { actorUserId: userId },
          );
          await assert.rejects(
            route("googlemail.com"),
            (e) => e.status === 409,
          );
          assert.equal(
            (await getRelayPublicData()).some(
              (x) => x.suffix === "googlemail.com",
            ),
            false,
          );
          await c.execute(
            "UPDATE mailboxes SET created_at='2026-01-01' WHERE public_id=?",
            [box.id],
          );
          await c.execute(
            "UPDATE relay_accounts SET status='ERROR',last_error='retry' WHERE id=?",
            [gmail.id],
          );
          const [[account]] = await c.execute(
            "SELECT * FROM relay_accounts WHERE id=?",
            [gmail.id],
          );
          let moved = false,
            released = 0;
          const raw = Buffer.from(
            `From: sender@example.test\r\nTo: ${box.address}\r\nSubject: Junk recovered\r\n\r\nsynthetic mail`,
          );
          const client = {
            mailbox: { uidValidity: 1, uidNext: 1 },
            connect: async () => {},
            logout: async () => {},
            list: async () => [{ specialUse: "\\Junk", path: "Junk" }],
            async getMailboxLock(path) {
              this.mailbox = {
                uidValidity: path === "Junk" ? 2 : 1,
                uidNext: moved ? 2 : 1,
              };
              this.path = path;
              return {
                release() {
                  released++;
                },
              };
            },
            async search() {
              return this.path === "Junk" || moved ? [1] : [];
            },
            async *fetch(uids, query) {
              yield query.envelope ? {uid:1,envelope:{to:[{address:box.address}]},size:raw.length,internalDate:new Date()} : { uid: 1, source: raw, internalDate: new Date() };
            },
            messageMove: async () => {
              moved = true;
              return {};
            },
          };
          dir = await mkdtemp(join(tmpdir(), "nodemail-port-"));
          const store = new AttachmentStore(dir);
          await store.initialize();
          await pollAccount(account, {
            config: {
              maxMessageBytes: 10000,
              maxAttachments: 10,
              maxAttachmentBytes: 1000,
              mailboxMaxMessages: 100,
              mailboxMaxBytes: 100000,
            },
            attachmentStore: store,
            dependencies: { client, recoverJunkMail },
          });
          assert.equal(moved, true);
          assert.equal(released, 3);
          assert.equal(
            (
              await c.execute(
                "SELECT COUNT(*) n FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE mb.public_id=?",
                [box.id],
              )
            )[0][0].n,
            1,
          );
          const [[a]] = await c.execute(
            "SELECT status,last_uid FROM relay_accounts WHERE id=?",
            [gmail.id],
          );
          assert.equal(a.status, "ACTIVE");
          assert.equal(Number(a.last_uid), 1);
        },
      );
      const ms = await add(name + "@hotmail.com");
      const grant = {
        reauthRequired: false,
        configRevision: "fixture",
        secret: Object.fromEntries(
          Object.entries(
            encryptMicrosoft(
              JSON.stringify({
                accessToken: "synthetic",
                refreshToken: "synthetic",
                expiresAt: Date.now() + 60000,
              }),
            ),
          ).map(([k, v]) => [k, v.toString("base64")]),
        ),
      };
      await c.execute(
        "INSERT INTO system_settings (`key`,value,value_type) VALUES ('microsoft_relay_config',?,'json') ON DUPLICATE KEY UPDATE value=VALUES(value)",
        [JSON.stringify({ revision: "fixture" })],
      );
      const token = "microsoft_relay_token:" + ms.public_id;
      tokenKeys.push(token);
      await c.execute(
        "INSERT INTO system_settings (`key`,value,value_type) VALUES (?,?,'json')",
        [token, JSON.stringify(grant)],
      );
      await t.test(
        "Microsoft mapping retains existing grant, physical username and checkpoint",
        async () => {
          await c.execute("UPDATE relay_accounts SET last_uid=46 WHERE id=?", [
            ms.id,
          ]);
          const before = (
            await c.execute("SELECT value FROM system_settings WHERE `key`=?", [
              token,
            ])
          )[0][0].value;
          await setRelayAlias(
            {
              id: ms.public_id,
              address: name + "@outlook.com",
              enabled: true,
              confirmed: true,
            },
            { actorUserId: userId },
          );
          const selected = await route("outlook.com");
          assert.equal(selected.id, ms.id);
          assert.equal(selected.username, ms.email);
          assert.equal(Number(selected.last_uid), 46);
          assert.equal(
            (
              await c.execute(
                "SELECT value FROM system_settings WHERE `key`=?",
                [token],
              )
            )[0][0].value,
            before,
          );
          await c.execute(
            "UPDATE relay_accounts SET status='DISABLED' WHERE id=?",
            [ms.id],
          );
          await assert.rejects(route("outlook.com"), (e) => e.status === 409);
          await c.execute(
            "UPDATE relay_accounts SET status='ACTIVE' WHERE id=?",
            [ms.id],
          );
          await c.execute("UPDATE system_settings SET value=? WHERE `key`=?", [
            JSON.stringify({ ...grant, reauthRequired: true }),
            token,
          ]);
          await assert.rejects(route("outlook.com"), (e) => e.status === 409);
        },
      );
      await t.test(
        "cross-table address ownership and changing an account with aliases are rejected",
        async () => {
          await assert.rejects(
            saveRelayAccount(input(name + "@outlook.com", "OUTLOOK"), {
              actorUserId: userId,
            }),
            (e) => e.status === 409,
          );
          await assert.rejects(
            saveRelayAccount(
              {
                ...input(name + "new@hotmail.com", "OUTLOOK"),
                id: ms.public_id,
              },
              { actorUserId: userId },
            ),
            (e) => e.status === 409,
          );
          const other = await add(name + "other@hotmail.com");
          await assert.rejects(
            setRelayAlias(
              {
                id: other.public_id,
                address: name + "@outlook.com",
                enabled: true,
                confirmed: true,
              },
              { actorUserId: userId },
            ),
            (e) => e.status === 409,
          );
        },
      );
      await t.test(
        "concurrent primary save and alias enable cannot claim one address twice",
        async () => {
          const address = name + "race@outlook.com";
          const result = await Promise.allSettled([
            setRelayAlias(
              { id: ms.public_id, address, enabled: true, confirmed: true },
              { actorUserId: userId },
            ),
            saveRelayAccount(input(address, "OUTLOOK"), {
              actorUserId: userId,
            }),
          ]);
          assert.equal(
            result.filter((r) => r.status === "fulfilled").length,
            1,
          );
          if (result[1].status === "fulfilled") {
            const r = result[1].value;
            publicIds.push(r.id);
            ids.push(
              (
                await c.execute(
                  "SELECT id FROM relay_accounts WHERE public_id=?",
                  [r.id],
                )
              )[0][0].id,
            );
          }
        },
      );
    } finally {
      if (userId) {
        await c.execute(
          "DELETE FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?)",
          [userId],
        );
        await c.execute(
          "DELETE FROM relay_message_links WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id=?)",
          [userId],
        );
        await c.execute("DELETE FROM point_transactions WHERE user_id=?", [
          userId,
        ]);
        await c.execute("DELETE FROM mailboxes WHERE user_id=?", [userId]);
        await c.execute("DELETE FROM audit_logs WHERE actor_user_id=?", [
          userId,
        ]);
      }
      for (const id of ids)
        await c.execute("DELETE FROM relay_accounts WHERE id=?", [id]);
      for (const key of tokenKeys)
        await c.execute("DELETE FROM system_settings WHERE `key`=?", [key]);
      if (configBefore === undefined)
        await c.execute(
          "DELETE FROM system_settings WHERE `key`='microsoft_relay_config'",
        );
      else
        await c.execute(
          "UPDATE system_settings SET value=? WHERE `key`='microsoft_relay_config'",
          [configBefore],
        );
      for (const [suffix, row] of domainsBefore) {
        if (!row)
          await c.execute("DELETE FROM domains WHERE domain=?", [suffix]);
        else
          await c.execute(
            "UPDATE domains SET kind=?,mx_status=?,status=?,mailbox_count=? WHERE id=?",
            [row.kind, row.mx_status, row.status, row.mailbox_count, row.id],
          );
      }
      if (userId) await c.execute("DELETE FROM users WHERE id=?", [userId]);
      c.release();
      await closeDatabasePool();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  },
);
