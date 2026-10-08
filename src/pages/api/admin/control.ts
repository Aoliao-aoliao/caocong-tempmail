import type { APIRoute } from 'astro';
import { consumeAuthRateLimit } from '../../../../server/auth/request-security.mjs';
import { requireApiUser, json, apiError } from '../../../../server/http/api.mjs';
import {
  createPlatformDomain,
  permanentlyDeleteMailbox,
  updateApiKey,
  updateDomain,
  updateMailboxStatus,
  updateMessageRisk,
  updateSystemSettings,
  updateTurnstileConfiguration,
  updateUserAccess,
  verifyTurnstileConfiguration,
} from '../../../../server/admin/mutations.mjs';
import { updateRechargePlan, updatePaymentChannel, updateRechargeOrder } from '../../../../server/admin/commerce.mjs';
import { setUserMembership } from '../../../../server/admin/membership-control.mjs';
import { verifyAllDomainDns, verifyDomainDns } from '../../../../server/admin/domain-dns.mjs';

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

function requestError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function readLimitedJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw requestError('请求长度无效。');
    if (length > MAX_ADMIN_BODY_BYTES) throw requestError('请求内容过大。', 413);
  }

  const reader = request.body?.getReader();
  if (!reader) throw requestError('请求内容不能为空。');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ADMIN_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw requestError('请求内容过大。', 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw requestError('请求内容不是有效 JSON。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError('请求内容格式不正确。');
  return body as Record<string, unknown>;
}

export const POST: APIRoute = async (context) => {
  try {
    const { user, ipAddress } = await requireApiUser(context, { admin:true });
    const rate = await consumeAuthRateLimit({ action:'ADMIN_CONTROL', identifier:`${user.id}:${ipAddress}`, limit:120, windowSeconds:300 });
    if (!rate.allowed) throw requestError(`操作过于频繁，请 ${rate.retryAfter} 秒后再试。`, 429);
    const body: any = await readLimitedJson(context.request);
    const common = { actorUserId:user.id, ipAddress };
    let result;
    switch (body.action) {
      case 'user-access': result = await updateUserAccess({ ...body, ...common }); break;
      case 'user-membership': result = await setUserMembership({ ...body, ...common }); break;
      case 'domain-update': result = await updateDomain({ ...body, ...common }); break;
      case 'domain-create': {
        const created = await createPlatformDomain({ ...body, ...common });
        result = await verifyDomainDns({ domain:created.domain, ...common });
        break;
      }
      case 'domain-dns-check': result = await verifyDomainDns({ domain:body.domain, ...common }); break;
      case 'domain-dns-check-all': result = await verifyAllDomainDns(common); break;
      case 'mailbox-status': result = await updateMailboxStatus({ ...body, ...common }); break;
      case 'mailbox-delete-permanently': result = await permanentlyDeleteMailbox({ ...body, ...common }); break;
      case 'message-risk': result = await updateMessageRisk({ ...body, ...common }); break;
      case 'api-key': result = await updateApiKey({ ...body, ...common }); break;
      case 'settings': result = await updateSystemSettings({ ...body, ...common }); break;
      case 'turnstile-config': result = await updateTurnstileConfiguration({ ...body, ...common }); break;
      case 'turnstile-test': result = await verifyTurnstileConfiguration({ ...body, ...common }); break;
      case 'recharge-plan': result = await updateRechargePlan({ ...body, ...common }); break;
      case 'payment-channel': result = await updatePaymentChannel({ ...body, ...common }); break;
      case 'recharge-order': result = await updateRechargeOrder({ ...body, ...common }); break;
      default: throw new Error('未知管理操作。');
    }
    return json({ ok:true, result });
  } catch (error) {
    return apiError(error, '管理操作失败。');
  }
};
