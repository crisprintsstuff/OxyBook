// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Database, type Kysely } from '@oxybook/db';
import { buildKey, type JobQueue, startJobs, syncKey } from '@oxybook/jobs';
import { type BuildEnvironment, runSpaceBuild } from '@oxybook/renderer';
import {
  findStaleSpaces,
  runSpaceSync,
  type SyncEnvironment,
  storedAppTokens,
} from '@oxybook/sync';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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

export interface JobWorkerOptions {
  log?: (line: string) => void;
  /** pg-boss schema, for tests. */
  schema?: string;
  pollingIntervalSeconds?: number;
  /** Defaults to a pool on databaseUrl. Tests pass one bound to their schema. */
  db?: Kysely<Database>;
  /** Defaults to tokens minted from the stored App with OXYBOOK_SECRET_KEY. */
  tokenFor?: SyncEnvironment['tokenFor'];
  githubUrl?: string;
  mirrorsDir?: string;
  sitesDir?: string;
  sitesDomain?: string;
  /** Cron for reconciliation, or 'off'. Default every 5 minutes. */
  reconcileCron?: string;
  /** Automatically queue a build after a sync job completes (default true). */
  buildAfterSync?: boolean;
}

/**
 * Registers a handler per queue. Without DATABASE_URL the worker only serves /healthz,
 * which is what compose's health check and the M0 tests need.
 */
export async function startJobWorker(
  databaseUrl: string,
  options: JobWorkerOptions = {},
): Promise<{ jobs: JobQueue; stop(): Promise<void> }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const ownDb = options.db ? null : createDb(databaseUrl, { max: 4 });
  const db = options.db ?? (ownDb as Kysely<Database>);
  const jobs = await startJobs(databaseUrl, {
    log,
    ...(options.schema ? { schema: options.schema } : {}),
  });
  const polling =
    options.pollingIntervalSeconds !== undefined
      ? { pollingIntervalSeconds: options.pollingIntervalSeconds }
      : {};
  const env: BuildEnvironment = {
    db,
    tokenFor: options.tokenFor ?? storedAppTokens(db, process.env.OXYBOOK_SECRET_KEY),
    githubUrl: options.githubUrl ?? process.env.OXYBOOK_GITHUB_URL ?? 'https://github.com',
    mirrorsDir:
      options.mirrorsDir ??
      process.env.OXYBOOK_MIRRORS_DIR ??
      path.join(REPO_ROOT, '.oxybook-mirrors'),
    sitesDir:
      options.sitesDir ?? process.env.OXYBOOK_SITES_DIR ?? path.join(REPO_ROOT, '.oxybook-sites'),
    sitesDomain: options.sitesDomain ?? process.env.OXYBOOK_SITES_DOMAIN ?? 'docs.localhost',
    log,
  };

  await jobs.work(
    'ping',
    async (job) => {
      log(`job ping ${job.id} from ${job.data.requestedBy} done`);
    },
    polling,
  );
  await jobs.work(
    'sync',
    async (job) => {
      const { spaceId, ref, reason } = job.data;
      log(
        `job sync ${job.id} space ${spaceId} ref ${ref} (${reason}${job.data.deliveryId ? ` ${job.data.deliveryId}` : ''})`,
      );
      try {
        await runSpaceSync(env, spaceId, ref);
        if (options.buildAfterSync !== false) {
          const buildJobId = await jobs.send(
            'build',
            { spaceId, version: 'default', ref, reason: 'sync' },
            { singletonKey: buildKey(spaceId, 'default') },
          );
          log(`sync ${spaceId} ${ref}: build ${buildJobId ?? 'already queued'}`);
        }
      } catch (error) {
        log(`job sync ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    polling,
  );
  await jobs.work(
    'build',
    async (job) => {
      const { spaceId, version, ref, reason } = job.data;
      log(`job build ${job.id} space ${spaceId} version ${version} ref ${ref} (${reason})`);
      try {
        await runSpaceBuild(env, spaceId, { version, ref });
      } catch (error) {
        log(
          `job build ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
    polling,
  );
  await jobs.work(
    'reconcile',
    async () => {
      for (const outcome of await findStaleSpaces(env)) {
        if (outcome.error) {
          log(`reconcile space ${outcome.spaceId}: ${outcome.error}`);
        } else if (outcome.behind) {
          const id = await jobs.send(
            'sync',
            { spaceId: outcome.spaceId, ref: outcome.ref, reason: 'reconcile' },
            { singletonKey: syncKey(outcome.spaceId, outcome.ref) },
          );
          log(
            `reconcile space ${outcome.spaceId} ${outcome.ref}: stored ${outcome.stored?.slice(0, 12) ?? 'none'}, remote ${outcome.remote?.slice(0, 12)}; sync ${id ?? 'already queued'}`,
          );
        }
      }
    },
    polling,
  );
  const cron = options.reconcileCron ?? process.env.OXYBOOK_RECONCILE_CRON ?? '*/5 * * * *';
  if (cron !== 'off') await jobs.schedule('reconcile', cron, {});

  return {
    jobs,
    async stop() {
      await jobs.stop();
      await ownDb?.destroy();
    },
  };
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1].endsWith('main.js');
}

if (invokedDirectly()) {
  const port = Number(process.env.HEALTH_PORT ?? 3001);
  startHealthServer({ port, service: 'worker' })
    .then(async ({ port: bound }) => {
      console.log(`worker listening on ${bound}`);
      if (!process.env.DATABASE_URL) {
        console.log('jobs: off (DATABASE_URL is not set)');
        return;
      }
      await startJobWorker(process.env.DATABASE_URL);
      console.log('jobs: working on ping, sync, build, reconcile');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
