// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type Kysely, sql } from '@oxybook/db';
import { mergeFile3 } from '@oxybook/git-write';
import { createTwoFilesPatch } from 'diff';
import { type Draft, type DraftFile, listDraftFiles } from './drafts.js';

/** Git objects for a space's repository. The worker backs it with the sync mirror. */
export interface BlobSource {
  /** Bytes of a blob by id. */
  blob(sha: string): Promise<Buffer>;
  /** The blob at `path` in `commit`, or null when the path does not exist there. */
  at(commit: string, path: string): Promise<{ sha: string; bytes: Buffer } | null>;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  op: DraftFile['op'];
  binary: boolean;
  additions: number;
  deletions: number;
  /** Unified diff (`--- a/` / `+++ b/`), empty for a binary file. */
  patch: string;
}

const isBinary = (bytes: Buffer) => bytes.includes(0);

/** The diff preview the user confirms before proposing (ARCHITECTURE §4.6). */
export async function draftDiff(
  db: Kysely<Database>,
  draft: Pick<Draft, 'id'>,
  source: BlobSource,
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  for (const file of await listDraftFiles(db, draft.id)) {
    const before = file.baseBlobSha ? await source.blob(file.baseBlobSha) : Buffer.alloc(0);
    const after = file.bytes ?? Buffer.alloc(0);
    const fromName = file.op === 'add' ? '/dev/null' : `a/${file.oldPath ?? file.path}`;
    const toName = file.op === 'delete' ? '/dev/null' : `b/${file.path}`;
    if (isBinary(before) || isBinary(after)) {
      diffs.push({
        path: file.path,
        oldPath: file.oldPath,
        op: file.op,
        binary: true,
        additions: 0,
        deletions: 0,
        patch: '',
      });
      continue;
    }
    const patch = createTwoFilesPatch(
      fromName,
      toName,
      before.toString('utf8'),
      after.toString('utf8'),
      '',
      '',
      {
        context: 3,
      },
    )
      // jsdiff opens with a row of '='; `git diff` does not.
      .replace(/^=+\n/, '')
      .replace(/^(---|\+\+\+) (.*)\t\n/gm, '$1 $2\n');
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    diffs.push({
      path: file.path,
      oldPath: file.oldPath,
      op: file.op,
      binary: false,
      additions,
      deletions,
      patch,
    });
  }
  return diffs;
}

type Decision =
  | { kind: 'keep' }
  | { kind: 'drop'; why: string }
  | { kind: 'update'; bytes: Buffer; baseBlobSha: string }
  | { kind: 'conflict'; why: string };

async function decide(file: DraftFile, head: string, source: BlobSource): Promise<Decision> {
  const draftBytes = file.bytes ?? Buffer.alloc(0);
  const mergeOnto = async (upstream: { sha: string; bytes: Buffer }): Promise<Decision> => {
    if (upstream.sha === file.baseBlobSha) return { kind: 'keep' };
    const base = await source.blob(file.baseBlobSha as string);
    const merged = mergeFile3(base, draftBytes, upstream.bytes);
    if (!merged.clean) {
      return {
        kind: 'conflict',
        why:
          merged.reason === 'binary' ? 'binary file changed upstream too' : 'edited upstream too',
      };
    }
    if (merged.bytes.equals(upstream.bytes))
      return { kind: 'drop', why: 'the same change landed upstream' };
    return { kind: 'update', bytes: merged.bytes, baseBlobSha: upstream.sha };
  };
  switch (file.op) {
    case 'add': {
      const upstream = await source.at(head, file.path);
      if (!upstream) return { kind: 'keep' };
      if (upstream.bytes.equals(draftBytes))
        return { kind: 'drop', why: 'the same file was added upstream' };
      return { kind: 'conflict', why: 'a different file was added upstream at this path' };
    }
    case 'modify': {
      const upstream = await source.at(head, file.path);
      if (!upstream) return { kind: 'conflict', why: 'deleted upstream, edited in the draft' };
      return mergeOnto(upstream);
    }
    case 'delete': {
      const upstream = await source.at(head, file.path);
      if (!upstream) return { kind: 'drop', why: 'already deleted upstream' };
      if (upstream.sha === file.baseBlobSha) return { kind: 'keep' };
      return { kind: 'conflict', why: 'edited upstream, deleted in the draft' };
    }
    case 'rename': {
      if (await source.at(head, file.path))
        return { kind: 'conflict', why: 'the new path now exists upstream' };
      const upstream = await source.at(head, file.oldPath as string);
      if (!upstream) return { kind: 'conflict', why: 'the original was deleted or moved upstream' };
      return mergeOnto(upstream);
    }
  }
}

export interface RebaseOutcome {
  draftId: string;
  result: 'rebased' | 'conflicted' | 'retry';
  /** Files whose bytes changed by a clean merge. */
  merged: string[];
  /** Files no longer needed (the same change landed upstream). */
  dropped: { path: string; why: string }[];
  conflicts: { path: string; why: string }[];
}

/**
 * The base ref of a space moved to `head` (ARCHITECTURE §4.5). Bring every open draft on
 * it forward: untouched files just take the new base, drafted files merge three-way with
 * `git merge-file`, and a draft with any conflict becomes `conflicted` and is left as it
 * was for the user to resolve. Each draft is updated in one transaction under its version,
 * so a save racing the rebase is not lost: the rebase reports `retry` instead.
 */
export async function rebaseDrafts(
  db: Kysely<Database>,
  input: { spaceId: string; ref: string; head: string; source: BlobSource },
): Promise<RebaseOutcome[]> {
  const drafts = await db
    .selectFrom('drafts')
    .select(['id', 'version'])
    .where('space_id', '=', input.spaceId)
    .where('base_ref', '=', input.ref)
    .where('base_sha', '!=', input.head)
    // A conflicted draft waits for its user; editing and proposed drafts move forward.
    .where('state', 'in', ['editing', 'proposed'])
    .execute();
  const outcomes: RebaseOutcome[] = [];
  for (const draft of drafts) {
    const outcome: RebaseOutcome = {
      draftId: draft.id,
      result: 'rebased',
      merged: [],
      dropped: [],
      conflicts: [],
    };
    const decisions: [DraftFile, Decision][] = [];
    for (const file of await listDraftFiles(db, draft.id)) {
      decisions.push([file, await decide(file, input.head, input.source)]);
    }
    for (const [file, decision] of decisions) {
      if (decision.kind === 'conflict')
        outcome.conflicts.push({ path: file.path, why: decision.why });
      if (decision.kind === 'drop') outcome.dropped.push({ path: file.path, why: decision.why });
      if (decision.kind === 'update') outcome.merged.push(file.path);
    }
    const applied = await db.transaction().execute(async (trx) => {
      const conflicted = outcome.conflicts.length > 0;
      const bumped = await trx
        .updateTable('drafts')
        .set({
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
          ...(conflicted ? { state: 'conflicted' as const } : { base_sha: input.head }),
        })
        .where('id', '=', draft.id)
        .where('version', '=', draft.version)
        .returning('id')
        .executeTakeFirst();
      if (!bumped) return false;
      if (conflicted) return true;
      for (const [file, decision] of decisions) {
        if (decision.kind === 'drop') {
          await trx
            .deleteFrom('draft_files')
            .where('draft_id', '=', draft.id)
            .where('path', '=', file.path)
            .execute();
        } else if (decision.kind === 'update') {
          await trx
            .updateTable('draft_files')
            .set({ bytes: decision.bytes, base_blob_sha: decision.baseBlobSha })
            .where('draft_id', '=', draft.id)
            .where('path', '=', file.path)
            .execute();
        }
      }
      return true;
    });
    if (!applied) outcome.result = 'retry';
    else if (outcome.conflicts.length > 0) outcome.result = 'conflicted';
    outcomes.push(outcome);
  }
  return outcomes;
}
