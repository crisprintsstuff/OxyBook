// SPDX-License-Identifier: AGPL-3.0-only

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export function createDb(
  connectionString: string,
  options: { max?: number; searchPath?: string } = {},
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}
