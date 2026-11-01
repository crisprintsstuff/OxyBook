// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { createSession, SESSION_COOKIE_NAME, signUpUser } from '../src/auth.js';
import { createEditorApi } from '../src/editor-api.js';

const url = process.env.DATABASE_URL;
const PAGE = '# Guide\n\nRead the [install page](install.md) and the [missing one](nope.md).\n';
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

describe('editor API', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let server: Server;
  let base = '';
  const queued: { queue: string; data: unknown; key: string | undefined }[] = [];
  const users: Record<
    'editor' | 'second' | 'viewer' | 'outsider',
    { cookie: string; csrf: string }
  > = {} as never;

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 3, searchPath: schema });
    await migrateToLatest(db, { schema });
    const org = await db
      .insertInto('orgs')
      .values({ slug: 'cris', name: 'Cris' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const space = await db
      .insertInto('spaces')
      .values({
        org_id: org.id,
        slug: 'test',
        name: 'Test',
        content_root: 'docs',
        default_ref: 'main',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('ref_state')
      .values({ org_id: org.id, space_id: space.id, ref: 'main', head_sha: 'a'.repeat(40) })
      .execute();
    for (const [path, text, title, page] of [
      ['guide.md', PAGE, 'Guide', '/guide'],
      ['install.md', '# Install\n', 'Install', '/install'],
    ] as const) {
      await db
        .insertInto('blobs')
        .values({ org_id: org.id, sha: sha1(text), bytes: Buffer.from(text) })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await db
        .insertInto('pages')
        .values({
          org_id: org.id,
          space_id: space.id,
          ref: 'main',
          path,
          blob_sha: sha1(text),
          title,
          url: page,
          nav_title: null,
        })
        .execute();
    }
    for (const [key, role] of [
      ['editor', 'editor'],
      ['second', 'editor'],
      ['viewer', 'viewer'],
      ['outsider', null],
    ] as const) {
      const user = await signUpUser(db, {
        email: `${key}@example.com`,
        name: key,
        password: 'password-1234',
      });
      if (role) {
        await db
          .insertInto('org_members')
          .values({ org_id: org.id, user_id: user.id, role: 'member' })
          .onConflict((oc) => oc.doNothing())
          .execute();
        await db
          .insertInto('space_members')
          .values({ org_id: org.id, space_id: space.id, user_id: user.id, role })
          .onConflict((oc) => oc.columns(['space_id', 'user_id']).doUpdateSet({ role }))
          .execute();
      } else {
        // The first sign-up adopts memberless orgs; make sure the outsider is not a member.
        await db.deleteFrom('space_members').where('user_id', '=', user.id).execute();
        await db.deleteFrom('org_members').where('user_id', '=', user.id).execute();
      }
      const session = await createSession(db, user.id);
      users[key] = { cookie: `${SESSION_COOKIE_NAME}=${session.token}`, csrf: '' };
    }
    const api = createEditorApi({
      db,
      secretKey: 'editor-api-test-secret',
      jobs: {
        async send(queue, data, options) {
          queued.push({ queue, data, key: options?.singletonKey });
          return `job-${queued.length}`;
        },
      },
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
    for (const key of ['editor', 'second', 'viewer'] as const) {
      const tree = (await (
        await fetch(`${base}/tree`, { headers: { cookie: users[key].cookie } })
      ).json()) as { csrfToken: string };
      users[key].csrf = tree.csrfToken;
    }
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  const call = (
    who: keyof typeof users,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}/${path}`, {
      method,
      headers: {
        cookie: users[who].cookie,
        'x-csrf-token': users[who].csrf,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined
        ? {
            body:
              typeof body === 'string' || body instanceof Uint8Array
                ? (body as string)
                : JSON.stringify(body),
          }
        : {}),
    });

  it('needs a session and a role; viewers read, editors write, writes need CSRF', async () => {
    assert.equal((await fetch(`${base}/tree`)).status, 401);
    assert.equal(
      (await call('outsider', 'GET', 'tree')).status,
      404,
      'a non-member cannot tell the space exists',
    );
    assert.equal(
      (
        await fetch(`${base.replace('/test', '/nope')}/tree`, {
          headers: { cookie: users.editor.cookie },
        })
      ).status,
      404,
    );
    const tree = (await (await call('viewer', 'GET', 'tree')).json()) as {
      role: string;
      pages: { path: string; title: string }[];
    };
    assert.equal(tree.role, 'viewer');
    assert.deepEqual(
      tree.pages.map((p) => [p.path, p.title]),
      [
        ['docs/guide.md', 'Guide'],
        ['docs/install.md', 'Install'],
      ],
    );
    assert.equal((await call('viewer', 'GET', 'page?path=docs/guide.md')).status, 200);
    const viewerWrite = await call('viewer', 'POST', 'draft', {});
    assert.equal(viewerWrite.status, 403);
    assert.match(((await viewerWrite.json()) as { error: string }).error, /editor or admin/);
    const noCsrf = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { cookie: users.editor.cookie },
    });
    assert.equal(noCsrf.status, 403);
  });

  let version = 0;
  it('opens a draft and autosaves with If-Match; a stale or missing version is refused', async () => {
    const opened = (await (await call('editor', 'POST', 'draft', {})).json()) as {
      draft: { version: number; state: string };
    };
    assert.equal(opened.draft.state, 'editing');
    version = opened.draft.version;
    const page = (await (await call('editor', 'GET', 'page?path=docs/guide.md')).json()) as {
      source: string;
      baseBlobSha: string;
      fromDraft: boolean;
    };
    assert.deepEqual([page.source, page.fromDraft], [PAGE, false]);
    const edited = PAGE.replace('Read the', 'First, read the');
    const file = {
      op: 'modify',
      path: 'docs/guide.md',
      baseBlobSha: page.baseBlobSha,
      content: edited,
    };
    const saved = await call('editor', 'PUT', 'draft/file', file, { 'if-match': String(version) });
    assert.equal(saved.status, 200);
    version = ((await saved.json()) as { version: number }).version;
    const stale = await call(
      'editor',
      'PUT',
      'draft/file',
      { ...file, content: 'other tab' },
      { 'if-match': String(version - 1) },
    );
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { current: number }).current, version);
    assert.equal((await call('editor', 'PUT', 'draft/file', file)).status, 428);
    const reloaded = (await (await call('editor', 'GET', 'page?path=docs/guide.md')).json()) as {
      source: string;
      fromDraft: boolean;
    };
    assert.deepEqual([reloaded.source, reloaded.fromDraft], [edited, true]);
  });

  it('diffs the draft, previews with the build renderer, and uploads an image', async () => {
    const diff = (await (await call('editor', 'GET', 'draft/diff')).json()) as {
      files: { path: string; patch: string }[];
    };
    assert.equal(diff.files[0]?.path, 'docs/guide.md');
    assert.match(diff.files[0]?.patch ?? '', /^-Read the \[install page\]/m);
    assert.match(diff.files[0]?.patch ?? '', /^\+First, read the \[install page\]/m);

    const preview = (await (
      await call('viewer', 'POST', 'preview', {
        path: 'docs/guide.md',
        content: '# Hello\n\n<Unknown />\n\n[x](nope.md)\n',
      })
    ).json()) as {
      html: string;
      warnings: { reason?: string }[];
    };
    assert.match(preview.html, /<h1[^>]*>Hello<\/h1>/);
    assert.ok(preview.warnings.length >= 1, 'placeholders and broken links come back as warnings');

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const upload = await fetch(`${base}/upload?path=docs/images/shot.png`, {
      method: 'POST',
      headers: {
        cookie: users.editor.cookie,
        'x-csrf-token': users.editor.csrf,
        'if-match': String(version),
      },
      body: png,
    });
    assert.equal(upload.status, 200);
    version = ((await upload.json()) as { version: number }).version;
    const notImage = await fetch(`${base}/upload?path=docs/run.sh`, {
      method: 'POST',
      headers: {
        cookie: users.editor.cookie,
        'x-csrf-token': users.editor.csrf,
        'if-match': String(version),
      },
      body: 'echo',
    });
    assert.equal(notImage.status, 400);
  });

  it('shows who else is editing a page', async () => {
    const opened = (await (await call('second', 'POST', 'draft', {})).json()) as {
      draft: { version: number };
    };
    const page = (await (await call('second', 'GET', 'page?path=docs/guide.md')).json()) as {
      baseBlobSha: string;
      othersEditing: string[];
    };
    assert.deepEqual(page.othersEditing, ['editor']);
    await call(
      'second',
      'PUT',
      'draft/file',
      { op: 'modify', path: 'docs/guide.md', baseBlobSha: page.baseBlobSha, content: 'x' },
      { 'if-match': String(opened.draft.version) },
    );
    const tree = (await (await call('editor', 'GET', 'tree')).json()) as {
      pages: { path: string; othersEditing: string[] }[];
    };
    assert.deepEqual(tree.pages.find((p) => p.path === 'docs/guide.md')?.othersEditing, ['second']);
  });

  it('queues a propose, needs a title, and discards a draft', async () => {
    assert.equal((await call('editor', 'POST', 'draft/propose', { title: '  ' })).status, 400);
    const proposed = await call('editor', 'POST', 'draft/propose', {
      title: 'Edit the guide',
      signOff: true,
    });
    assert.equal(proposed.status, 202);
    assert.equal(queued[0]?.queue, 'propose');
    const job = queued[0]?.data as { title?: string; signOff?: boolean } | undefined;
    assert.deepEqual(
      { title: job?.title, signOff: job?.signOff },
      { title: 'Edit the guide', signOff: true },
    );
    assert.match(queued[0]?.key ?? '', /^propose:/);
    const discarded = await call('second', 'POST', 'draft/discard', {}, { 'if-match': '2' });
    assert.equal(((await discarded.json()) as { draft: { state: string } }).draft.state, 'closed');
    const after = (await (await call('second', 'GET', 'draft')).json()) as { draft: unknown };
    assert.equal(after.draft, null);
  });
});
