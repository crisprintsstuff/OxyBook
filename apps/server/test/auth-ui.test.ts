// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  createDb,
  type Database,
  deriveSecretsKey,
  type Kysely,
  migrateToLatest,
  saveAppCredentials,
  sql,
} from '@oxybook/db';
import { createOrg, createSpace } from '../src/admin.js';
import {
  authenticateUser,
  createSession,
  hashPassword,
  hashSessionToken,
  loadSessionUser,
  SESSION_COOKIE_NAME,
  signUpUser,
  verifyPassword,
} from '../src/auth.js';
import { createUiRoutes } from '../src/ui-routes.js';

describe('password hashing (Argon2id)', () => {
  it('produces an argon2id PHC string and verifies only the matching password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.match(hash, /^\$argon2id\$v=19\$/);
    assert.equal(await verifyPassword(hash, 'correct-horse-battery-staple'), true);
    assert.equal(await verifyPassword(hash, 'wrong-password'), false);
  });
});

const url = process.env.DATABASE_URL;

describe('accounts, sessions, roles, and UI/API repo connection', {
  skip: url ? false : 'DATABASE_URL is not set',
}, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const secretKey = 'test-secret-key-for-auth-and-github-app';
  let admin: Kysely<Database>;
  let db: Kysely<Database>;

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
    await migrateToLatest(db, { schema });
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('stores only SHA-256 of session tokens and adopts pre-existing CLI orgs for the first user', async () => {
    // Simulate an org and space created earlier via `oxybook-admin` before any user existed
    await createOrg(db, { slug: 'cli-org', name: 'CLI Org' });
    await createSpace(db, {
      orgSlug: 'cli-org',
      slug: 'cli-space',
      name: 'CLI Space',
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      installationId: 176737174,
      contentRoot: 'docs',
      defaultRef: 'main',
    });

    const firstUser = await signUpUser(db, {
      email: 'Alice@Example.com',
      name: 'Alice',
      password: 'password-1234',
    });
    assert.equal(firstUser.email, 'Alice@Example.com');

    // Case-insensitive duplicate email is rejected
    await assert.rejects(
      signUpUser(db, {
        email: 'alice@example.com',
        name: 'Alice 2',
        password: 'password-1234',
      }),
      /already exists/,
    );

    // First user automatically became owner of `cli-org` and admin of `cli-space`
    const orgMember = await db
      .selectFrom('org_members')
      .select('role')
      .where('user_id', '=', firstUser.id)
      .executeTakeFirstOrThrow();
    assert.equal(orgMember.role, 'owner');

    const spaceMember = await db
      .selectFrom('space_members')
      .select('role')
      .where('user_id', '=', firstUser.id)
      .executeTakeFirstOrThrow();
    assert.equal(spaceMember.role, 'admin');

    // Authenticate & create session
    assert.equal(
      await authenticateUser(db, { email: 'alice@example.com', password: 'wrong' }),
      null,
    );
    const authed = await authenticateUser(db, {
      email: 'alice@example.com',
      password: 'password-1234',
    });
    assert.equal(authed?.id, firstUser.id);

    const session = await createSession(db, firstUser.id);
    const storedRow = await db
      .selectFrom('sessions')
      .select('token_hash')
      .where('user_id', '=', firstUser.id)
      .executeTakeFirstOrThrow();
    assert.deepEqual(storedRow.token_hash, hashSessionToken(session.token));
    assert.notEqual(
      storedRow.token_hash.toString('utf8'),
      session.token,
      'raw cookie token is never stored in the database',
    );

    const loaded = await loadSessionUser(db, session.token);
    assert.equal(loaded?.user.email, 'Alice@Example.com');

    // Expired session is not returned
    const expired = await loadSessionUser(
      db,
      session.token,
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    assert.equal(expired, null);
  });

  it('runs the full HTTP signup, CSRF check, org creation, §4.1 repo access check, space creation, role checks, and logout', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await saveAppCredentials(db, deriveSecretsKey(secretKey), {
      id: 5535294,
      slug: 'oxybook-cris',
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookSecret: 'wsecret',
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    });

    const syncedSpaces: Array<{ spaceId: string; ref: string; syncNow?: boolean }> = [];

    const fakeGithubFetch: typeof fetch = async (input, init) => {
      const u = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';

      if (u.endsWith('/app/installations?per_page=100')) {
        return new Response(
          JSON.stringify([{ id: 176737174, account: { login: 'crisprintsstuff' } }]),
          { status: 200 },
        );
      }
      if (u.endsWith('/app/installations/176737174/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_installation_token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201 },
        );
      }
      if (u.endsWith('/installation/repositories?per_page=100')) {
        return new Response(
          JSON.stringify({
            repositories: [
              {
                name: 'oxybook-test',
                full_name: 'crisprintsstuff/oxybook-test',
                default_branch: 'main',
                private: false,
                owner: { login: 'crisprintsstuff' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/repos/crisprintsstuff/oxybook-test/installation')) {
        return new Response(
          JSON.stringify({ id: 176737174, account: { login: 'crisprintsstuff' } }),
          { status: 200 },
        );
      }
      if (u.endsWith('/repos/crisprintsstuff/oxybook-test')) {
        if (auth === 'Bearer ghp_readonly') {
          return new Response(
            JSON.stringify({
              default_branch: 'main',
              private: false,
              permissions: { admin: false, maintain: false, push: false, pull: true },
            }),
            { status: 200 },
          );
        }
        if (auth === 'Bearer ghp_writer' || auth === 'Bearer ghs_installation_token') {
          return new Response(
            JSON.stringify({
              default_branch: 'main',
              private: false,
              permissions: { admin: true, maintain: true, push: true, pull: true },
            }),
            { status: 200 },
          );
        }
      }
      return new Response('{}', { status: 404 });
    };

    const ui = createUiRoutes({
      db,
      secretKey,
      fetch: fakeGithubFetch,
      onSpaceSync: async (s) => {
        syncedSpaces.push(s);
        return { synced: true, built: true };
      },
    });

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const handled = await ui.handle(req, res, Buffer.concat(chunks));
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Unauthenticated GET / redirects to /login
      const unauthHome = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(unauthHome.status, 303);
      assert.equal(unauthHome.headers.get('location'), '/login');

      // 2. Sign up Bob via JSON API
      const signupRes = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Bob Admin',
          email: 'bob@example.com',
          password: 'super-secret-password',
        }),
      });
      assert.equal(signupRes.status, 201);
      const setCookie = signupRes.headers.get('set-cookie') ?? '';
      assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`));
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      const bobCookie = setCookie.split(';')[0] ?? '';
      const signupBody = (await signupRes.json()) as {
        user: { id: string; email: string };
        csrfToken: string;
      };
      assert.equal(signupBody.user.email, 'bob@example.com');
      const bobCsrf = signupBody.csrfToken;

      // 3. CSRF enforcement on POST /api/orgs
      const badCsrfRes = await fetch(`${base}/api/orgs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': 'wrong-token',
        },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      assert.equal(badCsrfRes.status, 403);

      // 4. Create org `acme` with valid CSRF
      const orgRes = await fetch(`${base}/api/orgs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': bobCsrf,
        },
        body: JSON.stringify({ name: 'Acme Docs', slug: 'acme' }),
      });
      assert.equal(orgRes.status, 201);

      // 5. Dashboard HTML renders discovered repo `crisprintsstuff/oxybook-test` and org `acme`
      const dashRes = await fetch(`${base}/`, {
        headers: { cookie: bobCookie },
      });
      assert.equal(dashRes.status, 200);
      const dashHtml = await dashRes.text();
      assert.match(dashHtml, /oxybook-cris/);
      assert.match(dashHtml, /crisprintsstuff\/oxybook-test/);
      assert.match(dashHtml, /Acme Docs/);

      // 6. Connecting repo with a read-only user token is rejected (403, §4.1 check)
      const pullOnlySpace = await fetch(`${base}/api/orgs/acme/spaces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': bobCsrf,
        },
        body: JSON.stringify({
          name: 'Docs',
          slug: 'docs',
          repo: 'crisprintsstuff/oxybook-test',
          contentRoot: 'docs/',
          defaultRef: 'main',
          userToken: 'ghp_readonly',
        }),
      });
      assert.equal(pullOnlySpace.status, 403);
      assert.match(await pullOnlySpace.text(), /does not have admin or write access/);

      // 7. Connecting repo with a write/admin token succeeds, creates space + admin role, and triggers sync
      const createSpaceRes = await fetch(`${base}/api/orgs/acme/spaces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': bobCsrf,
        },
        body: JSON.stringify({
          name: 'Docs',
          slug: 'docs',
          repo: 'crisprintsstuff/oxybook-test',
          contentRoot: 'docs/',
          defaultRef: 'main',
          userToken: 'ghp_writer',
          syncNow: true,
        }),
      });
      assert.equal(createSpaceRes.status, 201);
      const createdSpaceBody = (await createSpaceRes.json()) as {
        space: { id: string; installationId: number; contentRoot: string };
        sync: { synced?: boolean; built?: boolean };
      };
      assert.equal(createdSpaceBody.space.installationId, 176737174);
      assert.equal(syncedSpaces.length, 1);
      assert.equal(syncedSpaces[0]?.spaceId, createdSpaceBody.space.id);
      assert.equal(syncedSpaces[0]?.syncNow, true);

      // 8. Sign up a second user (Carol) and grant her `viewer` role on `acme/docs`
      const carolSignup = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Carol Viewer',
          email: 'carol@example.com',
          password: 'carol-password-123',
        }),
      });
      assert.equal(carolSignup.status, 201);
      const carolCookie = (carolSignup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const carolCsrf = ((await carolSignup.json()) as { csrfToken: string }).csrfToken;

      const addMemberRes = await fetch(`${base}/api/orgs/acme/spaces/docs/members`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': bobCsrf,
        },
        body: JSON.stringify({ email: 'carol@example.com', role: 'viewer' }),
      });
      assert.equal(addMemberRes.status, 200);

      // Carol can view `acme/docs` but cannot trigger a sync or create a space in `acme`
      const carolView = await fetch(`${base}/api/orgs/acme/spaces/docs`, {
        headers: { cookie: carolCookie },
      });
      assert.equal(carolView.status, 200);

      const carolSync = await fetch(`${base}/api/orgs/acme/spaces/docs/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: carolCookie,
          'x-csrf-token': carolCsrf,
        },
        body: JSON.stringify({}),
      });
      assert.equal(carolSync.status, 403);

      // 9. Logout Bob and verify session is invalidated
      const logoutRes = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: bobCookie,
          'x-csrf-token': bobCsrf,
        },
      });
      assert.equal(logoutRes.status, 204);

      const meAfterLogout = await fetch(`${base}/api/auth/me`, {
        headers: { cookie: bobCookie },
      });
      assert.equal(meAfterLogout.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
