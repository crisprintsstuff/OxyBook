// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User authorization for the GitHub App (ARCHITECTURE §4.1, §7): "Sign in with GitHub"
 * and account linking use the App's own client id and secret. User tokens act as the
 * person, within what the App is allowed, so a PR opened with one is authored by them.
 */

export interface UserToken {
  accessToken: string;
  /** Null when the App does not expire user tokens. */
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  githubHost?: string;
}): string {
  const host = (input.githubHost ?? 'https://github.com').replace(/\/$/, '');
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    // GitHub App user tokens take their permissions from the App; no scopes to ask for.
    allow_signup: 'false',
  });
  return `${host}/login/oauth/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function tokenRequest(
  params: Record<string, string>,
  options: { fetch?: typeof fetch; githubHost?: string; now?: () => number },
): Promise<UserToken> {
  const fetchImpl = options.fetch ?? fetch;
  const host = (options.githubHost ?? 'https://github.com').replace(/\/$/, '');
  const response = await fetchImpl(`${host}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok)
    throw new OAuthError('http', `GitHub token request failed: HTTP ${response.status}`);
  // GitHub answers 200 with an `error` field for a bad or used code.
  const body = (await response.json()) as TokenResponse;
  if (typeof body.error === 'string') {
    throw new OAuthError(
      body.error,
      typeof body.error_description === 'string' ? body.error_description : body.error,
    );
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new OAuthError('no_token', 'GitHub token response had no access_token');
  }
  const now = (options.now ?? Date.now)();
  const after = (seconds: unknown) =>
    typeof seconds === 'number' && seconds > 0 ? new Date(now + seconds * 1000) : null;
  return {
    accessToken: body.access_token,
    expiresAt: after(body.expires_in),
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    refreshExpiresAt: after(body.refresh_token_expires_in),
  };
}

/** Exchange the `code` from the OAuth callback for a user token. */
export function exchangeOAuthCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  options: { fetch?: typeof fetch; githubHost?: string; now?: () => number } = {},
): Promise<UserToken> {
  return tokenRequest(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    },
    options,
  );
}

/** Trade a refresh token for a new user token (and a new refresh token). */
export function refreshUserToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  options: { fetch?: typeof fetch; githubHost?: string; now?: () => number } = {},
): Promise<UserToken> {
  return tokenRequest(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    },
    options,
  );
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

/** Who a user token belongs to. */
export async function fetchGithubUser(
  token: string,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<GithubUser> {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(`${apiBase}/user`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof body.id !== 'number' || typeof body.login !== 'string')
    throw new Error('GitHub user response had no id or login');
  return {
    id: body.id,
    login: body.login,
    name: typeof body.name === 'string' && body.name ? body.name : null,
  };
}

/** GitHub's noreply address: links commits to the profile without exposing an email. */
export function githubNoreplyEmail(user: { id: number; login: string }): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}
