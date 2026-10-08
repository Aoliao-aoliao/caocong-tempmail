import { closeDatabasePool, databaseLabel, migrateDatabase, openDatabase } from '../server/db/database.mjs';
import { seedDatabase } from '../server/db/seed.mjs';

const connection = await openDatabase();
try {
  await migrateDatabase(connection);
  await seedDatabase(connection);
  console.log(`NodeMail MySQL database ready: ${databaseLabel}`);
} finally {
  connection.release();
  await closeDatabasePool();
}
