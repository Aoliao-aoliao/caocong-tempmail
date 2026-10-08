import { readBoundedText } from '../../../../../server/http/request-body.mjs';
import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../../server/http/api.mjs';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { guestRequestIp } from '../../../../../server/guest/http.mjs';
import { recallMailbox, getMailboxRecallByRequestId } from '../../../../../server/member/mailbox-recall.mjs';
import { normalizeMailboxRecallRequestId } from '../../../../../server/member/mailbox-recall-policy.mjs';
import { requireTurnstileToken } from '../../../../../server/security/turnstile.mjs';
import { isMailboxCaptchaRequired } from '../../../../../server/member/mutations.mjs';

function tooManyRequests(retryAfter:number) {
  const seconds = Math.max(1, Math.trunc(retryAfter));
  return new Response(JSON.stringify({
    ok:false,
    message:`操作过于频繁，请 ${seconds} 秒后再试。`,
    retryAfter:seconds,
  }), {
    status:429,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'retry-after':String(seconds),
    },
  });
}

export const POST:APIRoute = async (context) => {
  try {
    const { user } = await requireApiUser(context);
    const contentLength = Number(context.request.headers.get('content-length') || 0);
    if (contentLength > 4096) throw Object.assign(new Error('请求内容过大。'), { status:413 });
    const rawBody = await readBoundedText(context.request, 4096);
    if (Buffer.byteLength(rawBody, 'utf8') > 4096) throw Object.assign(new Error('请求内容过大。'), { status:413 });
    const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('请求格式不正确。'), { status:400 });
    }

    const requestId = normalizeMailboxRecallRequestId(body.requestId);
    const mailboxId = String(body.mailboxId || '').trim();
    if (!/^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailboxId)) {
      throw Object.assign(new Error('邮箱标识无效。'), { status:400 });
    }
    if (!Number.isSafeInteger(body.durationHours)) {
      throw Object.assign(new Error('召回有效时长不合法或已停用。'), { status:400 });
    }
    if (!Number.isSafeInteger(body.expectedPrice) || body.expectedPrice < 0) {
      throw Object.assign(new Error('预期价格无效，请刷新页面后重试。'), { status:400 });
    }

    const replay = await getMailboxRecallByRequestId({
      userId:user.id,
      requestId,
      mailboxId,
      durationHours:body.durationHours,
      expectedPrice:body.expectedPrice,
    });
    if (replay) return json({ ok:true, result:replay });

    const requestIp = guestRequestIp(context.request, context.clientAddress);
    const accountRate = await consumeAuthRateLimit({
      action:'MEMBER_MAILBOX_RECALL_ACCOUNT',
      identifier:String(user.id),
      limit:6,
      windowSeconds:60,
    });
    if (!accountRate.allowed) return tooManyRequests(accountRate.retryAfter);
    const ipRate = await consumeAuthRateLimit({
      action:'MEMBER_MAILBOX_RECALL_IP',
      identifier:requestIp,
      limit:30,
      windowSeconds:60,
    });
    if (!ipRate.allowed) return tooManyRequests(ipRate.retryAfter);

    const captchaRequired = await isMailboxCaptchaRequired();
    if (captchaRequired) {
      await requireTurnstileToken({
        token:body.turnstileToken,
        remoteIp:requestIp,
        expectedAction:'member_mailbox_recall',
      });
    }

    return json({
      ok:true,
      result:await recallMailbox({
        userId:user.id,
        mailboxId,
        durationHours:body.durationHours,
        expectedPrice:body.expectedPrice,
        requestId,
        captchaVerified:captchaRequired,
        ipAddress:requestIp,
      }),
    });
  } catch (error) {
    return apiError(error, '邮箱召回失败。');
  }
};
