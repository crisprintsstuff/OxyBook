// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Kysely } from '@oxybook/db';
import { appendRedirect, ConfigEditError } from '@oxybook/doc-model';
import { listDraftFiles, openDraft, saveDraftFiles, spaceRoleOf } from '@oxybook/drafts';
import { type JobQueue, proposeKey } from '@oxybook/jobs';
import { parseRedirectSources } from '@oxybook/sync';

/**
 * Inferred redirects become commits (ARCHITECTURE §2.5, docs/M3-PLAN.md slice 4). Sync
 * serves a redirect for every out-of-band rename at once; a space admin turns them into
 * `redirects:` entries in oxybook.yml through a pull request, after which sync retires them.
 */

export class RedirectCommitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RedirectCommitError';
  }
}

export interface InferredRedirect {
  fromUrl: string;
  toUrl: string;
  fromPath: string;
  toPath: string;
}

export async function listInferredRedirects(
  db: Kysely<Database>,
  space: { id: string; ref: string },
): Promise<InferredRedirect[]> {
  return db
    .selectFrom('inferred_redirects')
    .select([
      'from_url as fromUrl',
      'to_url as toUrl',
      'from_path as fromPath',
      'to_path as toPath',
    ])
    .where('space_id', '=', space.id)
    .where('ref', '=', space.ref)
    .orderBy('from_url')
    .execute();
}

/**
 * Add every inferred redirect oxybook.yml does not have yet to the admin's draft. A draft
 * holding nothing else is proposed right away; otherwise the redirects ride along with the
 * admin's other changes.
 */
export async function commitInferredRedirects(
  db: Kysely<Database>,
  input: { userId: string; spaceId: string; jobs?: Pick<JobQueue, 'send'> },
): Promise<{ added: number; proposed: boolean }> {
  const space = await db
    .selectFrom('spaces')
    .select(['id', 'default_ref as ref'])
    .where('id', '=', input.spaceId)
    .executeTakeFirstOrThrow();
  if ((await spaceRoleOf(db, input.userId, space.id)) !== 'admin')
    throw new RedirectCommitError(403, 'only a space admin can commit redirects');
  const inferred = await listInferredRedirects(db, space);
  if (inferred.length === 0) throw new RedirectCommitError(400, 'there are no inferred redirects');

  const draft = await openDraft(db, {
    spaceId: space.id,
    userId: input.userId,
    baseRef: space.ref,
  });
  if (draft.state === 'conflicted')
    throw new RedirectCommitError(
      409,
      'your draft has conflicts; resolve them in the editor first',
    );
  const files = await listDraftFiles(db, draft.id);
  const drafted = files.find((f) => f.path === 'oxybook.yml');
  let bytes: Buffer | null;
  let baseBlobSha: string | null;
  let op: 'add' | 'modify';
  if (drafted) {
    bytes = drafted.bytes;
    baseBlobSha = drafted.baseBlobSha;
    op = drafted.op === 'add' ? 'add' : 'modify';
  } else {
    const state = await db
      .selectFrom('ref_state')
      .select('config_blob_sha')
      .where('space_id', '=', space.id)
      .where('ref', '=', space.ref)
      .executeTakeFirst();
    const sha = state?.config_blob_sha ?? null;
    if (sha === null)
      throw new RedirectCommitError(
        409,
        'sync the space once so OxyBook knows its oxybook.yml, then try again',
      );
    if (sha === 'none') {
      bytes = null;
      baseBlobSha = null;
      op = 'add';
    } else {
      const blob = await db
        .selectFrom('blobs')
        .select('bytes')
        .where('sha', '=', sha)
        .executeTakeFirstOrThrow();
      bytes = blob.bytes;
      baseBlobSha = sha;
      op = 'modify';
    }
  }

  const present = new Set(bytes ? parseRedirectSources(bytes) : []);
  let text = bytes?.toString('utf8') ?? null;
  let added = 0;
  for (const r of inferred) {
    if (present.has(r.fromUrl)) continue;
    try {
      text = appendRedirect(text, r.fromUrl, r.toUrl);
    } catch (error) {
      if (error instanceof ConfigEditError) throw new RedirectCommitError(400, error.message);
      throw error;
    }
    added++;
  }
  if (added === 0) throw new RedirectCommitError(400, 'oxybook.yml already has these redirects');

  await saveDraftFiles(db, {
    draftId: draft.id,
    ifMatch: draft.version,
    files: [
      {
        op,
        path: 'oxybook.yml',
        ...(baseBlobSha ? { baseBlobSha } : {}),
        bytes: Buffer.from(text as string, 'utf8'),
      },
    ],
  });
  const alone = files.every((f) => f.path === 'oxybook.yml');
  if (alone && input.jobs) {
    await input.jobs.send(
      'propose',
      {
        draftId: draft.id,
        userId: input.userId,
        title:
          added === 1
            ? 'Commit a redirect for a renamed page'
            : `Commit redirects for ${added} renamed pages`,
        signOff: false,
      },
      { singletonKey: proposeKey(draft.id) },
    );
    return { added, proposed: true };
  }
  return { added, proposed: false };
}
