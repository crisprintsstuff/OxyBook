// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import {
  applyPullRequestEvent,
  type BlobSource,
  draftBranch,
  getDraft,
  openDraft,
  type ProposeEnvironment,
  ProposeForbidden,
  proposeDraft,
  saveDraftFile,
} from '../src/index.js';

const url = process.env.DATABASE_URL;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Developer',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Developer',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  });
}

const PAGE = '# Guide\n\nOne.\n\nTwo.\n\nThree.\n';

describe('propose', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-propose-'));
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const mirror = path.join(tmp, 'mirror.git');
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let orgId: string;
  let spaceId: string;
  let writer: string;
  let viewer: string;
  const pulls: { title: string; head: string; base: string; body: string }[] = [];

  const blobs: BlobSource = {
    async blob(sha) {
      return Buffer.from(git(mirror, 'cat-file', 'blob', sha));
    },
    async at(commit, repoPath) {
      try {
        const sha = git(mirror, 'rev-parse', '--verify', '--quiet', `${commit}:${repoPath}`).trim();
        return { sha, bytes: Buffer.from(git(mirror, 'cat-file', 'blob', sha)) };
      } catch {
        return null;
      }
    },
  };

  const env = (): ProposeEnvironment => ({
    db,
    mirrorDir: mirror,
    async fetch(branch) {
      git(mirror, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`);
      return git(mirror, 'rev-parse', `refs/heads/${branch}`).trim();
    },
    async remoteHead(branch) {
      const line = git(mirror, 'ls-remote', 'origin', `refs/heads/${branch}`).trim();
      return line ? (line.split('\t')[0] ?? null) : null;
    },
    async push(commit, branch, expected) {
      git(
        mirror,
        'push',
        '--quiet',
        'origin',
        `${commit}:refs/heads/${branch}`,
        `--force-with-lease=refs/heads/${branch}:${expected}`,
      );
    },
    async openPullRequest(input) {
      pulls.push(input);
      return { number: 40 + pulls.length, url: `https://github.example/pull/${40 + pulls.length}` };
    },
    blobs,
    linkBack: 'https://oxybook.example/',
    commitEmail: (userId) => `${userId}@users.noreply.oxybook.example`,
  });

  const pushUpstream = (file: string, text: string, branch = 'main') => {
    git(work, 'checkout', '--quiet', branch);
    writeFileSync(path.join(work, file), text);
    git(work, 'commit', '--quiet', '-am', `upstream ${file}`);
    git(work, 'push', '--quiet', remote, branch);
    return git(remote, 'rev-parse', branch).trim();
  };
  const branchFiles = (ref: string) => git(remote, 'show', `${ref}:docs/guide.md`);

  before(async () => {
    admin = createDb(url as string, { max: 1 });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = createDb(url as string, { max: 3, searchPath: schema });
    await migrateToLatest(db, { schema });

    git(tmp, 'init', '--bare', '--quiet', '-b', 'main', remote);
    git(tmp, 'init', '--quiet', '-b', 'main', work);
    mkdirSync(path.join(work, 'docs'), { recursive: true });
    writeFileSync(path.join(work, 'docs/guide.md'), PAGE);
    writeFileSync(path.join(work, 'docs/other.md'), '# Other\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'base');
    git(work, 'push', '--quiet', remote, 'main');
    git(tmp, 'clone', '--quiet', '--bare', remote, mirror);
    const head = git(remote, 'rev-parse', 'main').trim();

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
      .values({ org_id: orgId, space_id: spaceId, ref: 'main', head_sha: head })
      .execute();
    for (const [name, role] of [
      ['Wren Writer', 'editor'],
      ['Vic Viewer', 'viewer'],
    ] as const) {
      const user = await db
        .insertInto('users')
        .values({ email: `${role}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('org_members')
        .values({ org_id: orgId, user_id: user.id, role: 'member' })
        .execute();
      await db
        .insertInto('space_members')
        .values({ org_id: orgId, space_id: spaceId, user_id: user.id, role })
        .execute();
      if (role === 'editor') writer = user.id;
      else viewer = user.id;
    }
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  const save = async (draftId: string, text: string) => {
    const draft = await getDraft(db, draftId);
    const base = git(mirror, 'rev-parse', `${draft?.baseSha}:docs/guide.md`).trim();
    return saveDraftFile(db, {
      draftId,
      ifMatch: draft?.version ?? 0,
      op: 'modify',
      path: 'docs/guide.md',
      baseBlobSha: base,
      bytes: Buffer.from(text),
    });
  };

  it('names the branch oxybook/<user>/<page>-<draft>', () => {
    assert.equal(
      draftBranch('Wren Writer', 'docs/guides/Install Guide.md', '0123abcd-4567-89ef'),
      'oxybook/wren-writer/install-guide-0123abcd',
    );
  });

  it('refuses viewers and anyone but the author', async () => {
    const viewerDraft = await openDraft(db, { spaceId, userId: viewer });
    await save(viewerDraft.id, PAGE.replace('One.', 'One, by a viewer.'));
    await assert.rejects(
      proposeDraft(env(), { draftId: viewerDraft.id, userId: viewer, title: 'x' }),
      ProposeForbidden,
    );
    await assert.rejects(
      proposeDraft(env(), { draftId: viewerDraft.id, userId: writer, title: 'x' }),
      /only the author/,
    );
  });

  let draftId = '';
  let first = '';
  it('pushes a new oxybook/* branch with only the draft change and opens the PR', async () => {
    draftId = (await openDraft(db, { spaceId, userId: writer })).id;
    await save(draftId, PAGE.replace('One.', 'One, edited.'));
    const outcome = await proposeDraft(env(), {
      draftId,
      userId: writer,
      title: 'Edit the guide',
      signOff: true,
    });
    assert.equal(outcome.kind, 'proposed');
    assert.ok(
      outcome.kind === 'proposed' &&
        outcome.mode === 'new' &&
        outcome.openedPullRequest &&
        outcome.prNumber === 41,
    );
    first = outcome.commit;
    const branch = draftBranch('Wren Writer', 'docs/guide.md', draftId);
    assert.equal(git(remote, 'rev-parse', branch).trim(), first);
    assert.equal(
      git(remote, 'diff', '--name-only', 'main', branch).trim(),
      'docs/guide.md',
      'only the drafted file',
    );
    assert.equal(
      git(remote, 'rev-parse', 'main').trim(),
      git(remote, 'rev-parse', `${branch}^`).trim(),
      'main untouched, branch on it',
    );
    assert.match(
      git(remote, 'log', '-1', '--format=%an <%ae>%n%B', branch),
      /^Wren Writer <.*@users\.noreply\.oxybook\.example>\nEdit the guide\n\nSigned-off-by: Wren Writer/,
    );
    assert.deepEqual(
      pulls[0] && { head: pulls[0].head, base: pulls[0].base, title: pulls[0].title },
      { head: branch, base: 'main', title: 'Edit the guide' },
    );
    assert.match(pulls[0]?.body ?? '', /- docs\/guide\.md/);
    const after = await getDraft(db, draftId);
    assert.deepEqual([after?.state, after?.pushedSha, after?.prNumber], ['proposed', first, 41]);
  });

  it('appends a commit for further edits, and does nothing when nothing changed', async () => {
    await save(draftId, PAGE.replace('One.', 'One, edited.').replace('Two.', 'Two, edited.'));
    const outcome = await proposeDraft(env(), { draftId, userId: writer, title: 'Edit the guide' });
    assert.ok(
      outcome.kind === 'proposed' && outcome.mode === 'append' && !outcome.openedPullRequest,
    );
    assert.equal(
      git(remote, 'rev-parse', `${(outcome as { branch: string }).branch}^`).trim(),
      first,
    );
    assert.equal(pulls.length, 1, 'no second PR');
    assert.equal(
      (await proposeDraft(env(), { draftId, userId: writer, title: 'Edit the guide' })).kind,
      'unchanged',
    );
  });

  it('rebuilds the branch on a moved base when only OxyBook pushed to it', async () => {
    const main = pushUpstream('docs/other.md', '# Other, edited upstream\n');
    const outcome = await proposeDraft(env(), { draftId, userId: writer, title: 'Edit the guide' });
    assert.ok(outcome.kind === 'proposed' && outcome.mode === 'rebuild');
    const branch = (outcome as { branch: string }).branch;
    assert.equal(
      git(remote, 'rev-parse', `${branch}^`).trim(),
      main,
      'the branch now sits on the new main',
    );
    assert.equal(git(remote, 'diff', '--name-only', 'main', branch).trim(), 'docs/guide.md');
    assert.equal((await getDraft(db, draftId))?.baseSha, main);
  });

  it('merges into a branch someone else pushed to, never rewriting their commit', async () => {
    const draft = await getDraft(db, draftId);
    const branch = draft?.branch as string;
    git(work, 'fetch', '--quiet', remote, `${branch}:${branch}`);
    const theirs = pushUpstream(
      'docs/guide.md',
      branchFiles(branch).replace('Three.', 'Three, by a developer on the PR branch.'),
      branch,
    );
    await save(draftId, PAGE.replace('One.', 'One, edited again.').replace('Two.', 'Two, edited.'));
    const outcome = await proposeDraft(env(), { draftId, userId: writer, title: 'Edit the guide' });
    assert.ok(outcome.kind === 'proposed' && outcome.mode === 'merge');
    const head = git(remote, 'rev-parse', branch).trim();
    assert.equal(
      git(remote, 'rev-parse', `${head}^1`).trim(),
      theirs,
      'their commit is the first parent',
    );
    assert.equal(
      branchFiles(branch),
      '# Guide\n\nOne, edited again.\n\nTwo, edited.\n\nThree, by a developer on the PR branch.\n',
    );
  });

  it('stops with a conflict when their push and the draft edit the same paragraph', async () => {
    const draft = await getDraft(db, draftId);
    const branch = draft?.branch as string;
    git(work, 'checkout', '--quiet', 'main');
    git(work, 'fetch', '--quiet', remote, `+${branch}:${branch}`);
    pushUpstream(
      'docs/guide.md',
      branchFiles(branch).replace('One, edited again.', 'One, rewritten by the developer.'),
      branch,
    );
    await save(
      draftId,
      PAGE.replace('One.', 'One, the writer disagrees.').replace('Two.', 'Two, edited.'),
    );
    const before = git(remote, 'rev-parse', branch).trim();
    const outcome = await proposeDraft(env(), { draftId, userId: writer, title: 'Edit the guide' });
    assert.deepEqual(outcome.kind === 'conflicted' && outcome.paths, ['docs/guide.md']);
    assert.equal(git(remote, 'rev-parse', branch).trim(), before, 'nothing pushed');
    assert.equal((await getDraft(db, draftId))?.state, 'conflicted');
  });

  it('follows the PR: merged and closed are final, reopened comes back', async () => {
    const draft = (await getDraft(db, draftId)) as NonNullable<
      Awaited<ReturnType<typeof getDraft>>
    >;
    await db.updateTable('drafts').set({ state: 'proposed' }).where('id', '=', draftId).execute();
    const ignored = await applyPullRequestEvent(db, {
      spaceIds: [spaceId],
      branch: draft.branch as string,
      prNumber: 999,
      event: 'merged',
    });
    assert.deepEqual(ignored, [], 'another PR number on the same branch is not ours');
    const closed = await applyPullRequestEvent(db, {
      spaceIds: [spaceId],
      branch: draft.branch as string,
      prNumber: 41,
      event: 'closed',
    });
    assert.equal(closed[0]?.state, 'closed');
    const reopened = await applyPullRequestEvent(db, {
      spaceIds: [spaceId],
      branch: draft.branch as string,
      prNumber: 41,
      event: 'reopened',
    });
    assert.equal(reopened[0]?.state, 'proposed');
    const merged = await applyPullRequestEvent(db, {
      spaceIds: [spaceId],
      branch: draft.branch as string,
      prNumber: 41,
      event: 'merged',
    });
    assert.equal(merged[0]?.state, 'merged');
    assert.notEqual(
      (await openDraft(db, { spaceId, userId: writer })).id,
      draftId,
      'after a merge the next edit starts a new draft',
    );
  });
});
