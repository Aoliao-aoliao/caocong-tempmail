import { discountedMailboxPrice, isValidMailboxDuration } from './mailbox-policy.mjs';

export const isValidRecallDuration = (hours) => Number.isSafeInteger(hours) && hours >= 24 && isValidMailboxDuration(hours * 60);

export function normalizeMailboxRecallRequestId(value, { required = true } = {}) {
  const requestId = String(value || '').trim().toLowerCase();
  if (!requestId && !required) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw Object.assign(new Error('请求标识无效。'), { status:400 });
  }
  return requestId;
}

function parsePlans(rawPlans) {
  if (Array.isArray(rawPlans)) return rawPlans;
  try {
    const parsed = JSON.parse(String(rawPlans || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function resolveMailboxRecallPlan({ rawPlans, durationHours, discountPercent = 100 }) {
  const hours = Number(durationHours);
  if (!isValidRecallDuration(hours)) {
    throw Object.assign(new Error('召回有效时长不合法或已停用。'), { status:400 });
  }

  const minutes = hours * 60;
  const plan = parsePlans(rawPlans).find((candidate) => (
    candidate?.enabled !== false
    && Number(candidate?.minutes) === minutes
    && Number.isSafeInteger(Number(candidate?.points))
    && Number(candidate.points) >= 0
  ));
  if (!plan) {
    throw Object.assign(new Error('召回有效时长不合法或已停用。'), { status:400 });
  }

  const discount = Number(discountPercent);
  if (!Number.isSafeInteger(discount) || discount < 0 || discount > 100) {
    throw new Error('Invalid mailbox recall pricing configuration.');
  }
  const basePrice = Number(plan.points);
  return {
    id:String(plan.id || ''),
    label:String(plan.label || ''),
    durationHours:hours,
    durationMinutes:minutes,
    basePrice,
    price:discountedMailboxPrice(basePrice, discount),
  };
}

export function assertMailboxRecallEligible({ status, isExpired, expiresAt }) {
  const recallableStatus = status === 'ACTIVE' || status === 'EXPIRED';
  if (!recallableStatus || !expiresAt || Number(isExpired) !== 1) {
    throw Object.assign(new Error('只有已过期的邮箱可以召回。'), { status:409 });
  }
}

export function assertMailboxRecallReplayMatches(existing, { mailboxId, durationHours, expectedPrice }) {
  if (
    String(existing.mailbox_id) !== String(mailboxId || '').trim()
    || Number(existing.duration_minutes) !== Number(durationHours) * 60
    || Number(existing.price_points) !== Number(expectedPrice)
  ) {
    throw Object.assign(new Error('该请求标识已用于其他召回操作。'), { status:409 });
  }
}
