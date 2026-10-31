// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  createDb,
  type Database,
  deriveSecretsKey,
  type Kysely,
  loadGithubAccount,
  migrateToLatest,
  saveAppCredentials,
  sql,
} from '@oxybook/db';
import { createSession, SESSION_COOKIE_NAME, signUpUser } from '../src/auth.js';
import { OAUTH_STATE_COOKIE } from '../src/github-oauth.js';
import { createUiRoutes } from '../src/ui-routes.js';

const url = process.env.DATABASE_URL;
const SECRET = 'test-secret-key-for-github-oauth';

/** GitHub's OAuth and /user endpoints. `who` decides which GitHub user the next code belongs to. */
function fakeGithub() {
  const state = {
    who: { id: 3594146, login: 'crisprintsstuff', name: 'Cris' },
    codes: [] as string[],
  };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target === 'https://github.test/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body)) as { code: string };
      state.codes.push(body.code);
      if (body.code === 'bad')
        return new Response(
          JSON.stringify({ error: 'bad_verification_code', error_description: 'expired' }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          access_token: `ghu_${body.code}`,
          expires_in: 28800,
          refresh_token: `ghr_${body.code}`,
        }),
        { status: 200 },
      );
    }
    if (target === 'https://api.github.test/user')
      return new Response(JSON.stringify(state.who), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { state, impl };
}

describe('Sign in with GitHub and account linking', {
  skip: url ? false : 'DATABASE_URL is not set',
}, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let server: Server;
  let base = '';
  const github = fakeGithub();

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 3, searchPath: schema });
    await migrateToLatest(db, { schema });
    await saveAppCredentials(db, deriveSecretsKey(SECRET), {
      id: 5535294,
      slug: 'oxybook-cris',
      clientId: 'Iv1.client',
      clientSecret: 'client-secret',
      webhookSecret: 'w',
      privateKeyPem: 'pem',
    });
    const routes = createUiRoutes({
      db,
      secretKey: SECRET,
      publicUrl: 'https://oxybook.example',
      githubHost: 'https://github.test',
      apiBase: 'https://api.github.test',
      fetch: github.impl,
    });
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      if (!(await routes.handle(request, response, Buffer.concat(chunks)))) {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  const get = (path: string, cookie = '') =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const cookieFrom = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0] ?? '';
  const errorOf = (response: Response) =>
    new URL(response.headers.get('location') ?? '/', 'http://x').searchParams.get('error') ?? '';
  const sessionFor = async (userId: string) =>
    `${SESSION_COOKIE_NAME}=${(await createSession(db, userId)).token}`;

  /** Start a flow, then come back from GitHub with `code`. Returns the callback response. */
  async function roundTrip(mode: 'signin' | 'link', code: string, session = '') {
    const start = await get(`/auth/github${mode === 'link' ? '?mode=link' : ''}`, session);
    assert.equal(start.status, 303);
    const authorize = new URL(start.headers.get('location') as string);
    assert.equal(
      authorize.origin + authorize.pathname,
      'https://github.test/login/oauth/authorize',
    );
    assert.equal(authorize.searchParams.get('client_id'), 'Iv1.client');
    assert.equal(
      authorize.searchParams.get('redirect_uri'),
      'https://oxybook.example/api/github/oauth/callback',
    );
    const stateCookie = cookieFrom(start, OAUTH_STATE_COOKIE);
    assert.match(
      start.headers.getSetCookie().join('\n'),
      /oxybook_oauth=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
    );
    const state = authorize.searchParams.get('state') as string;
    return get(
      `/api/github/oauth/callback?code=${code}&state=${state}`,
      [stateCookie, session].filter(Boolean).join('; '),
    );
  }

  let cris = '';

  it('links a GitHub account to the signed-in user and stores the token sealed', async () => {
    cris = (
      await signUpUser(db, { email: 'cris@example.com', name: 'Cris', password: 'password-1234' })
    ).id;
    const callback = await roundTrip('link', 'c1', await sessionFor(cris));
    assert.equal(callback.status, 303);
    assert.equal(
      callback.headers.get('location'),
      '/?notice=Linked+GitHub+account+%40crisprintsstuff.',
    );
    assert.match(
      callback.headers.getSetCookie().join('\n'),
      /oxybook_oauth=; .*Max-Age=0/,
      'state cookie cleared',
    );
    const account = await loadGithubAccount(db, deriveSecretsKey(SECRET), cris);
    assert.deepEqual(
      [account?.githubUserId, account?.login, account?.accessToken, account?.refreshToken],
      [3594146, 'crisprintsstuff', 'ghu_c1', 'ghr_c1'],
    );
    const dashboard = await (await get('/', await sessionFor(cris))).text();
    assert.match(dashboard, /Linked as <strong>@crisprintsstuff<\/strong>/);
  });

  it('signs a linked user in with GitHub, and refuses an unlinked GitHub account', async () => {
    const callback = await roundTrip('signin', 'c2');
    assert.equal(callback.headers.get('location'), '/');
    const session = cookieFrom(callback, SESSION_COOKIE_NAME);
    assert.ok(session, 'a session cookie is issued');
    assert.equal((await get('/api/auth/me', session)).status, 200);
    assert.equal(
      (await loadGithubAccount(db, deriveSecretsKey(SECRET), cris))?.accessToken,
      'ghu_c2',
      'token refreshed by signing in',
    );

    github.state.who = { id: 42, login: 'stranger', name: 'S' };
    const refused = await roundTrip('signin', 'c3');
    assert.match(
      errorOf(refused),
      /No OxyBook account is linked to GitHub @stranger/,
    );
    assert.equal(cookieFrom(refused, SESSION_COOKIE_NAME), '');
    assert.equal(
      (await db.selectFrom('users').select('id').execute()).length,
      1,
      'no account was created',
    );
  });

  it('refuses a callback with a missing or different state, and a bad code', async () => {
    const forged = await get(
      '/api/github/oauth/callback?code=c4&state=abc',
      `${OAUTH_STATE_COOKIE}=signin.xyz`,
    );
    assert.match(
      errorOf(forged),
      /expired or was not started here/,
    );
    const noCookie = await get('/api/github/oauth/callback?code=c4&state=abc');
    assert.match(
      errorOf(noCookie),
      /expired or was not started here/,
    );
    assert.ok(!github.state.codes.includes('c4'), 'the code was never exchanged');
    const bad = await roundTrip('signin', 'bad');
    assert.match(
      errorOf(bad),
      /GitHub sign-in failed: expired/,
    );
  });

  it('will not link one GitHub account to two users, and unlinks with CSRF', async () => {
    github.state.who = { id: 3594146, login: 'crisprintsstuff', name: 'Cris' };
    const other = (
      await signUpUser(db, { email: 'other@example.com', name: 'Other', password: 'password-1234' })
    ).id;
    const taken = await roundTrip('link', 'c5', await sessionFor(other));
    assert.match(
      errorOf(taken),
      /already linked to another OxyBook user/,
    );

    const session = await sessionFor(cris);
    const me = (await (await get('/api/auth/me', session)).json()) as { csrfToken: string };
    const noCsrf = await fetch(`${base}/auth/github/unlink`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: session },
    });
    assert.equal(noCsrf.status, 403);
    const unlinked = await fetch(`${base}/auth/github/unlink`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(me.csrfToken)}`,
    });
    assert.equal(unlinked.status, 303);
    assert.equal(await loadGithubAccount(db, deriveSecretsKey(SECRET), cris), null);
  });
});
