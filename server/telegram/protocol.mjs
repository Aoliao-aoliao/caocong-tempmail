import { timingSafeEqual } from 'node:crypto';

export const TELEGRAM_SETTING = 'telegram_bot_config';
export const WEBHOOK_PATH = '/api/telegram/webhook';
export const fail = (message, status=400) => Object.assign(new Error(message), {status});
export function validateOrigin(value) {
  let url;
  try { url=new URL(String(value || '')); } catch { throw fail('请输入有效的 HTTPS 网站地址。'); }
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.pathname!=='/' || url.search || url.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)
    || /\.(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) throw fail('请输入公网 HTTPS 网站根地址，不含端口、路径或参数。');
  return url.origin;
}
export function validateBotToken(value) {
  if (typeof value!=='string' || !/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(value)) throw fail('机器人 Token 格式无效，请从 BotFather 复制。');
  return value;
}
export function matchesWebhookSecret(actual, expected) {
  if(typeof actual!=='string'||typeof expected!=='string'||!expected) return false;
  const a=Buffer.from(actual),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}
export function parseBindingUpdate(update) {
  const m=update?.message;
  if(!Number.isSafeInteger(update?.update_id)||!m||m.chat?.type!=='private'||m.from?.is_bot
    || !Number.isSafeInteger(m.from?.id)||m.from.id<=0||m.chat.id!==m.from.id) return null;
  const match=/^\/start(?:@[A-Za-z0-9_]+)?\s+bind_([A-Za-z0-9_-]{43})\s*$/.exec(m.text || '');
  if(!match) return null;
  return {token:match[1],telegramId:String(m.from.id),username:/^[A-Za-z0-9_]{1,32}$/.test(m.from.username||'')?m.from.username:''};
}
// Fixed official endpoint, bounded requests and fixed public errors. Never echo
// Telegram responses or network exceptions: request URLs contain the bot token.
export async function telegramCall(token,method,body={},fetcher=fetch) {
  validateBotToken(token);
  if(!['getMe','getWebhookInfo','setWebhook','deleteWebhook'].includes(method)) throw new Error('Unsupported bot method');
  let response,data;
  try {
    response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});
    data=await response.json();
  } catch { throw fail('暂时无法连接 Telegram，请稍后重试。',503); }
  if(!response.ok||data?.ok!==true) throw fail(response.status===401?'机器人 Token 无效或已被撤销。':'Telegram 拒绝了配置，请核对 Token 和 HTTPS 网站地址。',400);
  return data.result;
}
