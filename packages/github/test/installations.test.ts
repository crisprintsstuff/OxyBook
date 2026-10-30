// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRepoInstallation } from '../src/installations.js';

describe('findRepoInstallation', () => {
  it('returns the installation id, null on 404, and throws on other errors', async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const fake = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;

    assert.deepEqual(
      await findRepoInstallation({
        owner: 'crisprintsstuff',
        repo: 'oxybook-test',
        appJwt: 'jwt',
        fetch: fake(200, { id: 176737174, account: { login: 'crisprintsstuff' } }),
      }),
      { id: 176737174, account: 'crisprintsstuff' },
    );
    assert.equal(
      requests[0]?.url,
      'https://api.github.com/repos/crisprintsstuff/oxybook-test/installation',
    );
    assert.equal(requests[0]?.auth, 'Bearer jwt');
    assert.equal(
      await findRepoInstallation({ owner: 'a', repo: 'b', appJwt: 'j', fetch: fake(404, {}) }),
      null,
    );
    await assert.rejects(
      findRepoInstallation({ owner: 'a', repo: 'b', appJwt: 'j', fetch: fake(401, {}) }),
      /HTTP 401/,
    );
  });
});
