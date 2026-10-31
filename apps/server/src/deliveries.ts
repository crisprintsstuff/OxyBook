// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type Kysely, sql } from '@oxybook/db';
import { applyPullRequestEvent, type PullRequestEvent } from '@oxybook/drafts';
import { type JobQueue, syncKey } from '@oxybook/jobs';

export interface Delivery {
  event: string;
  delivery: string;
  payload: unknown;
}

export type DeliveryOutcome =
  | { kind: 'duplicate' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'queued'; spaces: { spaceId: string; ref: string; job: string | null }[] }
  | { kind: 'drafts'; event: PullRequestEvent; drafts: { draftId: string; state: string }[] };

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { name?: unknown; owner?: { login?: unknown; name?: unknown } };
}

/**
 * What the app does with a verified webhook (ARCHITECTURE §5.4): dedupe by
 * X-GitHub-Delivery, then turn a push to a space's default branch into a sync job.
 * Everything else is acknowledged and ignored for now.
 */
export async function handleDelivery(
  db: Kysely<Database>,
  jobs: Pick<JobQueue, 'send'>,
  input: Delivery,
): Promise<DeliveryOutcome> {
  if (input.delivery !== 'unknown') {
    const inserted = await db
      .insertInto('webhook_deliveries')
      .values({ delivery_id: input.delivery, event: input.event })
      .onConflict((oc) => oc.column('delivery_id').doNothing())
      .returning('delivery_id')
      .executeTakeFirst();
    if (!inserted) return { kind: 'duplicate' };
  }
  if (input.event === 'pull_request') return handlePullRequest(db, input.payload);
  if (input.event !== 'push') return { kind: 'ignored', reason: `event ${input.event}` };

  const payload = (input.payload ?? {}) as PushPayload;
  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  if (!ref.startsWith('refs/heads/')) return { kind: 'ignored', reason: `ref ${ref || 'missing'}` };
  if (payload.deleted === true) return { kind: 'ignored', reason: `branch ${ref} deleted` };
  const branch = ref.slice('refs/heads/'.length);
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name;
  const repo = payload.repository?.name;
  if (typeof owner !== 'string' || typeof repo !== 'string') {
    return { kind: 'ignored', reason: 'push without repository owner and name' };
  }

  // GitHub owner and repo names are case-insensitive.
  const spaces = await db
    .selectFrom('spaces')
    .select('id')
    .where(sql<boolean>`lower(repo_owner) = lower(${owner})`)
    .where(sql<boolean>`lower(repo_name) = lower(${repo})`)
    .where('default_ref', '=', branch)
    .execute();
  if (spaces.length === 0) {
    return { kind: 'ignored', reason: `no space follows ${owner}/${repo}@${branch}` };
  }
  const queued: { spaceId: string; ref: string; job: string | null }[] = [];
  for (const space of spaces) {
    const job = await jobs.send(
      'sync',
      {
        spaceId: space.id,
        ref: branch,
        reason: 'push',
        deliveryId: input.delivery,
        ...(typeof payload.after === 'string' ? { after: payload.after } : {}),
      },
      { singletonKey: syncKey(space.id, branch) },
    );
    queued.push({ spaceId: space.id, ref: branch, job });
  }
  return { kind: 'queued', spaces: queued };
}

interface PullRequestPayload {
  action?: unknown;
  pull_request?: { number?: unknown; merged?: unknown; head?: { ref?: unknown } };
  repository?: { name?: unknown; owner?: { login?: unknown } };
}

/**
 * A pull request on an OxyBook branch was merged, closed, or reopened (ARCHITECTURE
 * §4.6): move the draft that opened it. Matched by repository, branch, and PR number.
 */
async function handlePullRequest(db: Kysely<Database>, raw: unknown): Promise<DeliveryOutcome> {
  const payload = (raw ?? {}) as PullRequestPayload;
  const pr = payload.pull_request;
  const branch = pr?.head?.ref;
  const number = pr?.number;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  if (
    typeof branch !== 'string' ||
    typeof number !== 'number' ||
    typeof owner !== 'string' ||
    typeof repo !== 'string'
  ) {
    return { kind: 'ignored', reason: 'pull_request without branch, number, or repository' };
  }
  if (!branch.startsWith('oxybook/'))
    return { kind: 'ignored', reason: `branch ${branch} is not an OxyBook branch` };
  let event: PullRequestEvent;
  if (payload.action === 'closed') event = pr?.merged === true ? 'merged' : 'closed';
  else if (payload.action === 'reopened') event = 'reopened';
  else return { kind: 'ignored', reason: `pull_request ${String(payload.action)}` };
  const spaces = await db
    .selectFrom('spaces')
    .select('id')
    .where(sql<boolean>`lower(repo_owner) = lower(${owner})`)
    .where(sql<boolean>`lower(repo_name) = lower(${repo})`)
    .execute();
  const drafts = await applyPullRequestEvent(db, {
    spaceIds: spaces.map((space) => space.id),
    branch,
    prNumber: number,
    event,
  });
  if (drafts.length === 0) return { kind: 'ignored', reason: `no draft owns ${branch} #${number}` };
  return { kind: 'drafts', event, drafts: drafts.map((d) => ({ draftId: d.id, state: d.state })) };
}

/** Delivery ids older than this are forgotten; GitHub does not redeliver after days. */
export async function pruneDeliveries(db: Kysely<Database>, olderThanDays = 7): Promise<void> {
  await db
    .deleteFrom('webhook_deliveries')
    .where('received_at', '<', sql<Date>`now() - make_interval(days => ${olderThanDays})`)
    .execute();
}
