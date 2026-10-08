import type { APIRoute } from 'astro';
import { runApi } from '../../../../../server/openapi/service.mjs';
import { isoDate, openApiDomainType } from '../../../../../server/openapi/contract.mjs';
import { openDatabase } from '../../../../../server/db/database.mjs';

export const GET: APIRoute = (context) =>
  runApi(context, async (user: any) => {
    const connection = await openDatabase();
    try {
      const [rows]: any = await connection.execute(`
        SELECT d.id,d.domain,d.kind,d.owner_user_id,d.created_at,d.updated_at,
          (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain_id=d.id AND mb.status<>'DELETED') AS mailbox_count,
          (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain_id=d.id AND mb.status='ACTIVE'
            AND (mb.expires_at IS NULL OR mb.expires_at>UTC_TIMESTAMP(3))) AS mailbox_occupy,
          (SELECT COUNT(*) FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id
            WHERE mb.domain_id=d.id) AS mail_count
        FROM domains d
        WHERE d.status='ACTIVE' AND d.mx_status='ACTIVE'
          AND (d.kind IN ('PUBLIC','LOGIN','MEMBER') OR (d.kind='PRIVATE' AND d.owner_user_id=?))
        ORDER BY d.kind,d.domain
      `, [user.user_id]);
      return rows.map((row: any) => ({
        id:Number(row.id),
        domain:row.domain,
        type:openApiDomainType(row.kind),
        ownerId:Number(row.owner_user_id || 0),
        mailboxOccupy:Number(row.mailbox_occupy || 0),
        mailboxCount:Number(row.mailbox_count || 0),
        mailCount:Number(row.mail_count || 0),
        state:0,
        createdAt:isoDate(row.created_at),
        updatedAt:isoDate(row.updated_at),
      }));
    } finally {
      connection.release();
    }
  });
