import { isIP } from 'node:net';

function normalizedIp(value) {
  const candidate = String(value || '').trim().replace(/^\[|\]$/g, '');
  return isIP(candidate) ? candidate : '';
}

function isPrivateProxyPeer(value) {
  const ip = normalizedIp(value).toLowerCase();
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true;
  const ipv4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!isIP(ipv4) || ipv4.includes(':')) return false;
  const octets = ipv4.split('.').map(Number);
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

export function guestRequestIp(request, fallback = '') {
  const peerIp = normalizedIp(fallback);

  // The production app port is loopback-only and is reached through the local
  // reverse proxy. Trust only the header that Nginx overwrites, and only when
  // the immediate peer is local/private. User-supplied CF/XFF headers are not
  // accepted because they can be forged when an origin is contacted directly.
  if (isPrivateProxyPeer(peerIp)) {
    const proxyIp = normalizedIp(request.headers.get('x-real-ip'));
    if (proxyIp) return proxyIp;
  }

  return peerIp || 'unknown';
}
