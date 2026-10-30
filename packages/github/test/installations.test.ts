// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkInstallationRepoAccess,
  checkUserRepoAccess,
  findRepoInstallation,
  listInstalledRepositories,
} from '../src/installations.js';

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

describe('checkUserRepoAccess and checkInstallationRepoAccess', () => {
  it('allows admin or push user permissions and rejects pull-only or 404', async () => {
    const fake = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

    const pushUser = await checkUserRepoAccess({
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      userToken: 'ghp_1',
      fetch: fake(200, {
        default_branch: 'main',
        private: false,
        permissions: { admin: false, maintain: false, push: true, pull: true },
      }),
    });
    assert.equal(pushUser.allowed, true);
    assert.equal(pushUser.defaultBranch, 'main');

    const pullOnly = await checkUserRepoAccess({
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      userToken: 'ghp_2',
      fetch: fake(200, {
        default_branch: 'main',
        private: false,
        permissions: { admin: false, maintain: false, push: false, pull: true },
      }),
    });
    assert.equal(pullOnly.allowed, false);

    const missing = await checkUserRepoAccess({
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      userToken: 'ghp_3',
      fetch: fake(404, {}),
    });
    assert.equal(missing.allowed, false);

    const instOk = await checkInstallationRepoAccess({
      owner: 'crisprintsstuff',
      repo: 'oxybook-test',
      installationToken: 'inst_1',
      fetch: fake(200, { default_branch: 'main', private: true }),
    });
    assert.deepEqual(instOk, { accessible: true, defaultBranch: 'main', private: true });
  });

  it('lists repositories across App installations', async () => {
    const fake = (async (url: string | URL | Request) => {
      const s = String(url);
      if (s.endsWith('/app/installations?per_page=100')) {
        return new Response(
          JSON.stringify([{ id: 176737174, account: { login: 'crisprintsstuff' } }]),
          { status: 200 },
        );
      }
      if (s.endsWith('/installation/repositories?per_page=100')) {
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
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const repos = await listInstalledRepositories({
      appJwt: 'jwt',
      getInstallationToken: async () => 'inst_tok',
      fetch: fake,
    });
    assert.deepEqual(repos, [
      {
        installationId: 176737174,
        account: 'crisprintsstuff',
        owner: 'crisprintsstuff',
        repo: 'oxybook-test',
        fullName: 'crisprintsstuff/oxybook-test',
        defaultBranch: 'main',
        private: false,
      },
    ]);
  });
});
