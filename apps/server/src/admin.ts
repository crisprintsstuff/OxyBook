// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Kysely } from '@oxybook/db';
import { findRepoInstallation, signAppJwt } from '@oxybook/github';
import { deriveSecretsKey, loadAppCredentials } from './app-credentials.js';

/**
 * Org and space setup without a UI (M1 slice 2). The UI in slice 8 calls the same
 * functions after its own checks.
 */

export async function createOrg(
  db: Kysely<Database>,
  input: { slug: string; name: string },
): Promise<{ id: string }> {
  return db
    .insertInto('orgs')
    .values({ slug: input.slug, name: input.name })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/** `docs/`, `./docs`, and `docs` all mean the same content root. `.` or empty is the repo root. */
export function normalizeContentRoot(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

export function parseRepo(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error(`expected owner/repo, got "${value}"`);
  return { owner: match[1], repo: match[2] };
}

export interface SpaceInput {
  orgSlug: string;
  slug: string;
  name: string;
  owner: string;
  repo: string;
  installationId: number;
  contentRoot: string;
  defaultRef: string;
}

export async function createSpace(
  db: Kysely<Database>,
  input: SpaceInput,
): Promise<{ id: string; orgId: string }> {
  const org = await db
    .selectFrom('orgs')
    .select('id')
    .where('slug', '=', input.orgSlug)
    .executeTakeFirst();
  if (!org) throw new Error(`no org with slug "${input.orgSlug}"; create it first`);
  const space = await db
    .insertInto('spaces')
    .values({
      org_id: org.id,
      slug: input.slug,
      name: input.name,
      github_installation_id: input.installationId,
      repo_owner: input.owner,
      repo_name: input.repo,
      content_root: normalizeContentRoot(input.contentRoot),
      default_ref: input.defaultRef,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: space.id, orgId: org.id };
}

export interface SpaceRow {
  org: string;
  space: string;
  name: string;
  repo: string | null;
  installationId: string | null;
  contentRoot: string;
  defaultRef: string;
}

export async function listSpaces(db: Kysely<Database>): Promise<SpaceRow[]> {
  const rows = await db
    .selectFrom('spaces')
    .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
    .select([
      'orgs.slug as org',
      'spaces.slug as space',
      'spaces.name as name',
      'spaces.repo_owner as owner',
      'spaces.repo_name as repo',
      'spaces.github_installation_id as installationId',
      'spaces.content_root as contentRoot',
      'spaces.default_ref as defaultRef',
    ])
    .orderBy('orgs.slug')
    .orderBy('spaces.slug')
    .execute();
  return rows.map((row) => ({
    org: row.org,
    space: row.space,
    name: row.name,
    repo: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
    installationId: row.installationId,
    contentRoot: row.contentRoot,
    defaultRef: row.defaultRef,
  }));
}

/**
 * Ask GitHub, as the stored App, which installation covers the repo. Fails clearly when
 * no App is stored or the App is not installed there.
 */
export async function lookupInstallation(
  db: Kysely<Database>,
  secretKey: string | undefined,
  owner: string,
  repo: string,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<number> {
  if (!secretKey) {
    throw new Error('OXYBOOK_SECRET_KEY is not set, so the stored App cannot be read');
  }
  const app = await loadAppCredentials(db, deriveSecretsKey(secretKey));
  if (!app) throw new Error('no GitHub App is stored; create one at /setup/github first');
  const found = await findRepoInstallation({
    owner,
    repo,
    appJwt: signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
    ...options,
  });
  if (!found) {
    throw new Error(
      `GitHub App ${app.slug} is not installed on ${owner}/${repo}; install it at https://github.com/apps/${app.slug}/installations/new`,
    );
  }
  return found.id;
}
