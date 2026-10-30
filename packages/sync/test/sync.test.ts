// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import { isPagePath, relativeToRoot } from '../src/pages.js';
import { type SyncTarget, syncSpace } from '../src/sync.js';

const url = process.env.DATABASE_URL;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // A machine's ~/.gitconfig (push.negotiate, signing, hooks) must not change the fixture.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

function write(work: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    writeFileSync(path.join(work, name), text);
  }
}

/** Page paths under docs/ at a commit, from git itself: what `pages` must equal. */
function pagesInGit(remote: string, commit: string): string[] {
  return git(remote, 'ls-tree', '-r', '--name-only', commit, '--', 'docs')
    .split('\n')
    .filter(Boolean)
    .map((p) => relativeToRoot(p, 'docs'))
    .filter((p): p is string => p !== null && isPagePath(p))
    .sort();
}

describe('sync', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-sync-'));
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const mirrorDir = path.join(tmp, 'mirror.git');
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let target: SyncTarget;
  const source = { mirrorDir, remoteUrl: `file://${remote}` };

  const pagesInDb = async () =>
    (
      await db
        .selectFrom('pages')
        .select('path')
        .where('space_id', '=', target.spaceId)
        .orderBy('path')
        .execute()
    ).map((row) => row.path);

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
      .values({ org_id: org.id, slug: 's', name: 'S', content_root: 'docs', default_ref: 'main' })
      .returning('id')
      .executeTakeFirstOrThrow();
    target = { orgId: org.id, spaceId: space.id, contentRoot: 'docs', ref: 'main' };

    git(tmp, 'init', '--bare', '--quiet', '-b', 'main', remote);
    // GitHub serves partial clones; a local bare repo must be told to.
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(tmp, 'init', '--quiet', '-b', 'main', work);
    write(work, {
      'README.md': '# Repo readme, outside the content root\n',
      'docs/index.md': '---\ntitle: Home\n---\n\n# Welcome\n',
      'docs/a.md': '# Page A\n\nSearchable words here.\n',
      'docs/guides/install.md': '# Install\n\nSteps.\n',
      'docs/guides/_dir.yml': 'title: Guides\n',
      'docs/_partials/footer.md': 'never a page\n',
      'docs/guides/images/x.png': 'not a page\n',
    });
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'one');
    git(work, 'push', '--quiet', remote, 'main');
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('first sync stores every page and nothing else', async () => {
    const result = await syncSpace(db, target, source);
    const head = git(remote, 'rev-parse', 'main').trim();
    assert.equal(result.from, null);
    assert.equal(result.to, head);
    assert.deepEqual(result.added.sort(), ['a.md', 'guides/install.md', 'index.md']);
    assert.deepEqual(await pagesInDb(), pagesInGit(remote, head));
    const rows = await db
      .selectFrom('pages')
      .select(['path', 'url', 'title'])
      .orderBy('path')
      .execute();
    assert.deepEqual(rows, [
      { path: 'a.md', url: '/a', title: 'Page A' },
      { path: 'guides/install.md', url: '/guides/install', title: 'Install' },
      { path: 'index.md', url: '/', title: 'Home' },
    ]);
    const state = await db.selectFrom('ref_state').select('head_sha').executeTakeFirstOrThrow();
    assert.equal(state.head_sha, head);
    const hit = await db
      .selectFrom('pages')
      .select('path')
      .where(sql<boolean>`tsv @@ plainto_tsquery('english', 'searchable')`)
      .execute();
    assert.deepEqual(hit, [{ path: 'a.md' }]);
  });

  it('applies an edit, a rename, a delete, and an add, and records the redirect', async () => {
    write(work, {
      'docs/index.md': '---\ntitle: Home again\n---\n\n# Welcome\n',
      'docs/b.mdx': '---\nslug: bee\n---\n\n# B\n',
    });
    git(work, 'mv', 'docs/guides/install.md', 'docs/guides/setup.md');
    git(work, 'rm', '--quiet', 'docs/a.md');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'two');
    git(work, 'push', '--quiet', remote, 'main');
    const head = git(remote, 'rev-parse', 'main').trim();

    const result = await syncSpace(db, target, source);
    assert.deepEqual(result.added.sort(), ['b.mdx', 'guides/setup.md']);
    assert.deepEqual(result.modified, ['index.md']);
    assert.deepEqual(result.deleted.sort(), ['a.md', 'guides/install.md']);
    assert.deepEqual(result.renamed, [
      {
        from: 'guides/install.md',
        to: 'guides/setup.md',
        fromUrl: '/guides/install',
        toUrl: '/guides/setup',
      },
    ]);
    assert.deepEqual(await pagesInDb(), pagesInGit(remote, head));
    const bee = await db
      .selectFrom('pages')
      .select('url')
      .where('path', '=', 'b.mdx')
      .executeTakeFirstOrThrow();
    assert.equal(bee.url, '/bee');
    const redirects = await db
      .selectFrom('inferred_redirects')
      .select(['from_url', 'to_url', 'commit_sha'])
      .execute();
    assert.deepEqual(redirects, [
      { from_url: '/guides/install', to_url: '/guides/setup', commit_sha: head },
    ]);
  });

  it('is a no-op when nothing changed, and recovers after the mirror is deleted', async () => {
    const again = await syncSpace(db, target, source);
    assert.deepEqual([again.added, again.modified, again.deleted], [[], [], []]);
    rmSync(mirrorDir, { recursive: true, force: true });
    const rebuilt = await syncSpace(db, target, source);
    assert.deepEqual([rebuilt.added, rebuilt.modified, rebuilt.deleted], [[], [], []]);
    assert.equal(rebuilt.unchanged, 3);
  });

  it('follows a force-push that rewrote history', async () => {
    git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
    write(work, { 'docs/c.md': '# C\n' });
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'rewritten');
    git(work, 'push', '--quiet', '--force', remote, 'main');
    const head = git(remote, 'rev-parse', 'main').trim();
    const result = await syncSpace(db, target, source);
    assert.equal(result.to, head);
    assert.deepEqual(await pagesInDb(), pagesInGit(remote, head));
  });

  it('skips a page whose URL another page already has', async () => {
    write(work, { 'docs/zz.md': '---\nslug: /c\n---\n\n# Clash\n' });
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'clash');
    git(work, 'push', '--quiet', remote, 'main');
    const lines: string[] = [];
    const result = await syncSpace(db, target, source, { log: (line) => lines.push(line) });
    assert.deepEqual(result.skipped, [{ path: 'zz.md', reason: 'URL /c is already used by c.md' }]);
    assert.ok(lines.some((line) => line.includes('sync skipped zz.md')));
  });

  it('omits pages matched by exclude in oxybook.yml', async () => {
    write(work, {
      'oxybook.yml': 'exclude:\n  - secret\n  - "*.wip.md"\n',
      'docs/secret/hidden-doc.md': '# Secret\n',
      'docs/draft.wip.md': '# Draft\n',
    });
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'exclude');
    git(work, 'push', '--quiet', remote, 'main');
    await syncSpace(db, target, source);
    const stored = await pagesInDb();
    assert.ok(!stored.includes('secret/hidden-doc.md'));
    assert.ok(!stored.includes('draft.wip.md'));
  });
});
