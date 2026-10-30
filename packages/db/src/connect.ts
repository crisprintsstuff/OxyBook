// SPDX-License-Identifier: AGPL-3.0-only

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

/**
 * pg waits forever for a connection by default. Something that accepts TCP on the
 * port but is not PostgreSQL (or a dead port forward) then hangs start-up silently.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function createDb(
  connectionString: string,
  options: { max?: number; searchPath?: string; connectTimeoutMs?: number } = {},
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/** host:port/db from a connection string, without credentials, for error messages. */
export function describeDatabaseUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return 'DATABASE_URL';
  }
}
