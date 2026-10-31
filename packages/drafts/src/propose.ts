// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type Kysely, type SpaceRole, sql } from '@oxybook/db';
import { commitFiles, type FileChange, mergeCommits, runGit } from '@oxybook/git-write';
import {
  DRAFT_COLUMNS,
  type Draft,
  DraftInputError,
  DraftStateError,
  getDraft,
  listDraftFiles,
  toDraft,
} from './drafts.js';
import { type BlobSource, rebaseDrafts } from './rebase.js';

export class ProposeForbidden extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ProposeForbidden';
  }
}

/** Try again: the base or the PR branch moved while the job ran. Not a failure to show. */
export class ProposeRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposeRetry';
  }
}

/**
 * The role a user holds on a space (ARCHITECTURE §7): an org owner is an admin of every
 * space in the org; otherwise the space membership decides; anyone else is a viewer.
 */
export async function spaceRoleOf(
  db: Kysely<Database>,
  userId: string,
  spaceId: string,
): Promise<SpaceRole | null> {
  const row = await db
    .selectFrom('spaces')
    .leftJoin('org_members', (join) =>
      join.onRef('org_members.org_id', '=', 'spaces.org_id').on('org_members.user_id', '=', userId),
    )
    .leftJoin('space_members', (join) =>
      join
        .onRef('space_members.space_id', '=', 'spaces.id')
        .on('space_members.user_id', '=', userId),
    )
    .select(['org_members.role as orgRole', 'space_members.role as spaceRole'])
    .where('spaces.id', '=', spaceId)
    .executeTakeFirst();
  if (!row || (!row.orgRole && !row.spaceRole)) return null;
  if (row.orgRole === 'owner') return 'admin';
  return row.spaceRole ?? 'viewer';
}

/** Editors and admins propose. Viewers read. Merging is never an OxyBook permission. */
export async function assertCanPropose(
  db: Kysely<Database>,
  userId: string,
  spaceId: string,
): Promise<void> {
  const role = await spaceRoleOf(db, userId, spaceId);
  if (role !== 'editor' && role !== 'admin') {
    throw new ProposeForbidden(
      `proposing changes needs the editor or admin role on this space (you are ${role ?? 'not a member'})`,
    );
  }
}

const slug = (text: string, fallback: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || fallback;

/** `oxybook/<user>/<page>-<draft>` (ARCHITECTURE §4.3). Stable for the draft's life. */
export function draftBranch(userName: string, firstPath: string, draftId: string): string {
  const page =
    firstPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  return `oxybook/${slug(userName, 'user')}/${slug(page, 'changes')}-${draftId.replace(/-/g, '').slice(0, 8)}`;
}

/** What the worker supplies: the space's mirror, its remote, and GitHub. */
export interface ProposeEnvironment {
  db: Kysely<Database>;
  mirrorDir: string;
  /** Fetch a branch into the mirror and return its head. */
  fetch(branch: string): Promise<string>;
  /** A branch's head on the remote, or null when it does not exist. */
  remoteHead(branch: string): Promise<string | null>;
  /** Push with --force-with-lease=<ref>:<expected> ('' = must not exist). */
  push(commit: string, branch: string, expected: string): Promise<void>;
  openPullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  blobs: BlobSource;
  /** Where the PR body links back to. */
  linkBack: string;
  /** Commit email for users (ARCHITECTURE §4.1: a per-instance noreply, not their address). */
  commitEmail(userId: string): string;
}

export interface ProposeInput {
  draftId: string;
  /** Who clicked Propose. Must own the draft and be an editor or admin. */
  userId: string;
  title: string;
  /** The user ticked the DCO affirmation. */
  signOff?: boolean;
}

export type ProposeOutcome =
  | {
      kind: 'proposed';
      branch: string;
      commit: string;
      prNumber: number;
      prUrl: string;
      /** new branch, a commit appended, the branch rebuilt on a moved base, or a merge commit. */
      mode: 'new' | 'append' | 'rebuild' | 'merge';
      openedPullRequest: boolean;
    }
  | { kind: 'unchanged'; branch: string; prNumber: number; prUrl: string }
  | { kind: 'conflicted'; reason: string; paths: string[] };

/**
 * Turn a draft into commits on its PR branch and a pull request (ARCHITECTURE §4.3–4.6).
 *
 * 1. Fetch the base; if it moved, rebase the draft first (a conflict stops here).
 * 2. Build the full draft tree on the base with `commitFiles`.
 * 3. Push: a new branch; a commit appended when only OxyBook pushed and the base is the
 *    same; the branch rebuilt on the new base when only OxyBook pushed and the base moved;
 *    a merge commit when anyone else pushed, never rewriting their history.
 * 4. Open the pull request once; later proposals update it by pushing.
 */
export async function proposeDraft(
  env: ProposeEnvironment,
  input: ProposeInput,
): Promise<ProposeOutcome> {
  const { db } = env;
  let draft = await getDraft(db, input.draftId);
  if (!draft) throw new DraftInputError(`draft ${input.draftId} does not exist`);
  if (draft.userId !== input.userId)
    throw new ProposeForbidden('only the author of a draft proposes it');
  if (draft.state !== 'editing' && draft.state !== 'proposed')
    throw new DraftStateError(draft.id, draft.state);
  await assertCanPropose(db, input.userId, draft.spaceId);
  if (input.title.trim() === '') throw new DraftInputError('a pull request needs a title');

  const head = await env.fetch(draft.baseRef);
  if (head !== draft.baseSha) {
    const [outcome] = (
      await rebaseDrafts(db, {
        spaceId: draft.spaceId,
        ref: draft.baseRef,
        head,
        source: env.blobs,
      })
    ).filter((o) => o.draftId === input.draftId);
    if (outcome?.result === 'conflicted') {
      const reason = `${draft.baseRef} moved and the draft conflicts with it`;
      await recordError(db, draft.id, reason);
      return { kind: 'conflicted', reason, paths: outcome.conflicts.map((c) => c.path) };
    }
    draft = (await getDraft(db, input.draftId)) as Draft;
    if (draft.baseSha !== head)
      throw new ProposeRetry('the draft changed while it was being rebased');
  }

  const files = await listDraftFiles(db, draft.id);
  if (files.length === 0) throw new DraftInputError('the draft has no changes to propose');
  const space = await db
    .selectFrom('spaces')
    .select(['content_root'])
    .where('id', '=', draft.spaceId)
    .executeTakeFirstOrThrow();
  const user = await db
    .selectFrom('users')
    .select(['name'])
    .where('id', '=', input.userId)
    .executeTakeFirstOrThrow();
  const author = { name: user.name, email: env.commitEmail(input.userId) };
  const branch = draft.branch ?? draftBranch(user.name, files[0]?.path ?? '', draft.id);
  const changes: FileChange[] = files.map((file) => ({
    op: file.op,
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    ...(file.bytes ? { bytes: file.bytes } : {}),
  }));
  const message = input.title.trim();

  const remote = await env.remoteHead(branch);
  let commit: string;
  let mode: 'new' | 'append' | 'rebuild' | 'merge';
  if (remote === null) {
    commit = commitFiles({
      mirrorDir: env.mirrorDir,
      base: draft.baseSha,
      contentRoot: space.content_root,
      changes,
      author,
      message,
      signOff: input.signOff === true,
    }).commit;
    mode = 'new';
  } else if (remote === draft.pushedSha) {
    if (draft.pushedBaseSha === draft.baseSha) {
      // Same base: the new commit's tree is the whole draft; its parent is the last push.
      const built = commitFiles({
        mirrorDir: env.mirrorDir,
        base: draft.baseSha,
        contentRoot: space.content_root,
        changes,
        author,
        message,
        signOff: input.signOff === true,
        parents: [remote],
      });
      if (built.tree === (await treeOf(env, remote))) {
        return {
          kind: 'unchanged',
          branch,
          prNumber: draft.prNumber as number,
          prUrl: draft.prUrl as string,
        };
      }
      commit = built.commit;
      mode = 'append';
    } else {
      // Only OxyBook pushed and the base moved: rebuild on the new base (lease on our push).
      commit = commitFiles({
        mirrorDir: env.mirrorDir,
        base: draft.baseSha,
        contentRoot: space.content_root,
        changes,
        author,
        message,
        signOff: input.signOff === true,
      }).commit;
      mode = 'rebuild';
    }
  } else {
    if (!draft.pushedSha) {
      throw new ProposeForbidden(
        `branch ${branch} already exists and was not created by this draft`,
      );
    }
    // Someone else pushed to the PR branch: never rewrite it; merge into it.
    await env.fetch(branch);
    const ours = commitFiles({
      mirrorDir: env.mirrorDir,
      base: draft.baseSha,
      contentRoot: space.content_root,
      changes,
      author,
      message,
      signOff: input.signOff === true,
      parents: [draft.pushedSha],
    });
    const merged = mergeCommits({
      mirrorDir: env.mirrorDir,
      theirs: remote,
      ours: ours.commit,
      author,
      message: `Merge OxyBook changes into ${branch}`,
    });
    if (!merged.clean) {
      const reason = `someone pushed to ${branch} and their changes conflict with the draft`;
      await db
        .updateTable('drafts')
        .set({
          state: 'conflicted',
          propose_error: reason,
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', draft.id)
        .execute();
      return { kind: 'conflicted', reason, paths: merged.conflictedPaths };
    }
    commit = merged.commit;
    mode = 'merge';
  }

  await env.push(commit, branch, remote ?? '');

  let prNumber = draft.prNumber;
  let prUrl = draft.prUrl;
  let openedPullRequest = false;
  if (prNumber === null) {
    const pr = await env.openPullRequest({
      title: message,
      head: branch,
      base: draft.baseRef,
      body: `${message}\n\nPages changed:\n${files.map((f) => `- ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`).join('\n')}\n\nProposed with OxyBook: ${env.linkBack}\n`,
    });
    prNumber = pr.number;
    prUrl = pr.url;
    openedPullRequest = true;
  }
  await db
    .updateTable('drafts')
    .set({
      state: 'proposed',
      branch,
      pr_number: prNumber,
      pr_url: prUrl,
      pushed_sha: commit,
      pushed_base_sha: draft.baseSha,
      propose_error: null,
      version: sql<number>`version + 1`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', draft.id)
    .execute();
  return {
    kind: 'proposed',
    branch,
    commit,
    prNumber,
    prUrl: prUrl as string,
    mode,
    openedPullRequest,
  };
}

async function treeOf(env: ProposeEnvironment, commit: string): Promise<string> {
  return runGit(env.mirrorDir, ['rev-parse', `${commit}^{tree}`]).trim();
}

async function recordError(db: Kysely<Database>, draftId: string, reason: string): Promise<void> {
  await db.updateTable('drafts').set({ propose_error: reason }).where('id', '=', draftId).execute();
}

export type PullRequestEvent = 'merged' | 'closed' | 'reopened';

/**
 * A `pull_request` webhook for an OxyBook branch (ARCHITECTURE §4.6): merged and closed
 * are final for the draft; reopened brings a closed one back to proposed. Matched by the
 * PR branch and number, so a PR someone else opened from the same branch name is ignored.
 */
export async function applyPullRequestEvent(
  db: Kysely<Database>,
  input: { spaceIds: readonly string[]; branch: string; prNumber: number; event: PullRequestEvent },
): Promise<Draft[]> {
  if (input.spaceIds.length === 0) return [];
  const next =
    input.event === 'merged' ? 'merged' : input.event === 'closed' ? 'closed' : 'proposed';
  const from = input.event === 'reopened' ? ['closed'] : ['proposed', 'editing', 'conflicted'];
  const update = db
    .updateTable('drafts')
    .set({ state: next, version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
    .where('space_id', 'in', input.spaceIds)
    .where('branch', '=', input.branch)
    .where('pr_number', '=', input.prNumber)
    .where('state', 'in', from as Draft['state'][])
    .returning(DRAFT_COLUMNS);
  try {
    return (await update.execute()).map(toDraft);
  } catch (error) {
    // Reopened after the author started a new draft: one open draft per user, space,
    // and ref wins. Acknowledge the webhook rather than fail it forever.
    if (input.event === 'reopened' && /drafts_one_open/.test(String(error))) return [];
    throw error;
  }
}
