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
      const stored = (await callback.json()) as Record<string, unknown>;
      assert.equal(callback.status, 200);
      assert.deepEqual(stored, {
        stored: true,
        persisted: false,
        id: 7,
        slug: 'oxybook',
        install_url: 'https://github.com/apps/oxybook/installations/new',
      });
      assert.equal(JSON.stringify(stored).includes('PRIVATE KEY'), false);
      assert.match(routes.store.get()?.privateKeyPem ?? '', /PRIVATE KEY/);
      const again = await fetch(`${base}/setup/github/callback?code=abc&state=${state}`);
      assert.equal(again.status, 400);
      const second = await fetch(`${base}/setup/github`);
      assert.equal(second.status, 409, 'a configured App is never replaced from the setup page');
      assert.match(await second.text(), /already configured/);
    });
  });

  it('persists after the exchange and reports a failed save', async () => {
    const exchange = async () =>
      new Response(
        JSON.stringify({
          id: 8,
          slug: 'oxy',
          client_id: 'cid',
          client_secret: 'cs',
          webhook_secret: 'ws',
          pem: 'pem',
        }),
        { status: 201 },
      );
    const saved: number[] = [];
    const ok = createGithubRoutes({
      manifest: manifestInput,
      owner: { kind: 'user' },
      fetch: exchange,
      persist: async (credentials) => {
        saved.push(credentials.id);
      },
      log: () => {},
    });
    await withServer(ok, async (base) => {
      const state = /state=([0-9a-f]+)/.exec(
        await (await fetch(`${base}/setup/github`)).text(),
      )?.[1];
      const callback = await fetch(`${base}/setup/github/callback?code=c&state=${state}`);
      assert.equal(callback.status, 200);
      assert.equal(((await callback.json()) as { persisted: boolean }).persisted, true);
      assert.deepEqual(saved, [8]);
    });

    const failing = createGithubRoutes({
      manifest: manifestInput,
      owner: { kind: 'user' },
      fetch: exchange,
      persist: async () => {
        throw new Error('db down');
      },
      log: () => {},
    });
    await withServer(failing, async (base) => {
      const state = /state=([0-9a-f]+)/.exec(
        await (await fetch(`${base}/setup/github`)).text(),
      )?.[1];
      const callback = await fetch(`${base}/setup/github/callback?code=c&state=${state}`);
      assert.equal(callback.status, 500);
      const body = await callback.text();
      assert.match(body, /created on GitHub but not saved: db down/);
      assert.doesNotMatch(body, /pem|"ws"/);
    });
  });

  it('answers the OAuth callback path with 501 instead of 404', async () => {
    const routes = createGithubRoutes({ manifest: manifestInput, owner: { kind: 'user' } });
    await withServer(routes, async (base) => {
      const response = await fetch(`${base}/api/github/oauth/callback?code=x`);
      assert.equal(response.status, 501);
      assert.match(await response.text(), /not implemented/);
    });
  });

  it('rejects a webhook whose signature does not match the raw body', async () => {
    const lines: string[] = [];
    const routes = createGithubRoutes({
      manifest: manifestInput,
      owner: { kind: 'user' },
      log: (line) => lines.push(line),
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
        headers: {
          'x-hub-signature-256': `sha256=${good}`,
          'x-github-event': 'push',
          'x-github-delivery': 'd-1',
        },
        body,
      });
      assert.equal(ok.status, 204);
      const bad = await fetch(`${base}/api/github/webhooks`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${good}` },
        body: `${body} `,
      });
      assert.equal(bad.status, 401);
      assert.deepEqual(lines, [
        'webhook verified event=push delivery=d-1',
        'webhook rejected event=unknown delivery=unknown reason=signature',
      ]);
    });
  });
});
