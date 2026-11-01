// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the editor SPA (`apps/editor`, built with `vite build`): `/orgs/:org/spaces/:space/edit`
 * answers with its `index.html`, and `/editor-assets/*` with its files. The SPA checks the
 * session itself through `/api/editor`, which enforces membership and roles.
 */

/** `apps/editor/dist`, from `apps/server/src` (tsx) and `apps/server/dist` (built) alike. */
export const DEFAULT_EDITOR_DIST = fileURLToPath(new URL('../../editor/dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The editor page's policy. The preview is a sandboxed `srcdoc` iframe, which inherits it:
 * its HTML can style itself and show images, and can run nothing.
 */
export const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const EDIT_PAGE = /^\/orgs\/[a-z0-9-]+\/spaces\/[a-z0-9-]+\/edit\/?$/;
const ASSET_PREFIX = '/editor-assets/';

export function createEditorAssets(options: { distDir?: string } = {}) {
  const dist = resolve(options.distDir ?? DEFAULT_EDITOR_DIST);

  async function sendIndex(response: ServerResponse): Promise<void> {
    let html: Buffer;
    try {
      html = await readFile(join(dist, 'index.html'));
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        'The editor is not built. Run `pnpm --filter @oxybook/editor build` (pnpm dev does this), then reload.',
      );
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': EDITOR_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    response.end(html);
  }

  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') return false;
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (EDIT_PAGE.test(pathname)) {
        await sendIndex(response);
        return true;
      }
      if (!pathname.startsWith(ASSET_PREFIX)) return false;

      let name: string;
      try {
        name = decodeURIComponent(pathname.slice(ASSET_PREFIX.length));
      } catch {
        name = '';
      }
      const file = resolve(dist, name);
      const type = TYPES[extname(file).toLowerCase()];
      // Only files inside dist, of a known type; never index.html or a dotfile by this route.
      if (
        !name ||
        !type ||
        !file.startsWith(dist + sep) ||
        name.split('/').some((part) => part.startsWith('.'))
      ) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return true;
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        response.writeHead(200, {
          'content-type': type,
          // Vite puts a content hash in every asset name.
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        });
        response.end(method === 'HEAD' ? undefined : body);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
      }
      return true;
    },
  };
}
