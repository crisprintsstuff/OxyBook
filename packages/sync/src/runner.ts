// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Database,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  loadGithubAccount,
  updateGithubTokens,
} from '@oxybook/db';
import { InstallationTokenCache, refreshUserToken, signAppJwt } from '@oxybook/github';
import { fetchRef, mirrorBlobSource, mirrorPath, pushBranch, remoteHead } from './mirror.js';
import { type SyncResult, syncSpace } from './sync.js';

export interface SyncEnvironment {
  db: Kysely<Database>;
  /** Installation token for git over HTTPS. Undefined for a file:// remote in tests. */
  tokenFor: (installationId: number) => Promise<string | undefined>;
  /** `https://github.com` in production. */
  githubUrl: string;
  mirrorsDir: string;
  log?: (line: string) => void;
}

/**
 * Installation tokens minted from the stored App (ARCHITECTURE §4.1), cached in memory
 * until shortly before expiry. Fails clearly when no App or no key is available.
 */
export function storedAppTokens(
  db: Kysely<Database>,
  secretKey: string | undefined,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): (installationId: number) => Promise<string> {
  let cache: InstallationTokenCache | null = null;
  return async (installationId) => {
    if (!cache) {
      if (!secretKey)
        throw new Error('OXYBOOK_SECRET_KEY is not set, so the stored App cannot be read');
      const app = await loadAppCredentials(db, deriveSecretsKey(secretKey));
      if (!app) throw new Error('no GitHub App is stored; create one at /setup/github first');
      cache = new InstallationTokenCache({
        signJwt: () => signAppJwt({ appId: app.id, privateKeyPem: app.privateKeyPem }),
        ...options,
      });
    }
    return cache.get(installationId);
  };
}

export interface UserGithub {
  accessToken: string;
  githubUserId: number;
  login: string;
}

/**
 * A linked user's GitHub token, refreshed when it is within five minutes of expiry
 * (GitHub App user tokens last eight hours). Null when the user has no linked account,
 * or its refresh token is gone or rejected: the caller falls back to the App.
 */
export function storedUserTokens(
  db: Kysely<Database>,
  secretKey: string | undefined,
  options: {
    fetch?: typeof fetch;
    githubHost?: string;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
): (userId: string) => Promise<UserGithub | null> {
  return async (userId) => {
    if (!secretKey) return null;
    const key = deriveSecretsKey(secretKey);
    const account = await loadGithubAccount(db, key, userId);
    if (!account) return null;
    const now = (options.now ?? Date.now)();
    const fresh = !account.accessExpiresAt || account.accessExpiresAt.getTime() - now > 5 * 60_000;
    if (fresh)
      return {
        accessToken: account.accessToken,
        githubUserId: account.githubUserId,
        login: account.login,
      };
    const refreshable =
      account.refreshToken &&
      (!account.refreshExpiresAt || account.refreshExpiresAt.getTime() > now);
    const app = refreshable ? await loadAppCredentials(db, key) : null;
    if (!refreshable || !app) {
      options.log?.(
        `github token for @${account.login} expired and cannot be refreshed; using the App`,
      );
      return null;
    }
    try {
      const token = await refreshUserToken(
        {
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          refreshToken: account.refreshToken as string,
        },
        {
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.githubHost ? { githubHost: options.githubHost } : {}),
          ...(options.now ? { now: options.now } : {}),
        },
      );
      await updateGithubTokens(db, key, userId, token);
      return {
        accessToken: token.accessToken,
        githubUserId: account.githubUserId,
        login: account.login,
      };
    } catch (error) {
      options.log?.(
        `github token refresh for @${account.login} failed (${error instanceof Error ? error.message : String(error)}); using the App`,
      );
      return null;
    }
  };
}

interface SpaceSource {
  orgId: string;
  spaceId: string;
  owner: string;
  repo: string;
  installationId: number;
  contentRoot: string;
  defaultRef: string;
}

async function loadSpace(db: Kysely<Database>, spaceId: string): Promise<SpaceSource> {
  const row = await db
    .selectFrom('spaces')
    .select([
      'id',
      'org_id',
      'repo_owner',
      'repo_name',
      'github_installation_id',
      'content_root',
      'default_ref',
    ])
    .where('id', '=', spaceId)
    .executeTakeFirst();
  if (!row) throw new Error(`space ${spaceId} does not exist`);
  if (!row.repo_owner || !row.repo_name || !row.github_installation_id) {
    throw new Error(`space ${spaceId} is not connected to a repository`);
  }
  return {
    orgId: row.org_id,
    spaceId: row.id,
    owner: row.repo_owner,
    repo: row.repo_name,
    installationId: Number(row.github_installation_id),
    contentRoot: row.content_root,
    defaultRef: row.default_ref,
  };
}

function remoteUrl(env: SyncEnvironment, space: SpaceSource): string {
  return `${env.githubUrl.replace(/\/$/, '')}/${space.owner}/${space.repo}.git`;
}

/** Blob reads from a space's mirror, with its installation token, for drafts. */
export async function spaceBlobSource(env: SyncEnvironment, spaceId: string) {
  const space = await loadSpace(env.db, spaceId);
  const token = await env.tokenFor(space.installationId);
  return mirrorBlobSource(mirrorPath(env.mirrorsDir, space.owner, space.repo), token);
}

/**
 * Git access to a space's repository for the write path: the shared blobless mirror,
 * authenticated with the space's installation token on every call.
 */
export async function spaceGit(env: SyncEnvironment, spaceId: string) {
  const space = await loadSpace(env.db, spaceId);
  const token = await env.tokenFor(space.installationId);
  const mirrorDir = mirrorPath(env.mirrorsDir, space.owner, space.repo);
  const url = remoteUrl(env, space);
  const auth = token ? { token } : {};
  return {
    owner: space.owner,
    repo: space.repo,
    installationId: space.installationId,
    token,
    mirrorDir,
    fetch: (branch: string) => fetchRef({ mirrorDir, remoteUrl: url, ref: branch, ...auth }),
    remoteHead: (branch: string) => remoteHead({ remoteUrl: url, ref: branch, ...auth }),
    push: (commit: string, branch: string, expected: string) =>
      pushBranch({ mirrorDir, commit, branch, expected, ...auth }),
    blobs: mirrorBlobSource(mirrorDir, token),
  };
}

/** Sync one space's ref. The unit of work behind the `sync` job and `oxybook-admin sync`. */
export async function runSpaceSync(
  env: SyncEnvironment,
  spaceId: string,
  ref?: string,
): Promise<SyncResult> {
  const space = await loadSpace(env.db, spaceId);
  const token = await env.tokenFor(space.installationId);
  return syncSpace(
    env.db,
    {
      orgId: space.orgId,
      spaceId: space.spaceId,
      contentRoot: space.contentRoot,
      ref: ref ?? space.defaultRef,
    },
    {
      mirrorDir: mirrorPath(env.mirrorsDir, space.owner, space.repo),
      remoteUrl: remoteUrl(env, space),
      ...(token ? { token } : {}),
    },
    env.log ? { log: env.log } : {},
  );
}

export interface ReconcileOutcome {
  spaceId: string;
  ref: string;
  /** Stored head, or null before the first sync. */
  stored: string | null;
  remote: string | null;
  behind: boolean;
  error?: string;
}

/**
 * Reconciliation (ARCHITECTURE §4.2): webhook delivery is not guaranteed, so compare each
 * connected space's remote head (`git ls-remote`) with ref_state. A space whose check fails
 * is reported and the rest continue.
 */
export async function findStaleSpaces(env: SyncEnvironment): Promise<ReconcileOutcome[]> {
  const spaces = await env.db
    .selectFrom('spaces')
    .leftJoin('ref_state', (join) =>
      join
        .onRef('ref_state.space_id', '=', 'spaces.id')
        .onRef('ref_state.ref', '=', 'spaces.default_ref'),
    )
    .select(['spaces.id as id', 'spaces.default_ref as ref', 'ref_state.head_sha as stored'])
    .where('spaces.repo_owner', 'is not', null)
    .where('spaces.github_installation_id', 'is not', null)
    .execute();
  const outcomes: ReconcileOutcome[] = [];
  for (const row of spaces) {
    try {
      const space = await loadSpace(env.db, row.id);
      const token = await env.tokenFor(space.installationId);
      const remote = await remoteHead({
        remoteUrl: remoteUrl(env, space),
        ref: row.ref,
        ...(token ? { token } : {}),
      });
      outcomes.push({
        spaceId: row.id,
        ref: row.ref,
        stored: row.stored,
        remote,
        behind: remote !== null && remote !== row.stored,
      });
    } catch (error) {
      outcomes.push({
        spaceId: row.id,
        ref: row.ref,
        stored: row.stored,
        remote: null,
        behind: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
