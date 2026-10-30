// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
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
});
