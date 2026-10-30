// SPDX-License-Identifier: AGPL-3.0-only

import { createDb, databaseUrlFromEnv } from '@oxybook/db';
import { startJobs } from '@oxybook/jobs';
import { createOrg, createSpace, listSpaces, lookupInstallation, parseRepo } from './admin.js';

const USAGE = `usage:
  oxybook-admin org create <slug> [--name <name>]
  oxybook-admin space create <org>/<space> --repo <owner/repo> [--name <name>]
      [--installation-id <id>] [--content-root docs] [--default-ref main]
  oxybook-admin space list
  oxybook-admin job ping

Needs DATABASE_URL. Without --installation-id, space create asks GitHub as the stored App,
which needs OXYBOOK_SECRET_KEY.`;

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

  if (noun === 'job' && verb === 'ping') {
    const jobs = await startJobs(databaseUrlFromEnv(env), { log: () => {} });
    try {
      const id = await jobs.send('ping', {
        requestedBy: 'oxybook-admin',
        at: new Date().toISOString(),
      });
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
