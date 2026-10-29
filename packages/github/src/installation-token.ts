// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Installation access tokens live only in this process.
 * Nothing in this module writes them to disk.
 */
export class InstallationTokenCache {
  private readonly entries = new Map<number, { token: string; expiresAtMs: number }>();
  private readonly skewMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly apiBase: string;

  constructor(
    private readonly options: {
      signJwt: () => string | Promise<string>;
      fetch?: typeof fetch;
      now?: () => number;
      /** Refresh this long before GitHub's expires_at. Default 60 seconds. */
      skewMs?: number;
      apiBase?: string;
    },
  ) {
    this.skewMs = options.skewMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
  }

  async get(installationId: number): Promise<string> {
    const cached = this.entries.get(installationId);
    if (cached && cached.expiresAtMs - this.skewMs > this.now()) return cached.token;
    const jwt = await this.options.signJwt();
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub installation token request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) {
      throw new Error('GitHub installation token response was missing token or expires_at');
    }
    const expiresAtMs = Date.parse(body.expires_at);
    if (Number.isNaN(expiresAtMs))
      throw new Error('GitHub installation token expiry was not a date');
    this.entries.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }
}
