export const defaultActiveMailboxLimit = 20;
export { discountedMailboxPrice } from './mailbox-price.mjs';

// Both the duration column (INT UNSIGNED) and the expiry column (DATETIME)
// must be able to store a configured plan before it is offered for purchase.
export function isValidMailboxDuration(value, now = Date.now()) {
  const minutes = Number(value);
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 0xffffffff
    && now + minutes * 60000 <= 253402300799999;
}

export function activeMailboxLimit(value, fallback = defaultActiveMailboxLimit) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 10_000);
}

export function assertExpectedMailboxPrice(expectedPrice, actualPrice) {
  if (expectedPrice === undefined || expectedPrice === null) return;
  const expected = Number(expectedPrice);
  const actual = Number(actualPrice);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw Object.assign(new Error('预期价格无效。'), { status:400 });
  }
  if (expected !== actual) {
    throw Object.assign(new Error('邮箱价格已更新，请刷新页面后重新确认。'), { status:409 });
  }
}

export function freeMailboxMinutes(value) {
  const parsed = Number(value ?? 60);
  return Number.isSafeInteger(parsed) ? Math.min(1440, Math.max(5, parsed)) : 60;
}
