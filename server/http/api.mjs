import { readBoundedText } from './request-body.mjs';
import { getSessionUser, sessionCookieName } from '../auth/service.mjs';
import { isSameOriginRequest } from '../auth/request-security.mjs';

export const json = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

export async function readJsonBody(request, maximumBytes=4096) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('请求格式不正确。'), { status:415 });
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw Object.assign(new Error('请求内容过大。'), { status:413 });
  }
  const raw = await readBoundedText(request, maximumBytes);
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) {
    throw Object.assign(new Error('请求内容过大。'), { status:413 });
  }
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid object');
    return value;
  } catch {
    throw Object.assign(new Error('请求内容不是有效的 JSON。'), { status:400 });
  }
}

export async function requireApiUser(context, { admin=false, jsonBody=true }={}) {
  if (!isSameOriginRequest(context.request,context.url.origin)) throw Object.assign(new Error('请求来源无效。'),{status:403});
  if (jsonBody && !context.request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw Object.assign(new Error('请求格式不正确。'),{ status:415 });
  const user = await getSessionUser(context.cookies.get(sessionCookieName)?.value);
  if (!user) throw Object.assign(new Error('请先登录。'),{ status:401 });
  if (admin && !['ADMIN','SUPER_ADMIN'].includes(user.role)) throw Object.assign(new Error('无权执行此操作。'),{ status:403 });
  return { user, ipAddress:context.clientAddress };
}

function isSafeClientMessage(value) {
  const message = String(value || '');
  return message.length > 0
    && message.length <= 200
    && /^(?:请求|操作|尝试|登录|注册|邮箱|邮件|中继|域名|账户|会员|当前|该|有效|支付|充值|积分|密钥|用户|不能|只有|无权|请|最多|至少|没有|未知|人机验证|普通管理员|已撤销|预期|单用户|服务器|Turnstile)/.test(message);
}

export function apiError(error, fallback='操作失败。') {
  const explicitStatus = Number(error?.status);
  const databaseFailure = Boolean(error?.code && /^ER_|^ECONN|^PROTOCOL_/i.test(String(error.code)))
    || Number.isInteger(error?.errno)
    || Boolean(error?.sqlState);
  const explicitlyPublic = [400,401,403,404,409,410,413,415,429,503].includes(explicitStatus);
  const inferredPublic = !databaseFailure && isSafeClientMessage(error?.message);
  const status = explicitlyPublic
    ? explicitStatus
    : databaseFailure
      ? 500
      : inferredPublic
        ? 400
        : String(error?.message || '').includes('origin')
        ? 403
        : 500;
  const message = status === 500
    ? fallback
    : (explicitlyPublic || inferredPublic) && error instanceof Error
      ? error.message
      : fallback;
  return json({ ok:false, message },status);
}
