import { resolveApiRateLimit } from '../member/api-key.mjs';
import { readBoundedText } from '../http/request-body.mjs';
import { createHash } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import { consumeAuthRateLimit } from '../auth/request-security.mjs';
import { guestRequestIp } from '../guest/http.mjs';

const OPENAPI_JSON_LIMIT = 16 * 1024;
const OPENAPI_IP_LIMIT_PER_MINUTE = 120;

const ERROR_MESSAGES = new Map([
  [-1001, '系统繁忙，请稍后重试'],
  [-1006, '操作频繁，请稍后再试'],
  [-1100, '请求参数不合法'],
  [-1101, '请求参数不能为空'],
  [-1102, '请求类型必须为application/json'],
  [-1208, '积分不足，请先充值'],
  [-1210, 'API Key无效'],
  [-1300, '请先开通有效会员后再使用此功能'],
  [-1400, '请选择收信域名'],
  [-1401, '该收信域名当前不可用'],
  [-1403, '该收信域名仅限会员使用'],
  [-1404, '该私有域名不可用'],
  [-1405, '请选择有效时长'],
  [-1407, '邮箱地址正在补充，请稍后重试'],
  [-1408, '邮箱名称格式不正确，长度不得低于 5 位'],
  [-1409, '该邮箱地址已被使用'],
  [-1410, '邮箱创建失败，请稍后重试'],
  [-1411, '该邮箱当前不可用'],
  [-1412, '该邮件当前不可查阅'],
  [-1700, '暂时没有可用的美国地址，请稍后重试'],
]);

export const apiJson = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });

export function apiError(code, message, status = 400, identity) {
  const error = new Error(message || ERROR_MESSAGES.get(code) || '请求失败');
  return Object.assign(error, { apiCode:code, status, identity });
}

export function apiSuccess(data) {
  return { code:0, msg:'操作成功', data };
}

export function apiFailure(error) {
  if (error?.code === 'INVALID_MAILBOX_REQUEST_ID') return { code:-1100, msg:'请求标识无效，请提供 UUID v4。', data:null };
  if (Number.isInteger(error?.apiCode) && error.apiCode < 0) {
    return {
      code:error.apiCode,
      msg:error instanceof Error ? error.message : ERROR_MESSAGES.get(error.apiCode),
      data:null,
    };
  }
  const message = error instanceof Error ? error.message : '请求失败';
  const mappings = [
    [/积分不足/, -1208],
    [/仅限会员/, -1403],
    [/私有域名/, -1404],
    [/有效时长|时长不合法/, -1405],
    [/名称只能|名称格式/, -1408],
    [/已被使用|ER_DUP_ENTRY/, -1409],
    [/域名.*不可用|没有可用收信域名/, -1401],
    [/活动邮箱.*上限/, -1410],
    [/邮件不存在|邮件当前不可查阅/, -1412],
    [/邮箱不存在|邮箱当前不可用/, -1411],
  ];
  const mapped = mappings.find(([pattern]) => pattern.test(message));
  if (!mapped) return { code:-1001, msg:ERROR_MESSAGES.get(-1001), data:null };
  return { code:mapped[1], msg:message, data:null };
}

export async function parseApiJson(request) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw apiError(-1102, undefined, 415);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > OPENAPI_JSON_LIMIT) {
    throw apiError(-1100, '请求内容过大', 413);
  }
  let rawBody;
  try { rawBody = await readBoundedText(request, OPENAPI_JSON_LIMIT); } catch (error) {
    if (error?.status === 413) throw apiError(-1100, '请求内容过大', 413);
    throw error;
  }
  if (Buffer.byteLength(rawBody, 'utf8') > OPENAPI_JSON_LIMIT) {
    throw apiError(-1100, '请求内容过大', 413);
  }
  let value;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw apiError(-1100, 'JSON 请求内容格式不正确', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(-1100, undefined, 400);
  }
  return value;
}

export function normalizeApiPage(value) {
  if (value === undefined || value === null || value === '') return 1;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw apiError(-1100, '页码必须是大于 0 的整数', 400);
  }
  return page;
}

export function normalizeApiKeyword(value) {
  const keyword = String(value || '').trim();
  if (keyword.length > 100) throw apiError(-1100, '关键词最长 100 个字符', 400);
  return keyword;
}

export function extractApiToken(headers) {
  const direct = String(headers.get('apiKey') || '').trim();
  if (direct) return direct;
  const authorization = String(headers.get('authorization') || '');
  return /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
}

export async function authenticateApiRequest(request) {
  const token = extractApiToken(request.headers);
  if (!token) throw apiError(-1210, 'API Key无效', 401);
  const hash = createHash('sha256').update(token).digest('hex');
  const connection = await openDatabase();
  try {
    const [[row]] = await connection.execute(`
      SELECT k.id AS api_key_id, k.public_id AS api_key_public_id, k.user_id, k.rate_limit_per_minute,
             u.public_id, u.email, u.status AS user_status, u.points_balance,
             u.created_at, u.updated_at
      FROM api_keys k
      JOIN users u ON u.id=k.user_id
      WHERE k.key_hash=? AND k.status='ACTIVE' AND u.status='ACTIVE'
      LIMIT 1
    `, [hash]);
    if (!row) throw apiError(-1210, 'API Key无效', 401);

    const [[membership]] = await connection.execute(`
      SELECT ms.expires_at, mp.api_limit_multiplier
      FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id
      WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3)
      ORDER BY ms.expires_at DESC
      LIMIT 1
    `, [row.user_id]);
    if (!membership) throw apiError(-1300, undefined, 403, row);
    row.vip_expires_at = membership.expires_at;
    row.rate_limit_per_minute=await resolveApiRateLimit(connection,{publicId:row.api_key_public_id,userId:row.user_id,multiplier:membership.api_limit_multiplier});

    const [[enabled]] = await connection.execute(
      "SELECT value FROM system_settings WHERE `key`='openapi_rate_limit_enabled' LIMIT 1",
    );
    if (enabled?.value === 'true') {
      const reservation = await consumeAuthRateLimit({
        action:'openapi',
        identifier:`api-key:${row.api_key_id}`,
        limit:Number(row.rate_limit_per_minute),
        windowSeconds:60,
        connection,
      });
      if (!reservation.allowed) {
        const error = apiError(-1006, undefined, 429, row);
        error.retryAfter = reservation.retryAfter;
        throw error;
      }
    }
    await connection.execute(
      'UPDATE api_keys SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?',
      [row.api_key_id],
    );
    return row;
  } finally {
    connection.release();
  }
}

export async function logApiRequest({ identity, request, status, ipAddress }) {
  if (!identity) return;
  const connection = await openDatabase();
  try {
    await connection.execute(
      'INSERT INTO api_request_logs(api_key_id,user_id,method,path,status_code,ip_address) VALUES (?,?,?,?,?,?)',
      [
        identity.api_key_id,
        identity.user_id,
        request.method,
        new URL(request.url).pathname,
        status,
        String(ipAddress || '').slice(0, 45) || null,
      ],
    );
  } finally {
    connection.release();
  }
}

export async function runApi(context, handler) {
  let identity;
  let status = 200;
  const requestIp = guestRequestIp(context.request, context.clientAddress);
  try {
    const ipReservation = await consumeAuthRateLimit({
      action:'OPENAPI_AUTH_IP',
      identifier:requestIp,
      limit:OPENAPI_IP_LIMIT_PER_MINUTE,
      windowSeconds:60,
    });
    if (!ipReservation.allowed) {
      const error = apiError(-1006, undefined, 429);
      error.retryAfter = ipReservation.retryAfter;
      throw error;
    }
    identity = await authenticateApiRequest(context.request);
    const result = await handler(identity);
    return apiJson(apiSuccess(result));
  } catch (error) {
    identity = error?.identity || identity;
    const failure = apiFailure(error);
    status = Number(error?.status) || (failure.code === -1001 ? 500 : 400);
    const headers = error?.retryAfter
      ? { 'retry-after':String(Math.max(1, Math.ceil(Number(error.retryAfter)))) }
      : {};
    return apiJson(failure, status, headers);
  } finally {
    try {
      await logApiRequest({
        identity,
        request:context.request,
        status,
        ipAddress:requestIp,
      });
    } catch {}
  }
}
