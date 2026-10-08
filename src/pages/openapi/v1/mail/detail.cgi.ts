import { htmlToPlainText } from '../../../../../server/mail/body-text.mjs';
import type { APIRoute } from 'astro';
import { apiError, parseApiJson, runApi } from '../../../../../server/openapi/service.mjs';
import { isoDate } from '../../../../../server/openapi/contract.mjs';
import { openDatabase } from '../../../../../server/db/database.mjs';

function messageSelector(value: unknown) {
  const raw = String(value ?? '').trim();
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return { sql:'m.id=?', value:Number(raw) };
  }
  if (/^MSG-[0-9a-f-]{36}$/i.test(raw)) return { sql:'m.public_id=?', value:raw };
  throw apiError(-1412, undefined, 400);
}

export const POST: APIRoute = (context) =>
  runApi(context, async (user: any) => {
    const body: any = await parseApiJson(context.request);
    const selector = messageSelector(body.id);
    const connection = await openDatabase();
    try {
      const [[row]]: any = await connection.execute(`
        SELECT m.id,m.message_id,mb.address,m.from_address,m.subject,m.text_content,m.html_content,
               m.received_at
        FROM messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        WHERE ${selector.sql} AND mb.user_id=? AND mb.status='ACTIVE'
          AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))
          AND m.risk_status='SAFE'
        LIMIT 1
      `, [selector.value, user.user_id]);
      if (!row) throw apiError(-1412, undefined, 404);
      const [attachments]: any = await connection.execute(`
        SELECT file_name,content_type,size_bytes
        FROM message_attachments
        WHERE message_id=?
        ORDER BY id
      `, [row.id]);
      await connection.execute(`
        UPDATE messages m
        JOIN mailboxes mb ON mb.id=m.mailbox_id
        SET m.is_read=1
        WHERE m.id=? AND mb.user_id=?
      `, [row.id, user.user_id]);
      return {
        id:Number(row.id),
        to:row.address,
        messageId:row.message_id || null,
        from:row.from_address,
        subject:row.subject || null,
        receivedAt:isoDate(row.received_at),
        textContent:row.text_content || htmlToPlainText(row.html_content) || null,
        attachments:attachments.map((attachment: any) => ({
          fileName:attachment.file_name,
          contentType:attachment.content_type || null,
          size:Number(attachment.size_bytes || 0),
        })),
      };
    } finally {
      connection.release();
    }
  });
