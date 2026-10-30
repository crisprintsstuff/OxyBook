// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDb, migrateToLatest } from '@oxybook/db';
import { type AppCredentials, MemoryAppCredentials } from '@oxybook/github';
import { deriveSecretsKey, loadAppCredentials, saveAppCredentials } from './app-credentials.js';
import { createGithubRoutes } from './github-routes.js';

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

export function startHealthServer(options: {
  port: number;
  host?: string;
  service: string;
}): Promise<HealthServer> {
  const server = createServer((request, response) => {
    const url = request.url?.split('?')[0];
    if (request.method === 'GET' && url === '/healthz') {
      const body = JSON.stringify({ ok: true, service: options.service });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected the health server to bind a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function startAppServer(options: {
  port: number;
  host?: string;
  publicUrl?: string;
  store?: MemoryAppCredentials;
  persist?: (credentials: AppCredentials) => Promise<void>;
}): Promise<HealthServer> {
  const publicUrl =
    options.publicUrl ?? process.env.OXYBOOK_PUBLIC_URL ?? 'http://app.localhost:8080';
  const github = createGithubRoutes({
    owner: { kind: 'user' },
    ...(options.store ? { store: options.store } : {}),
    ...(options.persist ? { persist: options.persist } : {}),
    manifest: {
      name: 'OxyBook',
      url: publicUrl,
      hookUrl: `${publicUrl}/api/github/webhooks`,
      redirectUrl: `${publicUrl}/setup/github/callback`,
      callbackUrl: `${publicUrl}/api/github/oauth/callback`,
      description: 'Docs whose git repository is the source of truth',
    },
  });
  const server = createServer(async (request, response) => {
    const rawBody = await readRawBody(request);
    if (await github.handle(request, response, rawBody)) return;
    const url = request.url?.split('?')[0];
    if (request.method === 'GET' && url === '/healthz') {
      const body = JSON.stringify({ ok: true, service: 'app' });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  return listen(server, options.port, options.host);
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function listen(server: Server, port: number, host?: string): Promise<HealthServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host ?? '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected the server to bind a TCP port'));
        return;
      }
      resolve({ port: address.port, close: () => closeServer(server) });
    });
  });
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1].endsWith('main.js');
}

/**
 * Compose sets OXYBOOK_MIGRATE_ON_START on the single app replica, and the worker waits
 * for app to be healthy, so migrations finish before either process serves anything.
 */
export async function migrateOnStart(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.OXYBOOK_MIGRATE_ON_START !== 'true') return [];
  if (!env.DATABASE_URL) {
    throw new Error('OXYBOOK_MIGRATE_ON_START is true but DATABASE_URL is not set');
  }
  const db = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const { applied } = await migrateToLatest(db);
    return applied;
  } finally {
    await db.destroy();
  }
}

/**
 * GitHub App credentials survive a restart only with both DATABASE_URL and
 * OXYBOOK_SECRET_KEY. Without them the manifest flow still works, in memory.
 */
export async function appCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<{
  store: MemoryAppCredentials;
  persist?: (credentials: AppCredentials) => Promise<void>;
}> {
  const store = new MemoryAppCredentials();
  if (!env.DATABASE_URL || !env.OXYBOOK_SECRET_KEY) {
    log(
      'github app credentials: memory only (set DATABASE_URL and OXYBOOK_SECRET_KEY to keep them)',
    );
    return { store };
  }
  const key = deriveSecretsKey(env.OXYBOOK_SECRET_KEY);
  const db = createDb(env.DATABASE_URL, { max: 2 });
  const existing = await loadAppCredentials(db, key);
  if (existing) {
    store.set(existing);
    log(`github app ${existing.id} (${existing.slug}) loaded from the database`);
  } else {
    log('github app credentials: none stored yet; open /setup/github to create the App');
  }
  return { store, persist: (credentials) => saveAppCredentials(db, key, credentials) };
}

if (invokedDirectly()) {
  const port = Number(process.env.PORT ?? 3000);
  migrateOnStart()
    .then(async (applied) => {
      for (const name of applied) console.log(`migrated ${name}`);
      const credentials = await appCredentialsFromEnv();
      return startAppServer({ port, ...credentials });
    })
    .then(({ port: bound }) => {
      console.log(`app listening on ${bound}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
