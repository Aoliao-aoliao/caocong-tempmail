import type { APIRoute } from 'astro';
import { getSessionUser, sessionCookieName } from '../../../server/auth/service.mjs';
import { selectMemberInbox } from '../../../server/member/inbox-selection.mjs';

export const GET:APIRoute=async context=>{
  const user=await getSessionUser(context.cookies.get(sessionCookieName)?.value);
  if(!user)return context.redirect(`/user/login.cgi?next=${encodeURIComponent(context.url.pathname+context.url.search)}`);
  try {
    const ids=context.url.searchParams.getAll('id');
    const destination=await selectMemberInbox(context,user.id,ids.length===1?ids[0]:'');
    return new Response(null,{status:303,headers:{Location:destination,'Cache-Control':'no-store'}});
  } catch(error) {
    const unavailable=[400,404].includes(Number((error as {status?:number})?.status));
    return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>收信入口 | NodeMail</title><p>${unavailable?'邮箱不存在、已过期或无权访问。':'收件箱读取失败，请稍后重试。'}</p><a href="/user/mailboxes.cgi">返回邮箱列表</a></html>`,{status:unavailable?404:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
  }
};
