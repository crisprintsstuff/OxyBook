// SPDX-License-Identifier: AGPL-3.0-only

import { createDb, databaseUrlFromEnv } from './connect.js';
import { migrateToLatest } from './migrate.js';

const db = createDb(databaseUrlFromEnv(), { max: 1 });
try {
  const { applied } = await migrateToLatest(db);
  if (applied.length === 0) console.log('migrations: up to date');
  for (const name of applied) console.log(`migrated ${name}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
