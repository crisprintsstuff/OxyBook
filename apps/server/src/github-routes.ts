// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AppCredentials,
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
  /** Durable save after the manifest exchange. Without it, credentials live in memory only. */
  persist?: (credentials: AppCredentials) => Promise<void>;
  log?: (line: string) => void;
  /**
   * Called after a delivery's signature is verified. A throw answers 500, so GitHub
   * marks the delivery failed and it can be redelivered.
   */
  onDelivery?: (delivery: { event: string; delivery: string; payload: unknown }) => Promise<void>;
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
  const log = options.log ?? ((line: string) => console.log(line));

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
        const existing = store.get();
        if (existing) {
          // A second App would orphan the first one's installations and key.
          sendJson(response, 409, {
            error: 'a GitHub App is already configured',
            id: existing.id,
            slug: existing.slug,
            install_url: installUrl(existing.slug, options.githubHost),
          });
          return true;
        }
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
        const stored = store.get() as AppCredentials;
        let persisted = false;
        if (options.persist) {
          try {
            await options.persist(stored);
            persisted = true;
          } catch (error) {
            // The App exists on GitHub and its key is only in this process now.
            const message = error instanceof Error ? error.message : String(error);
            log(`github app ${stored.id} created but not saved: ${message}`);
            sendJson(response, 500, {
              stored: false,
              persisted: false,
              id: stored.id,
              slug: stored.slug,
              error: `created on GitHub but not saved: ${message}`,
            });
            return true;
          }
        }
        log(
          `github app ${stored.id} (${stored.slug}) stored${persisted ? ' in the database' : ' in memory only'}`,
        );
        sendJson(response, 200, {
          stored: true,
          persisted,
          id: stored.id,
          slug: stored.slug,
          install_url: installUrl(stored.slug, options.githubHost),
        });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/github/webhooks') {
        const secret = store.get()?.webhookSecret ?? process.env.GITHUB_APP_WEBHOOK_SECRET ?? '';
        const header = headerValue(request.headers['x-hub-signature-256']);
        const event = headerValue(request.headers['x-github-event']) ?? 'unknown';
        const delivery = headerValue(request.headers['x-github-delivery']) ?? 'unknown';
        if (!secret || !verifyWebhookSignature(rawBody, header, secret)) {
          log(
            `webhook rejected event=${event} delivery=${delivery} reason=${secret ? 'signature' : 'no secret'}`,
          );
          response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('invalid signature');
          return true;
        }
        log(`webhook verified event=${event} delivery=${delivery}`);
        if (options.onDelivery) {
          let payload: unknown = null;
          try {
            payload = JSON.parse(rawBody.toString('utf8'));
          } catch {
            payload = null;
          }
          try {
            await options.onDelivery({ event, delivery, payload });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`webhook ${delivery} not handled: ${message}`);
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('delivery not handled');
            return true;
          }
        }
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function installUrl(slug: string, githubHost = 'https://github.com'): string {
  return `${githubHost.replace(/\/$/, '')}/apps/${encodeURIComponent(slug)}/installations/new`;
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
