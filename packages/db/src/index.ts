// SPDX-License-Identifier: AGPL-3.0-only

export { type Kysely, sql } from 'kysely';
export {
  createDb,
  DEFAULT_CONNECT_TIMEOUT_MS,
  databaseUrlFromEnv,
  describeDatabaseUrl,
} from './connect.js';
export {
  GithubAccountTaken,
  githubLoginOf,
  type LinkedGithubAccount,
  linkGithubAccount,
  loadGithubAccount,
  type StoredUserToken,
  unlinkGithubAccount,
  updateGithubTokens,
  userByGithubId,
} from './github-accounts.js';
export {
  deriveSecretsKey,
  loadAppCredentials,
  open,
  type StoredAppCredentials,
  saveAppCredentials,
  seal,
} from './github-app.js';
export {
  defaultMigrationsDir,
  type MigrateOutcome,
  migrateToLatest,
  SqlFileMigrationProvider,
} from './migrate.js';
export type * from './schema.js';
