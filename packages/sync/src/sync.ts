// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, type Kysely, sql } from '@oxybook/db';
import { fetchRef, findRenames, listFiles, readBlobs } from './mirror.js';
import { isPagePath, pageMeta, pageUrl, relativeToRoot } from './pages.js';

export interface SyncTarget {
  orgId: string;
  spaceId: string;
  /** Content root inside the repository, '' for the root. */
  contentRoot: string;
  /** Branch name, without refs/heads/. */
  ref: string;
}

export interface SyncResult {
  from: string | null;
  to: string;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string; fromUrl: string; toUrl: string }[];
  unchanged: number;
  /** Pages left out, with the reason (a URL that another page already has). */
  skipped: { path: string; reason: string }[];
}

interface Row {
  path: string;
  blob: string;
  title: string;
  url: string;
  navTitle: string | null;
  hidden: boolean;
  text: string;
}

/**
 * Bring `pages` for (space, ref) in line with the branch head, in one transaction
 * (ARCHITECTURE §4.2).
 *
 * Every sync compares the whole tree at the new head with the stored rows, instead of
 * applying only `git diff from..to`. Listing a tree reads no blobs, and the comparison
 * corrects itself after a lost webhook, a deleted mirror, or a force-push, which is
 * what reconciliation relies on. `git diff -M` is still used, for renames only.
 */
export async function syncSpace(
  db: Kysely<Database>,
  target: SyncTarget,
  source: { mirrorDir: string; remoteUrl: string; token?: string },
  options: { log?: (line: string) => void } = {},
): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const to = await fetchRef({ ...source, ref: target.ref });
  const state = await db
    .selectFrom('ref_state')
    .select('head_sha')
    .where('space_id', '=', target.spaceId)
    .where('ref', '=', target.ref)
    .executeTakeFirst();
  const from = state?.head_sha ?? null;

  const files = await listFiles(source.mirrorDir, to, target.contentRoot);
  const pageFiles = files
    .map((entry) => ({ ...entry, rel: relativeToRoot(entry.path, target.contentRoot) }))
    .filter(
      (entry): entry is typeof entry & { rel: string } =>
        entry.rel !== null && isPagePath(entry.rel),
    )
    .sort((a, b) => a.rel.localeCompare(b.rel));
  const relPaths = new Set(pageFiles.map((entry) => entry.rel));

  // Bytes: from the content-addressed cache when we have them, else from git.
  const wanted = [...new Set(pageFiles.map((entry) => entry.blob))];
  const cached = wanted.length
    ? await db
        .selectFrom('blobs')
        .select(['sha', 'bytes'])
        .where('org_id', '=', target.orgId)
        .where('sha', 'in', wanted)
        .execute()
    : [];
  const bytes = new Map(cached.map((row) => [row.sha, row.bytes]));
  const fresh = await readBlobs(
    source.mirrorDir,
    wanted.filter((sha) => !bytes.has(sha)),
    source.token,
  );
  for (const [sha, value] of fresh) bytes.set(sha, value);

  const rows: Row[] = [];
  const skipped: SyncResult['skipped'] = [];
  const byUrl = new Map<string, string>();
  for (const entry of pageFiles) {
    const meta = pageMeta(entry.rel, bytes.get(entry.blob) as Buffer);
    const url = pageUrl(entry.rel, relPaths, meta.slug);
    const taken = byUrl.get(url);
    if (taken) {
      skipped.push({ path: entry.rel, reason: `URL ${url} is already used by ${taken}` });
      continue;
    }
    byUrl.set(url, entry.rel);
    rows.push({
      path: entry.rel,
      blob: entry.blob,
      title: meta.title,
      url,
      navTitle: meta.navTitle,
      hidden: meta.hidden,
      text: meta.text,
    });
  }

  const existing = await db
    .selectFrom('pages')
    .select(['path', 'blob_sha', 'url', 'title', 'nav_title', 'hidden'])
    .where('space_id', '=', target.spaceId)
    .where('ref', '=', target.ref)
    .execute();
  const before = new Map(existing.map((row) => [row.path, row]));
  const after = new Map(rows.map((row) => [row.path, row]));
  const added = rows.filter((row) => !before.has(row.path));
  const modified = rows.filter((row) => {
    const old = before.get(row.path);
    return (
      old !== undefined &&
      (old.blob_sha !== row.blob ||
        old.url !== row.url ||
        old.title !== row.title ||
        old.nav_title !== row.navTitle ||
        old.hidden !== row.hidden)
    );
  });
  const deleted = existing.filter((row) => !after.has(row.path)).map((row) => row.path);

  const renamed: SyncResult['renamed'] = [];
  if (from && from !== to) {
    for (const rename of await findRenames(
      source.mirrorDir,
      from,
      to,
      target.contentRoot,
      source.token,
    )) {
      const fromRel = relativeToRoot(rename.from, target.contentRoot);
      const toRel = relativeToRoot(rename.to, target.contentRoot);
      const old = fromRel ? before.get(fromRel) : undefined;
      const now = toRel ? after.get(toRel) : undefined;
      if (fromRel && toRel && old && now && old.url !== now.url) {
        renamed.push({ from: fromRel, to: toRel, fromUrl: old.url, toUrl: now.url });
      }
    }
  }

  const writes = [...added, ...modified];
  await db.transaction().execute(async (trx) => {
    const newBlobs = writes
      .filter((row) => fresh.has(row.blob))
      .map((row) => ({
        org_id: target.orgId,
        sha: row.blob,
        bytes: fresh.get(row.blob) as Buffer,
      }));
    for (const blob of uniqueBy(newBlobs, (b) => b.sha)) {
      await trx
        .insertInto('blobs')
        .values(blob)
        .onConflict((oc) => oc.columns(['org_id', 'sha']).doNothing())
        .execute();
    }
    await trx
      .insertInto('ref_state')
      .values({ org_id: target.orgId, space_id: target.spaceId, ref: target.ref, head_sha: to })
      .onConflict((oc) =>
        oc.columns(['space_id', 'ref']).doUpdateSet({ head_sha: to, synced_at: sql`now()` }),
      )
      .execute();
    // Delete before insert: url is unique per (space, ref), and two pages can swap URLs.
    const remove = [...deleted, ...modified.map((row) => row.path)];
    if (remove.length) {
      await trx
        .deleteFrom('pages')
        .where('space_id', '=', target.spaceId)
        .where('ref', '=', target.ref)
        .where('path', 'in', remove)
        .execute();
    }
    for (const row of writes) {
      await trx
        .insertInto('pages')
        .values({
          org_id: target.orgId,
          space_id: target.spaceId,
          ref: target.ref,
          path: row.path,
          blob_sha: row.blob,
          title: row.title,
          url: row.url,
          nav_title: row.navTitle,
          hidden: row.hidden,
          tsv: sql<string>`setweight(to_tsvector('english', ${row.title}), 'A') || to_tsvector('english', ${row.text})`,
        })
        .execute();
    }
    for (const rename of renamed) {
      await trx
        .insertInto('inferred_redirects')
        .values({
          org_id: target.orgId,
          space_id: target.spaceId,
          ref: target.ref,
          from_url: rename.fromUrl,
          to_url: rename.toUrl,
          from_path: rename.from,
          to_path: rename.to,
          commit_sha: to,
        })
        .onConflict((oc) =>
          oc.columns(['space_id', 'ref', 'from_url']).doUpdateSet({
            to_url: rename.toUrl,
            to_path: rename.to,
            from_path: rename.from,
            commit_sha: to,
          }),
        )
        .execute();
    }
  });

  const result: SyncResult = {
    from,
    to,
    added: added.map((row) => row.path),
    modified: modified.map((row) => row.path),
    deleted,
    renamed,
    unchanged: rows.length - added.length - modified.length,
    skipped,
  };
  log(
    `sync ${target.spaceId} ${target.ref} ${from?.slice(0, 12) ?? 'none'}..${to.slice(0, 12)}: +${result.added.length} ~${result.modified.length} -${result.deleted.length} renamed ${result.renamed.length} unchanged ${result.unchanged}${skipped.length ? ` skipped ${skipped.length}` : ''}`,
  );
  for (const skip of skipped) log(`sync skipped ${skip.path}: ${skip.reason}`);
  return result;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
