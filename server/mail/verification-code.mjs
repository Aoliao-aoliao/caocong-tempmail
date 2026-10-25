import { htmlToPlainText } from './body-text.mjs';

export const CODE_SCAN_LIMIT = 65536;
const cuePattern = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|一次性密[码碼]|\b(?:(?:verification|security|authentication|confirmation|login|sign[ -]?in|one[ -]?time|access)\s+(?:code|password)|verify your (?:email|account)|confirm your email|passcode|otp|code)\b/gi;
const tokenPattern = /(?<![a-z0-9])(?:(?:\d[ \t\n]{1,3}){3,7}\d|\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|[a-z0-9]{4,10})(?![a-z0-9])/gi;

function fromText(input) {
  const text = input.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/https?:\/\/\S+|[\w.+-]{1,64}@[\w.-]{1,253}/gi, ' ');
  const codes = new Set();
  let cues = 0;
  for (const cue of text.matchAll(cuePattern)) {
    if (++cues > 200) break;
    const start = Math.max(0, cue.index - 64), end = Math.min(text.length, cue.index + cue[0].length + 80);
    const window = text.slice(start, end);
    for (const token of window.matchAll(tokenPattern)) {
      const at = start + token.index, raw = token[0], code = raw.replace(/[\s-]/g, '');
      if (at < cue.index + cue[0].length && at + raw.length > cue.index) continue;
      if (!/\d/.test(code) || (/^\d+$/.test(code) ? code.length > 8 : code.length > 10)) continue;
      const between = at >= cue.index ? text.slice(cue.index + cue[0].length, at) : text.slice(at + raw.length, cue.index);
      if (between.length > 48 || /[.!?。！？;；]/.test(between)) continue;
      if (/^\s*(?:minutes?|seconds?|hours?|days?|分钟|分鐘|秒|小时|小時|天)\b/i.test(text.slice(at + raw.length))) continue;
      const prefix = text.slice(Math.max(start, at - 28), at);
      if (/(?:order|invoice|reference|ticket|phone|tel|订单|訂單|电话|電話)[\s\w#:：-]{0,16}$/i.test(prefix)) continue;
      // Do not extract one piece of a date, time, telephone or longer identifier.
      if (/[\d][/:.+-]$/.test(prefix) || /^[/:.+-]\d/.test(text.slice(at + raw.length))) continue;
      codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}

/** Read-only, bounded extraction. Ambiguous/no-context numbers are not codes. */
export function extractVerificationCode({ subject = '', text = '', html = '' } = {}) {
  const title = String(subject || '').slice(0, 2048);
  for (const input of [title, title + '\n' + String(text || '').slice(0, CODE_SCAN_LIMIT)]) {
    const code = fromText(input);
    if (code) return code;
  }
  const plain = htmlToPlainText(String(html).slice(0, CODE_SCAN_LIMIT)
    .replace(/<\/(?:div|td|tr|h[1-6]|li)>/gi, '$& '))
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, entity) => {
      const value = entity[0].toLowerCase() === 'x' ? parseInt(entity.slice(1), 16) : Number(entity);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ';
    });
  return fromText(title + '\n' + plain);
}

/** Internal body snippets must never be spread into list JSON or SSR props. */
export function withVerificationCode({ _code_text, _code_html, ...message }) {
  return { ...message, verificationCode: extractVerificationCode({ subject: message.subject, text: _code_text, html: _code_html }) };
}
