// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Database, databaseUrlFromEnv, type Kysely } from '@oxybook/db';
import { buildKey, startJobs, syncKey } from '@oxybook/jobs';
import { runSpaceBuild } from '@oxybook/renderer';
import { runSpaceSync, storedAppTokens } from '@oxybook/sync';
import { createOrg, createSpace, listSpaces, lookupInstallation, parseRepo } from './admin.js';
import { runM1Exit } from './m1-exit.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const USAGE = `usage:
  oxybook-admin org create <slug> [--name <name>]
  oxybook-admin space create <org>/<space> --repo <owner/repo> [--name <name>]
      [--installation-id <id>] [--content-root docs] [--default-ref main]
  oxybook-admin space list
  oxybook-admin sync <org>/<space> [--now]
  oxybook-admin build <org>/<space> [--now]
  oxybook-admin pages <org>/<space>
  oxybook-admin job ping
  oxybook-admin m1-exit

Needs DATABASE_URL. Without --installation-id, space create asks GitHub as the stored App,
which needs OXYBOOK_SECRET_KEY. sync and build queue a job for the worker; --now runs it
here (needs OXYBOOK_SECRET_KEY, mirrors under OXYBOOK_MIRRORS_DIR or ./.oxybook-mirrors,
sites under OXYBOOK_SITES_DIR or ./.oxybook-sites).`;

async function findSpace(db: Kysely<Database>, target: string | undefined) {
  const [orgSlug, slug] = (target ?? '').split('/');
  if (!orgSlug || !slug) throw new Error('expected <org>/<space>');
  const space = await db
    .selectFrom('spaces')
    .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
    .select(['spaces.id as id', 'spaces.default_ref as ref'])
    .where('orgs.slug', '=', orgSlug)
    .where('spaces.slug', '=', slug)
    .executeTakeFirst();
  if (!space) throw new Error(`no space ${orgSlug}/${slug}`);
  return space;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`);
  return value;
}

export async function main(argv: readonly string[], env = process.env): Promise<number> {
  const args = argv.slice(2).filter((arg) => arg !== '--');
  const [noun, verb, target] = args;
  if (!noun || args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    return noun ? 0 : 2;
  }

  if (noun === 'm1-exit') {
    const report = await runM1Exit(env, (line) => console.log(line));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (noun === 'job' && verb === 'ping') {
    const jobs = await startJobs(databaseUrlFromEnv(env), { log: () => {} });
    try {
      const id = await jobs.send('ping', {
        requestedBy: 'oxybook-admin',
        at: new Date().toISOString(),
      });
      if (!id) throw new Error('ping was not queued');
      console.log(`sent ping ${id}`);
      const deadline = Date.now() + 15_000;
      let state = await jobs.state('ping', id);
      while (state !== 'completed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = await jobs.state('ping', id);
      }
      console.log(`ping ${id} ${state ?? 'unknown'}`);
      if (state !== 'completed') {
        console.error(
          'no worker completed it within 15s; is the worker running with DATABASE_URL?',
        );
        return 1;
      }
      return 0;
    } finally {
      await jobs.stop();
    }
  }

  const db = createDb(databaseUrlFromEnv(env), { max: 2 });
  try {
    if (noun === 'org' && verb === 'create' && target) {
      const { id } = await createOrg(db, { slug: target, name: flag(args, '--name') ?? target });
      console.log(`org ${target} ${id}`);
      return 0;
    }
    if (noun === 'space' && verb === 'create' && target) {
      const [orgSlug, slug] = target.split('/');
      if (!orgSlug || !slug) throw new Error('expected <org>/<space>');
      const repoFlag = flag(args, '--repo');
      if (!repoFlag) throw new Error('missing --repo <owner/repo>');
      const { owner, repo } = parseRepo(repoFlag);
      const given = flag(args, '--installation-id');
      const installationId =
        given !== undefined
          ? Number(given)
          : await lookupInstallation(db, env.OXYBOOK_SECRET_KEY, owner, repo);
      if (!Number.isInteger(installationId) || installationId <= 0) {
        throw new Error('--installation-id must be a positive integer');
      }
      const space = await createSpace(db, {
        orgSlug,
        slug,
        name: flag(args, '--name') ?? slug,
        owner,
        repo,
        installationId,
        contentRoot: flag(args, '--content-root') ?? 'docs',
        defaultRef: flag(args, '--default-ref') ?? 'main',
      });
      console.log(
        `space ${orgSlug}/${slug} ${space.id} -> ${owner}/${repo} (installation ${installationId})`,
      );
      return 0;
    }
    if (noun === 'sync') {
      const space = await findSpace(db, verb);
      if (args.includes('--now')) {
        const result = await runSpaceSync(
          {
            db,
            tokenFor: storedAppTokens(db, env.OXYBOOK_SECRET_KEY),
            githubUrl: env.OXYBOOK_GITHUB_URL ?? 'https://github.com',
            mirrorsDir: env.OXYBOOK_MIRRORS_DIR ?? path.join(REPO_ROOT, '.oxybook-mirrors'),
            log: (line) => console.log(line),
          },
          space.id,
        );
        for (const [label, list] of [
          ['added', result.added],
          ['modified', result.modified],
          ['deleted', result.deleted],
        ] as const) {
          for (const item of list) console.log(`${label} ${item}`);
        }
        for (const rename of result.renamed) {
          console.log(
            `renamed ${rename.from} -> ${rename.to} (redirect ${rename.fromUrl} -> ${rename.toUrl})`,
          );
        }
        return 0;
      }
      const jobs = await startJobs(databaseUrlFromEnv(env), { log: () => {} });
      try {
        const id = await jobs.send(
          'sync',
          { spaceId: space.id, ref: space.ref, reason: 'manual' },
          { singletonKey: syncKey(space.id, space.ref) },
        );
        console.log(id ? `queued sync ${id}` : 'a sync for this space is already queued');
      } finally {
        await jobs.stop();
      }
      return 0;
    }
    if (noun === 'build') {
      const space = await findSpace(db, verb);
      if (args.includes('--now')) {
        const result = await runSpaceBuild(
          {
            db,
            tokenFor: storedAppTokens(db, env.OXYBOOK_SECRET_KEY),
            githubUrl: env.OXYBOOK_GITHUB_URL ?? 'https://github.com',
            mirrorsDir: env.OXYBOOK_MIRRORS_DIR ?? path.join(REPO_ROOT, '.oxybook-mirrors'),
            sitesDir: env.OXYBOOK_SITES_DIR ?? path.join(REPO_ROOT, '.oxybook-sites'),
            sitesDomain: env.OXYBOOK_SITES_DOMAIN ?? 'docs.localhost',
            log: (line) => console.log(line),
          },
          space.id,
        );
        console.log(
          `built ${result.buildId} at ${result.commitSha.slice(0, 12)}: ${result.pageCount} pages, ${result.assetCount} assets, ${result.redirectCount} redirects, ${result.warnings.length} warnings`,
        );
        return 0;
      }
      const jobs = await startJobs(databaseUrlFromEnv(env), { log: () => {} });
      try {
        const id = await jobs.send(
          'build',
          { spaceId: space.id, version: 'default', ref: space.ref, reason: 'manual' },
          { singletonKey: buildKey(space.id, 'default') },
        );
        console.log(id ? `queued build ${id}` : 'a build for this space is already queued');
      } finally {
        await jobs.stop();
      }
      return 0;
    }
    if (noun === 'pages') {
      const space = await findSpace(db, verb);
      const state = await db
        .selectFrom('ref_state')
        .select(['head_sha', 'synced_at'])
        .where('space_id', '=', space.id)
        .where('ref', '=', space.ref)
        .executeTakeFirst();
      if (!state) {
        console.log('not synced yet');
        return 0;
      }
      console.log(`${space.ref} at ${state.head_sha}, synced ${state.synced_at.toISOString()}`);
      const rows = await db
        .selectFrom('pages')
        .select(['path', 'url', 'title', 'hidden'])
        .where('space_id', '=', space.id)
        .where('ref', '=', space.ref)
        .orderBy('url')
        .execute();
      for (const row of rows) {
        console.log(`${row.url}\t${row.path}\t${row.title}${row.hidden ? '\t(hidden)' : ''}`);
      }
      return 0;
    }
    if (noun === 'space' && verb === 'list') {
      const rows = await listSpaces(db);
      if (rows.length === 0) console.log('no spaces');
      for (const row of rows) {
        console.log(
          `${row.org}/${row.space}\t${row.repo ?? '-'}\tinstallation ${row.installationId ?? '-'}\troot ${row.contentRoot || '.'}\tref ${row.defaultRef}`,
        );
      }
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    await db.destroy();
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    // Unique violations are the common mistake: say which name is taken.
    console.error(/duplicate key/.test(detail) ? `already exists: ${detail}` : detail);
    process.exitCode = 1;
  },
);
