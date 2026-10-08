import { closeDatabasePool, databaseConfig, databaseLabel, openDatabase } from '../server/db/database.mjs';

const connection = await openDatabase();
try {
  const [ping] = await connection.query('SELECT 1 AS ok');
  const [tables] = await connection.execute(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ? AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, [databaseConfig.database]);
  const [membershipPlans] = await connection.query('SELECT code, duration_days, price_points, enabled FROM membership_plans ORDER BY sort_order');
  const [rechargePlans] = await connection.query('SELECT code, points, amount_usd_cents, enabled FROM recharge_plans ORDER BY sort_order');
  const [paymentChannels] = await connection.query('SELECT code, mode, token, network, enabled FROM payment_channels ORDER BY sort_order');
  const [indexes] = await connection.query("SHOW INDEX FROM recharge_orders WHERE Key_name = 'idx_recharge_orders_user_created'");
  const [engineRows] = await connection.execute(`
    SELECT COUNT(*) AS invalid_count FROM information_schema.tables
    WHERE table_schema = ? AND table_type = 'BASE TABLE' AND engine <> 'InnoDB'
  `, [databaseConfig.database]);

  const result = {
    database: databaseLabel,
    connected: Number(ping[0]?.ok) === 1,
    tableCount: tables.length,
    allTablesUseInnoDB: Number(engineRows[0]?.invalid_count || 0) === 0,
    indexedOrderQuery: indexes.length > 0,
    membershipPlans,
    rechargePlans,
    paymentChannels,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.connected || result.tableCount < 17 || !result.allTablesUseInnoDB || !result.indexedOrderQuery) process.exitCode = 1;
} finally {
  connection.release();
  await closeDatabasePool();
}
