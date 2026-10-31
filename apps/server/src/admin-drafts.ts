// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { type Database, type Kysely, sql } from '@oxybook/db';
import { draftDiff, findOpenDraft, getDraft, openDraft, saveDraftFile } from '@oxybook/drafts';
import { type JobQueue, proposeKey } from '@oxybook/jobs';
import { type SyncEnvironment, spaceGit } from '@oxybook/sync';

/**
 * `oxybook-admin draft …`: drive the write path from the command line until the editor
 * (M2 slice 4) exists. The same services the editor will call, nothing more.
 */

async function userByEmail(
  db: Kysely<Database>,
  email: string | undefined,
): Promise<{ id: string; name: string }> {
  if (!email) throw new Error('missing --user <email>');
  const user = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where(sql<boolean>`lower(email) = lower(${email})`)
    .executeTakeFirst();
  if (!user) throw new Error(`no user with email ${email}; sign up first`);
  return user;
}

export async function draftCommand(input: {
  db: Kysely<Database>;
  env: SyncEnvironment;
  jobs: () => Promise<JobQueue>;
  space: { id: string; ref: string };
  verb: string | undefined;
  args: string[];
  flag: (name: string) => string | undefined;
}): Promise<number> {
  const { db, env, space, verb, args, flag } = input;
  const user = await userByEmail(db, flag('--user'));

  if (verb === 'save') {
    const repoPath = args[3];
    if (!repoPath || repoPath.startsWith('--'))
      throw new Error(
        'usage: draft save <org>/<space> <repo-path> --user <email> (--file <local> | --delete)',
      );
    const draft = await openDraft(db, { spaceId: space.id, userId: user.id, baseRef: space.ref });
    const git = await spaceGit(env, space.id);
    await git.fetch(draft.baseRef);
    const base = await git.blobs.at(draft.baseSha, repoPath);
    const remove = args.includes('--delete');
    const file = flag('--file');
    if (!remove && !file) throw new Error('missing --file <local> (or --delete)');
    const saved = await saveDraftFile(db, {
      draftId: draft.id,
      ifMatch: draft.version,
      op: remove ? 'delete' : base ? 'modify' : 'add',
      path: repoPath,
      ...(base ? { baseBlobSha: base.sha } : {}),
      ...(remove ? {} : { bytes: readFileSync(file as string) }),
    });
    console.log(
      `draft ${saved.id} v${saved.version}: ${remove ? 'delete' : base ? 'modify' : 'add'} ${repoPath}`,
    );
    return 0;
  }

  if (verb === 'show') {
    const draft = await findOpenDraft(db, {
      spaceId: space.id,
      userId: user.id,
      baseRef: space.ref,
    });
    if (!draft) {
      console.log('no open draft');
      return 0;
    }
    console.log(
      `draft ${draft.id} v${draft.version} ${draft.state} on ${draft.baseRef}@${draft.baseSha.slice(0, 12)}`,
    );
    if (draft.branch)
      console.log(`branch ${draft.branch}${draft.prUrl ? `  PR ${draft.prUrl}` : ''}`);
    if (draft.proposeError) console.log(`last propose: ${draft.proposeError}`);
    const git = await spaceGit(env, space.id);
    await git.fetch(draft.baseRef);
    for (const diff of await draftDiff(db, draft, git.blobs)) {
      console.log(diff.binary ? `${diff.op} ${diff.path} (binary)` : diff.patch.trimEnd());
    }
    return 0;
  }

  if (verb === 'propose') {
    const draft = await findOpenDraft(db, {
      spaceId: space.id,
      userId: user.id,
      baseRef: space.ref,
    });
    if (!draft) throw new Error('no open draft to propose; save a file first');
    const title = flag('--title');
    if (!title) throw new Error('missing --title "<pull request title>"');
    const jobs = await input.jobs();
    try {
      const id = await jobs.send(
        'propose',
        { draftId: draft.id, userId: user.id, title, signOff: args.includes('--sign-off') },
        { singletonKey: proposeKey(draft.id) },
      );
      if (!id) {
        console.log('a propose for this draft is already queued');
        return 0;
      }
      console.log(`queued propose ${id}; waiting for the worker`);
      const deadline = Date.now() + 120_000;
      let state = await jobs.state('propose', id);
      while (state !== 'completed' && state !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        state = await jobs.state('propose', id);
      }
      const after = await getDraft(db, draft.id);
      console.log(
        `job ${state ?? 'unknown'}; draft ${after?.state}${after?.prUrl ? `, PR ${after.prUrl}` : ''}`,
      );
      if (after?.proposeError) console.log(`error: ${after.proposeError}`);
      return state === 'completed' && !after?.proposeError ? 0 : 1;
    } finally {
      await jobs.stop();
    }
  }

  throw new Error('usage: draft save|show|propose <org>/<space> --user <email> …');
}
