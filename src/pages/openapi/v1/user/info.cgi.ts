import type { APIRoute } from 'astro';
import { runApi } from '../../../../../server/openapi/service.mjs';
import { isoDate, openApiUserState } from '../../../../../server/openapi/contract.mjs';

export const GET: APIRoute = (context) =>
  runApi(context, async (user: any) => ({
    id:Number(user.user_id),
    email:user.email,
    score:Number(user.points_balance || 0),
    vipExpire:isoDate(user.vip_expires_at),
    state:openApiUserState(user.user_status),
    createdAt:isoDate(user.created_at),
    updatedAt:isoDate(user.updated_at),
  }));
