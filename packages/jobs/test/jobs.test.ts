// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { type JobQueue, startJobs } from '../src/index.js';

const url = process.env.DATABASE_URL;

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Needs a real PostgreSQL. CI starts one; locally, set DATABASE_URL or the suite is skipped.
describe('job queue', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `pgboss_test_${randomBytes(6).toString('hex')}`;
  const queues: JobQueue[] = [];

  after(async () => {
    for (const queue of queues) await queue.stop();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('runs each job exactly once across two workers', async () => {
    const app = await startJobs(url as string, { schema, log: () => {} });
    const workerA = await startJobs(url as string, { schema, log: () => {} });
    const workerB = await startJobs(url as string, { schema, log: () => {} });
    queues.push(app, workerA, workerB);

    const seen: { worker: string; id: string }[] = [];
    for (const [worker, queue] of [
      ['a', workerA],
      ['b', workerB],
    ] as const) {
      await queue.work(
        'ping',
        async (job) => {
          seen.push({ worker, id: job.id });
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        { pollingIntervalSeconds: 0.5 },
      );
    }

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await app.send('ping', { requestedBy: 'test', at: new Date().toISOString() });
      assert.ok(id);
      ids.push(id);
    }
    await until(() => seen.length >= ids.length);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(seen.length, 20, 'no job ran twice');
    assert.deepEqual(new Set(seen.map((entry) => entry.id)), new Set(ids));
    await until(async () => (await app.state('ping', ids[19] as string)) === 'completed');
  });

  it('retries a job whose handler throws', async () => {
    const queue = await startJobs(url as string, { schema, log: () => {} });
    queues.push(queue);
    // Stop the earlier workers taking this job.
    for (const earlier of queues.slice(0, -1)) await earlier.stop();
    queues.splice(0, queues.length - 1);

    let attempts = 0;
    await queue.work(
      'ping',
      async (job) => {
        attempts++;
        if (job.data.requestedBy === 'flaky' && job.retryCount === 0) throw new Error('first try');
      },
      { pollingIntervalSeconds: 0.5 },
    );
    const id = await queue.send(
      'ping',
      { requestedBy: 'flaky', at: new Date().toISOString() },
      { retryLimit: 1 },
    );
    assert.ok(id);
    await until(async () => (await queue.state('ping', id)) === 'completed', 30_000);
    assert.equal(attempts, 2);
  });
});
