import { openDatabase } from '../db/database.mjs';

// API access diagnostics have no role in payment idempotency. Use their existing
// created_at index; one bounded autocommit batch per minute limits lock time.
export async function runApiLogRetention(dependencies = {}) {
  const c = await (dependencies.openDatabase || openDatabase)();
  try {
    const [result] = await c.execute(`DELETE FROM api_request_logs
      WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)
      ORDER BY created_at, id LIMIT 1000`);
    return { deleted: result.affectedRows };
  } finally { c.release(); }
}

export function startApiLogRetention() {
  let stopped = false, timer, current = Promise.resolve();
  const run = () => {
    if (stopped) return;
    current = runApiLogRetention()
      .catch(() => console.warn('[api-log-retention] batch failed; retained for retry'))
      .finally(() => { if (!stopped) { timer = setTimeout(run, 60000); timer.unref(); } });
  };
  run();
  return { async stop() { stopped = true; clearTimeout(timer); await current; } };
}
