import { htmlToPlainText } from '../../../../../server/mail/body-text.mjs';
import type { APIRoute } from 'astro';
import {
  apiError,
  normalizeApiKeyword,
  normalizeApiPage,
  parseApiJson,
  runApi,
} from '../../../../../server/openapi/service.mjs';
import {
  extractMailKeyword,
  isoDate,
  OPENAPI_PAGE_SIZE,
  pagedResult,
} from '../../../../../server/openapi/contract.mjs';
import { openDatabase } from '../../../../../server/db/database.mjs';

function mailboxSelector(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return { sql:'mb.id=?', value:Number(raw) };
  }
  if (/^MB-[0-9a-f-]{36}$/i.test(raw)) return { sql:'mb.public_id=?', value:raw };
  throw apiError(-1411, undefined, 400);
}

export const POST: APIRoute = (context) =>
  runApi(context, async (user: any) => {
    const body: any = await parseApiJson(context.request);
    const page = normalizeApiPage(body.page);
    const keyword = normalizeApiKeyword(body.keyword);
    const mailbox = mailboxSelector(body.mailboxId);
    const mailboxSql = mailbox ? `AND ${mailbox.sql}` : '';
    const searchSql = keyword ? 'AND (m.subject LIKE ? OR m.from_address LIKE ?)' : '';
    const filterParams = [
      user.user_id,
      ...(mailbox ? [mailbox.value] : []),
      ...(keyword ? [`%${keyword}%`, `%${keyword}%`] : []),
    ];
    const connection = await openDatabase();
    try {
      const [[countRow]]: any = await connection.execute(`
        SELECT COUNT(*) AS count
        FROM messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        WHERE mb.user_id=? AND mb.status='ACTIVE'
          AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
          AND m.risk_status='SAFE'
          ${mailboxSql}
          ${searchSql}
      `, filterParams);
      const [rows]: any = await connection.execute(`
        SELECT m.id,m.message_id,mb.address,m.from_address,m.subject,m.text_content,m.html_content,
               m.is_read,m.received_at
        FROM messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        WHERE mb.user_id=? AND mb.status='ACTIVE'
          AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
          AND m.risk_status='SAFE'
          ${mailboxSql}
          ${searchSql}
        ORDER BY m.received_at DESC,m.id DESC
        LIMIT ? OFFSET ?
      `, [...filterParams, OPENAPI_PAGE_SIZE, (page - 1) * OPENAPI_PAGE_SIZE]);
      const data = rows.map((row: any) => {
        const extractedKeyword = extractMailKeyword(row.subject, row.text_content || htmlToPlainText(row.html_content));
        return {
          id:Number(row.id),
          to:row.address,
          messageId:row.message_id || null,
          from:row.from_address,
          subject:row.subject || null,
          receivedAt:isoDate(row.received_at),
          read:Boolean(row.is_read),
          keyword:extractedKeyword,
          keywordDisplay:extractedKeyword,
        };
      });
      return pagedResult({ count:countRow?.count, page, data });
    } finally {
      connection.release();
    }
  });
