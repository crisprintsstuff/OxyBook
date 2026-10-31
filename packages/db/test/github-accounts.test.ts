// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import { createDb } from '../src/connect.js';
import {
  GithubAccountTaken,
  githubLoginOf,
  linkGithubAccount,
  loadGithubAccount,
  unlinkGithubAccount,
  updateGithubTokens,
  userByGithubId,
} from '../src/github-accounts.js';
import { deriveSecretsKey } from '../src/github-app.js';
import { migrateToLatest } from '../src/migrate.js';

const url = process.env.DATABASE_URL;

describe('linked GitHub accounts', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const key = deriveSecretsKey('a-long-enough-secret-key');
  let admin: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
    await migrateToLatest(db, { schema });
    for (const name of ['Ann', 'Bo']) {
      users.push(
        (
          await db
            .insertInto('users')
            .values({ email: `${name}@example.com`, name })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
      );
    }
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('stores the token sealed, finds the user by GitHub id, and refuses a second owner', async () => {
    const [ann, bo] = users as [string, string];
    const expires = new Date('2026-11-01T00:00:00Z');
    await linkGithubAccount(db, key, {
      userId: ann,
      githubUserId: 3594146,
      login: 'crisprintsstuff',
      token: {
        accessToken: 'ghu_secret',
        expiresAt: expires,
        refreshToken: 'ghr_secret',
        refreshExpiresAt: null,
      },
    });
    const row = await db.selectFrom('github_accounts').selectAll().executeTakeFirstOrThrow();
    assert.equal(
      row.access_token_enc.includes(Buffer.from('ghu_secret')),
      false,
      'not stored in clear',
    );
    const loaded = await loadGithubAccount(db, key, ann);
    assert.deepEqual(loaded, {
      userId: ann,
      githubUserId: 3594146,
      login: 'crisprintsstuff',
      accessToken: 'ghu_secret',
      accessExpiresAt: expires,
      refreshToken: 'ghr_secret',
      refreshExpiresAt: null,
    });
    assert.equal((await userByGithubId(db, 3594146))?.id, ann);
    assert.equal(await githubLoginOf(db, ann), 'crisprintsstuff');
    const user = await db
      .selectFrom('users')
      .select('github_user_id')
      .where('id', '=', ann)
      .executeTakeFirstOrThrow();
    assert.equal(user.github_user_id, '3594146');
    await assert.rejects(
      linkGithubAccount(db, key, {
        userId: bo,
        githubUserId: 3594146,
        login: 'crisprintsstuff',
        token: { accessToken: 'x', expiresAt: null, refreshToken: null, refreshExpiresAt: null },
      }),
      GithubAccountTaken,
    );

    await updateGithubTokens(db, key, ann, {
      accessToken: 'ghu_new',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
    });
    assert.equal((await loadGithubAccount(db, key, ann))?.accessToken, 'ghu_new');
    await unlinkGithubAccount(db, ann);
    assert.equal(await loadGithubAccount(db, key, ann), null);
    assert.equal(await userByGithubId(db, 3594146), null);
  });
});
