// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createDb, type Database, type Kysely, migrateToLatest, sql } from '@oxybook/db';
import {
  type BlobSource,
  DraftInputError,
  DraftStateError,
  DraftVersionConflict,
  discardDraft,
  draftDiff,
  getDraft,
  listDraftFiles,
  openDraft,
  openDraftsTouching,
  rebaseDrafts,
  removeDraftFile,
  saveDraftFile,
} from '../src/index.js';

const url = process.env.DATABASE_URL;

/** Blob ids are content hashes, so equal bytes get equal ids, like git. */
const shaOf = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

/** A repository at two commits, as the worker's mirror would answer. */
function fakeRepo(
  trees: Record<string, Record<string, string>>,
): BlobSource & { hook?: () => Promise<void> } {
  const blobs = new Map<string, Buffer>();
  const index = new Map<string, string>();
  for (const [commit, files] of Object.entries(trees)) {
    for (const [path, text] of Object.entries(files)) {
      const bytes = Buffer.from(text);
      blobs.set(shaOf(bytes), bytes);
      index.set(`${commit}:${path}`, shaOf(bytes));
    }
  }
  const repo: BlobSource & { hook?: () => Promise<void> } = {
    async blob(sha) {
      const bytes = blobs.get(sha);
      if (!bytes) throw new Error(`no blob ${sha}`);
      return bytes;
    },
    async at(commit, path) {
      await repo.hook?.();
      const sha = index.get(`${commit}:${path}`);
      return sha ? { sha, bytes: blobs.get(sha) as Buffer } : null;
    },
  };
  return repo;
}

const PAGE = '# Install\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
const blobId = (text: string) => shaOf(Buffer.from(text));

describe('drafts', { skip: url ? false : 'DATABASE_URL is not set' }, () => {
  const schema = `oxybook_test_${randomBytes(6).toString('hex')}`;
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let spaceId: string;
  let orgId: string;

  const newUser = async (name: string) =>
    (
      await db
        .insertInto('users')
        .values({ email: `${name}-${randomBytes(3).toString('hex')}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

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
    await db
      .insertInto('ref_state')
      .values({ org_id: orgId, space_id: spaceId, ref: 'main', head_sha: OLD_HEAD })
      .execute();
  });

  after(async () => {
    await db?.destroy();
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin?.destroy();
  });

  it('opens one draft per user, space, and ref, based on the synced head', async () => {
    const alice = await newUser('Alice');
    const bob = await newUser('Bob');
    const first = await openDraft(db, { spaceId, userId: alice });
    assert.equal(first.baseSha, OLD_HEAD);
    assert.equal(first.state, 'editing');
    assert.equal(first.version, 1);
    assert.equal(
      (await openDraft(db, { spaceId, userId: alice })).id,
      first.id,
      'reopening returns the same draft',
    );
    const [x, y] = await Promise.all([
      openDraft(db, { spaceId, userId: bob }),
      openDraft(db, { spaceId, userId: bob }),
    ]);
    assert.equal(x.id, y.id, 'two tabs opening at once get one draft');
    assert.notEqual(x.id, first.id);
    await assert.rejects(
      openDraft(db, { spaceId, userId: alice, baseRef: 'release' }),
      DraftInputError,
    );
  });

  it('saves with If-Match and refuses a stale version', async () => {
    const draft = await openDraft(db, { spaceId, userId: await newUser('Carol') });
    const saved = await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: 'modify',
      path: 'docs/install.md',
      baseBlobSha: blobId(PAGE),
      bytes: Buffer.from(PAGE.replace('First', 'Edited first')),
    });
    assert.equal(saved.version, draft.version + 1);
    await assert.rejects(
      saveDraftFile(db, {
        draftId: draft.id,
        ifMatch: draft.version,
        op: 'modify',
        path: 'docs/install.md',
        baseBlobSha: blobId(PAGE),
        bytes: Buffer.from('second tab'),
      }),
      (error: unknown) =>
        error instanceof DraftVersionConflict &&
        error.status === 409 &&
        error.current === saved.version,
    );
    const files = await listDraftFiles(db, draft.id);
    assert.equal(files.length, 1);
    assert.equal(
      files[0]?.bytes?.toString(),
      PAGE.replace('First', 'Edited first'),
      'the stale save changed nothing',
    );
  });

  it('validates paths and ops before writing', async () => {
    const draft = await openDraft(db, { spaceId, userId: await newUser('Dan') });
    const base = { draftId: draft.id, ifMatch: draft.version };
    const bad: [string, Parameters<typeof saveDraftFile>[1], RegExp][] = [
      [
        'outside the content root',
        { ...base, op: 'add', path: 'src/x.md', bytes: Buffer.from('x') },
        /outside docs/,
      ],
      [
        'a hidden path',
        { ...base, op: 'add', path: 'docs/.env', bytes: Buffer.from('x') },
        /hidden/,
      ],
      [
        'modify without its base blob',
        { ...base, op: 'modify', path: 'docs/a.md', bytes: Buffer.from('x') },
        /base blob/,
      ],
      [
        'an add with a base blob',
        {
          ...base,
          op: 'add',
          path: 'docs/a.md',
          baseBlobSha: 'c'.repeat(40),
          bytes: Buffer.from('x'),
        },
        /no base blob/,
      ],
      [
        'a delete with bytes',
        {
          ...base,
          op: 'delete',
          path: 'docs/a.md',
          baseBlobSha: 'c'.repeat(40),
          bytes: Buffer.from('x'),
        },
        /no bytes/,
      ],
      [
        'too large',
        { ...base, op: 'add', path: 'docs/big.png', bytes: Buffer.alloc(5_000_001) },
        /limit/,
      ],
    ];
    for (const [label, input, message] of bad) {
      await assert.rejects(
        saveDraftFile(db, input),
        (e: unknown) => e instanceof DraftInputError && message.test(e.message),
        label,
      );
    }
    assert.equal(
      (await getDraft(db, draft.id))?.version,
      draft.version,
      'rejected input does not bump the version',
    );
    const image = await saveDraftFile(db, {
      ...base,
      op: 'add',
      path: 'docs/images/shot.png',
      bytes: Buffer.from([0x89, 0x50, 0, 1]),
    });
    assert.equal(image.version, draft.version + 1, 'an image upload is a draft file');
  });

  it('removes a file, discards a draft for good, and starts afresh', async () => {
    const user = await newUser('Erin');
    const draft = await openDraft(db, { spaceId, userId: user });
    const v2 = await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: 1,
      op: 'add',
      path: 'docs/new.md',
      bytes: Buffer.from('# New\n'),
    });
    const v3 = await removeDraftFile(db, {
      draftId: draft.id,
      ifMatch: v2.version,
      path: 'docs/new.md',
    });
    assert.deepEqual(await listDraftFiles(db, draft.id), []);
    const closed = await discardDraft(db, { draftId: draft.id, ifMatch: v3.version });
    assert.equal(closed.state, 'closed');
    await assert.rejects(
      saveDraftFile(db, {
        draftId: draft.id,
        ifMatch: closed.version + 1,
        op: 'add',
        path: 'docs/x.md',
        bytes: Buffer.from('x'),
      }),
      DraftStateError,
    );
    const fresh = await openDraft(db, { spaceId, userId: user });
    assert.notEqual(fresh.id, draft.id, 'a closed draft is not reopened');
  });

  it('shows who else has an open draft on a page, including the old path of a rename', async () => {
    const frank = await newUser('Frank');
    const gina = await newUser('Gina');
    const draft = await openDraft(db, { spaceId, userId: frank });
    await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: 'rename',
      oldPath: 'docs/old-name.md',
      path: 'docs/new-name.md',
      baseBlobSha: blobId(PAGE),
      bytes: Buffer.from(PAGE),
    });
    for (const path of ['docs/old-name.md', 'docs/new-name.md']) {
      const touching = await openDraftsTouching(db, { spaceId, path, excludeUserId: gina });
      assert.deepEqual(
        touching.map((t) => t.userName),
        ['Frank'],
        path,
      );
    }
    assert.deepEqual(
      await openDraftsTouching(db, { spaceId, path: 'docs/new-name.md', excludeUserId: frank }),
      [],
    );
  });

  it('previews a unified diff per file', async () => {
    const repo = fakeRepo({ [OLD_HEAD]: { 'docs/install.md': PAGE, 'docs/gone.md': '# Gone\n' } });
    const draft = await openDraft(db, { spaceId, userId: await newUser('Hank') });
    let v = draft.version;
    const save = async (
      input: Omit<Parameters<typeof saveDraftFile>[1], 'draftId' | 'ifMatch'>,
    ) => {
      v = (await saveDraftFile(db, { draftId: draft.id, ifMatch: v, ...input })).version;
    };
    await save({
      op: 'modify',
      path: 'docs/install.md',
      baseBlobSha: blobId(PAGE),
      bytes: Buffer.from(PAGE.replace('Second paragraph.', 'Second paragraph, edited.')),
    });
    await save({ op: 'add', path: 'docs/added.md', bytes: Buffer.from('# Added\n') });
    await save({ op: 'delete', path: 'docs/gone.md', baseBlobSha: blobId('# Gone\n') });
    await save({ op: 'add', path: 'docs/images/a.png', bytes: Buffer.from([0x89, 0x50, 0, 2]) });
    const diffs = await draftDiff(db, draft, repo);
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));
    assert.equal(
      byPath['docs/install.md']?.patch,
      '--- a/docs/install.md\n+++ b/docs/install.md\n@@ -2,6 +2,6 @@\n \n First paragraph.\n \n-Second paragraph.\n+Second paragraph, edited.\n \n Third paragraph.\n',
    );
    assert.deepEqual(
      [byPath['docs/install.md']?.additions, byPath['docs/install.md']?.deletions],
      [1, 1],
    );
    assert.match(
      byPath['docs/added.md']?.patch ?? '',
      /^--- \/dev\/null\n\+\+\+ b\/docs\/added.md\n/,
    );
    assert.match(
      byPath['docs/gone.md']?.patch ?? '',
      /^--- a\/docs\/gone.md\n\+\+\+ \/dev\/null\n[\s\S]*-# Gone/,
    );
    assert.equal(byPath['docs/images/a.png']?.binary, true);
  });

  describe('rebase when the base moves', () => {
    const upstreamEdit = PAGE.replace('Third paragraph.', 'Third paragraph, edited upstream.');

    async function draftWith(
      name: string,
      files: Omit<Parameters<typeof saveDraftFile>[1], 'draftId' | 'ifMatch'>[],
    ) {
      const draft = await openDraft(db, { spaceId, userId: await newUser(name) });
      let v = draft.version;
      for (const file of files)
        v = (await saveDraftFile(db, { draftId: draft.id, ifMatch: v, ...file })).version;
      return (await getDraft(db, draft.id)) as NonNullable<Awaited<ReturnType<typeof getDraft>>>;
    }

    it('merges cleanly, moves untouched files, drops changes that landed, and flags conflicts', async () => {
      const repo = fakeRepo({
        [OLD_HEAD]: {
          'docs/install.md': PAGE,
          'docs/other.md': '# Other\n',
          'docs/same.md': '# Same\n',
          'docs/clash.md': PAGE,
          'docs/deleted.md': '# D\n',
        },
        [NEW_HEAD]: {
          'docs/install.md': upstreamEdit,
          'docs/other.md': '# Other\n',
          'docs/same.md': '# Same, fixed\n',
          'docs/clash.md': PAGE.replace('Second paragraph.', 'Second, upstream.'),
        },
      });
      const clean = await draftWith('Ivy', [
        {
          op: 'modify',
          path: 'docs/install.md',
          baseBlobSha: blobId(PAGE),
          bytes: Buffer.from(PAGE.replace('First paragraph.', 'First, in the draft.')),
        },
        {
          op: 'modify',
          path: 'docs/other.md',
          baseBlobSha: blobId('# Other\n'),
          bytes: Buffer.from('# Other, drafted\n'),
        },
        {
          op: 'modify',
          path: 'docs/same.md',
          baseBlobSha: blobId('# Same\n'),
          bytes: Buffer.from('# Same, fixed\n'),
        },
      ]);
      const clashing = await draftWith('Jay', [
        {
          op: 'modify',
          path: 'docs/clash.md',
          baseBlobSha: blobId(PAGE),
          bytes: Buffer.from(PAGE.replace('Second paragraph.', 'Second, in the draft.')),
        },
      ]);
      const deletedUnder = await draftWith('Kim', [
        {
          op: 'modify',
          path: 'docs/deleted.md',
          baseBlobSha: blobId('# D\n'),
          bytes: Buffer.from('# D, edited\n'),
        },
      ]);

      const outcomes = await rebaseDrafts(db, {
        spaceId,
        ref: 'main',
        head: NEW_HEAD,
        source: repo,
      });
      const of = (id: string) => outcomes.find((o) => o.draftId === id);

      assert.equal(of(clean.id)?.result, 'rebased');
      assert.deepEqual(of(clean.id)?.merged, ['docs/install.md']);
      assert.deepEqual(of(clean.id)?.dropped, [
        { path: 'docs/same.md', why: 'the same change landed upstream' },
      ]);
      const after = await getDraft(db, clean.id);
      assert.equal(after?.baseSha, NEW_HEAD);
      assert.equal(
        after?.version,
        clean.version + 1,
        'the editor sees the content changed under it',
      );
      const files = Object.fromEntries(
        (await listDraftFiles(db, clean.id)).map((f) => [f.path, f]),
      );
      assert.equal(
        files['docs/install.md']?.bytes?.toString(),
        '# Install\n\nFirst, in the draft.\n\nSecond paragraph.\n\nThird paragraph, edited upstream.\n',
      );
      assert.equal(files['docs/install.md']?.baseBlobSha, blobId(upstreamEdit));
      assert.equal(
        files['docs/other.md']?.bytes?.toString(),
        '# Other, drafted\n',
        'untouched upstream: kept as drafted',
      );
      assert.equal(files['docs/same.md'], undefined);

      for (const [draft, why] of [
        [clashing, 'edited upstream too'],
        [deletedUnder, 'deleted upstream, edited in the draft'],
      ] as const) {
        assert.equal(of(draft.id)?.result, 'conflicted');
        assert.equal(of(draft.id)?.conflicts[0]?.why, why);
        const now = await getDraft(db, draft.id);
        assert.equal(now?.state, 'conflicted');
        assert.equal(
          now?.baseSha,
          OLD_HEAD,
          'a conflicted draft keeps its base for the conflict view',
        );
      }
      assert.deepEqual(
        await rebaseDrafts(db, { spaceId, ref: 'main', head: NEW_HEAD, source: repo }),
        [],
        'nothing left to rebase: rebased drafts are at the head, conflicted ones wait',
      );
    });

    it('reports retry when a save lands during the rebase, and loses neither', async () => {
      await db
        .updateTable('drafts')
        .set({ state: 'closed' })
        .where('space_id', '=', spaceId)
        .execute();
      const draft = await draftWith('Lee', [
        {
          op: 'modify',
          path: 'docs/install.md',
          baseBlobSha: blobId(PAGE),
          bytes: Buffer.from(PAGE.replace('First paragraph.', 'First, drafted.')),
        },
      ]);
      const repo = fakeRepo({
        [OLD_HEAD]: { 'docs/install.md': PAGE },
        [NEW_HEAD]: { 'docs/install.md': upstreamEdit },
      });
      let raced = false;
      repo.hook = async () => {
        if (raced) return;
        raced = true;
        await saveDraftFile(db, {
          draftId: draft.id,
          ifMatch: draft.version,
          op: 'add',
          path: 'docs/typed-meanwhile.md',
          bytes: Buffer.from('# Typed while the rebase ran\n'),
        });
      };
      const [outcome] = await rebaseDrafts(db, {
        spaceId,
        ref: 'main',
        head: NEW_HEAD,
        source: repo,
      });
      assert.equal(outcome?.result, 'retry');
      const files = (await listDraftFiles(db, draft.id)).map((f) => f.path);
      assert.deepEqual(files, ['docs/install.md', 'docs/typed-meanwhile.md'], 'the save survived');
      assert.equal(
        (await getDraft(db, draft.id))?.baseSha,
        OLD_HEAD,
        'the rebase did not half-apply',
      );
      repo.hook = undefined;
      const [second] = await rebaseDrafts(db, {
        spaceId,
        ref: 'main',
        head: NEW_HEAD,
        source: repo,
      });
      assert.equal(second?.result, 'rebased', 'the next pass succeeds');
    });
  });
});
