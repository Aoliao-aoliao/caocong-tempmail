import { openDatabase } from '../db/database.mjs';

// Server-only: recall-policy is also bundled into the browser, so database
// access must never live there. Recall and renewal follow the same admin
// switch as mailbox creation.
export async function assertMailboxRecallCaptcha(captchaVerified) {
  if (captchaVerified === true) return;
  const connection = await openDatabase();
  try {
    const [[setting]] = await connection.execute("SELECT value FROM system_settings WHERE `key`='captcha_before_mailbox_create'");
    if (setting?.value === 'true') throw Object.assign(new Error('请先完成人机验证。'), { status:403 });
  } finally {
    connection.release();
  }
}
