// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEditorAssets, EDITOR_CSP } from '../src/editor-assets.js';

async function serve(distDir: string): Promise<{ server: Server; base: string }> {
  const assets = createEditorAssets({ distDir });
  const server = createServer(async (request, response) => {
    if (!(await assets.handle(request, response))) {
      response.writeHead(418);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('editor assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'oxybook-editor-'));
  const dist = join(root, 'dist');
  let built: { server: Server; base: string };
  let missing: { server: Server; base: string };

  before(async () => {
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dist, 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dist, '.secret.js'), 'no');
    writeFileSync(join(root, 'outside.js'), 'no');
    built = await serve(dist);
    missing = await serve(join(root, 'not-built'));
  });

  after(() => {
    built.server.close();
    missing.server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers the edit route with index.html and a strict CSP', async () => {
    const response = await fetch(`${built.base}/orgs/cris/spaces/test/edit`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('content-security-policy'), EDITOR_CSP);
    assert.match(EDITOR_CSP, /script-src 'self'(;|$)/);
    assert.match(await response.text(), /id="root"/);
    assert.equal((await fetch(`${built.base}/orgs/cris/spaces/test/edit/`)).status, 200);
  });

  it('serves hashed assets and nothing outside dist', async () => {
    const js = await fetch(`${built.base}/editor-assets/index-abc123.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.match(js.headers.get('cache-control') ?? '', /immutable/);
    for (const path of [
      '/editor-assets/..%2foutside.js',
      '/editor-assets/.secret.js',
      '/editor-assets/index.html',
      '/editor-assets/nope.js',
      '/editor-assets/',
    ]) {
      assert.equal((await fetch(`${built.base}${path}`)).status, 404, path);
    }
  });

  it('leaves other routes alone and explains a missing build', async () => {
    assert.equal((await fetch(`${built.base}/orgs/cris/spaces/test`)).status, 418);
    assert.equal(
      (await fetch(`${built.base}/orgs/cris/spaces/test/edit`, { method: 'POST' })).status,
      418,
    );
    const response = await fetch(`${missing.base}/orgs/cris/spaces/test/edit`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /pnpm --filter @oxybook\/editor build/);
  });
});
