import { closeDatabasePool, openDatabase } from '../server/db/database.mjs';

const email = String(process.argv[2] || '').trim().toLowerCase();
const role = String(process.argv[3] || 'SUPER_ADMIN').trim().toUpperCase();

if (!/^\S+@\S+\.\S+$/.test(email) || !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
  console.error('用法: npm run admin:set-role -- user@example.com SUPER_ADMIN');
  process.exit(1);
}

const connection = await openDatabase();
try {
  const [result] = await connection.execute('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE email = ?', [role, email]);
  if (Number(result.affectedRows) !== 1) {
    console.error('没有找到该账户，请先通过用户端完成注册。');
    process.exitCode = 1;
  } else {
    console.log(`${email} 已设置为 ${role}。`);
  }
} finally {
  connection.release();
  await closeDatabasePool();
}
