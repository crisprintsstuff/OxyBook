// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import {
  createDb,
  type Database,
  databaseUrlFromEnv,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  sql,
} from '@oxybook/db';
import {
  type EditorBlockNode,
  openEditorDocument,
  serializeEditorState,
  updateEditorBlock,
} from '@oxybook/doc-model';
import { startJobs, syncKey } from '@oxybook/jobs';
import { storedAppTokens, storedUserTokens } from '@oxybook/sync';
import { createSession, SESSION_COOKIE_NAME, signUpUser } from './auth.js';

/**
 * `pnpm m2:exit <org>/<space>` (docs/M2-PLAN.md slice 5) measures the M2 exit sentence
 * (docs/MVP.md) against the running stack (`pnpm dev`: app, worker, Caddy) and the
 * space's real GitHub repository:
 *
 *   An end-to-end test edits one paragraph in an `.mdx` page containing JSX components,
 *   raw HTML and unusual frontmatter, and the resulting PR diff touches only that
 *   paragraph's lines; a non-GitHub user can propose a change that a GitHub user then
 *   merges, and the site updates.
 *
 * It writes to the repository through pull requests only. The first run adds the fixture
 * page (itself proposed and merged the same way); every run after that edits one line.
 */

export const FIXTURE_FILE = 'm2-exit.mdx';
export const MARKER_PREFIX = 'The paragraph the exit run edits. Run marker:';
export const WRITER_EMAIL = 'm2-exit-writer@example.com';

/** The fixture: JSX components, raw HTML, and frontmatter with a comment, a flow list, and a block scalar. */
export const FIXTURE_SOURCE = `---
title: M2 exit check
# frontmatter comment, kept as is
tags: [ oxybook,   "exit" ]
notes: |
  a block scalar
  over two lines
---

# M2 exit check

This page is edited by \`pnpm m2:exit\`. Everything except the marker paragraph must stay byte for byte.

<Tabs>
  <TabItem label="One">First tab.</TabItem>
  <TabItem label="Two">Second tab.</TabItem>
</Tabs>

<div align="center">
  <strong>Raw   HTML</strong>   kept as is
</div>

${MARKER_PREFIX} none yet.

*  odd   bullet list
*  kept byte for byte
`;

/**
 * Edit only the marker paragraph through the editor document bridge, the same
 * `serializeEditorState` path the visual editor uses. Throws if any other byte changed.
 */
export function editMarker(
  source: string,
  filename: string,
  runId: string,
): { text: string; removed: string[]; added: string[] } {
  const opened = openEditorDocument(source, { filename });
  if (opened.mode !== 'visual')
    throw new Error(`${filename} does not open visually (${opened.reason})`);
  const blocks = opened.state.sourceDoc.blocks;
  const index = blocks.findIndex((b) => b.source.startsWith(MARKER_PREFIX));
  const block = blocks[index];
  const current = opened.state.doc.content[index];
  if (!block || current?.type !== 'paragraph')
    throw new Error(`${filename} has no paragraph starting "${MARKER_PREFIX}"`);
  const line = `${MARKER_PREFIX} ${runId}.`;
  const next: EditorBlockNode = {
    type: 'paragraph',
    attrs: { srcId: current.attrs.srcId ?? null },
    content: [{ type: 'text', text: line }],
  };
  const text = serializeEditorState(updateEditorBlock(opened.state, index, next));
  if (text !== source.slice(0, block.start) + line + source.slice(block.end))
    throw new Error('the bridge changed bytes outside the marker paragraph');
  return { text, removed: block.source.split(/\r?\n/), added: [line] };
}

/** The removed and added lines of a unified diff hunk list (GitHub's `patch` field). */
export function patchChanges(patch: string): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1).replace(/\r$/, ''));
    else if (line.startsWith('+')) added.push(line.slice(1).replace(/\r$/, ''));
  }
  return { removed, added };
}

export interface M2ExitReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  space: string;
  repository: string;
  page: string;
  fixturePr: string | null;
  pr: { url: string; number: number; author: string; authorType: string; files: string[] };
  diff: { removed: string[]; added: string[] };
  mergedBy: string;
  mergeSha: string;
  siteUrl: string;
  siteUpdatedBy: 'webhook' | 'manual sync';
  siteUpdateSeconds: number;
  draftState: string;
}

interface Ctx {
  db: Kysely<Database>;
  log: (line: string) => void;
  appUrl: string;
  api: string;
  cookie: string;
  csrf: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(
  ctx: Ctx,
  method: string,
  action: string,
  options: { json?: unknown; ifMatch?: number; query?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const url = `${ctx.api}/${action}${options.query ? `?${new URLSearchParams(options.query)}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: {
      cookie: ctx.cookie,
      ...(method === 'GET' ? {} : { 'x-csrf-token': ctx.csrf }),
      ...(options.ifMatch !== undefined ? { 'if-match': String(options.ifMatch) } : {}),
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface DraftJson {
  version: number;
  state: string;
  prNumber: number | null;
  prUrl: string | null;
  pushedSha: string | null;
  proposeError: string | null;
  files: { path: string }[];
}

async function github<T>(token: string, method: string, path: string, json?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`GitHub ${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Save `text` as the page in a fresh draft, propose it, and wait for the PR. */
async function proposeFile(
  ctx: Ctx,
  file: { path: string; op: 'add' | 'modify'; baseBlobSha: string | null; text: string },
  title: string,
): Promise<DraftJson> {
  const existing = await call<{ draft: DraftJson | null }>(ctx, 'GET', 'draft');
  if (existing.body.draft) {
    ctx.log(
      `      discarding a leftover draft (v${existing.body.draft.version}, ${existing.body.draft.state})`,
    );
    await call(ctx, 'POST', 'draft/discard', { json: {}, ifMatch: existing.body.draft.version });
  }
  const opened = await call<{ draft: DraftJson }>(ctx, 'POST', 'draft', { json: {} });
  if (opened.status !== 200)
    throw new Error(`opening a draft: HTTP ${opened.status} ${JSON.stringify(opened.body)}`);
  const saved = await call<{ version?: number; error?: string }>(ctx, 'PUT', 'draft/file', {
    ifMatch: opened.body.draft.version,
    json: {
      op: file.op,
      path: file.path,
      content: file.text,
      ...(file.baseBlobSha ? { baseBlobSha: file.baseBlobSha } : {}),
    },
  });
  if (saved.status !== 200)
    throw new Error(`saving ${file.path}: HTTP ${saved.status} ${saved.body.error ?? ''}`);
  const proposed = await call<{ error?: string }>(ctx, 'POST', 'draft/propose', {
    json: { title, signOff: false },
  });
  if (proposed.status !== 202)
    throw new Error(`proposing: HTTP ${proposed.status} ${proposed.body.error ?? ''}`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const draft = (await call<{ draft: DraftJson | null }>(ctx, 'GET', 'draft')).body.draft;
    if (draft?.proposeError) throw new Error(`propose failed: ${draft.proposeError}`);
    if (draft?.prUrl && draft.prNumber && draft.pushedSha) return draft;
  }
  throw new Error('no pull request after 3 minutes: is the worker running (pnpm dev)?');
}

async function waitFor<T>(what: string, ms: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function runM2Exit(
  target: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<M2ExitReport> {
  const [orgSlug, spaceSlug] = (target ?? '').split('/');
  if (!orgSlug || !spaceSlug) throw new Error('usage: oxybook-admin m2-exit <org>/<space>');
  const secretKey = env.OXYBOOK_SECRET_KEY;
  if (!secretKey) throw new Error('OXYBOOK_SECRET_KEY is required (the run reads the stored App)');
  const appUrl = (env.M2_EXIT_APP_URL ?? `http://127.0.0.1:${env.PORT ?? '3000'}`).replace(
    /\/$/,
    '',
  );
  const sitesDomain = env.OXYBOOK_SITES_DOMAIN ?? 'docs.localhost';
  const caddyPort = env.CADDY_PORT ?? '8080';
  const runId = `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const db = createDb(databaseUrlFromEnv(env), { max: 2 });

  try {
    // 0. Preconditions: the running app, the space and its repository, the stored App,
    //    and a GitHub-linked admin to merge.
    const health = await fetch(`${appUrl}/healthz`).catch(() => null);
    if (!health?.ok)
      throw new Error(
        `the app is not answering at ${appUrl}/healthz: start pnpm dev (or set M2_EXIT_APP_URL)`,
      );
    const space = await db
      .selectFrom('spaces')
      .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
      .select([
        'spaces.id as id',
        'spaces.org_id as orgId',
        'spaces.repo_owner as owner',
        'spaces.repo_name as repo',
        'spaces.content_root as contentRoot',
        'spaces.default_ref as ref',
        'spaces.github_installation_id as installationId',
      ])
      .where('orgs.slug', '=', orgSlug)
      .where('spaces.slug', '=', spaceSlug)
      .executeTakeFirst();
    if (!space?.owner || !space.repo || !space.installationId)
      throw new Error(`space ${target} is missing or not connected to a GitHub repository`);
    if (!(await loadAppCredentials(db, deriveSecretsKey(secretKey))))
      throw new Error('no GitHub App is stored; create one at /setup/github first');
    const repository = `${space.owner}/${space.repo}`;
    const pagePath = space.contentRoot ? `${space.contentRoot}/${FIXTURE_FILE}` : FIXTURE_FILE;

    const mergerEmail = env.M2_EXIT_MERGER;
    const merger = await db
      .selectFrom('github_accounts')
      .innerJoin('users', 'users.id', 'github_accounts.user_id')
      .leftJoin('space_members', (join) =>
        join
          .onRef('space_members.user_id', '=', 'users.id')
          .on('space_members.space_id', '=', space.id),
      )
      .leftJoin('org_members', (join) =>
        join
          .onRef('org_members.user_id', '=', 'users.id')
          .on('org_members.org_id', '=', space.orgId),
      )
      .select(['users.id as id', 'users.email as email', 'github_accounts.login as login'])
      .where((eb) =>
        eb.or([eb('space_members.role', '=', 'admin'), eb('org_members.role', '=', 'owner')]),
      )
      .$if(Boolean(mergerEmail), (q) =>
        q.where(sql<boolean>`lower(users.email) = lower(${mergerEmail ?? ''})`),
      )
      .executeTakeFirst();
    if (!merger)
      throw new Error(
        'no space admin or org owner has a linked GitHub account: link one from the dashboard first',
      );
    const mergerToken = await storedUserTokens(db, secretKey)(merger.id);
    if (!mergerToken)
      throw new Error(
        `@${merger.login}'s GitHub token is gone or expired: sign in with GitHub again`,
      );
    log(
      `[0/5] ${repository} via ${target}; app at ${appUrl}; merger @${merger.login}; run ${runId}`,
    );

    // 1. The proposer: an OxyBook account with no GitHub account, an editor on the space.
    let writer = await db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', WRITER_EMAIL)
      .executeTakeFirst();
    if (!writer) {
      writer = await signUpUser(db, {
        email: WRITER_EMAIL,
        name: 'M2 exit writer',
        password: randomBytes(18).toString('base64url'),
      });
    }
    if (
      await db
        .selectFrom('github_accounts')
        .select('user_id')
        .where('user_id', '=', writer.id)
        .executeTakeFirst()
    )
      throw new Error(`${WRITER_EMAIL} has a linked GitHub account; it must not, for this check`);
    await db
      .insertInto('org_members')
      .values({ org_id: space.orgId, user_id: writer.id, role: 'member' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await db
      .insertInto('space_members')
      .values({ org_id: space.orgId, space_id: space.id, user_id: writer.id, role: 'editor' })
      .onConflict((oc) => oc.columns(['space_id', 'user_id']).doUpdateSet({ role: 'editor' }))
      .execute();
    const session = await createSession(db, writer.id);
    const ctx: Ctx = {
      db,
      log,
      appUrl,
      api: `${appUrl}/api/editor/${encodeURIComponent(orgSlug)}/${encodeURIComponent(spaceSlug)}`,
      cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
      csrf: '',
    };
    const tree = await call<{ csrfToken: string; role: string }>(ctx, 'GET', 'tree');
    if (tree.status !== 200) throw new Error(`editor API: HTTP ${tree.status}`);
    ctx.csrf = tree.body.csrfToken;
    log(`[1/5] proposer ${WRITER_EMAIL} (no GitHub account), role ${tree.body.role}`);

    const merge = async (prNumber: number) =>
      github<{ merged: boolean; sha: string }>(
        mergerToken.accessToken,
        'PUT',
        `/repos/${repository}/pulls/${prNumber}/merge`,
        { merge_method: 'merge' },
      );
    const pageNow = async () => {
      const page = await call<{ source: string; baseBlobSha: string | null; fromDraft: boolean }>(
        ctx,
        'GET',
        'page',
        { query: { path: pagePath } },
      );
      return page.status === 200 && !page.body.fromDraft ? page.body : null;
    };

    // 2. The fixture page, added through the same propose → merge path on the first run.
    let fixturePr: string | null = null;
    let page = await pageNow();
    if (!page) {
      log(`[2/5] ${pagePath} is not on ${space.ref} yet; proposing it`);
      const added = await proposeFile(
        ctx,
        { path: pagePath, op: 'add', baseBlobSha: null, text: FIXTURE_SOURCE },
        'm2:exit: add the fixture page',
      );
      fixturePr = added.prUrl;
      await merge(added.prNumber as number);
      log(`      merged ${added.prUrl}; waiting for the sync`);
      page = await waitFor('the fixture page to sync', 240_000, pageNow);
    } else {
      log(`[2/5] ${pagePath} is on ${space.ref}`);
    }

    // 3. Edit one paragraph and propose it as the non-GitHub user.
    const edit = editMarker(page.source, pagePath, runId);
    const draft = await proposeFile(
      ctx,
      { path: pagePath, op: 'modify', baseBlobSha: page.baseBlobSha, text: edit.text },
      `m2:exit run ${runId}`,
    );
    log(`[3/5] proposed ${draft.prUrl}`);

    // 4. The pull request touches only that paragraph's lines, and the App opened it.
    const installationToken = await storedAppTokens(db, secretKey)(Number(space.installationId));
    const pr = await github<{
      user: { login: string; type: string };
      number: number;
      html_url: string;
    }>(installationToken, 'GET', `/repos/${repository}/pulls/${draft.prNumber}`);
    const files = await github<{ filename: string; status: string; patch?: string }[]>(
      installationToken,
      'GET',
      `/repos/${repository}/pulls/${draft.prNumber}/files`,
    );
    const only = files[0];
    if (files.length !== 1 || only?.filename !== pagePath || only.status !== 'modified')
      throw new Error(
        `the PR changes ${files.map((f) => `${f.filename} (${f.status})`).join(', ')}, not just ${pagePath}`,
      );
    const diff = patchChanges(only.patch ?? '');
    if (JSON.stringify(diff) !== JSON.stringify({ removed: edit.removed, added: edit.added }))
      throw new Error(`the PR diff is not just the marker paragraph: ${JSON.stringify(diff)}`);
    if (pr.user.type !== 'Bot')
      throw new Error(
        `the PR author is ${pr.user.login} (${pr.user.type}); a proposer without GitHub should get an App-authored PR`,
      );
    log(
      `[4/5] ${pr.html_url}: by ${pr.user.login}, one file, -${diff.removed.length} +${diff.added.length}, only the marker paragraph`,
    );

    // 5. A GitHub user merges; the site updates.
    const merged = await merge(pr.number);
    if (!merged.merged) throw new Error('the merge did not go through');
    const after = await github<{ merged_by: { login: string } | null }>(
      installationToken,
      'GET',
      `/repos/${repository}/pulls/${pr.number}`,
    );
    const pageRow = await db
      .selectFrom('pages')
      .select('url')
      .where('space_id', '=', space.id)
      .where('ref', '=', space.ref)
      .where(
        'path',
        '=',
        space.contentRoot ? pagePath.slice(space.contentRoot.length + 1) : pagePath,
      )
      .executeTakeFirst();
    const siteUrl = `http://${spaceSlug}.${sitesDomain}:${caddyPort}${pageRow?.url ?? '/m2-exit'}`;
    const mergedAt = Date.now();
    const siteHas = async () => {
      const response = await fetch(siteUrl).catch(() => null);
      return response?.ok && (await response.text()).includes(runId) ? true : null;
    };
    let siteUpdatedBy: M2ExitReport['siteUpdatedBy'] = 'webhook';
    try {
      await waitFor('the site to update from the push webhook', 120_000, siteHas);
    } catch {
      log('      no site update within 2 minutes of the merge; queueing a sync by hand');
      siteUpdatedBy = 'manual sync';
      const jobs = await startJobs(databaseUrlFromEnv(env), { log: () => {} });
      try {
        await jobs.send(
          'sync',
          { spaceId: space.id, ref: space.ref, reason: 'manual' },
          { singletonKey: syncKey(space.id, space.ref) },
        );
      } finally {
        await jobs.stop();
      }
      await waitFor('the site to update after a manual sync', 180_000, siteHas);
    }
    const siteUpdateSeconds = Math.round((Date.now() - mergedAt) / 1000);
    const draftState = await waitFor('the draft to be marked merged', 60_000, async () => {
      const row = await db
        .selectFrom('drafts')
        .select('state')
        .where('pr_number', '=', pr.number)
        .where('space_id', '=', space.id)
        .executeTakeFirst();
      return row?.state === 'merged' ? row.state : null;
    }).catch(() => 'not marked merged within 60 s');
    log(
      `[5/5] merged by @${after.merged_by?.login ?? '?'} (${merged.sha.slice(0, 12)}); ${siteUrl} shows run ${runId} after ${siteUpdateSeconds}s (${siteUpdatedBy}); draft ${draftState}`,
    );

    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      space: target as string,
      repository,
      page: pagePath,
      fixturePr,
      pr: {
        url: pr.html_url,
        number: pr.number,
        author: pr.user.login,
        authorType: pr.user.type,
        files: files.map((f) => f.filename),
      },
      diff,
      mergedBy: after.merged_by?.login ?? '',
      mergeSha: merged.sha,
      siteUrl,
      siteUpdatedBy,
      siteUpdateSeconds,
      draftState,
    };
  } finally {
    await db.destroy();
  }
}
