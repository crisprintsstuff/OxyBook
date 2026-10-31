// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type DraftFileOp, type DraftState, type Kysely, sql } from '@oxybook/db';
import { assertAllowedPath } from '@oxybook/git-write';

/**
 * Drafts (ARCHITECTURE §4.4): per (user, space, base ref), the one place OxyBook holds
 * content that is not in git. Every write names the version it was based on (If-Match),
 * so two tabs cannot silently overwrite each other.
 */

/** A draft the editor can still change. merged and closed are final. */
export const OPEN_STATES: readonly DraftState[] = ['editing', 'proposed', 'conflicted'];

const MAX_FILE_BYTES = 5_000_000;

export class DraftVersionConflict extends Error {
  readonly status = 409;
  constructor(
    readonly draftId: string,
    readonly expected: number,
    readonly current: number,
  ) {
    super(`draft ${draftId} is at version ${current}, not ${expected}; reload before saving`);
    this.name = 'DraftVersionConflict';
  }
}

export class DraftStateError extends Error {
  readonly status = 409;
  constructor(
    readonly draftId: string,
    readonly state: DraftState,
  ) {
    super(`draft ${draftId} is ${state} and can no longer change`);
    this.name = 'DraftStateError';
  }
}

export class DraftInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DraftInputError';
  }
}

export interface Draft {
  id: string;
  orgId: string;
  spaceId: string;
  userId: string;
  baseRef: string;
  baseSha: string;
  branch: string | null;
  prNumber: number | null;
  state: DraftState;
  version: number;
}

export interface DraftFile {
  path: string;
  op: DraftFileOp;
  oldPath: string | null;
  baseBlobSha: string | null;
  bytes: Buffer | null;
}

type Executor = Kysely<Database>;

function toDraft(row: {
  id: string;
  org_id: string;
  space_id: string;
  user_id: string;
  base_ref: string;
  base_sha: string;
  branch: string | null;
  pr_number: number | null;
  state: DraftState;
  version: number;
}): Draft {
  return {
    id: row.id,
    orgId: row.org_id,
    spaceId: row.space_id,
    userId: row.user_id,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    branch: row.branch,
    prNumber: row.pr_number,
    state: row.state,
    version: row.version,
  };
}

const DRAFT_COLUMNS = [
  'id',
  'org_id',
  'space_id',
  'user_id',
  'base_ref',
  'base_sha',
  'branch',
  'pr_number',
  'state',
  'version',
] as const;

export async function getDraft(db: Executor, draftId: string): Promise<Draft | null> {
  const row = await db
    .selectFrom('drafts')
    .select(DRAFT_COLUMNS)
    .where('id', '=', draftId)
    .executeTakeFirst();
  return row ? toDraft(row) : null;
}

/**
 * The user's open draft on (space, ref), or a new one based on the ref's synced head.
 * A new draft needs a synced ref: the base is what the editor showed the user.
 */
export async function openDraft(
  db: Executor,
  input: { spaceId: string; userId: string; baseRef?: string },
): Promise<Draft> {
  const space = await db
    .selectFrom('spaces')
    .select(['org_id', 'default_ref'])
    .where('id', '=', input.spaceId)
    .executeTakeFirst();
  if (!space) throw new DraftInputError(`space ${input.spaceId} does not exist`);
  const baseRef = input.baseRef ?? space.default_ref;
  const find = () =>
    db
      .selectFrom('drafts')
      .select(DRAFT_COLUMNS)
      .where('space_id', '=', input.spaceId)
      .where('user_id', '=', input.userId)
      .where('base_ref', '=', baseRef)
      .where('state', 'in', OPEN_STATES)
      .executeTakeFirst();
  const existing = await find();
  if (existing) return toDraft(existing);
  const head = await db
    .selectFrom('ref_state')
    .select('head_sha')
    .where('space_id', '=', input.spaceId)
    .where('ref', '=', baseRef)
    .executeTakeFirst();
  if (!head)
    throw new DraftInputError(`${baseRef} has not been synced yet; nothing to base a draft on`);
  const created = await db
    .insertInto('drafts')
    .values({
      org_id: space.org_id,
      space_id: input.spaceId,
      user_id: input.userId,
      base_ref: baseRef,
      base_sha: head.head_sha,
    })
    // Two tabs opening at once: the partial unique index keeps one; read it back.
    .onConflict((oc) =>
      oc
        .columns(['space_id', 'user_id', 'base_ref'])
        // Literal, not parameters: Postgres matches it against drafts_one_open's predicate.
        .where(sql<boolean>`state NOT IN ('merged', 'closed')`)
        .doNothing(),
    )
    .returning(DRAFT_COLUMNS)
    .executeTakeFirst();
  if (created) return toDraft(created);
  const raced = await find();
  if (!raced) throw new Error('draft vanished while opening');
  return toDraft(raced);
}

/**
 * Bump the version if it is still `expected`, in the caller's transaction. Throws the
 * reason it is not: a final state, or someone else's newer save.
 */
async function claimVersion(trx: Executor, draftId: string, expected: number): Promise<Draft> {
  const bumped = await trx
    .updateTable('drafts')
    .set({ version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
    .where('id', '=', draftId)
    .where('version', '=', expected)
    .where('state', 'in', OPEN_STATES)
    .returning(DRAFT_COLUMNS)
    .executeTakeFirst();
  if (bumped) return toDraft(bumped);
  const current = await getDraft(trx, draftId);
  if (!current) throw new DraftInputError(`draft ${draftId} does not exist`);
  if (!OPEN_STATES.includes(current.state)) throw new DraftStateError(draftId, current.state);
  throw new DraftVersionConflict(draftId, expected, current.version);
}

async function contentRootOf(db: Executor, spaceId: string): Promise<string> {
  const row = await db
    .selectFrom('spaces')
    .select('content_root')
    .where('id', '=', spaceId)
    .executeTakeFirstOrThrow();
  return row.content_root;
}

export interface SaveFileInput {
  draftId: string;
  /** The version the editor last saw (If-Match). */
  ifMatch: number;
  op: DraftFileOp;
  /** Repository path. For a rename, the new path. */
  path: string;
  oldPath?: string;
  /** The blob the editor loaded. Required for modify, delete, and rename; absent for add. */
  baseBlobSha?: string;
  bytes?: Buffer;
}

/** Save one file into the draft. Returns the draft with its new version. */
export async function saveDraftFile(db: Executor, input: SaveFileInput): Promise<Draft> {
  const draft = await getDraft(db, input.draftId);
  if (!draft) throw new DraftInputError(`draft ${input.draftId} does not exist`);
  const root = await contentRootOf(db, draft.spaceId);
  let target: string;
  let oldPath: string | null = null;
  try {
    target = assertAllowedPath(input.path, root);
    if (input.op === 'rename') oldPath = assertAllowedPath(input.oldPath ?? '', root);
  } catch (error) {
    throw new DraftInputError(error instanceof Error ? error.message : String(error));
  }
  if (input.op === 'add' && input.baseBlobSha) {
    throw new DraftInputError('an added file has no base blob');
  }
  if (input.op !== 'add' && !input.baseBlobSha) {
    throw new DraftInputError(`${input.op} of ${target} needs the base blob the editor loaded`);
  }
  if (input.op === 'delete' ? input.bytes !== undefined : input.bytes === undefined) {
    throw new DraftInputError(
      input.op === 'delete' ? 'a delete carries no bytes' : `${input.op} needs bytes`,
    );
  }
  if (input.bytes && input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new DraftInputError(
      `${target} is ${input.bytes.byteLength} bytes; the limit is ${MAX_FILE_BYTES}`,
    );
  }
  return db.transaction().execute(async (trx) => {
    const next = await claimVersion(trx, draft.id, input.ifMatch);
    await trx
      .insertInto('draft_files')
      .values({
        org_id: draft.orgId,
        draft_id: draft.id,
        path: target,
        op: input.op,
        old_path: oldPath,
        base_blob_sha: input.baseBlobSha ?? null,
        bytes: input.bytes ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['draft_id', 'path']).doUpdateSet({
          op: input.op,
          old_path: oldPath,
          base_blob_sha: input.baseBlobSha ?? null,
          bytes: input.bytes ?? null,
        }),
      )
      .execute();
    return next;
  });
}

/** Drop one file from the draft (undo all its changes). */
export async function removeDraftFile(
  db: Executor,
  input: { draftId: string; ifMatch: number; path: string },
): Promise<Draft> {
  return db.transaction().execute(async (trx) => {
    const next = await claimVersion(trx, input.draftId, input.ifMatch);
    await trx
      .deleteFrom('draft_files')
      .where('draft_id', '=', input.draftId)
      .where('path', '=', input.path)
      .execute();
    return next;
  });
}

export async function listDraftFiles(db: Executor, draftId: string): Promise<DraftFile[]> {
  const rows = await db
    .selectFrom('draft_files')
    .select(['path', 'op', 'old_path', 'base_blob_sha', 'bytes'])
    .where('draft_id', '=', draftId)
    .orderBy('path')
    .execute();
  return rows.map((row) => ({
    path: row.path,
    op: row.op,
    oldPath: row.old_path,
    baseBlobSha: row.base_blob_sha,
    bytes: row.bytes,
  }));
}

/** Throw the draft away. Its files go with it (`closed` is final). */
export async function discardDraft(
  db: Executor,
  input: { draftId: string; ifMatch: number },
): Promise<Draft> {
  return db.transaction().execute(async (trx) => {
    await claimVersion(trx, input.draftId, input.ifMatch);
    const closed = await trx
      .updateTable('drafts')
      .set({ state: 'closed', updated_at: sql<Date>`now()` })
      .where('id', '=', input.draftId)
      .returning(DRAFT_COLUMNS)
      .executeTakeFirstOrThrow();
    await trx.deleteFrom('draft_files').where('draft_id', '=', input.draftId).execute();
    return toDraft(closed);
  });
}

/** "Alex has an open draft that touches this page" (ARCHITECTURE §4.5). */
export async function openDraftsTouching(
  db: Executor,
  input: { spaceId: string; path: string; excludeUserId?: string },
): Promise<{ draftId: string; userId: string; userName: string; state: DraftState }[]> {
  let query = db
    .selectFrom('draft_files')
    .innerJoin('drafts', 'drafts.id', 'draft_files.draft_id')
    .innerJoin('users', 'users.id', 'drafts.user_id')
    .select([
      'drafts.id as draftId',
      'drafts.user_id as userId',
      'users.name as userName',
      'drafts.state as state',
    ])
    .where('drafts.space_id', '=', input.spaceId)
    .where('drafts.state', 'in', OPEN_STATES)
    .where((eb) =>
      eb.or([eb('draft_files.path', '=', input.path), eb('draft_files.old_path', '=', input.path)]),
    );
  if (input.excludeUserId) query = query.where('drafts.user_id', '!=', input.excludeUserId);
  return query.distinct().orderBy('users.name').execute();
}
