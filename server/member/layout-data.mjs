import { openDatabase } from '../db/database.mjs';

// Presentation receives this read model; SQL remains in the private runtime.
export async function getMemberLayoutData(userId) {
  if (!userId) return { membershipPlans: [], activeMembership: null };
  const connection = await openDatabase();
  try {
    const [membershipPlans] = await connection.execute(
      'SELECT code,duration_days,price_points,message_retention_days FROM membership_plans WHERE enabled=1 ORDER BY sort_order,id',
    );
    const [memberships] = await connection.execute(
      "SELECT mp.name,ms.expires_at FROM memberships ms JOIN membership_plans mp ON mp.id=ms.plan_id WHERE ms.user_id=? AND ms.status='ACTIVE' AND ms.expires_at>UTC_TIMESTAMP(3) ORDER BY ms.expires_at DESC LIMIT 1",
      [userId],
    );
    return { membershipPlans, activeMembership: memberships[0] || null };
  } finally {
    connection.release();
  }
}
