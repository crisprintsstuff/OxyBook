// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authorizeUrl,
  exchangeOAuthCode,
  fetchGithubUser,
  githubNoreplyEmail,
  OAuthError,
  refreshUserToken,
} from '../src/oauth.js';

function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('GitHub App user authorization', () => {
  it('builds the authorize URL', () => {
    const url = new URL(
      authorizeUrl({
        clientId: 'Iv1.abc',
        redirectUri: 'https://oxybook.example/api/github/oauth/callback',
        state: 's1',
      }),
    );
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: 'Iv1.abc',
      redirect_uri: 'https://oxybook.example/api/github/oauth/callback',
      state: 's1',
      allow_signup: 'false',
    });
  });

  it('exchanges a code, with expiring tokens', async () => {
    const { calls, fetchImpl } = recorder(200, {
      access_token: 'ghu_1',
      expires_in: 28800,
      refresh_token: 'ghr_1',
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
    });
    const token = await exchangeOAuthCode(
      { clientId: 'Iv1.abc', clientSecret: 'secret', code: 'c1', redirectUri: 'https://x/cb' },
      { fetch: fetchImpl, now: () => 1_000_000 },
    );
    assert.deepEqual(token, {
      accessToken: 'ghu_1',
      expiresAt: new Date(1_000_000 + 28_800_000),
      refreshToken: 'ghr_1',
      refreshExpiresAt: new Date(1_000_000 + 15_897_600_000),
    });
    assert.equal(calls[0]?.url, 'https://github.com/login/oauth/access_token');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      client_id: 'Iv1.abc',
      client_secret: 'secret',
      code: 'c1',
      redirect_uri: 'https://x/cb',
    });
  });

  it('treats a non-expiring token as such, and reports GitHub errors sent with 200', async () => {
    const plain = await exchangeOAuthCode(
      { clientId: 'a', clientSecret: 'b', code: 'c', redirectUri: 'd' },
      { fetch: recorder(200, { access_token: 'ghu_2' }).fetchImpl },
    );
    assert.deepEqual(plain, {
      accessToken: 'ghu_2',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
    });
    await assert.rejects(
      exchangeOAuthCode(
        { clientId: 'a', clientSecret: 'b', code: 'used', redirectUri: 'd' },
        {
          fetch: recorder(200, {
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
          }).fetchImpl,
        },
      ),
      (error: unknown) => error instanceof OAuthError && error.code === 'bad_verification_code',
    );
  });

  it('refreshes with the refresh token', async () => {
    const { calls, fetchImpl } = recorder(200, {
      access_token: 'ghu_3',
      expires_in: 28800,
      refresh_token: 'ghr_3',
    });
    const token = await refreshUserToken(
      { clientId: 'a', clientSecret: 'b', refreshToken: 'ghr_old' },
      { fetch: fetchImpl },
    );
    assert.equal(token.accessToken, 'ghu_3');
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).grant_type, 'refresh_token');
  });

  it('looks up the user and derives the noreply address', async () => {
    const user = await fetchGithubUser('ghu_1', {
      fetch: recorder(200, { id: 3594146, login: 'crisprintsstuff', name: null }).fetchImpl,
    });
    assert.deepEqual(user, { id: 3594146, login: 'crisprintsstuff', name: null });
    assert.equal(githubNoreplyEmail(user), '3594146+crisprintsstuff@users.noreply.github.com');
  });
});
