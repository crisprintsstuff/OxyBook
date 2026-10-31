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
  /** Bring a space's ref in line with GitHub (ARCHITECTURE §4.2). The worker reads the head itself. */
  sync: {
    spaceId: string;
    ref: string;
    reason: 'push' | 'reconcile' | 'manual';
    deliveryId?: string;
    /** The head GitHub reported, for the log. Sync fetches and uses the real head. */
    after?: string;
  };
  /** Build a published site version at its synced head (ARCHITECTURE §5.3). */
  build: {
    spaceId: string;
    version: string;
    ref: string;
    reason: 'sync' | 'manual';
  };
  /** Push a draft to its oxybook/* branch and open or update its PR (ARCHITECTURE §4.3). */
  propose: {
    draftId: string;
    /** Who clicked Propose; must own the draft and be an editor or admin. */
    userId: string;
    title: string;
    /** The user ticked the DCO affirmation. */
    signOff: boolean;
  };
  /** Compare every space's remote head with ref_state and queue syncs for the ones behind. */
  reconcile: { at?: string };
}

export type QueueName = keyof JobPayloads;

export const QUEUE_NAMES: readonly QueueName[] = ['ping', 'sync', 'build', 'propose', 'reconcile'];

/**
 * `sync` is `stately` with singletonKey `<space>:<ref>`: at most one queued and one active
 * per space and ref, so a burst of pushes collapses into one follow-up sync.
 * `build` is `stately` with singletonKey `<space>:<version>` (§5.3).
 * `reconcile` is `singleton`: one pass at a time across all workers.
 */
const QUEUE_OPTIONS: Record<
  QueueName,
  { policy?: string; retryLimit?: number; retryDelay?: number; retryBackoff?: boolean }
> = {
  ping: {},
  sync: { policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true },
  build: { policy: 'stately', retryLimit: 2, retryDelay: 15, retryBackoff: true },
  // One propose per draft at a time. Retries cover a base or branch that moved mid-job.
  propose: { policy: 'stately', retryLimit: 3, retryDelay: 10, retryBackoff: true },
  reconcile: { policy: 'singleton', retryLimit: 0 },
};

export function syncKey(spaceId: string, ref: string): string {
  return `${spaceId}:${ref}`;
}

export function buildKey(spaceId: string, version: string): string {
  return `${spaceId}:${version}`;
}

/** pg-boss keeps its tables in its own schema, next to OxyBook's. */
export const DEFAULT_JOBS_SCHEMA = 'pgboss';

export interface ReceivedJob<Q extends QueueName> {
  id: string;
  name: Q;
  data: JobPayloads[Q];
  retryCount: number;
}

export interface JobQueue {
  /** The job id, or null when the queue's policy suppressed it (one is already waiting). */
  send<Q extends QueueName>(
    queue: Q,
    data: JobPayloads[Q],
    options?: { singletonKey?: string; retryLimit?: number },
  ): Promise<string | null>;
  /** Send `data` to `queue` on a cron schedule. One job per tick across all instances. */
  schedule<Q extends QueueName>(queue: Q, cron: string, data: JobPayloads[Q]): Promise<void>;
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
      return boss.send(queue, data, sendOptions);
    },
    async schedule(queue, cron, data) {
      await boss.schedule(queue, cron, data);
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
    await boss.createQueue(name, QUEUE_OPTIONS[name]);
  } catch (error) {
    // app and worker start together; whoever loses the race finds the queue there.
    if (!(await boss.getQueue(name))) throw error;
  }
}

/** One propose job queued and one running per draft. */
export function proposeKey(draftId: string): string {
  return `propose:${draftId}`;
}
