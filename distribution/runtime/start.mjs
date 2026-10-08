import { checkInstallation } from './setup.mjs';
import { closeDatabasePool } from '../../server/db/database.mjs';

try {
  await checkInstallation();
  await closeDatabasePool();
  await import('../../server/mail/process-manager.mjs');
} catch {
  console.error('Standalone startup refused: initialize a new empty database explicitly, or verify this release and the original .env. No automatic migration was attempted.');
  await closeDatabasePool();
  process.exitCode = 1;
}
