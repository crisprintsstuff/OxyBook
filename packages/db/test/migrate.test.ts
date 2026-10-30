// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Kysely, sql } from 'kysely';
import { createDb } from '../src/connect.js';
import { migrateToLatest } from '../src/migrate.js';
import type { Database } from '../src/schema.js';

const url = process.env.DATABASE_URL;
const sha = (char: string) => char.repeat(40);

// Needs a real PostgreSQL. CI starts one; locally, set DATABASE_URL or the suite is skipped.
describe('schema v0 migrations', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 2, searchPath: schema });
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('applies every migration once, then is a no-op', async () => {
    assert.deepEqual(await migrateToLatest(db, { schema }), {
      applied: ['0001_schema_v0', '0002_github_app', '0003_sync'],
    });
    assert.deepEqual(await migrateToLatest(db, { schema }), { applied: [] });
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = ${schema} and table_name not like 'kysely_%'
      order by table_name`.execute(db);
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        'blobs',
        'draft_files',
        'drafts',
        'github_app',
        'inferred_redirects',
        'org_members',
        'orgs',
        'pages',
        'ref_state',
        'sessions',
        'space_members',
        'spaces',
        'users',
        'webhook_deliveries',
      ],
    );
  });

  it('stores a page, a draft, and exact bytes', async () => {
    const org = await db
      .insertInto('orgs')
      .values({ slug: 'acme', name: 'Acme' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto('users')
      .values({ email: 'Writer@Example.com', name: 'Writer' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('org_members')
      .values({ org_id: org.id, user_id: user.id, role: 'owner' })
      .execute();
    const space = await db
      .insertInto('spaces')
      .values({ org_id: org.id, slug: 'docs', name: 'Docs', repo_owner: 'acme', repo_name: 'd' })
      .returning(['id', 'default_ref', 'content_root'])
      .executeTakeFirstOrThrow();
    assert.equal(space.default_ref, 'main');
    assert.equal(space.content_root, '');
    await db
      .insertInto('space_members')
      .values({ org_id: org.id, space_id: space.id, user_id: user.id, role: 'admin' })
      .execute();

    const bytes = Buffer.from('﻿# Title\r\n\r\nBody\n', 'utf8');
    await db
      .insertInto('blobs')
      .values({ org_id: org.id, sha: sha('a'), bytes })
      .execute();
    await db
      .insertInto('ref_state')
      .values({ org_id: org.id, space_id: space.id, ref: 'main', head_sha: sha('b') })
      .execute();
    await db
      .insertInto('pages')
      .values({
        org_id: org.id,
        space_id: space.id,
        ref: 'main',
        path: 'guides/install.md',
        blob_sha: sha('a'),
        title: 'Install',
        url: '/guides/install',
        nav_title: null,
        tsv: sql<string>`to_tsvector('english', 'Install the thing')`,
      })
      .execute();
    const blob = await db
      .selectFrom('blobs')
      .select('bytes')
      .where('sha', '=', sha('a'))
      .executeTakeFirstOrThrow();
    assert.ok(blob.bytes.equals(bytes), 'blob bytes must round-trip exactly');
    const hit = await db
      .selectFrom('pages')
      .select('path')
      .where(sql<boolean>`tsv @@ plainto_tsquery('english', 'installing')`)
      .execute();
    assert.deepEqual(hit, [{ path: 'guides/install.md' }]);

    const draft = await db
      .insertInto('drafts')
      .values({
        org_id: org.id,
        space_id: space.id,
        user_id: user.id,
        base_ref: 'main',
        base_sha: sha('b'),
      })
      .returning(['id', 'state', 'version'])
      .executeTakeFirstOrThrow();
    assert.equal(draft.state, 'editing');
    assert.equal(draft.version, 1);
    await db
      .insertInto('draft_files')
      .values({
        org_id: org.id,
        draft_id: draft.id,
        path: 'guides/install.md',
        op: 'modify',
        old_path: null,
        base_blob_sha: sha('a'),
        bytes: Buffer.from('# Title\n'),
      })
      .execute();

    // Constraints the application will rely on.
    await assert.rejects(
      db.insertInto('users').values({ email: 'writer@example.COM', name: 'Dup' }).execute(),
      /users_email_lower/,
      'emails are unique case-insensitively',
    );
    await assert.rejects(
      db
        .insertInto('drafts')
        .values({
          org_id: org.id,
          space_id: space.id,
          user_id: user.id,
          base_ref: 'main',
          base_sha: sha('b'),
        })
        .execute(),
      /drafts_one_open/,
      'one open draft per user, space and base ref',
    );
    await assert.rejects(
      db.updateTable('drafts').set({ branch: 'main' }).where('id', '=', draft.id).execute(),
      /drafts_branch_check/,
      'a draft branch must be oxybook/*',
    );
    await assert.rejects(
      db
        .insertInto('draft_files')
        .values({
          org_id: org.id,
          draft_id: draft.id,
          path: 'gone.md',
          op: 'delete',
          old_path: null,
          base_blob_sha: sha('a'),
          bytes: Buffer.from('x'),
        })
        .execute(),
      /draft_files_check/,
      'a delete carries no bytes',
    );
    await assert.rejects(
      db
        .insertInto('spaces')
        .values({ org_id: org.id, slug: 'escape', name: 'x', content_root: '../etc' })
        .execute(),
      /spaces_content_root_check/,
      'content_root cannot climb out of the repo',
    );

    const other = await db
      .insertInto('orgs')
      .values({ slug: 'other', name: 'Other' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await assert.rejects(
      db
        .insertInto('ref_state')
        .values({ org_id: other.id, space_id: space.id, ref: 'dev', head_sha: sha('c') })
        .execute(),
      /foreign key/,
      'a row cannot point at another org’s space',
    );
  });

  it('rolls back every pending file when one fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxybook-migrations-'));
    const broken = `${schema}_broken`;
    const scoped = createDb(url as string, { max: 1, searchPath: broken });
    try {
      await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE kept_if_committed (id int);');
      await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE nope (id no_such_type);');
      await sql.raw(`CREATE SCHEMA ${broken}`).execute(admin);
      await assert.rejects(
        migrateToLatest(scoped, { dir, schema: broken }),
        /migration 0002_bad failed: type "no_such_type" does not exist/,
      );
      const left = await sql<{ n: number }>`
        select count(*)::int as n from information_schema.tables
        where table_schema = ${broken} and table_name = 'kept_if_committed'`.execute(admin);
      assert.equal(left.rows[0]?.n, 0);
    } finally {
      await scoped.destroy();
      await sql.raw(`DROP SCHEMA IF EXISTS ${broken} CASCADE`).execute(admin);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
