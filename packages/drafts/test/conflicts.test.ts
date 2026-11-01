// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import {
  type BlobSource,
  DraftHeadMoved,
  DraftInputError,
  DraftVersionConflict,
  draftConflicts,
  getDraft,
  listDraftFiles,
  openDraft,
  rebaseDrafts,
  resolveDraft,
  type SaveFileInput,
  saveDraftFile,
} from '../src/index.js';

const url = process.env.DATABASE_URL;
const shaOf = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const blobId = (text: string) => shaOf(Buffer.from(text));
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

function fakeRepo(trees: Record<string, Record<string, string>>): BlobSource {
  const blobs = new Map<string, Buffer>();
  const index = new Map<string, string>();
  for (const [commit, files] of Object.entries(trees)) {
    for (const [path, text] of Object.entries(files)) {
      const bytes = Buffer.from(text);
      blobs.set(shaOf(bytes), bytes);
      index.set(`${commit}:${path}`, shaOf(bytes));
    }
  }
  return {
    async blob(sha) {
      const bytes = blobs.get(sha);
      if (!bytes) throw new Error(`no blob ${sha}`);
      return bytes;
    },
    async at(commit, path) {
      const sha = index.get(`${commit}:${path}`);
      return sha ? { sha, bytes: blobs.get(sha) as Buffer } : null;
    },
  };
}

// The H2 spike's page (spikes/conflicts) and a page with neighbouring paragraphs.
const PAGE = 'alpha\n\nbeta\n\ngamma\n';
// A heading directly followed by its paragraph: two blocks, neighbouring lines.
const NEAR = '# Near\none\n';

describe('conflict view and resolution', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId: string;
  let orgId: string;
  let userId: string;

  const setHead = (head: string) =>
    db.updateTable('ref_state').set({ head_sha: head }).where('space_id', '=', spaceId).execute();

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
    userId = (
      await db
        .insertInto('users')
        .values({ email: 'c@example.com', name: 'Cy' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  async function draftAt(head: string, files: Omit<SaveFileInput, 'draftId' | 'ifMatch'>[]) {
    await db.deleteFrom('draft_files').execute();
    await db.deleteFrom('drafts').execute();
    await db.deleteFrom('ref_state').execute();
    await db
      .insertInto('ref_state')
      .values({ org_id: orgId, space_id: spaceId, ref: 'main', head_sha: head })
      .execute();
    const draft = await openDraft(db, { spaceId, userId, baseRef: 'main' });
    let v = draft.version;
    for (const file of files)
      v = (await saveDraftFile(db, { draftId: draft.id, ifMatch: v, ...file })).version;
    return draft.id;
  }

  const repo = fakeRepo({
    [H1]: {
      'docs/clash.md': PAGE,
      'docs/clean.md': PAGE,
      'docs/near.md': NEAR,
      'docs/gone.md': '# Gone\n',
      'docs/kept.md': '# Kept\n',
      'docs/old.md': '# Old\n',
    },
    [H2]: {
      'docs/clash.md': PAGE.replace('beta', 'beta upstream'),
      'docs/clean.md': PAGE.replace('gamma', 'gamma upstream'),
      'docs/near.md': NEAR.replace('one', 'one, upstream'),
      'docs/kept.md': '# Kept, edited upstream\n',
      'docs/new.md': '# New, from upstream\n',
      'docs/old.md': '# Old\n',
      'docs/moved.md': '# Taken\n',
    },
    [H3]: {
      'docs/clash.md': PAGE.replace('beta', 'beta upstream').replace('alpha', 'alpha again'),
      'docs/clean.md': PAGE.replace('gamma', 'gamma upstream'),
    },
  });

  it('shows block regions and choices, and resolves the whole draft onto the head', async () => {
    const id = await draftAt(H1, [
      {
        op: 'modify',
        path: 'docs/clash.md',
        baseBlobSha: blobId(PAGE),
        bytes: Buffer.from(PAGE.replace('beta', 'beta draft')),
      },
      {
        op: 'modify',
        path: 'docs/clean.md',
        baseBlobSha: blobId(PAGE),
        bytes: Buffer.from(PAGE.replace('alpha', 'alpha draft')),
      },
      {
        op: 'modify',
        path: 'docs/near.md',
        baseBlobSha: blobId(NEAR),
        bytes: Buffer.from(NEAR.replace('# Near', '# Near, drafted')),
      },
      {
        op: 'modify',
        path: 'docs/gone.md',
        baseBlobSha: blobId('# Gone\n'),
        bytes: Buffer.from('# Gone, edited\n'),
      },
      { op: 'delete', path: 'docs/kept.md', baseBlobSha: blobId('# Kept\n') },
      { op: 'add', path: 'docs/new.md', bytes: Buffer.from('# New, from the draft\n') },
      {
        op: 'rename',
        path: 'docs/moved.md',
        oldPath: 'docs/old.md',
        baseBlobSha: blobId('# Old\n'),
        bytes: Buffer.from('# Old\n'),
      },
    ]);
    const [outcome] = await rebaseDrafts(db, { spaceId, ref: 'main', head: H2, source: repo });
    assert.equal(outcome?.result, 'conflicted');
    await setHead(H2);

    const view = await draftConflicts(db, id, repo);
    assert.equal(view.head, H2);
    const byPath = new Map(view.files.map((f) => [f.path, f]));
    assert.deepEqual([...byPath.keys()].sort(), [
      'docs/clash.md',
      'docs/gone.md',
      'docs/kept.md',
      'docs/moved.md',
      'docs/near.md',
      'docs/new.md',
    ]);
    const clash = byPath.get('docs/clash.md');
    assert.equal(clash?.kind, 'regions');
    assert.equal(clash?.conflicts, 1);
    assert.deepEqual(
      clash?.regions?.find((r) => r.kind === 'conflict'),
      { kind: 'conflict', base: '\n\nbeta', mine: '\n\nbeta draft', theirs: '\n\nbeta upstream' },
    );
    // git merge-file refuses neighbouring lines; the block-level merge settles them.
    assert.equal(byPath.get('docs/near.md')?.conflicts, 0);
    assert.deepEqual(byPath.get('docs/gone.md')?.choices, ['keep-mine', 'take-theirs']);
    assert.equal(byPath.get('docs/new.md')?.code, 'add-add');
    assert.deepEqual(byPath.get('docs/moved.md')?.choices, ['take-theirs']);

    // Refusals: stale version, a head that moved, a missing choice, an impossible choice.
    await assert.rejects(
      resolveDraft(db, {
        draftId: id,
        ifMatch: view.version - 1,
        head: H2,
        source: repo,
        resolutions: [],
      }),
      DraftVersionConflict,
    );
    await assert.rejects(
      resolveDraft(db, {
        draftId: id,
        ifMatch: view.version,
        head: H1,
        source: repo,
        resolutions: [],
      }),
      DraftHeadMoved,
    );
    await assert.rejects(
      resolveDraft(db, {
        draftId: id,
        ifMatch: view.version,
        head: H2,
        source: repo,
        resolutions: [],
      }),
      /docs\/clash\.md: choose/,
    );
    await assert.rejects(
      resolveDraft(db, {
        draftId: id,
        ifMatch: view.version,
        head: H2,
        source: repo,
        resolutions: [
          { path: 'docs/clash.md', choices: ['mine'] },
          { path: 'docs/gone.md', take: 'keep-mine' },
          { path: 'docs/kept.md', take: 'take-theirs' },
          { path: 'docs/new.md', take: 'keep-mine' },
          { path: 'docs/moved.md', take: 'keep-mine' },
        ],
      }),
      DraftInputError,
    );

    const resolved = await resolveDraft(db, {
      draftId: id,
      ifMatch: view.version,
      head: H2,
      source: repo,
      resolutions: [
        { path: 'docs/clash.md', choices: [{ text: '\n\nbeta, both' }] },
        { path: 'docs/gone.md', take: 'keep-mine' },
        { path: 'docs/kept.md', take: 'take-theirs' },
        { path: 'docs/new.md', choices: ['theirs'] },
        { path: 'docs/moved.md', take: 'take-theirs' },
      ],
    });
    assert.equal(resolved.state, 'editing');
    assert.equal(resolved.baseSha, H2);
    const files = new Map((await listDraftFiles(db, id)).map((f) => [f.path, f]));
    assert.deepEqual([...files.keys()].sort(), [
      'docs/clash.md',
      'docs/clean.md',
      'docs/gone.md',
      'docs/near.md',
    ]);
    assert.equal(files.get('docs/clash.md')?.bytes?.toString(), 'alpha\n\nbeta, both\n\ngamma\n');
    assert.equal(
      files.get('docs/clash.md')?.baseBlobSha,
      blobId(PAGE.replace('beta', 'beta upstream')),
    );
    // The clean file merged with the head; the neighbouring edits merged block by block.
    assert.equal(
      files.get('docs/clean.md')?.bytes?.toString(),
      'alpha draft\n\nbeta\n\ngamma upstream\n',
    );
    assert.equal(files.get('docs/near.md')?.bytes?.toString(), '# Near, drafted\none, upstream\n');
    // Keep mine on a file deleted upstream: it comes back as new.
    assert.deepEqual(
      {
        op: files.get('docs/gone.md')?.op,
        base: files.get('docs/gone.md')?.baseBlobSha,
        text: files.get('docs/gone.md')?.bytes?.toString(),
      },
      { op: 'add', base: null, text: '# Gone, edited\n' },
    );
  });

  it('conflicts again after another upstream move, and resolves again', async () => {
    const id = await draftAt(H2, [
      {
        op: 'modify',
        path: 'docs/clash.md',
        baseBlobSha: blobId(PAGE.replace('beta', 'beta upstream')),
        bytes: Buffer.from(PAGE.replace('beta', 'beta upstream').replace('alpha', 'alpha draft')),
      },
    ]);
    await rebaseDrafts(db, { spaceId, ref: 'main', head: H3, source: repo });
    await setHead(H3);
    const view = await draftConflicts(db, id, repo);
    assert.equal(view.files[0]?.conflicts, 1);
    const draft = await resolveDraft(db, {
      draftId: id,
      ifMatch: view.version,
      head: H3,
      source: repo,
      resolutions: [{ path: 'docs/clash.md', take: 'keep-mine' }],
    });
    assert.equal(draft.state, 'editing');
    const [file] = await listDraftFiles(db, id);
    assert.equal(
      file?.bytes?.toString(),
      PAGE.replace('beta', 'beta upstream').replace('alpha', 'alpha draft'),
    );
    assert.equal((await getDraft(db, id))?.baseSha, H3);
  });

  it('a draft with a pull request goes back to proposed', async () => {
    const id = await draftAt(H1, [
      {
        op: 'modify',
        path: 'docs/clash.md',
        baseBlobSha: blobId(PAGE),
        bytes: Buffer.from(PAGE.replace('beta', 'beta draft')),
      },
    ]);
    await db
      .updateTable('drafts')
      .set({
        pr_url: 'https://github.com/o/r/pull/1',
        branch: 'oxybook/cy/clash-1',
        pr_number: 1,
        state: 'proposed',
      })
      .where('id', '=', id)
      .execute();
    await rebaseDrafts(db, { spaceId, ref: 'main', head: H2, source: repo });
    await setHead(H2);
    const view = await draftConflicts(db, id, repo);
    const draft = await resolveDraft(db, {
      draftId: id,
      ifMatch: view.version,
      head: H2,
      source: repo,
      resolutions: [{ path: 'docs/clash.md', choices: ['theirs'] }],
    });
    assert.equal(draft.state, 'proposed');
    // Taking theirs left nothing to change: the file leaves the draft.
    assert.deepEqual(await listDraftFiles(db, id), []);
  });
});
