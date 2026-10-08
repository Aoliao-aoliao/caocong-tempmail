import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function ipv4Number(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(start / size);
}

function isNonPublicIpv4(address) {
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ].some(([base, prefix]) => inV4Range(address, base, prefix));
}

function isNonPublicIpv6(address) {
  // URL normalization collapses expanded zeros and converts embedded IPv4 to hex.
  const value = new URL(`http://[${String(address).split('%')[0]}]/`).hostname.slice(1, -1);
  if (value.startsWith('::ffff:')) {
    const words = value.slice(7).split(':').map(word => Number.parseInt(word, 16));
    const mapped = `${words[0] >>> 8}.${words[0] & 255}.${words[1] >>> 8}.${words[1] & 255}`;
    return isNonPublicIpv4(mapped);
  }
  return value === '::' || value === '::1'
    || /^f[cd]/.test(value)
    || /^fe[89ab]/.test(value)
    || value.startsWith('ff')
    || value.startsWith('2001:db8:');
}

export function normalizeImapHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || (!isIP(host) && !hostPattern.test(host))) {
    throw Object.assign(new Error('请输入有效的 IMAP 服务器。'), { status:400 });
  }
  return host;
}

function assertPublicAddress(address) {
  const family = isIP(address);
  if (!family || (family === 4 ? isNonPublicIpv4(address) : isNonPublicIpv6(address))) {
    throw Object.assign(new Error('IMAP 服务器必须使用可公开访问的网络地址。'), { status:400 });
  }
}

export async function resolvePublicImapHost(host, timeoutMs=8000) {
  const normalized = normalizeImapHost(host);
  if (isIP(normalized)) {
    assertPublicAddress(normalized);
    return { hostname:normalized, address:normalized };
  }
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('IMAP 服务器域名解析超时。'), { status:409, code:'ETIMEOUT' })), timeoutMs);
      timer.unref?.();
    });
    const addresses = await Promise.race([lookup(normalized, { all:true, verbatim:true }), timeout]);
    if (!addresses.length) throw Object.assign(new Error('IMAP 服务器域名无法解析。'), { status:409, code:'ENOTFOUND' });
    for (const item of addresses) assertPublicAddress(item.address);
    return { hostname:normalized, address:addresses[0].address };
  } finally {
    clearTimeout(timer);
  }
}
