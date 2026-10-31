// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { handleDelivery } from '../src/deliveries.js';

const url = process.env.DATABASE_URL;

describe('webhook deliveries', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId: string;
  const sent: { queue: string; data: unknown; key: string | undefined }[] = [];
  const jobs = {
    async send(queue: string, data: unknown, options?: { singletonKey?: string }) {
      sent.push({ queue, data, key: options?.singletonKey });
      return `job-${sent.length}`;
    },
  } as Parameters<typeof handleDelivery>[1];

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
    await migrateToLatest(db, { schema });
    const org = await db
      .insertInto('orgs')
      .values({ slug: 'o', name: 'O' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const space = await db
      .insertInto('spaces')
      .values({
        org_id: org.id,
        slug: 's',
        name: 'S',
        repo_owner: 'crisprintsstuff',
        repo_name: 'oxybook-test',
        github_installation_id: 176737174,
        default_ref: 'main',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    spaceId = space.id;
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  const push = (ref: string, extra: object = {}) => ({
    ref,
    after: 'a'.repeat(40),
    repository: { name: 'OxyBook-Test', owner: { login: 'CrisPrintsStuff' } },
    ...extra,
  });

  it('queues a sync for a push to the default branch, once per delivery', async () => {
    const first = await handleDelivery(db, jobs, {
      event: 'push',
      delivery: 'd1',
      payload: push('refs/heads/main'),
    });
    assert.deepEqual(first, { kind: 'queued', spaces: [{ spaceId, ref: 'main', job: 'job-1' }] });
    assert.deepEqual(sent[0], {
      queue: 'sync',
      data: { spaceId, ref: 'main', reason: 'push', deliveryId: 'd1', after: 'a'.repeat(40) },
      key: `${spaceId}:main`,
    });
    const again = await handleDelivery(db, jobs, {
      event: 'push',
      delivery: 'd1',
      payload: push('refs/heads/main'),
    });
    assert.deepEqual(again, { kind: 'duplicate' }, 'GitHub redelivery is ignored');
    assert.equal(sent.length, 1);
  });

  it('ignores other branches, tags, deletions, unknown repos, and other events', async () => {
    const outcomes = [
      await handleDelivery(db, jobs, {
        event: 'push',
        delivery: 'd2',
        payload: push('refs/heads/feature'),
      }),
      await handleDelivery(db, jobs, {
        event: 'push',
        delivery: 'd3',
        payload: push('refs/tags/v1'),
      }),
      await handleDelivery(db, jobs, {
        event: 'push',
        delivery: 'd4',
        payload: push('refs/heads/main', { deleted: true }),
      }),
      await handleDelivery(db, jobs, {
        event: 'push',
        delivery: 'd5',
        payload: { ref: 'refs/heads/main', repository: { name: 'other', owner: { login: 'x' } } },
      }),
      await handleDelivery(db, jobs, { event: 'pull_request', delivery: 'd6', payload: {} }),
    ];
    assert.deepEqual(
      outcomes.map((o) => o.kind),
      ['ignored', 'ignored', 'ignored', 'ignored', 'ignored'],
    );
    assert.equal(sent.length, 1);
  });

  it('moves the draft whose PR was merged, closed, or reopened', async () => {
    const user = await db
      .insertInto('users')
      .values({ email: 'w@example.com', name: 'W' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const space = await db
      .selectFrom('spaces')
      .select('org_id')
      .where('id', '=', spaceId)
      .executeTakeFirstOrThrow();
    const draft = await db
      .insertInto('drafts')
      .values({
        org_id: space.org_id,
        space_id: spaceId,
        user_id: user.id,
        base_ref: 'main',
        base_sha: 'a'.repeat(40),
        branch: 'oxybook/w/guide-12345678',
        pr_number: 7,
        state: 'proposed',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const pr = (
      action: string,
      merged: boolean,
      delivery: string,
      ref = 'oxybook/w/guide-12345678',
    ) =>
      handleDelivery(db, jobs, {
        event: 'pull_request',
        delivery,
        payload: {
          action,
          pull_request: { number: 7, merged, head: { ref } },
          repository: { name: 'OxyBook-Test', owner: { login: 'CrisPrintsStuff' } },
        },
      });
    assert.deepEqual(await pr('closed', false, 'p1'), {
      kind: 'drafts',
      event: 'closed',
      drafts: [{ draftId: draft.id, state: 'closed' }],
    });
    assert.equal((await pr('reopened', false, 'p2')).kind, 'drafts');
    assert.equal((await pr('synchronize', false, 'p3')).kind, 'ignored');
    assert.equal((await pr('closed', true, 'p4', 'feature/not-ours')).kind, 'ignored');
    assert.deepEqual(await pr('closed', true, 'p5'), {
      kind: 'drafts',
      event: 'merged',
      drafts: [{ draftId: draft.id, state: 'merged' }],
    });
    assert.deepEqual(await pr('closed', true, 'p5'), { kind: 'duplicate' });
  });
});
