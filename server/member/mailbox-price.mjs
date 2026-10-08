// Integer points must stay exact even for a large, valid configured price.
// Shared by the purchase APIs and their displayed/expected prices.
export function discountedMailboxPrice(points, discountPercent = 100) {
  const base = Number(points), discount = Number(discountPercent);
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(discount) || discount < 0 || discount > 100) {
    throw new Error('邮箱价格或折扣配置不合法。');
  }
  return Number(BigInt(base) * BigInt(discount) / 100n);
}
