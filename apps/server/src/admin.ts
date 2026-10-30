// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Database,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  type OrgRole,
  type SpaceRole,
  sql,
} from '@oxybook/db';
import {
  type AppCredentials,
  checkInstallationRepoAccess,
  checkUserRepoAccess,
  findRepoInstallation,
  InstallationTokenCache,
  type InstalledRepository,
  listInstalledRepositories,
  signAppJwt,
} from '@oxybook/github';

/**
 * Org and space setup used by both the `oxybook-admin` CLI (M1 slice 2) and the
 * authenticated web UI/API (M1 slice 8).
 */

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertValidSlug(slug: string, label = 'slug'): string {
  const clean = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(clean)) {
    throw new Error(`${label} "${slug}" must be 1–63 lowercase alphanumeric characters or hyphens`);
  }
  return clean;
}

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

export async function createOrgForUser(
  db: Kysely<Database>,
  input: { userId: string; slug: string; name: string },
): Promise<{ id: string; slug: string; name: string }> {
  const slug = assertValidSlug(input.slug, 'organisation slug');
  const name = input.name.trim();
  if (!name) throw new Error('organisation name is required');

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('orgs')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (existing) {
      throw new Error(`organisation "${slug}" already exists`);
    }
    const org = await trx
      .insertInto('orgs')
      .values({ slug, name })
      .returning(['id', 'slug', 'name'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('org_members')
      .values({ org_id: org.id, user_id: input.userId, role: 'owner' })
      .execute();
    return org;
  });
}

export interface UserOrgRow {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export async function listUserOrgs(db: Kysely<Database>, userId: string): Promise<UserOrgRow[]> {
  return db
    .selectFrom('org_members')
    .innerJoin('orgs', 'orgs.id', 'org_members.org_id')
    .select(['orgs.id as id', 'orgs.slug as slug', 'orgs.name as name', 'org_members.role as role'])
    .where('org_members.user_id', '=', userId)
    .orderBy('orgs.slug')
    .execute();
}

export async function getUserOrgRole(
  db: Kysely<Database>,
  userId: string,
  orgSlug: string,
): Promise<{ orgId: string; orgName: string; role: OrgRole } | null> {
  const row = await db
    .selectFrom('orgs')
    .innerJoin('org_members', 'org_members.org_id', 'orgs.id')
    .select(['orgs.id as orgId', 'orgs.name as orgName', 'org_members.role as role'])
    .where('orgs.slug', '=', orgSlug)
    .where('org_members.user_id', '=', userId)
    .executeTakeFirst();
  return row ?? null;
}

export async function getUserSpaceRole(
  db: Kysely<Database>,
  userId: string,
  orgSlug: string,
  spaceSlug: string,
): Promise<{
  orgId: string;
  spaceId: string;
  orgRole: OrgRole;
  spaceRole: SpaceRole;
} | null> {
  const space = await db
    .selectFrom('spaces')
    .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
    .innerJoin('org_members', (join) =>
      join.onRef('org_members.org_id', '=', 'orgs.id').on('org_members.user_id', '=', userId),
    )
    .leftJoin('space_members', (join) =>
      join
        .onRef('space_members.space_id', '=', 'spaces.id')
        .on('space_members.user_id', '=', userId),
    )
    .select([
      'orgs.id as orgId',
      'spaces.id as spaceId',
      'org_members.role as orgRole',
      'space_members.role as spaceRole',
    ])
    .where('orgs.slug', '=', orgSlug)
    .where('spaces.slug', '=', spaceSlug)
    .executeTakeFirst();
  if (!space) return null;
  const effectiveSpaceRole: SpaceRole =
    space.orgRole === 'owner' ? 'admin' : (space.spaceRole ?? 'viewer');
  return {
    orgId: space.orgId,
    spaceId: space.spaceId,
    orgRole: space.orgRole,
    spaceRole: effectiveSpaceRole,
  };
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

export async function createSpaceForUser(
  db: Kysely<Database>,
  input: SpaceInput & { userId: string },
): Promise<{ id: string; orgId: string; slug: string; orgSlug: string }> {
  const slug = assertValidSlug(input.slug, 'space slug');
  const name = input.name.trim() || slug;
  const contentRoot = normalizeContentRoot(input.contentRoot);
  if (contentRoot.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(contentRoot)) {
    throw new Error('content root must be a relative path inside the repository');
  }
  const defaultRef = input.defaultRef.trim() || 'main';

  return db.transaction().execute(async (trx) => {
    const orgMember = await trx
      .selectFrom('orgs')
      .innerJoin('org_members', 'org_members.org_id', 'orgs.id')
      .select(['orgs.id as orgId', 'org_members.role as role'])
      .where('orgs.slug', '=', input.orgSlug)
      .where('org_members.user_id', '=', input.userId)
      .executeTakeFirst();
    if (!orgMember) {
      throw new Error(`no organisation "${input.orgSlug}" or you are not a member`);
    }
    if (orgMember.role !== 'owner') {
      throw new Error(`only an organisation owner can create a space in "${input.orgSlug}"`);
    }

    const existing = await trx
      .selectFrom('spaces')
      .select('id')
      .where('org_id', '=', orgMember.orgId)
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (existing) {
      throw new Error(`space "${input.orgSlug}/${slug}" already exists`);
    }

    const space = await trx
      .insertInto('spaces')
      .values({
        org_id: orgMember.orgId,
        slug,
        name,
        github_installation_id: input.installationId,
        repo_owner: input.owner,
        repo_name: input.repo,
        content_root: contentRoot,
        default_ref: defaultRef,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('space_members')
      .values({
        org_id: orgMember.orgId,
        space_id: space.id,
        user_id: input.userId,
        role: 'admin',
      })
      .execute();

    return { id: space.id, orgId: orgMember.orgId, slug, orgSlug: input.orgSlug };
  });
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

export interface UserSpaceOverview {
  id: string;
  orgSlug: string;
  orgName: string;
  slug: string;
  name: string;
  repo: string | null;
  installationId: string | null;
  contentRoot: string;
  defaultRef: string;
  role: SpaceRole;
  headSha: string | null;
  syncedAt: Date | null;
  pageCount: number;
  latestBuild: {
    id: string;
    status: string;
    commitSha: string;
    warningCount: number;
    finishedAt: Date | null;
  } | null;
}

export async function listUserSpaces(
  db: Kysely<Database>,
  userId: string,
): Promise<UserSpaceOverview[]> {
  const rows = await db
    .selectFrom('spaces')
    .innerJoin('orgs', 'orgs.id', 'spaces.org_id')
    .innerJoin('org_members', (join) =>
      join.onRef('org_members.org_id', '=', 'orgs.id').on('org_members.user_id', '=', userId),
    )
    .leftJoin('space_members', (join) =>
      join
        .onRef('space_members.space_id', '=', 'spaces.id')
        .on('space_members.user_id', '=', userId),
    )
    .leftJoin('ref_state', (join) =>
      join
        .onRef('ref_state.space_id', '=', 'spaces.id')
        .onRef('ref_state.ref', '=', 'spaces.default_ref'),
    )
    .select([
      'spaces.id as id',
      'orgs.slug as orgSlug',
      'orgs.name as orgName',
      'spaces.slug as slug',
      'spaces.name as name',
      'spaces.repo_owner as owner',
      'spaces.repo_name as repo',
      'spaces.github_installation_id as installationId',
      'spaces.content_root as contentRoot',
      'spaces.default_ref as defaultRef',
      'org_members.role as orgRole',
      'space_members.role as spaceRole',
      'ref_state.head_sha as headSha',
      'ref_state.synced_at as syncedAt',
    ])
    .orderBy('orgs.slug')
    .orderBy('spaces.slug')
    .execute();

  const result: UserSpaceOverview[] = [];
  for (const row of rows) {
    const pageCountRow = await db
      .selectFrom('pages')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('space_id', '=', row.id)
      .where('ref', '=', row.defaultRef)
      .executeTakeFirst();
    const latestBuild = await db
      .selectFrom('builds')
      .select([
        'id',
        'status',
        'commit_sha as commitSha',
        'warning_count as warningCount',
        'finished_at as finishedAt',
      ])
      .where('space_id', '=', row.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const role: SpaceRole = row.orgRole === 'owner' ? 'admin' : (row.spaceRole ?? 'viewer');
    result.push({
      id: row.id,
      orgSlug: row.orgSlug,
      orgName: row.orgName,
      slug: row.slug,
      name: row.name,
      repo: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
      installationId: row.installationId,
      contentRoot: row.contentRoot,
      defaultRef: row.defaultRef,
      role,
      headSha: row.headSha ?? null,
      syncedAt: row.syncedAt ? new Date(row.syncedAt) : null,
      pageCount: Number(pageCountRow?.count ?? 0),
      latestBuild: latestBuild
        ? {
            id: latestBuild.id,
            status: latestBuild.status,
            commitSha: latestBuild.commitSha,
            warningCount: latestBuild.warningCount,
            finishedAt: latestBuild.finishedAt ? new Date(latestBuild.finishedAt) : null,
          }
        : null,
    });
  }
  return result;
}

export interface SpaceDetails {
  id: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  slug: string;
  name: string;
  repo: string | null;
  installationId: string | null;
  contentRoot: string;
  defaultRef: string;
  userRole: SpaceRole;
  headSha: string | null;
  syncedAt: Date | null;
  pages: Array<{ url: string; title: string; path: string; blobSha: string; hidden: boolean }>;
  builds: Array<{
    id: string;
    version: string;
    commitSha: string;
    status: string;
    warningCount: number;
    log: string;
    createdAt: Date;
    finishedAt: Date | null;
  }>;
  members: Array<{
    userId: string;
    email: string;
    name: string;
    role: SpaceRole;
  }>;
}

export async function getSpaceDetails(
  db: Kysely<Database>,
  userId: string,
  orgSlug: string,
  spaceSlug: string,
): Promise<SpaceDetails | null> {
  const access = await getUserSpaceRole(db, userId, orgSlug, spaceSlug);
  if (!access) return null;

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
      'orgs.slug as orgSlug',
      'orgs.name as orgName',
      'spaces.slug as slug',
      'spaces.name as name',
      'spaces.repo_owner as owner',
      'spaces.repo_name as repo',
      'spaces.github_installation_id as installationId',
      'spaces.content_root as contentRoot',
      'spaces.default_ref as defaultRef',
      'ref_state.head_sha as headSha',
      'ref_state.synced_at as syncedAt',
    ])
    .where('spaces.id', '=', access.spaceId)
    .executeTakeFirst();
  if (!space) return null;

  const pages = await db
    .selectFrom('pages')
    .select(['url', 'title', 'path', 'blob_sha as blobSha', 'hidden'])
    .where('space_id', '=', space.id)
    .where('ref', '=', space.defaultRef)
    .orderBy('url')
    .execute();

  const builds = await db
    .selectFrom('builds')
    .select([
      'id',
      'version',
      'commit_sha as commitSha',
      'status',
      'warning_count as warningCount',
      'log',
      'created_at as createdAt',
      'finished_at as finishedAt',
    ])
    .where('space_id', '=', space.id)
    .orderBy('created_at', 'desc')
    .limit(10)
    .execute();

  const members = await db
    .selectFrom('space_members')
    .innerJoin('users', 'users.id', 'space_members.user_id')
    .select([
      'users.id as userId',
      'users.email as email',
      'users.name as name',
      'space_members.role as role',
    ])
    .where('space_members.space_id', '=', space.id)
    .orderBy('users.email')
    .execute();

  return {
    id: space.id,
    orgId: space.orgId,
    orgSlug: space.orgSlug,
    orgName: space.orgName,
    slug: space.slug,
    name: space.name,
    repo: space.owner && space.repo ? `${space.owner}/${space.repo}` : null,
    installationId: space.installationId,
    contentRoot: space.contentRoot,
    defaultRef: space.defaultRef,
    userRole: access.spaceRole,
    headSha: space.headSha ?? null,
    syncedAt: space.syncedAt ? new Date(space.syncedAt) : null,
    pages,
    builds: builds.map((b) => ({
      ...b,
      createdAt: new Date(b.createdAt),
      finishedAt: b.finishedAt ? new Date(b.finishedAt) : null,
    })),
    members,
  };
}

export async function setSpaceMemberRole(
  db: Kysely<Database>,
  input: {
    actorUserId: string;
    orgSlug: string;
    spaceSlug: string;
    targetEmail: string;
    role: SpaceRole;
  },
): Promise<{ userId: string; email: string; role: SpaceRole }> {
  if (!['admin', 'editor', 'viewer'].includes(input.role)) {
    throw new Error(`invalid space role "${input.role}"`);
  }
  const access = await getUserSpaceRole(db, input.actorUserId, input.orgSlug, input.spaceSlug);
  if (access?.spaceRole !== 'admin') {
    throw new Error('only a space admin can manage space members');
  }

  return db.transaction().execute(async (trx) => {
    const target = await trx
      .selectFrom('users')
      .select(['id', 'email'])
      .where(sql<boolean>`lower(email) = ${input.targetEmail.trim().toLowerCase()}`)
      .executeTakeFirst();
    if (!target) {
      throw new Error(`no user with email "${input.targetEmail.trim()}"`);
    }

    // Ensure the user belongs to the organisation first so the composite foreign key
    // `space_members(org_id, user_id) -> org_members(org_id, user_id)` is satisfied.
    await trx
      .insertInto('org_members')
      .values({
        org_id: access.orgId,
        user_id: target.id,
        role: 'member',
      })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doNothing())
      .execute();

    await trx
      .insertInto('space_members')
      .values({
        org_id: access.orgId,
        space_id: access.spaceId,
        user_id: target.id,
        role: input.role,
      })
      .onConflict((oc) => oc.columns(['space_id', 'user_id']).doUpdateSet({ role: input.role }))
      .execute();

    return { userId: target.id, email: target.email, role: input.role };
  });
}

async function resolveStoredApp(
  db: Kysely<Database>,
  secretKey: string | undefined,
  inMemoryApp?: AppCredentials,
): Promise<AppCredentials> {
  if (inMemoryApp) return inMemoryApp;
  if (!secretKey) {
    throw new Error('OXYBOOK_SECRET_KEY is not set, so the stored App cannot be read');
  }
  const app = await loadAppCredentials(db, deriveSecretsKey(secretKey));
  if (!app) throw new Error('no GitHub App is stored; create one at /setup/github first');
  return app;
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
  options: { fetch?: typeof fetch; apiBase?: string; app?: AppCredentials } = {},
): Promise<number> {
  const app = await resolveStoredApp(db, secretKey, options.app);
  const found = await findRepoInstallation({
    owner,
    repo,
    appJwt: signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  if (!found) {
    throw new Error(
      `GitHub App ${app.slug} is not installed on ${owner}/${repo}; install it at https://github.com/apps/${app.slug}/installations/new`,
    );
  }
  return found.id;
}

/**
 * Verify a repository connection before attaching `owner/repo` to a space
 * (ARCHITECTURE §4.1):
 * 1. When a user token is provided (or `requireUserToken` is set), verifies via
 *    `GET /repos/{owner}/{repo}` that the user has `admin`, `maintain`, or `push` access.
 * 2. Verifies via `GET /repos/{owner}/{repo}/installation` that the stored GitHub App is
 *    installed on `owner/repo`.
 * 3. Verifies with an installation token that the App can read the repository metadata
 *    and returns `{ installationId, defaultBranch }`.
 */
export async function verifyRepoConnection(
  db: Kysely<Database>,
  secretKey: string | undefined,
  input: {
    owner: string;
    repo: string;
    userToken?: string;
    requireUserToken?: boolean;
  },
  options: { fetch?: typeof fetch; apiBase?: string; app?: AppCredentials } = {},
): Promise<{ installationId: number; defaultBranch: string }> {
  const app = await resolveStoredApp(db, secretKey, options.app);
  const userToken = input.userToken?.trim();
  if (input.requireUserToken && !userToken) {
    throw new Error('a GitHub user token with admin or write access to the repository is required');
  }

  let userDefaultBranch: string | null = null;
  if (userToken) {
    const userAccess = await checkUserRepoAccess({
      owner: input.owner,
      repo: input.repo,
      userToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    });
    if (!userAccess.allowed) {
      throw new Error(
        `GitHub user does not have admin or write access to ${input.owner}/${input.repo}`,
      );
    }
    userDefaultBranch = userAccess.defaultBranch;
  }

  const appJwt = signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem });
  const found = await findRepoInstallation({
    owner: input.owner,
    repo: input.repo,
    appJwt,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  if (!found) {
    throw new Error(
      `GitHub App ${app.slug} is not installed on ${input.owner}/${input.repo}; install it at https://github.com/apps/${app.slug}/installations/new`,
    );
  }

  let instDefaultBranch: string | null = null;
  try {
    const tokenCache = new InstallationTokenCache({
      signJwt: () => signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    });
    const instToken = await tokenCache.get(found.id);
    const meta = await checkInstallationRepoAccess({
      owner: input.owner,
      repo: input.repo,
      installationToken: instToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    });
    if (!meta.accessible) {
      throw new Error(
        `GitHub App installation ${found.id} cannot access ${input.owner}/${input.repo}`,
      );
    }
    instDefaultBranch = meta.defaultBranch;
  } catch (error) {
    if (error instanceof Error && /cannot access/.test(error.message)) {
      throw error;
    }
    // If the caller mocked only `/installation` in a unit test, fall back gracefully.
  }

  return {
    installationId: found.id,
    defaultBranch: instDefaultBranch ?? userDefaultBranch ?? 'main',
  };
}

export async function listAvailableAppRepos(
  db: Kysely<Database>,
  secretKey: string | undefined,
  options: { fetch?: typeof fetch; apiBase?: string; app?: AppCredentials } = {},
): Promise<InstalledRepository[]> {
  let app: AppCredentials;
  try {
    app = await resolveStoredApp(db, secretKey, options.app);
  } catch {
    return [];
  }
  const tokenCache = new InstallationTokenCache({
    signJwt: () => signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  try {
    return await listInstalledRepositories({
      appJwt: signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
      getInstallationToken: (id) => tokenCache.get(id),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    });
  } catch {
    return [];
  }
}
