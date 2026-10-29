// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAppManifest,
  exchangeManifestCode,
  MemoryAppCredentials,
  manifestCreateUrl,
} from '../src/manifest.js';

const input = {
  name: 'OxyBook',
  url: 'http://app.localhost:8080',
  hookUrl: 'http://app.localhost:8080/api/github/webhooks',
  redirectUrl: 'http://app.localhost:8080/setup/github/callback',
  callbackUrl: 'http://app.localhost:8080/api/github/oauth/callback',
  description: 'Docs whose git repo is the source of truth',
};

describe('app manifest', () => {
  it('asks only for contents, pull requests, and metadata', () => {
    const manifest = buildAppManifest(input);
    assert.deepEqual(manifest.default_permissions, {
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
    assert.equal('workflows' in manifest.default_permissions, false);
    assert.deepEqual(manifest.default_events, [
      'push',
      'pull_request',
      'installation',
      'installation_repositories',
    ]);
    assert.equal(manifest.hook_attributes.active, true);
    assert.equal(manifest.public, false);
    assert.equal(manifestCreateUrl({ kind: 'user' }), 'https://github.com/settings/apps/new');
    assert.equal(
      manifestCreateUrl({ kind: 'org', org: 'acme' }),
      'https://github.com/organizations/acme/settings/apps/new',
    );
  });

  it('exchanges the callback code against the conversions endpoint and does not persist it', async () => {
    let seen = '';
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = String(url);
      assert.equal(init?.method, 'POST');
      return new Response(
        JSON.stringify({
          id: 99,
          slug: 'oxybook-dev',
          client_id: 'cid',
          client_secret: 'csecret',
          webhook_secret: 'wsecret',
          pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        }),
        { status: 201 },
      );
    };
    const credentials = await exchangeManifestCode('manifest-code', { fetch: fetchImpl });
    assert.equal(seen, 'https://api.github.com/app-manifests/manifest-code/conversions');
    assert.equal(credentials.id, 99);
    assert.match(credentials.privateKeyPem, /BEGIN PRIVATE KEY/);
    const store = new MemoryAppCredentials();
    assert.equal(store.get(), null);
    store.set(credentials);
    assert.equal(store.get()?.webhookSecret, 'wsecret');
  });
});
