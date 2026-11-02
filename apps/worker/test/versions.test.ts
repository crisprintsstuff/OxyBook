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

/**
 * Versions in sync and build (docs/M3-PLAN.md slice 5): a space with the default branch,
 * a release branch and a tag builds each version from its own ref, the switcher links
 * each page to the same page in the other versions, a push to the release branch rebuilds
 * only that version, and a version removed from the list stops being served.
 */

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

async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const VERSIONS = `title: Docs
versions:
  - name: latest
    ref: main
  - name: 1.x
    ref: release/1.x
  - name: "0.9"
    ref: v0.9.0
`;

/** The switcher's options on a page, as [name, url, selected]. */
function switcher(html: string): [string, string, boolean][] {
  const select = html.match(/<select[^>]*data-version-switcher[^>]*>(.*?)<\/select>/s)?.[1] ?? '';
  return [...select.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [
    m[3] as string,
    m[1] as string,
    m[2] !== undefined,
  ]);
}

describe('versions: sync and build', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const bossSchema = `pgboss_test_${randomBytes(6).toString('hex')}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-versions-'));
  const remote = path.join(tmp, 'hub', 'acme', 'docs.git');
  const work = path.join(tmp, 'work');
  const site = path.join(tmp, 'sites', 'by-host', 'docs.docs.localhost', 'current');
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId: string;
  let app: JobQueue;
  let stopWorker: () => Promise<void>;
  const lines: string[] = [];

  const succeeded = async (version: string) =>
    (
      await db
        .selectFrom('builds')
        .select('id')
        .where('space_id', '=', spaceId)
        .where('version', '=', version)
        .where('status', '=', 'succeeded')
        .execute()
    ).length;
  const page = (rel: string) => readFileSync(path.join(site, rel), 'utf8');
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      writeFileSync(path.join(work, file), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', message);
  };

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

    // v0.9.0: an annotated tag on the oldest commit.
    commit({ 'docs/index.md': '# Nine home\n' }, 'nine');
    git(work, 'tag', '-a', 'v0.9.0', '-m', 'v0.9.0');
    // release/1.x: has old.md, never gets new.md.
    commit({ 'docs/index.md': '# One home\n', 'docs/old.md': '# Old page\n' }, 'one');
    git(work, 'branch', 'release/1.x');
    // main: lists the versions, has new.md and not old.md.
    git(work, 'rm', '--quiet', 'docs/old.md');
    commit(
      {
        'docs/index.md': '# Latest home\n',
        'docs/new.md': '# New page\n',
        'oxybook.yml': VERSIONS,
      },
      'latest',
    );
    git(work, 'push', '--quiet', remote, 'main', 'release/1.x', 'refs/tags/v0.9.0');

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

  it('syncing the default branch publishes every listed version from its own ref', async () => {
    await app.send('sync', { spaceId, ref: 'main', reason: 'manual' });
    await until(
      async () =>
        (await succeeded('default')) >= 1 &&
        (await succeeded('1.x')) >= 1 &&
        (await succeeded('0.9')) >= 1,
    );

    const versions = await db
      .selectFrom('space_versions')
      .select(['name', 'ref', 'is_default'])
      .where('space_id', '=', spaceId)
      .orderBy('position')
      .execute();
    assert.deepEqual(versions, [
      { name: 'latest', ref: 'main', is_default: true },
      { name: '1.x', ref: 'release/1.x', is_default: false },
      { name: '0.9', ref: 'refs/tags/v0.9.0', is_default: false },
    ]);

    // Each version's pages come from its own ref.
    assert.match(page('index.html'), /Latest home/);
    assert.match(page('new.html'), /New page/);
    assert.match(page('1.x/index.html'), /One home/);
    assert.match(page('1.x/old.html'), /Old page/);
    assert.equal(existsSync(path.join(site, '1.x/new.html')), false);
    assert.match(page('0.9/index.html'), /Nine home/);
    assert.equal(existsSync(path.join(site, 'old.html')), false);
    // Search is built per version, inside its prefix.
    assert.ok(existsSync(path.join(site, 'pagefind')));
    assert.ok(existsSync(path.join(site, '1.x/pagefind')));

    // The switcher: the same page in the other versions, or that version's root.
    assert.deepEqual(switcher(page('new.html')), [
      ['latest', '/new', true],
      ['1.x', '/1.x/', false],
      ['0.9', '/0.9/', false],
    ]);
    assert.deepEqual(switcher(page('1.x/old.html')), [
      ['latest', '/', false],
      ['1.x', '/1.x/old', true],
      ['0.9', '/0.9/', false],
    ]);
    assert.deepEqual(switcher(page('0.9/index.html')), [
      ['latest', '/', false],
      ['1.x', '/1.x/', false],
      ['0.9', '/0.9/', true],
    ]);
  });

  it('a push to the release branch rebuilds only that version', async () => {
    const before = {
      default: await succeeded('default'),
      '1.x': await succeeded('1.x'),
      '0.9': await succeeded('0.9'),
    };
    git(work, 'checkout', '--quiet', 'release/1.x');
    commit({ 'docs/old.md': '# Old page, patched\n' }, 'patch 1.x');
    git(work, 'push', '--quiet', remote, 'release/1.x');
    git(work, 'checkout', '--quiet', 'main');

    await app.send('sync', { spaceId, ref: 'release/1.x', reason: 'push' });
    await until(async () => (await succeeded('1.x')) > before['1.x']);
    assert.match(page('1.x/old.html'), /Old page, patched/);
    assert.match(page('index.html'), /Latest home/);
    assert.match(page('0.9/index.html'), /Nine home/);
    // Give any stray build a moment to show up before counting.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await succeeded('default'), before.default);
    assert.equal(await succeeded('0.9'), before['0.9']);
  });

  it('reconciliation leaves a tag alone until it is re-pointed, then rebuilds that version', async () => {
    const before = await succeeded('0.9');
    const quiet = await app.send('reconcile', {});
    assert.ok(quiet);
    await until(async () => (await app.state('reconcile', quiet)) === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await succeeded('0.9'), before, 'an unmoved tag is not synced again');

    git(work, 'checkout', '--quiet', 'v0.9.0');
    commit({ 'docs/index.md': '# Nine home, re-tagged\n' }, 'nine again');
    git(work, 'tag', '-f', '-a', 'v0.9.0', '-m', 'v0.9.0 again');
    git(work, 'checkout', '--quiet', 'main');
    git(work, 'push', '--quiet', '--force', remote, 'refs/tags/v0.9.0');

    await app.send('reconcile', {});
    await until(async () => (await succeeded('0.9')) > before);
    assert.match(page('0.9/index.html'), /Nine home, re-tagged/);
  });

  it('a version removed from versions: stops being served', async () => {
    const before = await succeeded('default');
    commit(
      { 'oxybook.yml': VERSIONS.replace(/ {2}- name: "0\.9"\n {4}ref: v0\.9\.0\n/, '') },
      'drop 0.9',
    );
    git(work, 'push', '--quiet', remote, 'main');

    await app.send('sync', { spaceId, ref: 'main', reason: 'push' });
    await until(async () => (await succeeded('default')) > before);
    assert.equal(existsSync(path.join(site, '0.9')), false);
    assert.match(page('1.x/index.html'), /One home/);
    assert.deepEqual(
      switcher(page('index.html')).map(([name]) => name),
      ['latest', '1.x'],
    );
  });
});
