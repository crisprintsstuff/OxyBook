// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { createGithubRoutes } from '../src/github-routes.js';

const manifestInput = {
  name: 'OxyBook',
  url: 'http://app.localhost:8080',
  hookUrl: 'http://app.localhost:8080/api/github/webhooks',
  redirectUrl: 'http://app.localhost:8080/setup/github/callback',
  callbackUrl: 'http://app.localhost:8080/api/github/oauth/callback',
};

async function withServer(
  routes: ReturnType<typeof createGithubRoutes>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const handled = await routes.handle(request, response, Buffer.concat(chunks));
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('GitHub manifest routes', () => {
  it('renders a manifest form and stores credentials from a mocked exchange', async () => {
    const routes = createGithubRoutes({
      manifest: manifestInput,
      owner: { kind: 'user' },
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: 7,
            slug: 'oxybook',
            client_id: 'cid',
            client_secret: 'csecret',
            webhook_secret: 'wsecret',
            pem: '-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----\n',
          }),
          { status: 201 },
        ),
    });
    await withServer(routes, async (base) => {
      const page = await fetch(`${base}/setup/github`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /action="https:\/\/github.com\/settings\/apps\/new\?state=/);
      assert.match(html, /contents&quot;:&quot;write/);
      assert.doesNotMatch(html, /workflows/);
      const state = /state=([0-9a-f]+)/.exec(html)?.[1];
      assert.ok(state);
      const callback = await fetch(`${base}/setup/github/callback?code=abc&state=${state}`);
      const stored = (await callback.json()) as { stored: boolean; id: number; slug: string };
      assert.equal(callback.status, 200);
      assert.deepEqual(stored, { stored: true, id: 7, slug: 'oxybook' });
      assert.equal(JSON.stringify(stored).includes('PRIVATE KEY'), false);
      assert.match(routes.store.get()?.privateKeyPem ?? '', /PRIVATE KEY/);
      const again = await fetch(`${base}/setup/github/callback?code=abc&state=${state}`);
      assert.equal(again.status, 400);
    });
  });

  it('rejects a webhook whose signature does not match the raw body', async () => {
    const routes = createGithubRoutes({
      manifest: manifestInput,
      owner: { kind: 'user' },
    });
    routes.store.set({
      id: 1,
      slug: 'oxybook',
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookSecret: 'wsecret',
      privateKeyPem: 'pem',
    });
    await withServer(routes, async (base) => {
      const body = '{"zen":"keep the bytes"}';
      const good = createHmac('sha256', 'wsecret').update(body).digest('hex');
      const ok = await fetch(`${base}/api/github/webhooks`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${good}` },
        body,
      });
      assert.equal(ok.status, 204);
      const bad = await fetch(`${base}/api/github/webhooks`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${good}` },
        body: `${body} `,
      });
      assert.equal(bad.status, 401);
    });
  });
});
