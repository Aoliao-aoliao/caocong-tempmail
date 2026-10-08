import type { APIRoute } from 'astro';
import { consumeAuthRateLimit } from '../../../../../server/auth/request-security.mjs';
import { apiError, json, requireApiUser } from '../../../../../server/http/api.mjs';
import { getMemberMailboxPage } from '../../../../../server/member/read-model.mjs';

export const prerender = false;

export const GET:APIRoute = async (context) => {
  try {
    if (Buffer.byteLength(context.url.search, 'utf8') > 4096) {
      throw Object.assign(new Error('请求内容过大。'), { status:413 });
    }
    const allowed = new Set(['page','q']);
    for (const key of context.url.searchParams.keys()) {
      if (!allowed.has(key) || context.url.searchParams.getAll(key).length !== 1) {
        throw Object.assign(new Error('请求参数不正确。'), { status:400 });
      }
    }

    const { user } = await requireApiUser(context,{ jsonBody:false });
    const rate = await consumeAuthRateLimit({
      action:'MEMBER_MAILBOX_LIST',
      identifier:String(user.id),
      limit:120,
      windowSeconds:60,
    });
    if (!rate.allowed) {
      return new Response(JSON.stringify({ ok:false,message:'刷新过于频繁，请稍后再试。' }), {
        status:429,
        headers:{
          'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store',
          'retry-after':String(Math.max(1,Math.trunc(rate.retryAfter))),
        },
      });
    }

    const rawPage = context.url.searchParams.get('page') ?? '1';
    if (!/^[1-9]\d{0,5}$/.test(rawPage) || Number(rawPage) > 100000) {
      throw Object.assign(new Error('页码必须是大于 0 的整数。'), { status:400 });
    }
    const result = await getMemberMailboxPage({
      userId:user.id,
      query:context.url.searchParams.get('q') ?? '',
      page:Number(rawPage),
    });
    return json({ ok:true,...result });
  } catch (error) {
    return apiError(error,'邮箱列表读取失败。');
  }
};
