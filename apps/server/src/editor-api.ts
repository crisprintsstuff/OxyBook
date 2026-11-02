// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database, Kysely } from '@oxybook/db';
import { inspectFrontmatter, parse } from '@oxybook/doc-model';
import {
  type BlobSource,
  type Draft,
  DraftHeadMoved,
  DraftInputError,
  DraftStateError,
  DraftVersionConflict,
  discardDraft,
  draftConflicts,
  draftDiff,
  type FileResolution,
  findOpenDraft,
  listDraftFiles,
  openDraft,
  openDraftsTouching,
  planRename,
  removeDraftFile,
  resolveDraft,
  type SpaceFile,
  saveDraftFile,
  saveDraftFiles,
  spaceRoleOf,
} from '@oxybook/drafts';
import { type JobQueue, proposeKey } from '@oxybook/jobs';
import { renderPage } from '@oxybook/renderer';
import { pageUrl } from '@oxybook/sync';
import {
  deriveCsrfToken,
  loadSessionUser,
  parseCookies,
  SESSION_COOKIE_NAME,
  verifyCsrfToken,
} from './auth.js';

/**
 * The editor's HTTP API (M2 slice 4), under /api/editor/<org>/<space>/. JSON in and out.
 * Every route needs a session and a role on the space: viewers read, editors and admins
 * write. State-changing routes need the session's CSRF token in `x-csrf-token`; saves
 * need the draft version in `If-Match` (ARCHITECTURE §4.4).
 */

export interface EditorApiOptions {
  db: Kysely<Database>;
  secretKey: string | undefined;
  /** Queues the propose job. Without it, propose answers 503. */
  jobs?: Pick<JobQueue, 'send'>;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MAX_JSON_BYTES = 8_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function jsonBody(rawBody: Buffer): Record<string, unknown> {
  if (rawBody.byteLength > MAX_JSON_BYTES) throw new HttpError(413, 'request body too large');
  if (rawBody.byteLength === 0) return {};
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'expected a JSON object');
}

function ifMatch(request: IncomingMessage): number {
  const raw = request.headers['if-match'];
  const value = Number(String(Array.isArray(raw) ? raw[0] : (raw ?? '')).replace(/"/g, ''));
  if (!Number.isInteger(value) || value < 1)
    throw new HttpError(428, 'If-Match with the draft version is required');
  return value;
}

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, `${name} is required`);
  return value;
};

function draftSummary(draft: Draft | null, files: Awaited<ReturnType<typeof listDraftFiles>> = []) {
  if (!draft) return null;
  return {
    id: draft.id,
    version: draft.version,
    state: draft.state,
    baseRef: draft.baseRef,
    baseSha: draft.baseSha,
    branch: draft.branch,
    prNumber: draft.prNumber,
    prUrl: draft.prUrl,
    pushedSha: draft.pushedSha,
    proposeError: draft.proposeError,
    files: files.map((f) => ({ path: f.path, op: f.op, oldPath: f.oldPath })),
  };
}

/** Base blobs for the diff preview, from the read model. Pages are always there. */
function dbBlobs(db: Kysely<Database>, orgId: string): BlobSource {
  return {
    async blob(sha) {
      const row = await db
        .selectFrom('blobs')
        .select('bytes')
        .where('org_id', '=', orgId)
        .where('sha', '=', sha)
        .executeTakeFirst();
      if (!row)
        throw new HttpError(
          409,
          `the base of a drafted file (${sha.slice(0, 12)}) is not synced; sync the space and retry`,
        );
      return row.bytes;
    },
    async at() {
      throw new Error('not available in the app');
    },
  };
}

/**
 * The space's files at its synced head, from the read model, for the conflict view.
 * Pages are all there; a conflict on any other file (an image, `oxybook.yml`) is
 * resolved on GitHub or by discarding, because the app holds no git mirror.
 */
function headBlobs(
  db: Kysely<Database>,
  space: { id: string; orgId: string; ref: string; contentRoot: string },
): BlobSource {
  const base = dbBlobs(db, space.orgId);
  return {
    blob: base.blob,
    async at(commit, path) {
      const state = await db
        .selectFrom('ref_state')
        .select('head_sha')
        .where('space_id', '=', space.id)
        .where('ref', '=', space.ref)
        .executeTakeFirst();
      if (state?.head_sha !== commit)
        throw new HttpError(409, 'the space is syncing; reload in a moment');
      const root = space.contentRoot ? `${space.contentRoot}/` : '';
      if (!path.startsWith(root) || !/\.mdx?$/i.test(path))
        throw new HttpError(
          409,
          `${path} is not a page, so its conflict cannot be shown here; resolve it on GitHub or discard the draft`,
        );
      const row = await db
        .selectFrom('pages')
        .innerJoin('blobs', (join) =>
          join.onRef('blobs.org_id', '=', 'pages.org_id').onRef('blobs.sha', '=', 'pages.blob_sha'),
        )
        .select(['pages.blob_sha as sha', 'blobs.bytes as bytes'])
        .where('pages.space_id', '=', space.id)
        .where('pages.ref', '=', space.ref)
        .where('pages.path', '=', path.slice(root.length))
        .executeTakeFirst();
      return row ?? null;
    },
  };
}

function resolutions(value: unknown): FileResolution[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'resolutions must be a list');
  return value.map((item) => {
    if (!item || typeof item !== 'object')
      throw new HttpError(400, 'a resolution must be an object');
    const r = item as Record<string, unknown>;
    if (typeof r.path !== 'string') throw new HttpError(400, 'a resolution needs a path');
    if (r.take === 'keep-mine' || r.take === 'take-theirs') return { path: r.path, take: r.take };
    if (typeof r.content === 'string')
      return { path: r.path, bytes: Buffer.from(r.content, 'utf8') };
    if (Array.isArray(r.choices))
      return {
        path: r.path,
        choices: r.choices.map((c) => {
          if (c === 'mine' || c === 'theirs') return c;
          if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string')
            return { text: (c as { text: string }).text };
          throw new HttpError(400, 'a choice is "mine", "theirs", or { text }');
        }),
      };
    throw new HttpError(400, `${r.path}: give take, choices, or content`);
  });
}

export function createEditorApi(options: EditorApiOptions) {
  const { db } = options;
  const csrfSecret = options.secretKey ?? 'oxybook-dev-csrf-secret';

  async function context(request: IncomingMessage, orgSlug: string, spaceSlug: string) {
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME);
    const session = await loadSessionUser(db, token, options.now?.() ?? new Date());
    if (!session) throw new HttpError(401, 'sign in first');
    const space = await db
      .selectFrom('spaces')
      .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
      .leftJoin('ref_state', (join) =>
        join
          .onRef('ref_state.space_id', '=', 'spaces.id')
          .onRef('ref_state.ref', '=', 'spaces.default_ref'),
      )
      .select([
        'spaces.id as id',
        'spaces.org_id as orgId',
        'spaces.name as name',
        'spaces.content_root as contentRoot',
        'spaces.default_ref as ref',
        'ref_state.head_sha as head',
      ])
      .where('orgs.slug', '=', orgSlug)
      .where('spaces.slug', '=', spaceSlug)
      .executeTakeFirst();
    // Same answer for "no such space" and "not yours": do not reveal which spaces exist.
    const role = space ? await spaceRoleOf(db, session.user.id, space.id) : null;
    if (!space || !role) throw new HttpError(404, 'no such space');
    return {
      user: session.user,
      csrf: deriveCsrfToken(session.tokenHash, csrfSecret),
      space,
      role,
    };
  }

  type Ctx = Awaited<ReturnType<typeof context>>;

  function requireWrite(request: IncomingMessage, ctx: Ctx): void {
    const header = request.headers['x-csrf-token'];
    if (!verifyCsrfToken(ctx.csrf, Array.isArray(header) ? header[0] : header))
      throw new HttpError(403, 'invalid CSRF token');
    if (ctx.role !== 'editor' && ctx.role !== 'admin')
      throw new HttpError(403, `editing needs the editor or admin role (you are ${ctx.role})`);
  }

  const repoPath = (ctx: Ctx, relPath: string) =>
    ctx.space.contentRoot ? `${ctx.space.contentRoot}/${relPath}` : relPath;

  async function myDraft(ctx: Ctx) {
    return findOpenDraft(db, {
      spaceId: ctx.space.id,
      userId: ctx.user.id,
      baseRef: ctx.space.ref,
    });
  }

  /** A draft the caller owns, or 404. */
  async function ownDraft(ctx: Ctx): Promise<Draft> {
    const draft = await myDraft(ctx);
    if (!draft) throw new HttpError(404, 'no open draft; open one first');
    return draft;
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    ctx: Ctx,
    action: string,
    url: URL,
    rawBody: Buffer,
  ) {
    const method = request.method ?? 'GET';

    if (method === 'GET' && action === 'tree') {
      const pages = await db
        .selectFrom('pages')
        .select(['path', 'url', 'title', 'nav_title as navTitle', 'hidden', 'blob_sha as blobSha'])
        .where('space_id', '=', ctx.space.id)
        .where('ref', '=', ctx.space.ref)
        .orderBy('path')
        .execute();
      const others = await db
        .selectFrom('draft_files')
        .innerJoin('drafts', 'drafts.id', 'draft_files.draft_id')
        .innerJoin('users', 'users.id', 'drafts.user_id')
        .select(['draft_files.path as path', 'users.name as name'])
        .where('drafts.space_id', '=', ctx.space.id)
        .where('drafts.user_id', '!=', ctx.user.id)
        .where('drafts.state', 'in', ['editing', 'proposed', 'conflicted'])
        .execute();
      const draft = await myDraft(ctx);
      sendJson(response, 200, {
        space: {
          name: ctx.space.name,
          contentRoot: ctx.space.contentRoot,
          ref: ctx.space.ref,
          head: ctx.space.head,
        },
        user: { id: ctx.user.id, name: ctx.user.name },
        role: ctx.role,
        csrfToken: ctx.csrf,
        pages: pages.map((p) => {
          const path = repoPath(ctx, p.path);
          return {
            ...p,
            relPath: p.path,
            path,
            othersEditing: [...new Set(others.filter((o) => o.path === path).map((o) => o.name))],
          };
        }),
        draft: draftSummary(draft, draft ? await listDraftFiles(db, draft.id) : []),
      });
      return;
    }

    if (method === 'GET' && action === 'page') {
      const path = str(url.searchParams.get('path'), 'path');
      const draft = await myDraft(ctx);
      const drafted = draft
        ? (await listDraftFiles(db, draft.id)).find((f) => f.path === path)
        : undefined;
      if (drafted) {
        if (drafted.op === 'delete') throw new HttpError(410, `${path} is deleted in your draft`);
        sendJson(response, 200, {
          path,
          source: drafted.bytes?.toString('utf8') ?? '',
          baseBlobSha: drafted.baseBlobSha,
          fromDraft: true,
          op: drafted.op,
        });
        return;
      }
      const rel =
        ctx.space.contentRoot && path.startsWith(`${ctx.space.contentRoot}/`)
          ? path.slice(ctx.space.contentRoot.length + 1)
          : path;
      const page = await db
        .selectFrom('pages')
        .innerJoin('blobs', (join) =>
          join.onRef('blobs.org_id', '=', 'pages.org_id').onRef('blobs.sha', '=', 'pages.blob_sha'),
        )
        .select(['pages.blob_sha as blobSha', 'blobs.bytes as bytes'])
        .where('pages.space_id', '=', ctx.space.id)
        .where('pages.ref', '=', ctx.space.ref)
        .where('pages.path', '=', rel)
        .executeTakeFirst();
      if (!page) throw new HttpError(404, `no page ${path}`);
      const touching = await openDraftsTouching(db, {
        spaceId: ctx.space.id,
        path,
        excludeUserId: ctx.user.id,
      });
      sendJson(response, 200, {
        path,
        source: page.bytes.toString('utf8'),
        baseBlobSha: page.blobSha,
        fromDraft: false,
        othersEditing: touching.map((t) => t.userName),
      });
      return;
    }

    if (method === 'GET' && action === 'draft') {
      const draft = await myDraft(ctx);
      sendJson(response, 200, {
        draft: draftSummary(draft, draft ? await listDraftFiles(db, draft.id) : []),
      });
      return;
    }

    if (method === 'GET' && action === 'draft/diff') {
      const draft = await ownDraft(ctx);
      sendJson(response, 200, { files: await draftDiff(db, draft, dbBlobs(db, ctx.space.orgId)) });
      return;
    }

    if (method === 'POST' && action === 'preview') {
      const body = jsonBody(rawBody);
      const path = str(body.path, 'path');
      const content = typeof body.content === 'string' ? body.content : '';
      const rel =
        ctx.space.contentRoot && path.startsWith(`${ctx.space.contentRoot}/`)
          ? path.slice(ctx.space.contentRoot.length + 1)
          : path;
      const pages = await db
        .selectFrom('pages')
        .select(['path', 'url'])
        .where('space_id', '=', ctx.space.id)
        .where('ref', '=', ctx.space.ref)
        .execute();
      // Preview runs the same renderer as the build: nothing in the page is executed.
      const result = await renderPage(content, {
        filename: rel,
        pages: new Map(pages.map((p) => [p.path, p.url])),
      });
      sendJson(response, 200, {
        parsed: result.parsed,
        ...(result.error ? { error: result.error } : {}),
        html: result.html,
        warnings: result.warnings,
      });
      return;
    }

    if (method === 'GET' && action === 'draft/conflicts') {
      const draft = await ownDraft(ctx);
      if (draft.state !== 'conflicted') {
        sendJson(response, 200, {
          draftId: draft.id,
          version: draft.version,
          head: ctx.space.head,
          files: [],
        });
        return;
      }
      sendJson(response, 200, await draftConflicts(db, draft.id, headBlobs(db, ctx.space)));
      return;
    }

    // Everything below writes.
    requireWrite(request, ctx);

    if (method === 'POST' && action === 'draft') {
      const draft = await openDraft(db, {
        spaceId: ctx.space.id,
        userId: ctx.user.id,
        baseRef: ctx.space.ref,
      });
      sendJson(response, 200, { draft: draftSummary(draft, await listDraftFiles(db, draft.id)) });
      return;
    }

    if (method === 'PUT' && action === 'draft/file') {
      const draft = await ownDraft(ctx);
      const body = jsonBody(rawBody);
      const op = str(body.op, 'op');
      if (!['add', 'modify', 'delete', 'rename'].includes(op))
        throw new HttpError(400, 'op must be add, modify, delete, or rename');
      const bytes =
        typeof body.contentBase64 === 'string'
          ? Buffer.from(body.contentBase64, 'base64')
          : typeof body.content === 'string'
            ? Buffer.from(body.content, 'utf8')
            : undefined;
      const saved = await saveDraftFile(db, {
        draftId: draft.id,
        ifMatch: ifMatch(request),
        op: op as 'add' | 'modify' | 'delete' | 'rename',
        path: str(body.path, 'path'),
        ...(typeof body.oldPath === 'string' ? { oldPath: body.oldPath } : {}),
        ...(typeof body.baseBlobSha === 'string' ? { baseBlobSha: body.baseBlobSha } : {}),
        ...(bytes ? { bytes } : {}),
      });
      sendJson(response, 200, { version: saved.version });
      return;
    }

    if (method === 'DELETE' && action === 'draft/file') {
      const draft = await ownDraft(ctx);
      const saved = await removeDraftFile(db, {
        draftId: draft.id,
        ifMatch: ifMatch(request),
        path: str(url.searchParams.get('path'), 'path'),
      });
      sendJson(response, 200, { version: saved.version });
      return;
    }

    if (method === 'POST' && action === 'draft/discard') {
      const draft = await ownDraft(ctx);
      const closed = await discardDraft(db, { draftId: draft.id, ifMatch: ifMatch(request) });
      sendJson(response, 200, { draft: draftSummary(closed) });
      return;
    }

    if (method === 'POST' && action === 'draft/resolve') {
      const draft = await ownDraft(ctx);
      const body = jsonBody(rawBody);
      const resolved = await resolveDraft(db, {
        draftId: draft.id,
        ifMatch: ifMatch(request),
        head: str(body.head, 'head'),
        source: headBlobs(db, ctx.space),
        resolutions: resolutions(body.resolutions),
      });
      sendJson(response, 200, {
        draft: draftSummary(resolved, await listDraftFiles(db, resolved.id)),
      });
      return;
    }

    if (method === 'POST' && action === 'draft/rename') {
      const draft = await ownDraft(ctx);
      if (draft.state === 'conflicted')
        throw new HttpError(409, 'the draft has conflicts with new commits; resolve them first');
      const body = jsonBody(rawBody);
      const from = str(body.from, 'from');
      const to = str(body.to, 'to');
      const root = ctx.space.contentRoot ? `${ctx.space.contentRoot}/` : '';
      if (!to.startsWith(root)) throw new HttpError(400, `pages live under ${root || 'the root'}`);

      // The space as the draft sees it: the synced pages, overlaid with the draft's files.
      const head = await db
        .selectFrom('pages')
        .innerJoin('blobs', (join) =>
          join.onRef('blobs.org_id', '=', 'pages.org_id').onRef('blobs.sha', '=', 'pages.blob_sha'),
        )
        .select([
          'pages.path as rel',
          'pages.url as url',
          'pages.blob_sha as sha',
          'blobs.bytes as bytes',
        ])
        .where('pages.space_id', '=', ctx.space.id)
        .where('pages.ref', '=', ctx.space.ref)
        .execute();
      const files = new Map<string, SpaceFile>();
      for (const row of head)
        files.set(root + row.rel, {
          path: root + row.rel,
          bytes: row.bytes,
          baseBlobSha: row.sha,
          drafted: null,
        });
      const drafted = await listDraftFiles(db, draft.id);
      let configFile: (typeof drafted)[number] | undefined;
      for (const f of drafted) {
        if (f.path === 'oxybook.yml') {
          configFile = f;
          continue;
        }
        if (f.op === 'delete') files.delete(f.path);
        else {
          if (f.op === 'rename' && f.oldPath) files.delete(f.oldPath);
          if (/\.mdx?$/i.test(f.path))
            files.set(f.path, {
              path: f.path,
              bytes: f.bytes ?? Buffer.alloc(0),
              baseBlobSha: f.baseBlobSha,
              drafted: { op: f.op, oldPath: f.oldPath },
            });
        }
      }
      let config: { bytes: Buffer | null; baseBlobSha: string | null; drafted: boolean };
      if (configFile) {
        config = { bytes: configFile.bytes, baseBlobSha: configFile.baseBlobSha, drafted: true };
      } else {
        const state = await db
          .selectFrom('ref_state')
          .select('config_blob_sha')
          .where('space_id', '=', ctx.space.id)
          .where('ref', '=', ctx.space.ref)
          .executeTakeFirst();
        const sha = state?.config_blob_sha ?? null;
        if (sha === null)
          throw new HttpError(
            409,
            'sync the space once (Sync & rebuild on the space page) so OxyBook knows its oxybook.yml, then rename',
          );
        config =
          sha === 'none'
            ? { bytes: null, baseBlobSha: null, drafted: false }
            : {
                bytes: await dbBlobs(db, ctx.space.orgId).blob(sha),
                baseBlobSha: sha,
                drafted: false,
              };
      }

      // URLs: the one the site serves now (the original path's, for a page already moved in
      // this draft), and the one it will serve. A frontmatter slug keeps the URL.
      const moving = files.get(from);
      const origin = moving?.drafted?.op === 'rename' ? moving.drafted.oldPath : from;
      const oldUrl = head.find((row) => root + row.rel === origin)?.url ?? null;
      const relPaths = new Set(
        [...files.keys()].filter((p) => p !== from).map((p) => p.slice(root.length)),
      );
      relPaths.add(to.slice(root.length));
      const parsed = moving ? parse(moving.bytes.toString('utf8'), { filename: from }) : null;
      const slug = parsed?.ok ? inspectFrontmatter(parsed.doc).known.slug : undefined;
      const newUrl = pageUrl(to.slice(root.length), relPaths, slug);

      const plan = planRename({ from, to, files: [...files.values()], config, oldUrl, newUrl });
      const saved = await saveDraftFiles(db, {
        draftId: draft.id,
        ifMatch: ifMatch(request),
        files: plan.changes,
        remove: plan.remove,
      });
      sendJson(response, 200, {
        version: saved.version,
        path: to,
        redirect: plan.redirect,
        patched: plan.patched,
        rawMentions: plan.rawMentions,
      });
      return;
    }

    if (method === 'POST' && action === 'draft/propose') {
      const draft = await ownDraft(ctx);
      if (draft.state === 'conflicted')
        throw new HttpError(409, 'the draft has conflicts with new commits; resolve them first');
      if (!options.jobs)
        throw new HttpError(503, 'proposing needs the job queue (DATABASE_URL on the app)');
      const body = jsonBody(rawBody);
      const title = str(typeof body.title === 'string' ? body.title.trim() : body.title, 'title');
      if ((await listDraftFiles(db, draft.id)).length === 0)
        throw new HttpError(400, 'the draft has no changes to propose');
      const job = await options.jobs.send(
        'propose',
        { draftId: draft.id, userId: ctx.user.id, title, signOff: body.signOff === true },
        { singletonKey: proposeKey(draft.id) },
      );
      await db
        .updateTable('drafts')
        .set({ propose_error: null })
        .where('id', '=', draft.id)
        .execute();
      sendJson(response, 202, { job, queued: job !== null });
      return;
    }

    if (method === 'POST' && action === 'upload') {
      const draft = await ownDraft(ctx);
      const path = str(url.searchParams.get('path'), 'path');
      if (!/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path))
        throw new HttpError(400, 'only images can be uploaded');
      const saved = await saveDraftFile(db, {
        draftId: draft.id,
        ifMatch: ifMatch(request),
        op: 'add',
        path,
        bytes: rawBody,
      });
      sendJson(response, 200, { path, version: saved.version });
      return;
    }

    throw new HttpError(404, 'no such editor route');
  }

  return {
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
      rawBody: Buffer,
    ): Promise<boolean> {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const match = /^\/api\/editor\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(
        url.pathname,
      );
      if (!match) return false;
      try {
        const ctx = await context(request, match[1] as string, match[2] as string);
        await route(request, response, ctx, match[3] as string, url, rawBody);
      } catch (error) {
        if (error instanceof HttpError)
          sendJson(response, error.status, { error: error.message, ...error.extra });
        else if (error instanceof DraftVersionConflict)
          sendJson(response, 409, { error: error.message, current: error.current });
        else if (error instanceof DraftStateError)
          sendJson(response, 409, { error: error.message, state: error.state });
        else if (error instanceof DraftInputError)
          sendJson(response, 400, { error: error.message });
        else if (error instanceof DraftHeadMoved)
          sendJson(response, 409, { error: error.message, head: error.current });
        else throw error;
      }
      return true;
    },
  };
}
