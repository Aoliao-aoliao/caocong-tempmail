import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const localPartPattern = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;
const riskyExtensions = new Set([
  'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe', 'hta', 'html', 'htm',
  'img', 'iso', 'jar', 'js', 'jse', 'lnk', 'msi', 'msp', 'pif', 'ps1', 'reg',
  'scr', 'svg', 'vbe', 'vbs', 'wsf',
]);
const riskyContentTypes = new Set([
  'application/hta',
  'application/java-archive',
  'application/vnd.microsoft.portable-executable',
  'application/x-dosexec',
  'application/x-msdownload',
  'application/x-msdos-program',
  'text/html',
  'image/svg+xml',
]);

export function normalizeMailboxAddress(value) {
  const input = String(value || '').trim();
  const separator = input.lastIndexOf('@');
  if (separator < 1 || separator === input.length - 1 || input.length > 320) return null;
  const local = input.slice(0, separator).toLowerCase();
  const domain = domainToASCII(input.slice(separator + 1).replace(/\.$/, '')).toLowerCase();
  if (!localPartPattern.test(local) || !domainPattern.test(domain)) return null;
  const address = `${local}@${domain}`;
  return address.length <= 320 ? address : null;
}

function normalizedAttachmentName(value, index = 0) {
  const fallback = `attachment-${index + 1}.bin`;
  const normalized = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return normalized || fallback;
}

export function safeAttachmentName(value, index = 0) {
  const source = normalizedAttachmentName(value, index);
  let result = '';
  let bytes = 0;
  for (const character of source) {
    const length = Buffer.byteLength(character);
    if (bytes + length > 180) break;
    result += character;
    bytes += length;
  }
  return result || `attachment-${index + 1}.bin`;
}

export function isRiskyAttachment(attachment) {
  // Normalization and the byte limit can reveal an executable extension that
  // is absent from the wire name. Keep the untruncated name check as well so
  // shortening a long executable name cannot turn it into a SAFE attachment.
  const names = [String(attachment?.filename || ''), normalizedAttachmentName(attachment?.filename), safeAttachmentName(attachment?.filename)];
  const riskyName = names.some(name => {
    const value = name.toLowerCase().replace(/[.\s]+$/gu, '');
    const extension = value.includes('.') ? value.split('.').pop() : '';
    return riskyExtensions.has(extension);
  });
  const contentType = String(attachment?.contentType || '').toLowerCase().split(';', 1)[0].trim();
  return riskyName || riskyContentTypes.has(contentType);
}

export function smtpError(message, responseCode, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.responseCode = responseCode;
  error.smtpSafe = true;
  return error;
}

export function publicMessageId() {
  return `MSG-${randomUUID()}`;
}

export function clip(value, maximum) {
  return String(value || '').slice(0, maximum);
}
