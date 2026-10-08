import { consumeAuthRateLimit } from '../auth/request-security.mjs';
import { guestReadIdentity } from './service.mjs';

const readPolicies = {
  mailbox: { action: 'GUEST_MAILBOX_READ', limit: 240 },
  list: { action: 'GUEST_MESSAGES_LIST', limit: 180 },
  detail: { action: 'GUEST_MESSAGE_DETAIL', limit: 120 },
};

// One stable allowance covers all private guest read endpoints. Verify the
// cookie before allocating session/manual-refresh buckets; arbitrary unsigned
// values must never turn into independent database records. This signature
// check is only for rate accounting, not mailbox authorization.
export async function consumeGuestReadLimit({ kind, ipAddress, cookieValue }, {
  consume = consumeAuthRateLimit, identify = guestReadIdentity,
} = {}) {
  const policy = readPolicies[kind];
  if (!policy) throw new Error('Unknown guest read kind');
  const ip = String(ipAddress || 'unknown');
  const ipRate = await consume({
    action: 'GUEST_READ_IP', identifier: ip, limit: 600, windowSeconds: 60,
  });
  if (!ipRate.allowed) return { ...ipRate, sessionIdentifier: null };
  const identity = identify(cookieValue);
  if (!identity) return { ...ipRate, sessionIdentifier: null };
  const sessionIdentifier = `${ip}:${identity}`;
  const rate = await consume({
    action: policy.action, identifier: sessionIdentifier,
    limit: policy.limit, windowSeconds: 60,
  });
  return { ...rate, sessionIdentifier };
}
