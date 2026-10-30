// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { type JobQueue, startJobs } from '@oxybook/jobs';
import pg from 'pg';
import { startJobWorker } from '../src/main.js';

const url = process.env.DATABASE_URL;

describe('worker jobs', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `pgboss_test_${randomBytes(6).toString('hex')}`;
  const queues: JobQueue[] = [];
  const stops: (() => Promise<void>)[] = [];

  after(async () => {
    for (const stop of stops) await stop();
    for (const queue of queues) await queue.stop();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('completes a ping sent by the app side', async () => {
    const lines: string[] = [];
    const worker = await startJobWorker(url as string, {
      schema,
      log: (line) => lines.push(line),
      pollingIntervalSeconds: 0.5,
      reconcileCron: 'off',
    });
    const app = await startJobs(url as string, { schema, log: () => {} });
    stops.push(worker.stop);
    queues.push(app);
    const id = await app.send('ping', { requestedBy: 'test', at: new Date().toISOString() });
    assert.ok(id);
    const deadline = Date.now() + 15_000;
    while ((await app.state('ping', id)) !== 'completed') {
      if (Date.now() > deadline) throw new Error('ping never completed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(lines, [`job ping ${id} from test done`]);
  });
});
