// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Database,
  deriveSecretsKey,
  GithubAccountTaken,
  type Kysely,
  linkGithubAccount,
  unlinkGithubAccount,
  userByGithubId,
} from '@oxybook/db';
import {
  type AppCredentials,
  authorizeUrl,
  exchangeOAuthCode,
  fetchGithubUser,
  OAuthError,
} from '@oxybook/github';
import { createSession, formatSessionCookie, parseCookies } from './auth.js';

/**
 * Sign in with GitHub and account linking (ARCHITECTURE §4.1, §7), with the GitHub App's
 * user authorization. Linking is done from a signed-in session; after that, "Sign in
 * with GitHub" logs that user in. GitHub sign-in never creates an account: an instance's
 * accounts come from its own sign-up and invites.
 */

export const OAUTH_STATE_COOKIE = 'oxybook_oauth';
const STATE_TTL_SECONDS = 600;

export interface GithubOAuthContext {
  db: Kysely<Database>;
  secretKey: string | undefined;
  publicUrl: string;
  githubHost: string;
  apiBase?: string;
  fetch?: typeof fetch;
  secureCookies: boolean;
  now?: () => Date;
  currentApp(): Promise<AppCredentials | null>;
  currentSession(
    request: IncomingMessage,
  ): Promise<{ user: { id: string }; csrfToken: string } | null>;
  checkCsrf(request: IncomingMessage, params: Record<string, string>, expected: string): boolean;
  parseBody(request: IncomingMessage, rawBody: Buffer): Record<string, string>;
}

type Mode = 'signin' | 'link';

function go(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(303, { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  response.end();
}

function stateCookie(value: string, secure: boolean, maxAge: number): string {
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax: GitHub's redirect back is a top-level GET, which still carries the cookie.
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const withQuery = (path: string, key: 'error' | 'notice', text: string) =>
  `${path}?${new URLSearchParams({ [key]: text }).toString()}`;

export function callbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, '')}/api/github/oauth/callback`;
}

/** Answers its three routes and returns true; returns false for anything else. */
export async function handleGithubOAuth(
  ctx: GithubOAuthContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rawBody: Buffer,
): Promise<boolean> {
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/auth/github') {
    const mode: Mode = url.searchParams.get('mode') === 'link' ? 'link' : 'signin';
    const back = mode === 'link' ? '/' : '/login';
    const app = await ctx.currentApp();
    if (!app || !ctx.secretKey) {
      go(
        response,
        withQuery(
          back,
          'error',
          'Sign in with GitHub needs the GitHub App and OXYBOOK_SECRET_KEY to be set up first.',
        ),
      );
      return true;
    }
    if (mode === 'link' && !(await ctx.currentSession(request))) {
      go(response, '/login');
      return true;
    }
    const state = randomBytes(24).toString('base64url');
    go(
      response,
      authorizeUrl({
        clientId: app.clientId,
        redirectUri: callbackUrl(ctx.publicUrl),
        state,
        githubHost: ctx.githubHost,
      }),
      [stateCookie(`${mode}.${state}`, ctx.secureCookies, STATE_TTL_SECONDS)],
    );
    return true;
  }

  if (method === 'GET' && url.pathname === '/api/github/oauth/callback') {
    const clear = stateCookie('', ctx.secureCookies, 0);
    const [mode, expected] = (
      parseCookies(request.headers.cookie).get(OAUTH_STATE_COOKIE) ?? ''
    ).split('.');
    const back = mode === 'link' ? '/' : '/login';
    const state = url.searchParams.get('state') ?? '';
    // No cookie, or a different state: not a flow this browser started (or it expired).
    if (
      (mode !== 'signin' && mode !== 'link') ||
      !expected ||
      !state ||
      !sameState(expected, state)
    ) {
      go(
        response,
        withQuery(
          '/login',
          'error',
          'That GitHub sign-in link expired or was not started here. Try again.',
        ),
        [clear],
      );
      return true;
    }
    if (url.searchParams.get('error')) {
      go(response, withQuery(back, 'error', 'GitHub authorization was cancelled.'), [clear]);
      return true;
    }
    const app = await ctx.currentApp();
    const code = url.searchParams.get('code');
    if (!app || !ctx.secretKey || !code) {
      go(response, withQuery(back, 'error', 'GitHub did not return an authorization code.'), [
        clear,
      ]);
      return true;
    }
    const key = deriveSecretsKey(ctx.secretKey);
    let token: Awaited<ReturnType<typeof exchangeOAuthCode>>;
    let ghUser: Awaited<ReturnType<typeof fetchGithubUser>>;
    try {
      token = await exchangeOAuthCode(
        {
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          code,
          redirectUri: callbackUrl(ctx.publicUrl),
        },
        { githubHost: ctx.githubHost, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) },
      );
      ghUser = await fetchGithubUser(token.accessToken, {
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        ...(ctx.apiBase ? { apiBase: ctx.apiBase } : {}),
      });
    } catch (error) {
      const why = error instanceof OAuthError ? error.message : 'GitHub could not be reached';
      go(response, withQuery(back, 'error', `GitHub sign-in failed: ${why}`), [clear]);
      return true;
    }
    const stored = { githubUserId: ghUser.id, login: ghUser.login, token };

    if (mode === 'link') {
      const session = await ctx.currentSession(request);
      if (!session) {
        go(response, '/login', [clear]);
        return true;
      }
      try {
        await linkGithubAccount(ctx.db, key, { userId: session.user.id, ...stored });
      } catch (error) {
        if (error instanceof GithubAccountTaken) {
          go(response, withQuery('/', 'error', error.message), [clear]);
          return true;
        }
        throw error;
      }
      go(response, withQuery('/', 'notice', `Linked GitHub account @${ghUser.login}.`), [clear]);
      return true;
    }

    const user = await userByGithubId(ctx.db, ghUser.id);
    if (!user) {
      go(
        response,
        withQuery(
          '/login',
          'error',
          `No OxyBook account is linked to GitHub @${ghUser.login}. Sign in with your email, then link GitHub from the dashboard.`,
        ),
        [clear],
      );
      return true;
    }
    // Keep the freshest token: signing in is also a re-authorization.
    await linkGithubAccount(ctx.db, key, { userId: user.id, ...stored });
    const session = await createSession(ctx.db, user.id, ctx.now ? { now: ctx.now() } : {});
    go(response, '/', [clear, formatSessionCookie(session.token, { secure: ctx.secureCookies })]);
    return true;
  }

  if (method === 'POST' && url.pathname === '/auth/github/unlink') {
    const session = await ctx.currentSession(request);
    if (!session) {
      go(response, '/login');
      return true;
    }
    if (!ctx.checkCsrf(request, ctx.parseBody(request, rawBody), session.csrfToken)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('invalid CSRF token');
      return true;
    }
    await unlinkGithubAccount(ctx.db, session.user.id);
    go(
      response,
      withQuery(
        '/',
        'notice',
        'Unlinked your GitHub account. Pull requests you propose are now opened by the App.',
      ),
    );
    return true;
  }

  return false;
}
