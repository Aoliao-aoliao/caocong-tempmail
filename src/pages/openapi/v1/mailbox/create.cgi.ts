import type { APIRoute } from 'astro';
import { parseApiJson, runApi } from '../../../../../server/openapi/service.mjs';
import {
  getCreatedMailbox,
  isoDate,
  normalizeDurationHours,
  normalizeMailboxPrefix,
  selectOpenApiDomain,
} from '../../../../../server/openapi/contract.mjs';
import { createMailbox } from '../../../../../server/member/mutations.mjs';

export const POST: APIRoute = (context) =>
  runApi(context, async (user: any) => {
    const body: any = await parseApiJson(context.request);
    const prefix = normalizeMailboxPrefix(body.prefix ?? body.localPart);
    const durationHours = normalizeDurationHours(body.durationHours);
    const domain = await selectOpenApiDomain({
      userId:user.user_id,
      domainId:body.domainId,
      legacyDomain:body.domain,
    });
    const requestId = String(
      body.requestId || context.request.headers.get('idempotency-key') || '',
    ).trim() || null;
    const created = await createMailbox({
      userId:user.user_id,
      localPart:prefix,
      domain:domain.domain,
      durationMinutes:durationHours * 60,
      requestId:requestId as any,
      captchaExempt:true,
    });
    const mailbox = await getCreatedMailbox({
      userId:user.user_id,
      publicId:created.id,
    });
    return {
      id:Number(mailbox.id),
      email:mailbox.address,
      receivedCount:Number(mailbox.received_count || 0),
      expiresAt:isoDate(mailbox.expires_at),
      guest:false,
    };
  });
