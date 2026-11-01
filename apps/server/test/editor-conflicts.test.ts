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
const PAGE = '# Guide\n\nalpha\n\nbeta\n\ngamma\n';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

describe('editor API: conflicts', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
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
    await putBlob(PAGE);
    await db
      .insertInto('pages')
      .values({
        org_id: orgId,
        space_id: spaceId,
        ref: 'main',
        path: 'guide.md',
        blob_sha: sha1(PAGE),
        title: 'Guide',
        url: '/guide',
        nav_title: null,
      })
      .execute();
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

  it('shows a conflict from the read model, refuses stale input, resolves, and blocks propose until then', async () => {
    const opened = (await (await call('POST', 'draft', {})).json()) as {
      draft: { version: number };
    };
    const saved = await call(
      'PUT',
      'draft/file',
      {
        op: 'modify',
        path: 'docs/guide.md',
        baseBlobSha: sha1(PAGE),
        content: PAGE.replace('beta', 'beta draft'),
      },
      { 'if-match': String(opened.draft.version) },
    );
    assert.equal(saved.status, 200);

    // Upstream edits the same paragraph; sync updates the read model and the rebase marks the draft.
    const upstream = PAGE.replace('beta', 'beta upstream');
    await putBlob(upstream);
    await db
      .updateTable('pages')
      .set({ blob_sha: sha1(upstream) })
      .where('space_id', '=', spaceId)
      .execute();
    await db
      .updateTable('ref_state')
      .set({ head_sha: NEW })
      .where('space_id', '=', spaceId)
      .execute();
    await db.updateTable('drafts').set({ state: 'conflicted' }).execute();

    assert.equal((await call('POST', 'draft/propose', { title: 'x' })).status, 409);

    const view = (await (await call('GET', 'draft/conflicts')).json()) as {
      version: number;
      head: string;
      files: {
        path: string;
        kind: string;
        conflicts: number;
        regions: { kind: string; mine?: string; theirs?: string }[];
      }[];
    };
    assert.equal(view.head, NEW);
    assert.equal(view.files.length, 1);
    assert.equal(view.files[0]?.path, 'docs/guide.md');
    assert.equal(view.files[0]?.conflicts, 1);
    assert.deepEqual(
      view.files[0]?.regions.filter((r) => r.kind === 'conflict').map((r) => [r.mine, r.theirs]),
      [['\n\nbeta draft', '\n\nbeta upstream']],
    );

    const resolve = (ifMatch: number, head: string, resolutions: unknown) =>
      call('POST', 'draft/resolve', { head, resolutions }, { 'if-match': String(ifMatch) });
    const moved = await resolve(view.version, OLD, []);
    assert.equal(moved.status, 409);
    assert.equal(((await moved.json()) as { head: string }).head, NEW);
    assert.equal((await resolve(view.version - 1, NEW, [])).status, 409);
    assert.equal((await resolve(view.version, NEW, [])).status, 400);
    assert.equal(
      (await resolve(view.version, NEW, [{ path: 'docs/guide.md', choices: ['nope'] }])).status,
      400,
    );

    const done = await resolve(view.version, NEW, [
      { path: 'docs/guide.md', choices: [{ text: '\n\nbeta, both' }] },
    ]);
    assert.equal(done.status, 200);
    const draft = ((await done.json()) as { draft: { state: string } }).draft;
    assert.equal(draft.state, 'editing');
    const page = (await (await call('GET', 'page?path=docs/guide.md')).json()) as {
      source: string;
      baseBlobSha: string;
    };
    assert.equal(page.source, PAGE.replace('beta', 'beta, both'));
    assert.equal(page.baseBlobSha, sha1(upstream));
    assert.equal((await call('POST', 'draft/propose', { title: 'x' })).status, 202);
    const empty = (await (await call('GET', 'draft/conflicts')).json()) as { files: unknown[] };
    assert.deepEqual(empty.files, []);
  });
});
