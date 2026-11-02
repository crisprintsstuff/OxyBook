// SPDX-License-Identifier: AGPL-3.0-only

import posixPath from 'node:path/posix';
import { type Database, type Kysely, sql } from '@oxybook/db';
import {
  fetchRef,
  isAssetPath,
  isDirConfigPath,
  listFiles,
  mirrorPath,
  readBlobs,
  relativeToRoot,
  runSpaceSync,
  type SyncEnvironment,
  spaceVersions,
} from '@oxybook/sync';
import {
  type BuildAssetInput,
  type BuildPageInput,
  type BuildVersionResult,
  buildSiteVersion,
} from './build.js';

export interface BuildEnvironment extends SyncEnvironment {
  sitesDir: string;
  sitesDomain?: string;
}

export interface SpaceBuildResult extends BuildVersionResult {
  buildId: string;
  commitSha: string;
  ref: string;
  version: string;
}

interface SpaceRow {
  orgId: string;
  spaceId: string;
  slug: string;
  name: string;
  owner: string | null;
  repo: string | null;
  installationId: number | null;
  contentRoot: string;
  defaultRef: string;
}

async function loadSpaceForBuild(db: Kysely<Database>, spaceId: string): Promise<SpaceRow> {
  const row = await db
    .selectFrom('spaces')
    .select([
      'id',
      'org_id',
      'slug',
      'name',
      'repo_owner',
      'repo_name',
      'github_installation_id',
      'content_root',
      'default_ref',
    ])
    .where('id', '=', spaceId)
    .executeTakeFirst();
  if (!row) throw new Error(`space ${spaceId} does not exist`);
  return {
    orgId: row.org_id,
    spaceId: row.id,
    slug: row.slug,
    name: row.name,
    owner: row.repo_owner,
    repo: row.repo_name,
    installationId: row.github_installation_id !== null ? Number(row.github_installation_id) : null,
    contentRoot: row.content_root,
    defaultRef: row.default_ref,
  };
}

export class VersionNotListed extends Error {
  constructor(
    readonly spaceId: string,
    readonly version: string,
  ) {
    super(`space ${spaceId} does not list a version ${version}`);
    this.name = 'VersionNotListed';
  }
}

/**
 * Build one version of a space from its synced read model (`pages` + `blobs`) and
 * git mirror (`oxybook.yml`, `_dir.yml`, and assets), record the outcome in `builds`,
 * and atomically swap the live release symlink (ARCHITECTURE §5.3).
 */
export async function runSpaceBuild(
  env: BuildEnvironment,
  spaceId: string,
  options: {
    version?: string;
    ref?: string;
    isDefaultVersion?: boolean;
    keepBuilds?: number;
    indexSearch?: boolean;
  } = {},
): Promise<SpaceBuildResult> {
  const space = await loadSpaceForBuild(env.db, spaceId);
  const version = options.version ?? 'default';
  // Published versions come from the default ref's oxybook.yml (§2.6), stored by sync.
  const versions = await spaceVersions(env.db, spaceId);
  const isDefaultVersion = options.isDefaultVersion ?? version === 'default';
  let ref = options.ref ?? space.defaultRef;
  if (version !== 'default' && options.ref === undefined) {
    const listed = versions.find((v) => !v.isDefault && v.name === version);
    if (!listed) throw new VersionNotListed(spaceId, version);
    ref = listed.ref;
  }

  let refState = await env.db
    .selectFrom('ref_state')
    .select('head_sha')
    .where('space_id', '=', spaceId)
    .where('ref', '=', ref)
    .executeTakeFirst();

  if (!refState) {
    await runSpaceSync(env, spaceId, ref);
    refState = await env.db
      .selectFrom('ref_state')
      .select('head_sha')
      .where('space_id', '=', spaceId)
      .where('ref', '=', ref)
      .executeTakeFirst();
    if (!refState) {
      throw new Error(`space ${spaceId} ref ${ref} has not been synced`);
    }
  }

  const headSha = refState.head_sha;
  const buildRow = await env.db
    .insertInto('builds')
    .values({
      org_id: space.orgId,
      space_id: space.spaceId,
      version,
      ref,
      commit_sha: headSha,
      status: 'running',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    env.log?.(line);
  };

  try {
    const pageRows = await env.db
      .selectFrom('pages')
      .innerJoin('blobs', (join) =>
        join.onRef('blobs.org_id', '=', 'pages.org_id').onRef('blobs.sha', '=', 'pages.blob_sha'),
      )
      .select([
        'pages.path as path',
        'pages.blob_sha as blobSha',
        'pages.url as url',
        'pages.title as title',
        'pages.nav_title as navTitle',
        'pages.hidden as hidden',
        'blobs.bytes as bytes',
      ])
      .where('pages.space_id', '=', spaceId)
      .where('pages.ref', '=', ref)
      .orderBy('pages.path')
      .execute();

    const pages: BuildPageInput[] = pageRows.map((row) => ({
      path: row.path,
      blobSha: row.blobSha,
      source: row.bytes.toString('utf8'),
      url: row.url,
      title: row.title,
      navTitle: row.navTitle,
      hidden: row.hidden,
    }));

    const redirectRows = await env.db
      .selectFrom('inferred_redirects')
      .select(['from_url', 'to_url'])
      .where('space_id', '=', spaceId)
      .where('ref', '=', ref)
      .orderBy('from_url')
      .execute();

    const inferredRedirects = redirectRows.map((r) => ({
      from: r.from_url,
      to: r.to_url,
    }));

    let oxybookYaml: string | undefined;
    const dirConfigs = new Map<string, string>();
    const assets: BuildAssetInput[] = [];

    if (space.owner && space.repo) {
      const mDir = mirrorPath(env.mirrorsDir, space.owner, space.repo);
      const token =
        space.installationId !== null ? await env.tokenFor(space.installationId) : undefined;
      const remoteUrl = `${env.githubUrl.replace(/\/$/, '')}/${space.owner}/${space.repo}.git`;

      let rootFiles: { path: string; blob: string }[];
      try {
        rootFiles = await listFiles(mDir, headSha, space.contentRoot);
      } catch {
        await fetchRef({
          mirrorDir: mDir,
          remoteUrl,
          ref,
          ...(token ? { token } : {}),
        });
        rootFiles = await listFiles(mDir, headSha, space.contentRoot);
      }

      const configEntries = await listFiles(mDir, headSha, 'oxybook.yml');
      const configEntry = configEntries.find((e) => e.path === 'oxybook.yml');

      const dirEntries: { dir: string; blob: string }[] = [];
      const assetEntries: { rel: string; blob: string }[] = [];

      for (const entry of rootFiles) {
        const rel = relativeToRoot(entry.path, space.contentRoot);
        if (rel === null) continue;
        if (isDirConfigPath(rel)) {
          const rawDir = posixPath.dirname(rel);
          dirEntries.push({ dir: rawDir === '.' ? '' : rawDir, blob: entry.blob });
        } else if (isAssetPath(rel)) {
          assetEntries.push({ rel, blob: entry.blob });
        }
      }

      const wantedShas = [
        ...new Set([
          ...(configEntry ? [configEntry.blob] : []),
          ...dirEntries.map((d) => d.blob),
          ...assetEntries.map((a) => a.blob),
        ]),
      ];

      const blobBytes = new Map<string, Buffer>();
      if (wantedShas.length > 0) {
        const cached = await env.db
          .selectFrom('blobs')
          .select(['sha', 'bytes'])
          .where('org_id', '=', space.orgId)
          .where('sha', 'in', wantedShas)
          .execute();
        for (const row of cached) blobBytes.set(row.sha, row.bytes);

        const missing = wantedShas.filter((sha) => !blobBytes.has(sha));
        if (missing.length > 0) {
          const fetched = await readBlobs(mDir, missing, token);
          for (const [sha, buf] of fetched) blobBytes.set(sha, buf);
        }
      }

      if (configEntry) {
        const buf = blobBytes.get(configEntry.blob);
        if (buf) oxybookYaml = buf.toString('utf8');
      }
      for (const d of dirEntries) {
        const buf = blobBytes.get(d.blob);
        if (buf) dirConfigs.set(d.dir, buf.toString('utf8'));
      }
      for (const a of assetEntries) {
        const buf = blobBytes.get(a.blob);
        if (buf) assets.push({ path: a.rel, bytes: buf });
      }
    }

    // The switcher links each page to the same URL in every other version that has it.
    let versionSwitch:
      | { name: string; isDefault: boolean; urls: ReadonlySet<string> }[]
      | undefined;
    if (versions.length > 1) {
      const urlRows = await env.db
        .selectFrom('pages')
        .select(['ref', 'url'])
        .where('space_id', '=', spaceId)
        .where(
          'ref',
          'in',
          versions.map((v) => v.ref),
        )
        .execute();
      versionSwitch = versions.map((v) => ({
        name: v.name,
        isDefault: v.isDefault,
        urls: new Set(urlRows.filter((r) => r.ref === v.ref).map((r) => r.url)),
      }));
    }

    const result = await buildSiteVersion({
      spaceId: space.spaceId,
      spaceSlug: space.slug,
      spaceName: space.name,
      version,
      isDefaultVersion,
      ...(versionSwitch ? { versionSwitch } : {}),
      liveVersions: versions.filter((v) => !v.isDefault).map((v) => v.name),
      commitSha: headSha,
      buildId: buildRow.id,
      sitesDir: env.sitesDir,
      ...(env.sitesDomain ? { sitesDomain: env.sitesDomain } : {}),
      ...(oxybookYaml !== undefined ? { oxybookYaml } : {}),
      dirConfigs,
      pages,
      assets,
      inferredRedirects,
      ...(options.keepBuilds !== undefined ? { keepBuilds: options.keepBuilds } : {}),
      ...(options.indexSearch !== undefined ? { indexSearch: options.indexSearch } : {}),
      log,
    });

    await env.db
      .updateTable('builds')
      .set({
        status: 'succeeded',
        warning_count: result.warnings.length,
        log: logLines.join('\n'),
        finished_at: sql`now()`,
      })
      .where('id', '=', buildRow.id)
      .execute();

    return {
      ...result,
      buildId: buildRow.id,
      commitSha: headSha,
      ref,
      version,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logLines.push(`error ${msg}`);
    await env.db
      .updateTable('builds')
      .set({
        status: 'failed',
        log: logLines.join('\n'),
        finished_at: sql`now()`,
      })
      .where('id', '=', buildRow.id)
      .execute();
    throw error;
  }
}
