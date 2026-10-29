// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permissions from ARCHITECTURE §4.1. Workflows is intentionally absent.
 * default_events is push and pull_request only. GitHub rejects installation
 * and installation_repositories in that list and delivers those events itself
 * when the App has a webhook.
 */
export interface AppManifestInput {
  name: string;
  url: string;
  hookUrl: string;
  redirectUrl: string;
  callbackUrl: string;
  description?: string;
}

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  public: false;
  default_permissions: {
    contents: 'write';
    pull_requests: 'write';
    metadata: 'read';
  };
  default_events: ['push', 'pull_request'];
  description?: string;
}

export function buildAppManifest(input: AppManifestInput): AppManifest {
  return {
    name: input.name,
    url: input.url,
    hook_attributes: { url: input.hookUrl, active: true },
    redirect_url: input.redirectUrl,
    callback_urls: [input.callbackUrl],
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    },
    default_events: ['push', 'pull_request'],
    ...(input.description ? { description: input.description } : {}),
  };
}

export function manifestCreateUrl(
  target: { kind: 'user' } | { kind: 'org'; org: string },
  githubHost = 'https://github.com',
): string {
  const host = githubHost.replace(/\/$/, '');
  if (target.kind === 'org') {
    return `${host}/organizations/${encodeURIComponent(target.org)}/settings/apps/new`;
  }
  return `${host}/settings/apps/new`;
}

export interface AppCredentials {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
}

interface ConversionResponse {
  id?: number;
  slug?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  pem?: string;
}

/** Exchange the manifest `code` GitHub redirects back with. Does not persist the result. */
export async function exchangeManifestCode(
  code: string,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<AppCredentials> {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const response = await fetchImpl(
    `${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub manifest exchange failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as ConversionResponse;
  if (
    typeof body.id !== 'number' ||
    !body.slug ||
    !body.client_id ||
    !body.client_secret ||
    !body.webhook_secret ||
    !body.pem
  ) {
    throw new Error('GitHub manifest exchange response was missing credentials');
  }
  return {
    id: body.id,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    webhookSecret: body.webhook_secret,
    privateKeyPem: body.pem,
  };
}

/** In-process only. The spike does not write the private key or secrets to disk. */
export class MemoryAppCredentials {
  private current: AppCredentials | null = null;

  set(credentials: AppCredentials): void {
    this.current = credentials;
  }

  get(): AppCredentials | null {
    return this.current;
  }
}
