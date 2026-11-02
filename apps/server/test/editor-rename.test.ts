// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { createSession, SESSION_COOKIE_NAME, signUpUser } from '../src/auth.js';
import { createEditorApi } from '../src/editor-api.js';

const url = process.env.DATABASE_URL;
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const GUIDE = '# Guide\n\nFirst [install it](install.md#steps).\n';
const INSTALL = '# Install\n\nBack to the [guide](guide.md).\n';
const OLD = 'a'.repeat(40);

describe('editor API: rename', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let server: Server;
  let base = '';
  let cookie = '';
  let csrf = '';
  let orgId = '';
  let spaceId = '';

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/${path}`, {
      method,
      headers: {
        cookie,
        // Like the browser: the CSRF token goes on writes only.
        ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const putBlob = (text: string) =>
    db
      .insertInto('blobs')
      .values({ org_id: orgId, sha: sha1(text), bytes: Buffer.from(text) })
      .onConflict((oc) => oc.doNothing())
      .execute();

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 3, searchPath: schema });
    await migrateToLatest(db, { schema });
    orgId = (
      await db
        .insertInto('orgs')
        .values({ slug: 'cris', name: 'Cris' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    spaceId = (
      await db
        .insertInto('spaces')
        .values({
          org_id: orgId,
          slug: 'test',
          name: 'Test',
          content_root: 'docs',
          default_ref: 'main',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('ref_state')
      .values({ org_id: orgId, space_id: spaceId, ref: 'main', head_sha: OLD })
      .execute();
    for (const [path, text, title, page] of [
      ['guide.md', GUIDE, 'Guide', '/guide'],
      ['install.md', INSTALL, 'Install', '/install'],
    ] as const) {
      await putBlob(text);
      await db
        .insertInto('pages')
        .values({
          org_id: orgId,
          space_id: spaceId,
          ref: 'main',
          path,
          blob_sha: sha1(text),
          title,
          url: page,
          nav_title: null,
        })
        .execute();
    }
    const user = await signUpUser(db, {
      email: 'e@example.com',
      name: 'Edie',
      password: 'password-1234',
    });
    await db
      .insertInto('space_members')
      .values({ org_id: orgId, space_id: spaceId, user_id: user.id, role: 'editor' })
      .onConflict((oc) => oc.columns(['space_id', 'user_id']).doUpdateSet({ role: 'editor' }))
      .execute();
    cookie = `${SESSION_COOKIE_NAME}=${(await createSession(db, user.id)).token}`;
    const api = createEditorApi({
      db,
      secretKey: 'editor-conflicts-test',
      jobs: { send: async () => 'job-1' },
    });
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      if (!(await api.handle(request, response, Buffer.concat(chunks)))) {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}/api/editor/cris/test`;
    csrf = ((await (await call('GET', 'tree')).json()) as { csrfToken: string }).csrfToken;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('renames a page into one draft change: move, links, and redirect', async () => {
    const opened = (await (await call('POST', 'draft', {})).json()) as {
      draft: { version: number };
    };
    const rename = (version: number) =>
      call(
        'POST',
        'draft/rename',
        { from: 'docs/install.md', to: 'docs/setup/install.md' },
        { 'if-match': String(version) },
      );
    // Synced before oxybook.yml was recorded: ask for one sync first.
    const early = await rename(opened.draft.version);
    assert.equal(early.status, 409);
    assert.match(((await early.json()) as { error: string }).error, /sync the space once/);
    await db.updateTable('ref_state').set({ config_blob_sha: 'none' }).execute();

    const done = await rename(opened.draft.version);
    assert.equal(done.status, 200);
    const report = (await done.json()) as {
      version: number;
      redirect: { from: string; to: string };
      patched: { path: string; links: number }[];
    };
    assert.deepEqual(report.redirect, { from: '/install', to: '/setup/install' });
    assert.deepEqual(report.patched.map((p) => p.path).sort(), [
      'docs/guide.md',
      'docs/setup/install.md',
    ]);
    assert.equal(report.version, opened.draft.version + 1);

    const files = await db
      .selectFrom('draft_files')
      .select(['path', 'op', 'old_path', 'bytes'])
      .orderBy('path')
      .execute();
    assert.deepEqual(
      files.map((f) => [f.path, f.op, f.old_path]),
      [
        ['docs/guide.md', 'modify', null],
        ['docs/setup/install.md', 'rename', 'docs/install.md'],
        ['oxybook.yml', 'add', null],
      ],
    );
    assert.equal(
      files[0]?.bytes?.toString(),
      GUIDE.replace('(install.md#steps)', '(setup/install.md#steps)'),
    );
    assert.equal(files[1]?.bytes?.toString(), INSTALL.replace('(guide.md)', '(../guide.md)'));
    assert.equal(
      files[2]?.bytes?.toString(),
      'redirects:\n  - from: /install\n    to: /setup/install\n',
    );

    const page = (await (await call('GET', 'page?path=docs/setup/install.md')).json()) as {
      source: string;
    };
    assert.equal(page.source, INSTALL.replace('(guide.md)', '(../guide.md)'));
    // A second rename onto a taken path is refused; nothing changes.
    const taken = await call(
      'POST',
      'draft/rename',
      { from: 'docs/guide.md', to: 'docs/setup/install.md' },
      { 'if-match': String(report.version) },
    );
    assert.equal(taken.status, 400);
  });
});
