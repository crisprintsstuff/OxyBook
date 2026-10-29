// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstallationTokenCache } from '../src/installation-token.js';
import {
  openPullRequest,
  openPullRequestFromInstallation,
  pullRequestHead,
  renderPullRequestBody,
} from '../src/pulls.js';

describe('pull request body', () => {
  it('lists the pages and links back', () => {
    const body = renderPullRequestBody({
      summary: 'Update docs/a.md',
      changedPaths: ['docs/a.md'],
      linkBack: 'https://tunnel.example/',
    });
    assert.match(body, /^Update docs\/a\.md\n/);
    assert.match(body, /Pages changed:\n- docs\/a\.md\n/);
    assert.match(body, /Link back: https:\/\/tunnel\.example\/\n$/);
  });

  it('refuses the base branch as the head', () => {
    assert.throws(() => pullRequestHead('refs/heads/main', 'main'), /base branch/);
    assert.throws(() => pullRequestHead('main', 'main'), /base branch/);
    assert.equal(pullRequestHead('refs/heads/oxybook/ada/page-1', 'main'), 'oxybook/ada/page-1');
  });
});

describe('POST /repos/{owner}/{repo}/pulls', () => {
  it('sends the installation token from the cache and does not push the base', async () => {
    const now = 1_700_000_000_000;
    const seen: { url: string; method: string; authorization: string | null; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (url.endsWith('/app/installations/42/access_tokens')) {
        assert.equal(headers.get('authorization'), 'Bearer test-jwt');
        return new Response(
          JSON.stringify({
            token: 'ghs_from_cache',
            expires_at: new Date(now + 10 * 60_000).toISOString(),
          }),
          { status: 201 },
        );
      }
      assert.equal(url, 'https://api.github.com/repos/acme/docs/pulls');
      return new Response(
        JSON.stringify({
          number: 12,
          html_url: 'https://github.com/acme/docs/pull/12',
        }),
        { status: 201 },
      );
    };
    const cache = new InstallationTokenCache({
      signJwt: () => 'test-jwt',
      fetch: fetchImpl,
      now: () => now,
    });
    const opened = await openPullRequestFromInstallation(
      cache,
      42,
      {
        owner: 'acme',
        repo: 'docs',
        title: 'Update docs/a.md',
        head: 'refs/heads/oxybook/ada/page-1',
        base: 'main',
        body: renderPullRequestBody({
          summary: 'Update docs/a.md',
          changedPaths: ['docs/a.md'],
          linkBack: 'https://tunnel.example/drafts/1',
        }),
      },
      { fetch: fetchImpl },
    );
    assert.deepEqual(opened, { number: 12, url: 'https://github.com/acme/docs/pull/12' });
    const pulls = seen.find((call) => call.url.endsWith('/pulls'));
    assert.ok(pulls);
    assert.equal(pulls.method, 'POST');
    assert.equal(pulls.authorization, 'Bearer ghs_from_cache');
    const payload = JSON.parse(pulls.body) as { head: string; base: string; body: string };
    assert.equal(payload.head, 'oxybook/ada/page-1');
    assert.equal(payload.base, 'main');
    assert.notEqual(payload.head, payload.base);
    assert.match(payload.body, /docs\/a\.md/);
    assert.match(payload.body, /https:\/\/tunnel\.example\/drafts\/1/);
    assert.equal(
      seen.some((call) => call.url.includes('/git/') || call.method === 'PUSH'),
      false,
    );
  });

  it('reports a non-2xx response and does not invent a url', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"message":"Validation Failed"}', { status: 422 });
    await assert.rejects(
      () =>
        openPullRequest(
          {
            owner: 'acme',
            repo: 'docs',
            title: 'Update',
            head: 'oxybook/ada/page-1',
            base: 'main',
            body: 'x',
            token: 'ghs_test',
          },
          { fetch: fetchImpl },
        ),
      /HTTP 422/,
    );
  });
});
