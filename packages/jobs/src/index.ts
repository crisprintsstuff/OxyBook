// SPDX-License-Identifier: AGPL-3.0-only

import { PgBoss } from 'pg-boss';

/**
 * Every queue OxyBook uses, with its payload. ARCHITECTURE §8: jobs are claimed
 * through pg-boss (SKIP LOCKED), so more worker replicas never run one job twice.
 * Add a queue here, not as a string at a call site.
 */
export interface JobPayloads {
  /** Round-trip check from `oxybook-admin job ping`. The worker logs it and completes it. */
  ping: { requestedBy: string; at: string };
}

export type QueueName = keyof JobPayloads;

export const QUEUE_NAMES: readonly QueueName[] = ['ping'];

/** pg-boss keeps its tables in its own schema, next to OxyBook's. */
export const DEFAULT_JOBS_SCHEMA = 'pgboss';

export interface ReceivedJob<Q extends QueueName> {
  id: string;
  name: Q;
  data: JobPayloads[Q];
  retryCount: number;
}

export interface JobQueue {
  send<Q extends QueueName>(
    queue: Q,
    data: JobPayloads[Q],
    options?: { singletonKey?: string; retryLimit?: number },
  ): Promise<string>;
  /** One job at a time per call. A thrown error fails the attempt and pg-boss retries it. */
  work<Q extends QueueName>(
    queue: Q,
    handler: (job: ReceivedJob<Q>) => Promise<void>,
    options?: { pollingIntervalSeconds?: number },
  ): Promise<string>;
  /** Job state as pg-boss records it, or null when the job is unknown or deleted. */
  state(queue: QueueName, id: string): Promise<string | null>;
  stop(): Promise<void>;
}

export async function startJobs(
  connectionString: string,
  options: {
    schema?: string;
    log?: (line: string) => void;
    /** Defaults to 10s, like @oxybook/db: never wait forever for a connection. */
    connectTimeoutMs?: number;
  } = {},
): Promise<JobQueue> {
  const log = options.log ?? ((line: string) => console.log(line));
  const boss = new PgBoss({
    connectionString,
    schema: options.schema ?? DEFAULT_JOBS_SCHEMA,
    application_name: 'oxybook-jobs',
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
  });
  boss.on('error', (error: unknown) => {
    log(`jobs error: ${error instanceof Error ? error.message : String(error)}`);
  });
  await boss.start();
  for (const name of QUEUE_NAMES) await ensureQueue(boss, name);

  return {
    async send(queue, data, sendOptions = {}) {
      const id = await boss.send(queue, data, sendOptions);
      if (!id) {
        // pg-boss returns null when a singleton or policy rule suppressed the job.
        throw new Error(`job not queued on ${queue}: suppressed by its singleton key or policy`);
      }
      return id;
    },
    async work(queue, handler, workOptions = {}) {
      return boss.work<JobPayloads[typeof queue]>(
        queue,
        { batchSize: 1, ...workOptions },
        async (jobs) => {
          for (const job of jobs) {
            await handler({
              id: job.id,
              name: queue,
              data: job.data,
              retryCount: job.retryCount,
            });
          }
        },
      );
    },
    async state(queue, id) {
      const found = await boss.findJobs(queue, { id });
      return found[0]?.state ?? null;
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}

async function ensureQueue(boss: PgBoss, name: QueueName): Promise<void> {
  if (await boss.getQueue(name)) return;
  try {
    await boss.createQueue(name);
  } catch (error) {
    // app and worker start together; whoever loses the race finds the queue there.
    if (!(await boss.getQueue(name))) throw error;
  }
}
