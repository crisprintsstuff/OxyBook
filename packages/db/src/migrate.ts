// SPDX-License-Identifier: AGPL-3.0-only

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type Kysely, sql } from 'kysely';
import {
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  Migrator,
} from 'kysely/migration';

/** `migrations/` sits beside `src/` and `dist/`, so this resolves from either. */
export const defaultMigrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * Plain SQL files, applied in filename order. Forward-only: there is no `down`.
 * Kysely records applied names in `kysely_migration`, takes a Postgres advisory lock,
 * and runs the pending files in one transaction.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string = defaultMigrationsDir) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const name of names) {
      const text = await readFile(`${this.dir.replace(/\/?$/, '/')}${name}`, 'utf8');
      migrations[name.replace(/\.sql$/, '')] = {
        async up(db: Kysely<unknown>) {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

export interface MigrateOutcome {
  applied: string[];
}

/** Apply every pending migration. Throws with the failing migration's name on error. */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  options: { dir?: string; schema?: string } = {},
): Promise<MigrateOutcome> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(options.dir),
    // Without this, Kysely finds its bookkeeping tables in any schema on the server
    // and then queries them unqualified. Pass it whenever search_path is not `public`.
    ...(options.schema ? { migrationTableSchema: options.schema } : {}),
  });
  const result: MigrationResultSet = await migrator.migrateToLatest();
  const failed = result.results?.find((entry) => entry.status === 'Error');
  if (result.error) {
    const cause = result.error instanceof Error ? result.error.message : String(result.error);
    const name = failed ? ` ${failed.migrationName}` : '';
    throw new Error(`migration${name} failed: ${cause}`, { cause: result.error });
  }
  return {
    applied: (result.results ?? [])
      .filter((entry) => entry.status === 'Success')
      .map((entry) => entry.migrationName),
  };
}
