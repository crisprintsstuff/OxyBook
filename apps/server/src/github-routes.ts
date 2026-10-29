// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AppManifestInput,
  buildAppManifest,
  exchangeManifestCode,
  MemoryAppCredentials,
  manifestCreateUrl,
  verifyWebhookSignature,
} from '@oxybook/github';

export interface GithubRouteOptions {
  manifest: AppManifestInput;
  /** `user` posts to /settings/apps/new. An org name posts to that org. */
  owner: { kind: 'user' } | { kind: 'org'; org: string };
  githubHost?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  store?: MemoryAppCredentials;
  now?: () => number;
}

interface PendingState {
  expiresAt: number;
}

export function createGithubRoutes(options: GithubRouteOptions): {
  store: MemoryAppCredentials;
  handle(request: IncomingMessage, response: ServerResponse, rawBody: Buffer): Promise<boolean>;
} {
  const store = options.store ?? new MemoryAppCredentials();
  const pending = new Map<string, PendingState>();
  const now = options.now ?? Date.now;

  function issueState(): string {
    const state = randomBytes(16).toString('hex');
    pending.set(state, { expiresAt: now() + 15 * 60_000 });
    return state;
  }

  function consumeState(state: string | null): boolean {
    if (!state) return false;
    const entry = pending.get(state);
    pending.delete(state);
    return entry !== undefined && entry.expiresAt > now();
  }

  return {
    store,
    async handle(request, response, rawBody) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/setup/github') {
        const state = issueState();
        const manifest = buildAppManifest(options.manifest);
        const action = `${manifestCreateUrl(options.owner, options.githubHost)}?state=${encodeURIComponent(state)}`;
        const html = renderManifestForm(action, JSON.stringify(manifest));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/setup/github/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !consumeState(state)) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('invalid manifest callback');
          return true;
        }
        try {
          const credentials = await exchangeManifestCode(code, {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.apiBase ? { apiBase: options.apiBase } : {}),
          });
          store.set(credentials);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'manifest exchange failed';
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(message);
          return true;
        }
        const stored = store.get();
        const body = JSON.stringify({
          stored: true,
          id: stored?.id ?? null,
          slug: stored?.slug ?? null,
        });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(body);
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/github/webhooks') {
        const secret = store.get()?.webhookSecret ?? process.env.GITHUB_APP_WEBHOOK_SECRET ?? '';
        const header = headerValue(request.headers['x-hub-signature-256']);
        if (!secret || !verifyWebhookSignature(rawBody, header, secret)) {
          response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('invalid signature');
          return true;
        }
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function renderManifestForm(action: string, manifestJson: string): string {
  return `<!doctype html>
<html><body>
<form method="post" action="${escapeAttr(action)}">
<input type="hidden" name="manifest" value="${escapeAttr(manifestJson)}">
<button type="submit">Create GitHub App</button>
</form>
</body></html>
`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
