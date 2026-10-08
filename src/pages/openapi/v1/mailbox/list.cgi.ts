import type { APIRoute } from 'astro';
import {
  normalizeApiKeyword,
  normalizeApiPage,
  parseApiJson,
  runApi,
} from '../../../../../server/openapi/service.mjs';
import {
  isoDate,
  mailboxExpiry,
  OPENAPI_PAGE_SIZE,
  pagedResult,
} from '../../../../../server/openapi/contract.mjs';
import { openDatabase } from '../../../../../server/db/database.mjs';

export const POST: APIRoute = (context) =>
  runApi(context, async (user: any) => {
    const body: any = await parseApiJson(context.request);
    const page = normalizeApiPage(body.page);
    const keyword = normalizeApiKeyword(body.keyword);
    const connection = await openDatabase();
    try {
      const pattern = `%${keyword}%`;
      const [[countRow]]: any = await connection.execute(
        "SELECT COUNT(*) AS count FROM mailboxes WHERE user_id=? AND status<>'DELETED' AND address LIKE ?",
        [user.user_id, pattern],
      );
      const [rows]: any = await connection.execute(`
        SELECT id,domain_id,user_id,address,received_count,status,expires_at,created_at,updated_at
        FROM mailboxes
        WHERE user_id=? AND status<>'DELETED' AND address LIKE ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `, [user.user_id, pattern, OPENAPI_PAGE_SIZE, (page - 1) * OPENAPI_PAGE_SIZE]);
      const data = rows.map((row: any) => ({
        id:Number(row.id),
        domainId:Number(row.domain_id),
        email:row.address,
        userId:Number(row.user_id),
        receivedCount:Number(row.received_count || 0),
        expiresAt:isoDate(row.expires_at),
        createdAt:isoDate(row.created_at),
        updatedAt:isoDate(row.updated_at),
        ...mailboxExpiry(row.expires_at, row.status),
      }));
      return pagedResult({ count:countRow?.count, page, data });
    } finally {
      connection.release();
    }
  });
