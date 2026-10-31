// SPDX-License-Identifier: AGPL-3.0-only

import { type Kysely, sql } from 'kysely';
import { open, seal } from './github-app.js';
import type { Database } from './schema.js';

/** A user's linked GitHub account, with the token opened. Never logged, never returned to a browser. */
export interface LinkedGithubAccount {
  userId: string;
  githubUserId: number;
  login: string;
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

export interface StoredUserToken {
  accessToken: string;
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

export class GithubAccountTaken extends Error {
  readonly status = 409;
  constructor(readonly login: string) {
    super(`GitHub account @${login} is already linked to another OxyBook user`);
    this.name = 'GithubAccountTaken';
  }
}

/**
 * Link (or re-link) a GitHub account to a user and store its token sealed. One GitHub
 * account belongs to at most one OxyBook user, and one user has at most one GitHub account.
 */
export async function linkGithubAccount(
  db: Kysely<Database>,
  key: Buffer,
  input: { userId: string; githubUserId: number; login: string; token: StoredUserToken },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const owner = await trx
      .selectFrom('github_accounts')
      .select('user_id')
      .where('github_user_id', '=', String(input.githubUserId))
      .executeTakeFirst();
    if (owner && owner.user_id !== input.userId) throw new GithubAccountTaken(input.login);
    const values = {
      github_user_id: input.githubUserId,
      login: input.login,
      access_token_enc: seal(input.token.accessToken, key),
      access_expires_at: input.token.expiresAt,
      refresh_token_enc: input.token.refreshToken ? seal(input.token.refreshToken, key) : null,
      refresh_expires_at: input.token.refreshExpiresAt,
      updated_at: sql<Date>`now()`,
    };
    await trx
      .insertInto('github_accounts')
      .values({ user_id: input.userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    await trx
      .updateTable('users')
      .set({ github_user_id: input.githubUserId })
      .where('id', '=', input.userId)
      .execute();
  });
}

/** Replace the tokens after a refresh. */
export async function updateGithubTokens(
  db: Kysely<Database>,
  key: Buffer,
  userId: string,
  token: StoredUserToken,
): Promise<void> {
  await db
    .updateTable('github_accounts')
    .set({
      access_token_enc: seal(token.accessToken, key),
      access_expires_at: token.expiresAt,
      refresh_token_enc: token.refreshToken ? seal(token.refreshToken, key) : null,
      refresh_expires_at: token.refreshExpiresAt,
      updated_at: sql<Date>`now()`,
    })
    .where('user_id', '=', userId)
    .execute();
}

export async function loadGithubAccount(
  db: Kysely<Database>,
  key: Buffer,
  userId: string,
): Promise<LinkedGithubAccount | null> {
  const row = await db
    .selectFrom('github_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    login: row.login,
    accessToken: open(row.access_token_enc, key),
    accessExpiresAt: row.access_expires_at,
    refreshToken: row.refresh_token_enc ? open(row.refresh_token_enc, key) : null,
    refreshExpiresAt: row.refresh_expires_at,
  };
}

/** The login of a user's linked account, without opening any token. */
export async function githubLoginOf(db: Kysely<Database>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('github_accounts')
    .select('login')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.login ?? null;
}

/** The OxyBook user a GitHub account is linked to, for "Sign in with GitHub". */
export async function userByGithubId(
  db: Kysely<Database>,
  githubUserId: number,
): Promise<{ id: string; email: string; name: string } | null> {
  const row = await db
    .selectFrom('github_accounts')
    .innerJoin('users', 'users.id', 'github_accounts.user_id')
    .select(['users.id as id', 'users.email as email', 'users.name as name'])
    .where('github_accounts.github_user_id', '=', String(githubUserId))
    .executeTakeFirst();
  return row ?? null;
}

export async function unlinkGithubAccount(db: Kysely<Database>, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('github_accounts').where('user_id', '=', userId).execute();
    await trx.updateTable('users').set({ github_user_id: null }).where('id', '=', userId).execute();
  });
}
