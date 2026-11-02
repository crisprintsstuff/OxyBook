// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { listDraftFiles, openDraft, saveDraftFile } from '@oxybook/drafts';
import { commitInferredRedirects, RedirectCommitError } from '../src/redirects.js';

const url = process.env.DATABASE_URL;
const HEAD = 'a'.repeat(40);

describe('committing inferred redirects', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId = '';
  let orgId = '';
  let owner = '';
  let editor = '';
  const queued: { data: unknown }[] = [];
  const jobs = {
    async send(_queue: string, data: unknown) {
      queued.push({ data });
      return 'job';
    },
  };

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 3, searchPath: schema });
    await migrateToLatest(db, { schema });
    orgId = (
      await db
        .insertInto('orgs')
        .values({ slug: 'o', name: 'O' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    spaceId = (
      await db
        .insertInto('spaces')
        .values({ org_id: orgId, slug: 's', name: 'S', content_root: 'docs', default_ref: 'main' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('ref_state')
      .values({ org_id: orgId, space_id: spaceId, ref: 'main', head_sha: HEAD })
      .execute();
    for (const [key, role] of [
      ['owner', 'admin'],
      ['editor', 'editor'],
    ] as const) {
      const id = (
        await db
          .insertInto('users')
          .values({ email: `${key}@example.com`, name: key })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('org_members')
        .values({ org_id: orgId, user_id: id, role: 'member' })
        .execute();
      await db
        .insertInto('space_members')
        .values({ org_id: orgId, space_id: spaceId, user_id: id, role })
        .execute();
      if (key === 'owner') owner = id;
      else editor = id;
    }
    await db
      .insertInto('inferred_redirects')
      .values({
        org_id: orgId,
        space_id: spaceId,
        ref: 'main',
        from_url: '/guides/install',
        to_url: '/guides/setup',
        from_path: 'guides/install.md',
        to_path: 'guides/setup.md',
        commit_sha: HEAD,
      })
      .execute();
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('is for admins, after one sync, and proposes a draft that holds nothing else', async () => {
    await assert.rejects(
      commitInferredRedirects(db, { userId: editor, spaceId, jobs }),
      (e: unknown) => e instanceof RedirectCommitError && e.status === 403,
    );
    await assert.rejects(
      commitInferredRedirects(db, { userId: owner, spaceId, jobs }),
      /sync the space once/,
    );
    await db.updateTable('ref_state').set({ config_blob_sha: 'none' }).execute();

    const result = await commitInferredRedirects(db, { userId: owner, spaceId, jobs });
    assert.deepEqual(result, { added: 1, proposed: true });
    const job = queued[0]?.data as { title?: string } | undefined;
    assert.equal(job?.title, 'Commit a redirect for a renamed page');
    const draft = await openDraft(db, { spaceId, userId: owner, baseRef: 'main' });
    const [file] = await listDraftFiles(db, draft.id);
    assert.deepEqual(
      { path: file?.path, op: file?.op, text: file?.bytes?.toString() },
      {
        path: 'oxybook.yml',
        op: 'add',
        text: 'redirects:\n  - from: /guides/install\n    to: /guides/setup\n',
      },
    );
    // Already there: nothing to add.
    await assert.rejects(
      commitInferredRedirects(db, { userId: owner, spaceId, jobs }),
      /already has/,
    );
  });

  it('adds to a draft with other changes without proposing it', async () => {
    await db.deleteFrom('draft_files').execute();
    await db.deleteFrom('drafts').execute();
    const draft = await openDraft(db, { spaceId, userId: owner, baseRef: 'main' });
    await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: 'add',
      path: 'docs/new.md',
      bytes: Buffer.from('# New\n'),
    });
    const before = queued.length;
    assert.deepEqual(await commitInferredRedirects(db, { userId: owner, spaceId, jobs }), {
      added: 1,
      proposed: false,
    });
    assert.equal(queued.length, before);
    assert.deepEqual(
      (await listDraftFiles(db, draft.id)).map((f) => f.path),
      ['docs/new.md', 'oxybook.yml'],
    );
  });
});
