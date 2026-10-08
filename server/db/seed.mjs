const membershipPlans = [
  ['VIP_30', '30 天会员', 30, 2000, 1],
  ['VIP_60', '60 天会员', 60, 4000, 2],
  ['VIP_90', '90 天会员', 90, 6000, 3],
  ['VIP_180', '180 天会员', 180, 12000, 4],
];

const rechargePlans = [
  ['POINTS_100', 100, 100, 1],
  ['POINTS_1200', 1200, 1000, 2],
  ['POINTS_3000', 3000, 2000, 3],
  ['POINTS_8000', 8000, 5000, 4],
  ['POINTS_20000', 20000, 10000, 5],
];

const paymentChannels = [
  ['USDT_TRC20', 'CRYPTO', 'USDT', 'Tron', 'USDT · Tron', 1],
  ['USDT_ERC20', 'CRYPTO', 'USDT', 'Ethereum', 'USDT · Ethereum', 2],
  ['USDC_ERC20', 'CRYPTO', 'USDC', 'Ethereum', 'USDC · Ethereum', 3],
  ['USDT_BEP20', 'CRYPTO', 'USDT', 'BNB Smart Chain', 'USDT · BNB Smart Chain', 4],
  ['USDC_BEP20', 'CRYPTO', 'USDC', 'BNB Smart Chain', 'USDC · BNB Smart Chain', 5],
  ['USDT_POLYGON', 'CRYPTO', 'USDT', 'Polygon', 'USDT · Polygon', 6],
  ['USDC_POLYGON', 'CRYPTO', 'USDC', 'Polygon', 'USDC · Polygon', 7],
  ['USD_ALIPAY', 'ALIPAY', null, null, '支付宝', 8],
  ['USD_WXPAY', 'WXPAY', null, null, '微信支付', 9],
];

const settings = [
  ['free_mailbox_minutes', '60', 'integer', '免费邮箱有效时长（分钟）'],
  ['default_message_retention_days', '7', 'integer', '普通用户邮件保留天数'],
  ['member_message_retention_days', '90', 'integer', '会员邮件保留天数'],
  ['registration_bonus_points', '100', 'integer', '注册赠送积分'],
  ['pending_order_limit', '3', 'integer', '单个用户最多待支付订单数'],
  ['active_mailbox_limit_per_user', '20', 'integer', '单个用户最多活动邮箱数'],
  ['captcha_before_mailbox_create', 'false', 'boolean', '创建邮箱前是否启用人机验证'],
  ['relay_remote_cleanup_enabled', 'true', 'boolean', '中继邮箱到期后将已保存的上游原邮件移入垃圾箱'],
  ['openapi_rate_limit_enabled', 'true', 'boolean', '是否启用 OpenAPI 自动限流'],
  ['mailbox_duration_plans', '[{"id":"hour","label":"1 小时","minutes":60,"points":0},{"id":"day","label":"1 天","minutes":1440,"points":3},{"id":"week","label":"7 天","minutes":10080,"points":10},{"id":"month","label":"30 天","minutes":43200,"points":20},{"id":"season","label":"120 天","minutes":172800,"points":40}]', 'json', '邮箱有效期与积分价格'],
];

export async function seedDatabase(connection) {
  await connection.beginTransaction();
  try {
    for (const plan of membershipPlans) {
      await connection.execute(`INSERT IGNORE INTO membership_plans
        (code, name, duration_days, price_points, mailbox_discount_percent, message_retention_days, api_limit_multiplier, enabled, sort_order)
        VALUES (?, ?, ?, ?, 70, 90, 5, 1, ?)`, plan);
    }
    for (const plan of rechargePlans) {
      await connection.execute(`INSERT IGNORE INTO recharge_plans
        (code, points, amount_usd_cents, enabled, sort_order) VALUES (?, ?, ?, 1, ?)`, plan);
    }
    for (const channel of paymentChannels) {
      await connection.execute(`INSERT IGNORE INTO payment_channels
        (code, mode, token, network, label, enabled, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)`, channel);
    }
    for (const setting of settings) {
      await connection.execute(`INSERT IGNORE INTO system_settings
        (\`key\`, value, value_type, description) VALUES (?, ?, ?, ?)`, setting);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
