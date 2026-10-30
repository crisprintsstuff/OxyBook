// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { type JobQueue, startJobs } from '@oxybook/jobs';

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

/**
 * Registers a handler per queue. Without DATABASE_URL the worker only serves /healthz,
 * which is what compose's health check and the M0 tests need.
 */
export async function startJobWorker(
  databaseUrl: string,
  options: { log?: (line: string) => void; schema?: string; pollingIntervalSeconds?: number } = {},
): Promise<JobQueue> {
  const log = options.log ?? ((line: string) => console.log(line));
  const jobs = await startJobs(databaseUrl, {
    log,
    ...(options.schema ? { schema: options.schema } : {}),
  });
  const polling =
    options.pollingIntervalSeconds !== undefined
      ? { pollingIntervalSeconds: options.pollingIntervalSeconds }
      : {};
  await jobs.work(
    'ping',
    async (job) => {
      log(`job ping ${job.id} from ${job.data.requestedBy} done`);
    },
    polling,
  );
  return jobs;
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
      console.log('jobs: working on ping');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
