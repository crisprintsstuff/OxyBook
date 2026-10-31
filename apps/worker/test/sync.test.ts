// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { getDraft, listDraftFiles, openDraft, saveDraftFile } from '@oxybook/drafts';
import { type JobQueue, startJobs } from '@oxybook/jobs';
import pg from 'pg';
import { startJobWorker } from '../src/main.js';

const url = process.env.DATABASE_URL;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('worker sync and reconcile', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const bossSchema = `pgboss_test_${randomBytes(6).toString('hex')}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-worker-'));
  // runSpaceSync builds <githubUrl>/<owner>/<repo>.git, so lay the remote out that way.
  const remote = path.join(tmp, 'hub', 'acme', 'docs.git');
  const work = path.join(tmp, 'work');
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId: string;
  let app: JobQueue;
  let stopWorker: () => Promise<void>;
  const lines: string[] = [];
  const pullRequests: { url: string; body: { head: string; base: string; title: string } }[] = [];

  const paths = async () =>
    (await db.selectFrom('pages').select('path').orderBy('path').execute()).map((row) => row.path);

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 4, searchPath: schema });
    await migrateToLatest(db, { schema });
    const org = await db
      .insertInto('orgs')
      .values({ slug: 'acme', name: 'Acme' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const space = await db
      .insertInto('spaces')
      .values({
        org_id: org.id,
        slug: 'docs',
        name: 'Docs',
        repo_owner: 'acme',
        repo_name: 'docs',
        github_installation_id: 1,
        content_root: 'docs',
        default_ref: 'main',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    spaceId = space.id;

    mkdirSync(path.dirname(remote), { recursive: true });
    git(tmp, 'init', '--bare', '--quiet', '-b', 'main', remote);
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(tmp, 'init', '--quiet', '-b', 'main', work);
    mkdirSync(path.join(work, 'docs'), { recursive: true });
    writeFileSync(path.join(work, 'docs/index.md'), '# Home\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'one');
    git(work, 'push', '--quiet', remote, 'main');

    const worker = await startJobWorker(url as string, {
      schema: bossSchema,
      db,
      log: (line) => lines.push(line),
      pollingIntervalSeconds: 0.5,
      tokenFor: async () => undefined,
      githubUrl: `file://${path.join(tmp, 'hub')}`,
      mirrorsDir: path.join(tmp, 'mirrors'),
      sitesDir: path.join(tmp, 'sites'),
      reconcileCron: 'off',
      githubApiBase: 'https://api.github.test',
      publicUrl: 'https://oxybook.test',
      // GitHub's pulls API, recorded: the worker opens the PR through it.
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        pullRequests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ number: 101, html_url: 'https://github.test/acme/docs/pull/101' }),
          { status: 201 },
        );
      }) as typeof fetch,
    });
    stopWorker = worker.stop;
    app = await startJobs(url as string, { schema: bossSchema, log: () => {} });
  });

  after(async () => {
    await app?.stop();
    await stopWorker?.();
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await client.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a sync job brings pages in line with the branch and builds the site', async () => {
    const id = await app.send('sync', { spaceId, ref: 'main', reason: 'manual' });
    assert.ok(id);
    await until(async () => (await app.state('sync', id)) === 'completed');
    assert.deepEqual(await paths(), ['index.md']);

    const siteHome = path.join(
      tmp,
      'sites',
      'by-host',
      'docs.docs.localhost',
      'current',
      'index.html',
    );
    await until(async () => existsSync(siteHome));
    assert.match(readFileSync(siteHome, 'utf8'), /<h1 id="home">Home<\/h1>/);
    const buildRow = await db
      .selectFrom('builds')
      .select(['status', 'version'])
      .where('space_id', '=', spaceId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    assert.equal(buildRow.status, 'succeeded');
    assert.equal(buildRow.version, 'default');
  });

  it('reconcile catches a push whose webhook never arrived and rebuilds the site', async () => {
    writeFileSync(path.join(work, 'docs/missed.md'), '# Missed\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'no webhook for this one');
    git(work, 'push', '--quiet', remote, 'main');
    const head = git(remote, 'rev-parse', 'main').trim();

    const id = await app.send('reconcile', {});
    assert.ok(id);
    await until(async () => (await paths()).includes('missed.md'));
    const state = await db.selectFrom('ref_state').select('head_sha').executeTakeFirstOrThrow();
    assert.equal(state.head_sha, head);
    assert.ok(lines.some((line) => line.includes('reconcile space') && line.includes('sync')));

    const missedHtml = path.join(
      tmp,
      'sites',
      'by-host',
      'docs.docs.localhost',
      'current',
      'missed.html',
    );
    await until(async () => existsSync(missedHtml));
    assert.match(readFileSync(missedHtml, 'utf8'), /<h1 id="missed">Missed<\/h1>/);
  });

  it('a sync that moves the base rebases open drafts with a three-way merge', async () => {
    const page = '# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
    writeFileSync(path.join(work, 'docs/guide.md'), page);
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'add guide');
    git(work, 'push', '--quiet', remote, 'main');
    const first = await app.send('sync', { spaceId, ref: 'main', reason: 'manual' });
    assert.ok(first);
    await until(async () => (await app.state('sync', first)) === 'completed');

    const user = await db
      .insertInto('users')
      .values({ email: 'writer@example.com', name: 'Writer' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const draft = await openDraft(db, { spaceId, userId: user.id });
    const row = await db
      .selectFrom('pages')
      .select('blob_sha')
      .where('path', '=', 'guide.md')
      .executeTakeFirstOrThrow();
    await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: 'modify',
      path: 'docs/guide.md',
      baseBlobSha: row.blob_sha,
      bytes: Buffer.from(page.replace('First paragraph.', 'First paragraph, from the draft.')),
    });

    writeFileSync(
      path.join(work, 'docs/guide.md'),
      page.replace('Third paragraph.', 'Third paragraph, from upstream.'),
    );
    git(work, 'commit', '--quiet', '-am', 'upstream edit');
    git(work, 'push', '--quiet', remote, 'main');
    const head = git(remote, 'rev-parse', 'main').trim();
    const second = await app.send('sync', { spaceId, ref: 'main', reason: 'manual' });
    assert.ok(second);
    await until(async () => (await getDraft(db, draft.id))?.baseSha === head);

    const [file] = await listDraftFiles(db, draft.id);
    assert.equal(
      file?.bytes?.toString(),
      '# Guide\n\nFirst paragraph, from the draft.\n\nSecond paragraph.\n\nThird paragraph, from upstream.\n',
    );
    assert.equal(file?.baseBlobSha, git(remote, 'rev-parse', `${head}:docs/guide.md`).trim());
    assert.equal((await getDraft(db, draft.id))?.state, 'editing');
    assert.ok(
      lines.some((line) => line.includes(`draft ${draft.id} rebased onto ${head.slice(0, 12)}`)),
    );
  });

  it('a propose job pushes an oxybook/* branch and opens the pull request', async () => {
    const space = await db
      .selectFrom('spaces')
      .select('org_id')
      .where('id', '=', spaceId)
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto('users')
      .values({ email: 'editor@example.com', name: 'Eda Editor' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('org_members')
      .values({ org_id: space.org_id, user_id: user.id, role: 'member' })
      .execute();
    await db
      .insertInto('space_members')
      .values({ org_id: space.org_id, space_id: spaceId, user_id: user.id, role: 'editor' })
      .execute();
    const draft = await openDraft(db, { spaceId, userId: user.id });
    const base = await db
      .selectFrom('pages')
      .select('blob_sha')
      .where('path', '=', 'index.md')
      .executeTakeFirstOrThrow();
    await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: 'modify',
      path: 'docs/index.md',
      baseBlobSha: base.blob_sha,
      bytes: Buffer.from('# Home\n\nProposed from OxyBook.\n'),
    });

    const id = await app.send('propose', {
      draftId: draft.id,
      userId: user.id,
      title: 'Say hello',
      signOff: false,
    });
    assert.ok(id);
    await until(async () => (await app.state('propose', id)) === 'completed');

    const after = await getDraft(db, draft.id);
    assert.equal(after?.state, 'proposed', after?.proposeError ?? '');
    assert.equal(after?.prUrl, 'https://github.test/acme/docs/pull/101');
    const branch = after?.branch as string;
    assert.match(branch, /^oxybook\/eda-editor\/index-[0-9a-f]{8}$/);
    assert.equal(git(remote, 'diff', '--name-only', 'main', branch).trim(), 'docs/index.md');
    assert.equal(
      git(remote, 'show', `${branch}:docs/index.md`),
      '# Home\n\nProposed from OxyBook.\n',
    );
    assert.match(
      git(remote, 'log', '-1', '--format=%ae', branch).trim(),
      /@users\.noreply\.oxybook\.test$/,
    );
    assert.deepEqual(
      {
        url: pullRequests[0]?.url,
        head: pullRequests[0]?.body.head,
        base: pullRequests[0]?.body.base,
        title: pullRequests[0]?.body.title,
      },
      {
        url: 'https://api.github.test/repos/acme/docs/pulls',
        head: branch,
        base: 'main',
        title: 'Say hello',
      },
    );
    assert.ok(lines.some((line) => line.includes(`draft ${draft.id} proposed (new)`)));
  });
});
