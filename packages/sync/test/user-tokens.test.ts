// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createDb,
  type Database,
  deriveSecretsKey,
  type Kysely,
  linkGithubAccount,
  loadGithubAccount,
  migrateToLatest,
  saveAppCredentials,
  sql,
} from '@oxybook/db';
import { storedUserTokens } from '../src/runner.js';

const url = process.env.DATABASE_URL;
const SECRET = 'a-long-enough-secret-key';

describe('linked user tokens', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const key = deriveSecretsKey(SECRET);
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let userId: string;
  const NOW = Date.parse('2026-10-31T12:00:00Z');

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
    await migrateToLatest(db, { schema });
    await saveAppCredentials(db, key, {
      id: 5535294,
      slug: 'oxybook-cris',
      clientId: 'Iv1.client',
      clientSecret: 'client-secret',
      webhookSecret: 'w',
      privateKeyPem: 'pem',
    });
    userId = (
      await db
        .insertInto('users')
        .values({ email: 'c@example.com', name: 'C' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  const link = (expiresInMs: number, refresh: string | null) =>
    linkGithubAccount(db, key, {
      userId,
      githubUserId: 3594146,
      login: 'crisprintsstuff',
      token: {
        accessToken: 'ghu_old',
        expiresAt: new Date(NOW + expiresInMs),
        refreshToken: refresh,
        refreshExpiresAt: null,
      },
    });

  it('returns nothing for an unlinked user, and a fresh token as is', async () => {
    const tokens = storedUserTokens(db, SECRET, { now: () => NOW });
    assert.equal(await tokens(userId), null);
    await link(60 * 60_000, 'ghr_old');
    assert.deepEqual(await tokens(userId), {
      accessToken: 'ghu_old',
      githubUserId: 3594146,
      login: 'crisprintsstuff',
    });
  });

  it('refreshes a token about to expire, with the App credentials, and stores the new one', async () => {
    await link(2 * 60_000, 'ghr_old');
    const sent: Record<string, string>[] = [];
    const tokens = storedUserTokens(db, SECRET, {
      now: () => NOW,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new' }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    assert.equal((await tokens(userId))?.accessToken, 'ghu_new');
    assert.deepEqual(sent[0], {
      client_id: 'Iv1.client',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
    const stored = await loadGithubAccount(db, key, userId);
    assert.equal(stored?.accessToken, 'ghu_new');
    assert.equal(stored?.refreshToken, 'ghr_new');
  });

  it('falls back to the App when the refresh is rejected or impossible', async () => {
    const lines: string[] = [];
    await link(-60_000, 'ghr_revoked');
    const rejecting = storedUserTokens(db, SECRET, {
      now: () => NOW,
      log: (line) => lines.push(line),
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'bad_refresh_token' }), {
          status: 200,
        })) as typeof fetch,
    });
    assert.equal(await rejecting(userId), null);
    await link(-60_000, null);
    assert.equal(
      await storedUserTokens(db, SECRET, { now: () => NOW, log: (line) => lines.push(line) })(
        userId,
      ),
      null,
    );
    assert.equal(lines.length, 2);
    assert.match(lines.join('\n'), /refresh .* failed/);
    assert.equal(await storedUserTokens(db, undefined)(userId), null, 'no key, no token');
  });
});
