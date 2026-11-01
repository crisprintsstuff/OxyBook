// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type Kysely, sql } from '@oxybook/db';
import {
  type Draft,
  type DraftFile,
  DraftInputError,
  DraftStateError,
  DraftVersionConflict,
  getDraft,
  listDraftFiles,
} from './drafts.js';
import {
  conflictCount,
  type MergeRegion,
  mergeText,
  type RegionChoice,
  resolveRegions,
} from './merge3.js';
import { type BlobSource, type ConflictCode, type Decision, decide } from './rebase.js';

/**
 * Conflict view and resolution (ARCHITECTURE §4.5, docs/M3-PLAN.md slice 1). A draft
 * becomes `conflicted` when the base moved and a drafted file cannot follow on its own.
 * The view shows each such file against the current head: content conflicts as
 * block-level regions, structural ones (deleted, added twice, renamed onto) as an explicit
 * keep-mine / take-theirs choice. Resolving re-bases the whole draft onto that head.
 */

export type ConflictChoice = 'keep-mine' | 'take-theirs';

export interface FileConflict {
  path: string;
  oldPath: string | null;
  op: DraftFile['op'];
  code: ConflictCode;
  why: string;
  /** `regions` for text conflicts; `choice` when only keep-mine / take-theirs applies. */
  kind: 'regions' | 'choice';
  regions: MergeRegion[] | null;
  /** Conflicting regions in `regions` (0: the block-level merge settled it on its own). */
  conflicts: number;
  choices: ConflictChoice[];
  /** The draft's text and the head's text, for display; null when absent or binary. */
  mine: string | null;
  theirs: string | null;
}

export interface DraftConflicts {
  draftId: string;
  version: number;
  /** The head the view was computed against; resolving must name it. */
  head: string;
  files: FileConflict[];
}

export type FileResolution =
  | { path: string; take: ConflictChoice }
  | { path: string; choices: RegionChoice[] }
  | { path: string; bytes: Buffer };

/** The base moved again after the view was built; the caller reloads the view. */
export class DraftHeadMoved extends Error {
  readonly status = 409;
  constructor(
    readonly expected: string,
    readonly current: string,
  ) {
    super(
      `the base moved to ${current.slice(0, 12)} since ${expected.slice(0, 12)}; reload the conflicts`,
    );
    this.name = 'DraftHeadMoved';
  }
}

const isBinary = (bytes: Buffer | null) => Boolean(bytes?.includes(0));
const text = (bytes: Buffer | null) => (bytes && !isBinary(bytes) ? bytes.toString('utf8') : null);

async function currentHead(db: Kysely<Database>, draft: Draft): Promise<string> {
  const row = await db
    .selectFrom('ref_state')
    .select('head_sha')
    .where('space_id', '=', draft.spaceId)
    .where('ref', '=', draft.baseRef)
    .executeTakeFirst();
  if (!row) throw new DraftInputError(`no synced head for ${draft.baseRef}`);
  return row.head_sha;
}

type Settled = { file: DraftFile; decision: Decision; view: FileConflict | null; base: string };

async function settle(head: string, source: BlobSource, files: DraftFile[]): Promise<Settled[]> {
  const out: Settled[] = [];
  for (const file of files) {
    const decision = await decide(file, head, source);
    if (decision.kind !== 'conflict') {
      out.push({ file, decision, view: null, base: '' });
      continue;
    }
    const mine = file.bytes;
    const theirs = decision.upstream?.bytes ?? null;
    const base =
      file.baseBlobSha && (decision.code === 'content' || decision.code === 'add-add')
        ? (await source.blob(file.baseBlobSha)).toString('utf8')
        : '';
    const textual =
      (decision.code === 'content' || decision.code === 'add-add') &&
      !isBinary(mine) &&
      !isBinary(theirs);
    const regions = textual
      ? mergeText(base, text(mine) ?? '', text(theirs) ?? '', file.path)
      : null;
    const choices: ConflictChoice[] =
      decision.code === 'rename-target-exists' ? ['take-theirs'] : ['keep-mine', 'take-theirs'];
    out.push({
      file,
      decision,
      base,
      view: {
        path: file.path,
        oldPath: file.oldPath,
        op: file.op,
        code: decision.code,
        why: decision.why,
        kind: regions ? 'regions' : 'choice',
        regions,
        conflicts: regions ? conflictCount(regions) : 0,
        choices,
        mine: text(mine),
        theirs: text(theirs),
      },
    });
  }
  return out;
}

/** The conflicts of a draft against the current head of its base ref. */
export async function draftConflicts(
  db: Kysely<Database>,
  draftId: string,
  source: BlobSource,
): Promise<DraftConflicts> {
  const draft = await getDraft(db, draftId);
  if (!draft) throw new DraftInputError(`draft ${draftId} does not exist`);
  const head = await currentHead(db, draft);
  const settled = await settle(head, source, await listDraftFiles(db, draft.id));
  return {
    draftId: draft.id,
    version: draft.version,
    head,
    files: settled.flatMap((s) => (s.view ? [s.view] : [])),
  };
}

type Row = {
  op: DraftFile['op'];
  oldPath: string | null;
  baseBlobSha: string | null;
  bytes: Buffer | null;
};

/** What a resolution turns a conflicted file into: a draft row, or nothing (take theirs). */
function apply(settled: Settled, resolution: FileResolution | undefined): Row | null {
  const { file, decision, view } = settled;
  if (decision.kind !== 'conflict' || !view) throw new Error('not a conflict');
  const upstream = decision.upstream;
  let bytes: Buffer | null;
  if (!resolution) {
    // A text conflict the block-level merge settled on its own needs no choice.
    if (view.regions && view.conflicts === 0) bytes = Buffer.from(resolveRegions(view.regions, []));
    else throw new DraftInputError(`${file.path}: choose how to resolve (${view.why})`);
  } else if ('take' in resolution) {
    if (!view.choices.includes(resolution.take))
      throw new DraftInputError(
        `${file.path}: ${resolution.take} is not possible here (${view.why})`,
      );
    if (resolution.take === 'take-theirs') return null;
    bytes = file.bytes;
  } else if ('choices' in resolution) {
    if (!view.regions) throw new DraftInputError(`${file.path} has no text regions to choose from`);
    try {
      bytes = Buffer.from(resolveRegions(view.regions, resolution.choices));
    } catch (error) {
      throw new DraftInputError(`${file.path}: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    if (view.kind !== 'regions')
      throw new DraftInputError(`${file.path}: keep mine or take theirs (${view.why})`);
    bytes = resolution.bytes;
  }

  switch (view.code) {
    case 'content':
    case 'binary':
    case 'add-add': {
      if (!upstream) throw new Error('a content conflict without an upstream blob');
      // Nothing left to change against the head: the file leaves the draft (a rename stays).
      if (file.op !== 'rename' && bytes?.equals(upstream.bytes)) return null;
      return {
        op: file.op === 'add' ? 'modify' : file.op,
        oldPath: file.oldPath,
        baseBlobSha: upstream.sha,
        bytes,
      };
    }
    case 'deleted-upstream':
    case 'rename-source-gone':
      // Keep mine: the file comes back as new.
      return { op: 'add', oldPath: null, baseBlobSha: null, bytes };
    case 'edited-upstream':
      // Keep mine: delete the edited file anyway.
      return { op: 'delete', oldPath: null, baseBlobSha: upstream?.sha ?? null, bytes: null };
    case 'rename-target-exists':
      throw new DraftInputError(`${file.path} exists upstream now; take theirs, then rename again`);
  }
}

/**
 * Resolve every conflicted file and re-base the draft onto `head`, the head the caller's
 * view was built against. Files that merge cleanly at that head move with it, and the
 * draft goes back to `editing` (or `proposed` if it has a pull request).
 */
export async function resolveDraft(
  db: Kysely<Database>,
  input: {
    draftId: string;
    ifMatch: number;
    head: string;
    source: BlobSource;
    resolutions: FileResolution[];
  },
): Promise<Draft> {
  const draft = await getDraft(db, input.draftId);
  if (!draft) throw new DraftInputError(`draft ${input.draftId} does not exist`);
  if (draft.state !== 'conflicted') throw new DraftStateError(draft.id, draft.state);
  if (draft.version !== input.ifMatch)
    throw new DraftVersionConflict(draft.id, input.ifMatch, draft.version);
  const head = await currentHead(db, draft);
  if (head !== input.head) throw new DraftHeadMoved(input.head, head);

  const settled = await settle(head, input.source, await listDraftFiles(db, draft.id));
  const byPath = new Map(input.resolutions.map((r) => [r.path, r]));
  for (const path of byPath.keys()) {
    if (!settled.some((s) => s.view && s.file.path === path))
      throw new DraftInputError(`${path} is not in conflict`);
  }
  const plan: { path: string; row: Row | null }[] = [];
  for (const s of settled) {
    if (s.view) plan.push({ path: s.file.path, row: apply(s, byPath.get(s.file.path)) });
    else if (s.decision.kind === 'drop') plan.push({ path: s.file.path, row: null });
    else if (s.decision.kind === 'update')
      plan.push({
        path: s.file.path,
        row: {
          op: s.file.op,
          oldPath: s.file.oldPath,
          baseBlobSha: s.decision.baseBlobSha,
          bytes: s.decision.bytes,
        },
      });
  }

  return db.transaction().execute(async (trx) => {
    const bumped = await trx
      .updateTable('drafts')
      .set({
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
        base_sha: head,
        state: sql`case when pr_url is null then 'editing' else 'proposed' end`,
      })
      .where('id', '=', draft.id)
      .where('version', '=', input.ifMatch)
      .where('state', '=', 'conflicted')
      .returning('id')
      .executeTakeFirst();
    if (!bumped) {
      const current = await getDraft(trx, draft.id);
      if (current && current.state !== 'conflicted')
        throw new DraftStateError(draft.id, current.state);
      throw new DraftVersionConflict(draft.id, input.ifMatch, current?.version ?? -1);
    }
    for (const { path, row } of plan) {
      if (!row) {
        await trx
          .deleteFrom('draft_files')
          .where('draft_id', '=', draft.id)
          .where('path', '=', path)
          .execute();
      } else {
        await trx
          .updateTable('draft_files')
          .set({
            op: row.op,
            old_path: row.oldPath,
            base_blob_sha: row.baseBlobSha,
            bytes: row.bytes,
          })
          .where('draft_id', '=', draft.id)
          .where('path', '=', path)
          .execute();
      }
    }
    const after = await getDraft(trx, draft.id);
    if (!after) throw new Error('draft vanished while resolving');
    return after;
  });
}
