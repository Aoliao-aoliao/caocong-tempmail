import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../server/mail/attachment-store.mjs';
import { isRiskyAttachment, safeAttachmentName } from '../server/mail/mail-utils.mjs';
import { chooseRoutedAccount } from '../server/relay/address-routes.mjs';

function mime(filename, contentType = 'application/octet-stream') {
  return Buffer.from([
    'From: sender@example.test', 'To: recipient@example.test',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
    '--fixture', `Content-Type: ${contentType}`,
    `Content-Disposition: attachment; filename*=utf-8''${encodeURIComponent(filename)}`,
    'Content-Transfer-Encoding: base64', '', Buffer.from('harmless fixture').toString('base64'),
    '--fixture--', '',
  ].join('\r\n'));
}

test('parsed MIME attachments use the same risk classification as their persisted names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodemail-seven-attachment-'));
  try {
    const store = new AttachmentStore(directory);
    await store.initialize();
    const fixtures = [
      ['payload.exe ', true], ['payload.ｅｘｅ', true], ['payload．html', true],
      ['payload.ex\u0000e', true], ['payload.EXE.', true],
      ['a'.repeat(176) + '.exe.txt', true], // The stored byte limit exposes .exe.
      ['a'.repeat(180) + '.exe', true], // Truncation must not conceal original risk.
      ['邮'.repeat(58) + 'aa.exe.txt', true], // Byte limit, not character limit.
      ['report.txt', false], ['照片.png', false], ['../report.pdf', false],
    ];
    for (const [filename, risky] of fixtures) {
      const parsed = await simpleParser(mime(filename));
      assert.equal(parsed.attachments.length, 1);
      const attachment = parsed.attachments[0];
      assert.equal(isRiskyAttachment(attachment), risky, filename);
      const stored = await store.persist(`MSG-${randomUUID()}`, [attachment]);
      assert.equal(stored.records[0].fileName, safeAttachmentName(attachment.filename));
      assert.ok(Buffer.byteLength(stored.records[0].fileName) <= 180);
      if (!risky) assert.equal(isRiskyAttachment({ ...attachment, filename: stored.records[0].fileName }), false);
      await stored.cleanup();
    }
    const html = await simpleParser(mime('ordinary.txt', 'text/html; charset=UTF-8'));
    assert.equal(isRiskyAttachment(html.attachments[0]), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('routing rechecks capacity under the account lock even when a candidate filled after selection', async () => {
  const checked = [];
  const db = {
    async execute(sql, parameters) {
      if (sql.startsWith('SELECT DISTINCT')) return [[{ id: 1 }, { id: 2 }]];
      if (sql.startsWith('SELECT ra.*')) {
        assert.match(sql, /FOR UPDATE/);
        return [[{ id: parameters[0], suffix: 'example.test', email: `account${parameters[0]}@example.test`, max_aliases: 1 }]];
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        assert.match(sql, /FOR UPDATE/);
        checked.push(parameters[0]);
        return [[{ count: parameters[0] === 1 ? 1 : 0 }]];
      }
      throw Error('Unexpected SQL in routing fixture');
    },
  };
  const account = await chooseRoutedAccount(db, 'example.test');
  assert.equal(account.id, 2);
  assert.deepEqual(checked, [1, 2]);
});
