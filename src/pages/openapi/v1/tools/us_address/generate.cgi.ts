import type { APIRoute } from 'astro';
import { apiError, parseApiJson, runApi } from '../../../../../../server/openapi/service.mjs';
import {
  getCreatedMailbox,
  normalizeDurationHours,
  normalizeMailboxPrefix,
  selectOpenApiDomain,
} from '../../../../../../server/openapi/contract.mjs';
import { createMailbox } from '../../../../../../server/member/mutations.mjs';
import { createUsAddressProfile } from '../../../../../../server/tools/us-address.mjs';

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
    let profile;
    try {
      profile = createUsAddressProfile({
        stateCode:body.stateCode,
        domain:domain.domain,
        localPart:prefix,
      });
    } catch (error: any) {
      if (Number(error?.status) === 400) throw apiError(-1100, error.message, 400);
      throw apiError(-1700, undefined, 503);
    }
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
      mailboxId:Number(mailbox.id),
      email:mailbox.address,
      mailboxDomainId:Number(mailbox.domain_id),
      firstName:profile.firstName,
      lastName:profile.lastName,
      gender:profile.gender,
      phone:profile.phone,
      streetAddress:profile.streetAddress,
      city:profile.city,
      stateName:profile.stateName,
      stateCode:profile.stateCode,
      zipCode:profile.zipCode,
      latitude:Number(profile.latitude),
      longitude:Number(profile.longitude),
      fullAddress:profile.fullAddress,
    };
  });
