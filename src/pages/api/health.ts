import type { APIRoute } from 'astro';
import { openDatabase } from '../../../server/db/database.mjs';

export const prerender = false;

export const GET: APIRoute = async () => {
  let connection;
  try {
    connection = await openDatabase();
    await connection.query('SELECT 1');
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  } finally {
    connection?.release();
  }
};
