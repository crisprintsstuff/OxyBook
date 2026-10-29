// SPDX-License-Identifier: AGPL-3.0-only

import type { InstallationTokenCache } from './installation-token.js';

export interface PullRequestBodyInput {
  summary: string;
  changedPaths: readonly string[];
  linkBack: string;
}

export interface OpenPullRequestInput {
  owner: string;
  repo: string;
  title: string;
  /** Branch name on the same repo. Not `refs/heads/`, and never the base branch. */
  head: string;
  base: string;
  body: string;
  /** Installation access token from `InstallationTokenCache`. */
  token: string;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

/**
 * Summary, the pages that changed, and a link back.
 * The link is whatever the caller has. This repo has no draft page yet.
 */
export function renderPullRequestBody(input: PullRequestBodyInput): string {
  if (input.linkBack === '') throw new Error('pull request body is missing its link back');
  const pages =
    input.changedPaths.length > 0
      ? input.changedPaths.map((page) => `- ${page}`).join('\n')
      : '- (none)';
  return `${input.summary}\n\nPages changed:\n${pages}\n\nLink back: ${input.linkBack}\n`;
}

/** Branch name GitHub's pulls API expects. Refuses the base branch. */
export function pullRequestHead(ref: string, baseBranch: string): string {
  const prefix = 'refs/heads/';
  const head = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
  if (head === baseBranch || head === `refs/heads/${baseBranch}`) {
    throw new Error(`refusing to open a pull request whose head is the base branch ${baseBranch}`);
  }
  if (!head.startsWith('oxybook/')) {
    throw new Error(
      `refusing to open a pull request for ${head}; head must be an oxybook/* branch`,
    );
  }
  return head;
}

export async function openPullRequest(
  input: OpenPullRequestInput,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<OpenedPullRequest> {
  const head = pullRequestHead(input.head, input.base);
  if (!/^[\w.-]+$/.test(input.owner) || !/^[\w.-]+$/.test(input.repo)) {
    throw new Error('owner and repo must be a single path segment');
  }
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(
    `${apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        title: input.title,
        head,
        base: input.base,
        body: input.body,
      }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub pull request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  const payload = (await response.json()) as { number?: number; html_url?: string };
  if (typeof payload.number !== 'number' || !payload.html_url) {
    throw new Error('GitHub pull request response was missing number or html_url');
  }
  return { number: payload.number, url: payload.html_url };
}

/** Mint or reuse an installation token, then open the pull request with it. */
export async function openPullRequestFromInstallation(
  cache: InstallationTokenCache,
  installationId: number,
  input: Omit<OpenPullRequestInput, 'token'>,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<OpenedPullRequest> {
  const token = await cache.get(installationId);
  return openPullRequest({ ...input, token }, options);
}
