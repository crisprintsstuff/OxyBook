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
