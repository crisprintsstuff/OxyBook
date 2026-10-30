// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which installation of this App covers `owner/repo`. Answers with the App JWT,
 * so it also proves the App is installed on that repository.
 * Returns null when GitHub says the App is not installed there (HTTP 404).
 */
export async function findRepoInstallation(input: {
  owner: string;
  repo: string;
  appJwt: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): Promise<{ id: number; account: string | null } | null> {
  const fetchImpl = input.fetch ?? fetch;
  const apiBase = input.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(
    `${apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/installation`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.appJwt}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub installation lookup failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { id?: unknown; account?: { login?: unknown } };
  if (typeof body.id !== 'number') {
    throw new Error('GitHub installation lookup response had no id');
  }
  const login = body.account?.login;
  return { id: body.id, account: typeof login === 'string' ? login : null };
}

export interface RepoUserAccess {
  /** True when the user has admin, maintain, or push (write) access (ARCHITECTURE §4.1). */
  allowed: boolean;
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    pull: boolean;
  };
  defaultBranch: string | null;
  private: boolean;
}

/**
 * Verify with a user's GitHub token that the user has admin or write (`push`) access
 * to `owner/repo` before connecting the repository to a space (ARCHITECTURE §4.1).
 */
export async function checkUserRepoAccess(input: {
  owner: string;
  repo: string;
  userToken: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): Promise<RepoUserAccess> {
  const fetchImpl = input.fetch ?? fetch;
  const apiBase = input.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(
    `${apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.userToken}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return {
      allowed: false,
      permissions: { admin: false, maintain: false, push: false, pull: false },
      defaultBranch: null,
      private: false,
    };
  }
  if (!response.ok) {
    throw new Error(`GitHub user repository check failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    default_branch?: unknown;
    private?: unknown;
    permissions?: {
      admin?: unknown;
      maintain?: unknown;
      push?: unknown;
      pull?: unknown;
    };
  };
  const admin = body.permissions?.admin === true;
  const maintain = body.permissions?.maintain === true;
  const push = body.permissions?.push === true;
  const pull = body.permissions?.pull === true;
  return {
    allowed: admin || maintain || push,
    permissions: { admin, maintain, push, pull },
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : null,
    private: body.private === true,
  };
}

export interface RepoInstallationMetadata {
  accessible: boolean;
  defaultBranch: string | null;
  private: boolean;
}

/**
 * Verify with an installation access token that the GitHub App installation can read
 * `owner/repo` and return its `default_branch` and `private` flag.
 */
export async function checkInstallationRepoAccess(input: {
  owner: string;
  repo: string;
  installationToken: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): Promise<RepoInstallationMetadata> {
  const fetchImpl = input.fetch ?? fetch;
  const apiBase = input.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(
    `${apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.installationToken}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (response.status === 403 || response.status === 404) {
    return { accessible: false, defaultBranch: null, private: false };
  }
  if (!response.ok) {
    throw new Error(`GitHub installation repository check failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    default_branch?: unknown;
    private?: unknown;
  };
  return {
    accessible: true,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : null,
    private: body.private === true,
  };
}

export interface InstalledRepository {
  installationId: number;
  account: string | null;
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * List repositories accessible across all installations of the stored GitHub App, so
 * the space creation screen can offer a one-click picker alongside manual `owner/repo`.
 */
export async function listInstalledRepositories(input: {
  appJwt: string;
  getInstallationToken: (installationId: number) => Promise<string>;
  fetch?: typeof fetch;
  apiBase?: string;
}): Promise<InstalledRepository[]> {
  const fetchImpl = input.fetch ?? fetch;
  const apiBase = input.apiBase ?? 'https://api.github.com';
  const instRes = await fetchImpl(`${apiBase}/app/installations?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${input.appJwt}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!instRes.ok) {
    throw new Error(`GitHub list installations failed: HTTP ${instRes.status}`);
  }
  const installations = (await instRes.json()) as Array<{
    id?: unknown;
    account?: { login?: unknown };
  }>;
  const repos: InstalledRepository[] = [];
  for (const inst of Array.isArray(installations) ? installations : []) {
    if (typeof inst.id !== 'number') continue;
    const account = typeof inst.account?.login === 'string' ? inst.account.login : null;
    const token = await input.getInstallationToken(inst.id);
    const repoRes = await fetchImpl(`${apiBase}/installation/repositories?per_page=100`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!repoRes.ok) continue;
    const payload = (await repoRes.json()) as {
      repositories?: Array<{
        name?: unknown;
        full_name?: unknown;
        default_branch?: unknown;
        private?: unknown;
        owner?: { login?: unknown };
      }>;
    };
    for (const r of payload.repositories ?? []) {
      const owner = typeof r.owner?.login === 'string' ? r.owner.login : '';
      const repo = typeof r.name === 'string' ? r.name : '';
      if (!owner || !repo) continue;
      repos.push({
        installationId: inst.id,
        account,
        owner,
        repo,
        fullName: typeof r.full_name === 'string' ? r.full_name : `${owner}/${repo}`,
        defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
        private: r.private === true,
      });
    }
  }
  return repos;
}
