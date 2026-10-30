// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Database,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  type SpaceRole,
} from '@oxybook/db';
import type { AppCredentials, InstalledRepository, MemoryAppCredentials } from '@oxybook/github';
import {
  createOrgForUser,
  createSpaceForUser,
  getSpaceDetails,
  getUserSpaceRole,
  listAvailableAppRepos,
  listUserOrgs,
  listUserSpaces,
  parseRepo,
  type SpaceDetails,
  setSpaceMemberRole,
  type UserOrgRow,
  type UserSpaceOverview,
  verifyRepoConnection,
} from './admin.js';
import {
  type AuthUser,
  authenticateUser,
  createSession,
  deleteSession,
  deriveCsrfToken,
  formatClearSessionCookie,
  formatSessionCookie,
  loadSessionUser,
  parseCookies,
  SESSION_COOKIE_NAME,
  signUpUser,
  verifyCsrfToken,
} from './auth.js';

export interface UiRouteOptions {
  db: Kysely<Database>;
  secretKey?: string;
  publicUrl?: string;
  sitesDomain?: string;
  sitesPort?: string | number;
  store?: MemoryAppCredentials;
  githubHost?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  requireUserToken?: boolean;
  onSpaceSync?: (input: {
    spaceId: string;
    ref: string;
    syncNow?: boolean;
  }) => Promise<{ jobId?: string | null; synced?: boolean; built?: boolean }>;
  now?: () => Date;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function wantsJson(request: IncomingMessage, pathname: string): boolean {
  if (pathname.startsWith('/api/')) return true;
  const accept = request.headers.accept ?? '';
  const contentType = request.headers['content-type'] ?? '';
  return accept.includes('application/json') || contentType.includes('application/json');
}

function parseBodyParams(request: IncomingMessage, rawBody: Buffer): Record<string, string> {
  const contentType = (request.headers['content-type'] ?? '').toLowerCase();
  const text = rawBody.toString('utf8');
  if (!text.trim()) return {};
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v;
          else if (typeof v === 'boolean' || typeof v === 'number') out[k] = String(v);
        }
        return out;
      }
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    ...extraHeaders,
  });
  response.end(html);
}

function redirect(
  response: ServerResponse,
  location: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(303, {
    location,
    ...extraHeaders,
  });
  response.end();
}

const UI_STYLES = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --border: #d1d9e0;
  --surface: #f6f8fa;
  --accent: #0969da;
  --accent-bg: #ddf4ff;
  --danger: #d1242f;
  --danger-bg: #ffebe9;
  --ok: #1a7f37;
  --ok-bg: #dafbe1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --surface: #161b22;
    --accent: #58a6ff;
    --accent-bg: rgba(56, 139, 253, 0.15);
    --danger: #f85149;
    --danger-bg: rgba(248, 81, 73, 0.15);
    --ok: #3fb950;
    --ok-bg: rgba(63, 185, 80, 0.15);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
header a.brand {
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--fg);
  text-decoration: none;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.9rem;
}
main {
  max-width: 68rem;
  margin: 0 auto;
  padding: 1.75rem 1.5rem 3rem;
}
.auth-box {
  max-width: 26rem;
  margin: 3rem auto;
  padding: 1.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.card {
  margin-bottom: 1.5rem;
  padding: 1.25rem 1.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.card h2 {
  margin-top: 0;
  margin-bottom: 0.75rem;
  font-size: 1.15rem;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
}
label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
input[type="text"], input[type="email"], input[type="password"], select {
  width: 100%;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.92rem;
  margin-bottom: 0.75rem;
}
button, .btn {
  display: inline-block;
  padding: 0.45rem 0.9rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #ffffff;
  font-size: 0.9rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
button.secondary, .btn.secondary {
  background: transparent;
  color: var(--fg);
  border-color: var(--border);
}
.alert-error {
  padding: 0.65rem 0.9rem;
  margin-bottom: 1rem;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 0.9rem;
}
.alert-ok {
  padding: 0.65rem 0.9rem;
  margin-bottom: 1rem;
  border: 1px solid var(--ok);
  border-radius: 6px;
  background: var(--ok-bg);
  color: var(--ok);
  font-size: 0.9rem;
}
.badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--accent-bg);
  color: var(--accent);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th, td {
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85em;
}
.muted { color: var(--muted); font-size: 0.85rem; }`;

function renderShell(options: {
  title: string;
  user?: AuthUser | null;
  csrfToken?: string;
  body: string;
}): string {
  const userNav = options.user
    ? `<div class="header-right">
        <span>${escapeHtml(options.user.name)} (<code>${escapeHtml(options.user.email)}</code>)</span>
        <form method="post" action="/logout" style="margin:0">
          <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken ?? '')}">
          <button type="submit" class="secondary">Sign out</button>
        </form>
      </div>`
    : `<div class="header-right">
        <a href="/login">Sign in</a>
        <a href="/signup">Create account</a>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} — OxyBook</title>
  <style>${UI_STYLES}</style>
</head>
<body>
  <header>
    <a class="brand" href="/">OxyBook</a>
    ${userNav}
  </header>
  <main>
    ${options.body}
  </main>
</body>
</html>
`;
}

function renderSignupPage(error?: string): string {
  const errHtml = error ? `<div class="alert-error">${escapeHtml(error)}</div>` : '';
  return renderShell({
    title: 'Create account',
    body: `<div class="auth-box">
      <h1 style="margin-top:0;font-size:1.35rem">Create your OxyBook account</h1>
      ${errHtml}
      <form method="post" action="/signup">
        <label for="name">Name</label>
        <input id="name" name="name" type="text" required autocomplete="name">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        <label for="password">Password (min 8 characters)</label>
        <input id="password" name="password" type="password" minlength="8" required autocomplete="new-password">
        <button type="submit" style="width:100%">Create account</button>
      </form>
      <p class="muted" style="margin-bottom:0;margin-top:1rem">Already have an account? <a href="/login">Sign in</a>.</p>
    </div>`,
  });
}

function renderLoginPage(error?: string): string {
  const errHtml = error ? `<div class="alert-error">${escapeHtml(error)}</div>` : '';
  return renderShell({
    title: 'Sign in',
    body: `<div class="auth-box">
      <h1 style="margin-top:0;font-size:1.35rem">Sign in to OxyBook</h1>
      ${errHtml}
      <form method="post" action="/login">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
        <button type="submit" style="width:100%">Sign in</button>
      </form>
      <p class="muted" style="margin-bottom:0;margin-top:1rem">Need an account? <a href="/signup">Create one</a>.</p>
    </div>`,
  });
}

function formatPublishedSiteUrl(
  spaceSlug: string,
  sitesDomain: string,
  sitesPort: string | number | undefined,
): string {
  const portSuffix =
    sitesPort && String(sitesPort) !== '80' && String(sitesPort) !== '443' ? `:${sitesPort}` : '';
  return `http://${spaceSlug}.${sitesDomain}${portSuffix}/`;
}

function renderDashboardPage(input: {
  user: AuthUser;
  csrfToken: string;
  app: AppCredentials | null;
  githubHost: string;
  installedRepos: InstalledRepository[];
  orgs: UserOrgRow[];
  spaces: UserSpaceOverview[];
  sitesDomain: string;
  sitesPort?: string | number;
  requireUserToken?: boolean;
  error?: string;
  notice?: string;
}): string {
  const errHtml = input.error ? `<div class="alert-error">${escapeHtml(input.error)}</div>` : '';
  const noticeHtml = input.notice ? `<div class="alert-ok">${escapeHtml(input.notice)}</div>` : '';

  const installUrl = input.app
    ? `${input.githubHost.replace(/\/$/, '')}/apps/${encodeURIComponent(input.app.slug)}/installations/new`
    : null;

  const appSection = input.app
    ? `<p style="margin:0 0 0.5rem">Connected GitHub App: <strong>${escapeHtml(input.app.slug)}</strong> (ID <code>${input.app.id}</code>) <span class="badge">Active</span></p>
       <p class="muted" style="margin:0 0 0.75rem">Install the App on the GitHub repositories you want to publish with OxyBook.</p>
       <a class="btn secondary" href="${escapeHtml(installUrl ?? '#')}" target="_blank" rel="noopener noreferrer">Configure / Install on GitHub</a>`
    : `<p style="margin:0 0 0.75rem">No GitHub App is configured for this instance yet. Create one with the GitHub App Manifest flow so permissions and webhooks are configured automatically.</p>
       <a class="btn" href="/setup/github">Create GitHub App</a>`;

  const orgRows =
    input.orgs.length > 0
      ? `<table>
          <thead><tr><th>Organisation</th><th>Slug</th><th>Role</th></tr></thead>
          <tbody>
            ${input.orgs
              .map(
                (o) =>
                  `<tr><td><strong>${escapeHtml(o.name)}</strong></td><td><code>${escapeHtml(o.slug)}</code></td><td><span class="badge">${escapeHtml(o.role)}</span></td></tr>`,
              )
              .join('')}
          </tbody>
        </table>`
      : `<p class="muted">You do not belong to an organisation yet. Create one to get started.</p>`;

  const ownerOrgs = input.orgs.filter((o) => o.role === 'owner');

  const spaceRows =
    input.spaces.length > 0
      ? `<table>
          <thead>
            <tr>
              <th>Space</th>
              <th>Repository</th>
              <th>Root / Ref</th>
              <th>Synced SHA</th>
              <th>Pages</th>
              <th>Build</th>
              <th>Published site</th>
            </tr>
          </thead>
          <tbody>
            ${input.spaces
              .map((s) => {
                const siteUrl = formatPublishedSiteUrl(s.slug, input.sitesDomain, input.sitesPort);
                const shaText = s.headSha
                  ? `<code>${escapeHtml(s.headSha.slice(0, 12))}</code>`
                  : '<span class="muted">not synced</span>';
                const buildText = s.latestBuild
                  ? `<span class="badge">${escapeHtml(s.latestBuild.status)}</span> (${s.latestBuild.warningCount} warn)`
                  : '<span class="muted">none</span>';
                return `<tr>
                  <td><a href="/orgs/${encodeURIComponent(s.orgSlug)}/spaces/${encodeURIComponent(s.slug)}"><strong>${escapeHtml(s.name)}</strong></a><br><span class="muted"><code>${escapeHtml(s.orgSlug)}/${escapeHtml(s.slug)}</code> · ${escapeHtml(s.role)}</span></td>
                  <td><code>${escapeHtml(s.repo ?? '—')}</code></td>
                  <td><code>${escapeHtml(s.contentRoot || '.')}</code> @ <code>${escapeHtml(s.defaultRef)}</code></td>
                  <td>${shaText}</td>
                  <td>${s.pageCount}</td>
                  <td>${buildText}</td>
                  <td><a href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(siteUrl)}</a></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`
      : `<p class="muted">No spaces created yet.</p>`;

  const repoPickerHtml =
    input.installedRepos.length > 0
      ? `<label for="installed_repo">Discovered repositories from GitHub App</label>
         <select id="installed_repo" onchange="if(this.value){var p=this.value.split('|');document.getElementById('repo').value=p[0];if(p[1])document.getElementById('default_ref').value=p[1];}">
           <option value="">Select an installed repository…</option>
           ${input.installedRepos
             .map(
               (r) =>
                 `<option value="${escapeHtml(r.fullName)}|${escapeHtml(r.defaultBranch)}">${escapeHtml(r.fullName)} (${escapeHtml(r.defaultBranch)})</option>`,
             )
             .join('')}
         </select>`
      : '';

  const createSpaceSection =
    ownerOrgs.length > 0
      ? `<form method="post" action="/spaces">
          <input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">
          <input type="hidden" name="sync_now" value="true">
          <div class="grid-2">
            <div>
              <label for="org_slug">Organisation</label>
              <select id="org_slug" name="org_slug" required>
                ${ownerOrgs
                  .map(
                    (o) =>
                      `<option value="${escapeHtml(o.slug)}">${escapeHtml(o.name)} (${escapeHtml(o.slug)})</option>`,
                  )
                  .join('')}
              </select>
              <label for="space_name">Space name</label>
              <input id="space_name" name="name" type="text" placeholder="OxyBook Docs" required>
              <label for="space_slug">Space slug (subdomain)</label>
              <input id="space_slug" name="slug" type="text" placeholder="docs" pattern="[a-z0-9][a-z0-9-]{0,62}" required>
            </div>
            <div>
              ${repoPickerHtml}
              <label for="repo">GitHub repository (<code>owner/repo</code>)</label>
              <input id="repo" name="repo" type="text" placeholder="crisprintsstuff/oxybook-test" required>
              <label for="content_root">Content root directory</label>
              <input id="content_root" name="content_root" type="text" value="docs">
              <label for="default_ref">Default branch</label>
              <input id="default_ref" name="default_ref" type="text" value="main" required>
              <label for="user_token">GitHub user token ${input.requireUserToken ? '(required)' : '(optional, verifies admin/write repo access)'}</label>
              <input id="user_token" name="user_token" type="password" placeholder="ghp_… or github_pat_…" ${input.requireUserToken ? 'required' : ''}>
            </div>
          </div>
          <button type="submit">Connect repository &amp; build site</button>
        </form>`
      : `<p class="muted">Create an organisation first to connect a repository and publish a space.</p>`;

  return renderShell({
    title: 'Dashboard',
    user: input.user,
    csrfToken: input.csrfToken,
    body: `
      ${errHtml}
      ${noticeHtml}
      <div class="grid-2">
        <section class="card">
          <h2>1. GitHub App</h2>
          ${appSection}
        </section>
        <section class="card">
          <h2>2. Organisations</h2>
          ${orgRows}
          <hr style="border:none;border-top:1px solid var(--border);margin:1rem 0">
          <form method="post" action="/orgs">
            <input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">
            <div class="grid-2">
              <div>
                <label for="org_name">New organisation name</label>
                <input id="org_name" name="name" type="text" placeholder="Acme" required>
              </div>
              <div>
                <label for="new_org_slug">Organisation slug</label>
                <input id="new_org_slug" name="slug" type="text" placeholder="acme" pattern="[a-z0-9][a-z0-9-]{0,62}" required>
              </div>
            </div>
            <button type="submit">Create organisation</button>
          </form>
        </section>
      </div>

      <section class="card">
        <h2>3. Connect repository &amp; create space</h2>
        ${createSpaceSection}
      </section>

      <section class="card">
        <h2>4. Spaces</h2>
        ${spaceRows}
      </section>
    `,
  });
}

function renderSpacePage(input: {
  user: AuthUser;
  csrfToken: string;
  space: SpaceDetails;
  sitesDomain: string;
  sitesPort?: string | number;
  error?: string;
  notice?: string;
}): string {
  const { space } = input;
  const siteUrl = formatPublishedSiteUrl(space.slug, input.sitesDomain, input.sitesPort);
  const errHtml = input.error ? `<div class="alert-error">${escapeHtml(input.error)}</div>` : '';
  const noticeHtml = input.notice ? `<div class="alert-ok">${escapeHtml(input.notice)}</div>` : '';

  const syncForm =
    space.userRole === 'admin'
      ? `<form method="post" action="/orgs/${encodeURIComponent(space.orgSlug)}/spaces/${encodeURIComponent(space.slug)}/sync" style="display:inline">
          <input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">
          <input type="hidden" name="sync_now" value="true">
          <button type="submit">Sync &amp; rebuild now</button>
        </form>`
      : '';

  const pagesTable =
    space.pages.length > 0
      ? `<table>
          <thead><tr><th>URL</th><th>Title</th><th>Source path</th><th>Blob SHA</th></tr></thead>
          <tbody>
            ${space.pages
              .map(
                (p) =>
                  `<tr>
                    <td><a href="${escapeHtml(siteUrl.replace(/\/$/, '') + p.url)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(p.url)}</code></a>${p.hidden ? ' <span class="badge">hidden</span>' : ''}</td>
                    <td>${escapeHtml(p.title)}</td>
                    <td><code>${escapeHtml(p.path)}</code></td>
                    <td><code>${escapeHtml(p.blobSha.slice(0, 12))}</code></td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
      : `<p class="muted">No pages synced yet. Click "Sync &amp; rebuild now" or push to <code>${escapeHtml(space.defaultRef)}</code>.</p>`;

  const buildsTable =
    space.builds.length > 0
      ? `<table>
          <thead><tr><th>Build ID</th><th>Commit</th><th>Status</th><th>Warnings</th><th>Finished</th></tr></thead>
          <tbody>
            ${space.builds
              .map(
                (b) =>
                  `<tr>
                    <td><code>${escapeHtml(b.id.slice(0, 8))}</code></td>
                    <td><code>${escapeHtml(b.commitSha.slice(0, 12))}</code></td>
                    <td><span class="badge">${escapeHtml(b.status)}</span></td>
                    <td>${b.warningCount}</td>
                    <td>${b.finishedAt ? escapeHtml(b.finishedAt.toISOString()) : '—'}</td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
      : `<p class="muted">No builds recorded yet.</p>`;

  const membersTable = `<table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
    <tbody>
      ${space.members
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.name)}</td><td><code>${escapeHtml(m.email)}</code></td><td><span class="badge">${escapeHtml(m.role)}</span></td></tr>`,
        )
        .join('')}
    </tbody>
  </table>`;

  const memberForm =
    space.userRole === 'admin'
      ? `<hr style="border:none;border-top:1px solid var(--border);margin:1rem 0">
         <form method="post" action="/orgs/${encodeURIComponent(space.orgSlug)}/spaces/${encodeURIComponent(space.slug)}/members">
           <input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">
           <div class="grid-2">
             <div>
               <label for="member_email">User email</label>
               <input id="member_email" name="email" type="email" placeholder="writer@example.com" required>
             </div>
             <div>
               <label for="member_role">Space role</label>
               <select id="member_role" name="role">
                 <option value="editor">editor</option>
                 <option value="viewer">viewer</option>
                 <option value="admin">admin</option>
               </select>
             </div>
           </div>
           <button type="submit" class="secondary">Add / update member</button>
         </form>`
      : '';

  return renderShell({
    title: `${space.orgSlug}/${space.slug}`,
    user: input.user,
    csrfToken: input.csrfToken,
    body: `
      <p style="margin-top:0"><a href="/">&larr; Back to dashboard</a></p>
      ${errHtml}
      ${noticeHtml}
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
          <div>
            <h1 style="margin:0 0 0.35rem;font-size:1.4rem">${escapeHtml(space.name)} <span class="badge">${escapeHtml(space.userRole)}</span></h1>
            <p class="muted" style="margin:0">
              Space <code>${escapeHtml(space.orgSlug)}/${escapeHtml(space.slug)}</code> ·
              Repo <code>${escapeHtml(space.repo ?? '—')}</code> ·
              Root <code>${escapeHtml(space.contentRoot || '.')}</code> ·
              Ref <code>${escapeHtml(space.defaultRef)}</code> ·
              Head <code>${escapeHtml(space.headSha?.slice(0, 12) ?? 'not synced')}</code>
            </p>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center">
            <a class="btn secondary" href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener noreferrer">Open published site &rarr;</a>
            ${syncForm}
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Synced pages (${space.pages.length})</h2>
        ${pagesTable}
      </section>

      <div class="grid-2">
        <section class="card">
          <h2>Recent builds</h2>
          ${buildsTable}
        </section>
        <section class="card">
          <h2>Space members</h2>
          ${membersTable}
          ${memberForm}
        </section>
      </div>
    `,
  });
}

export function createUiRoutes(options: UiRouteOptions): {
  handle(request: IncomingMessage, response: ServerResponse, rawBody: Buffer): Promise<boolean>;
} {
  const { db } = options;
  const csrfSecret = options.secretKey ?? 'oxybook-dev-csrf-secret';
  const secureCookie = (options.publicUrl ?? '').startsWith('https://');
  const sitesDomain = options.sitesDomain ?? process.env.OXYBOOK_SITES_DOMAIN ?? 'docs.localhost';
  const sitesPort = options.sitesPort ?? process.env.CADDY_PORT ?? 8080;
  const githubHost = options.githubHost ?? 'https://github.com';

  async function currentApp(): Promise<AppCredentials | null> {
    const inMem = options.store?.get();
    if (inMem) return inMem;
    if (!options.secretKey) return null;
    try {
      return await loadAppCredentials(db, deriveSecretsKey(options.secretKey));
    } catch {
      return null;
    }
  }

  async function currentSession(request: IncomingMessage) {
    const cookies = parseCookies(request.headers.cookie);
    const rawToken = cookies.get(SESSION_COOKIE_NAME);
    const session = await loadSessionUser(db, rawToken, options.now?.() ?? new Date());
    if (!session) return null;
    const csrfToken = deriveCsrfToken(session.tokenHash, csrfSecret);
    return { ...session, rawToken: rawToken as string, csrfToken };
  }

  function checkCsrf(
    request: IncomingMessage,
    params: Record<string, string>,
    expectedCsrf: string,
  ): boolean {
    const headerToken = request.headers['x-csrf-token'];
    const candidate = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? params._csrf;
    return verifyCsrfToken(expectedCsrf, candidate);
  }

  return {
    async handle(request, response, rawBody) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;
      const method = request.method ?? 'GET';
      const isJson = wantsJson(request, pathname);

      // 1. Auth: GET /signup & GET /login
      if (method === 'GET' && pathname === '/signup') {
        const session = await currentSession(request);
        if (session) {
          redirect(response, '/');
          return true;
        }
        sendHtml(response, 200, renderSignupPage(url.searchParams.get('error') ?? undefined));
        return true;
      }

      if (method === 'GET' && pathname === '/login') {
        const session = await currentSession(request);
        if (session) {
          redirect(response, '/');
          return true;
        }
        sendHtml(response, 200, renderLoginPage(url.searchParams.get('error') ?? undefined));
        return true;
      }

      // 2. Auth: POST /signup or POST /api/auth/signup
      if (method === 'POST' && (pathname === '/signup' || pathname === '/api/auth/signup')) {
        const params = parseBodyParams(request, rawBody);
        try {
          const user = await signUpUser(db, {
            email: params.email ?? '',
            name: params.name ?? '',
            password: params.password ?? '',
          });
          const created = await createSession(db, user.id, {
            ...(options.now ? { now: options.now() } : {}),
          });
          const cookie = formatSessionCookie(created.token, { secure: secureCookie });
          const csrfToken = deriveCsrfToken(created.tokenHash, csrfSecret);
          if (isJson) {
            sendJson(response, 201, { user, csrfToken }, { 'set-cookie': cookie });
          } else {
            redirect(response, '/', { 'set-cookie': cookie });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'signup failed';
          if (isJson) {
            sendJson(response, 400, { error: message });
          } else {
            sendHtml(response, 400, renderSignupPage(message));
          }
        }
        return true;
      }

      // 3. Auth: POST /login or POST /api/auth/login
      if (method === 'POST' && (pathname === '/login' || pathname === '/api/auth/login')) {
        const params = parseBodyParams(request, rawBody);
        const user = await authenticateUser(db, {
          email: params.email ?? '',
          password: params.password ?? '',
        });
        if (!user) {
          const message = 'invalid email or password';
          if (isJson) {
            sendJson(response, 401, { error: message });
          } else {
            sendHtml(response, 401, renderLoginPage(message));
          }
          return true;
        }
        const created = await createSession(db, user.id, {
          ...(options.now ? { now: options.now() } : {}),
        });
        const cookie = formatSessionCookie(created.token, { secure: secureCookie });
        const csrfToken = deriveCsrfToken(created.tokenHash, csrfSecret);
        if (isJson) {
          sendJson(response, 200, { user, csrfToken }, { 'set-cookie': cookie });
        } else {
          redirect(response, '/', { 'set-cookie': cookie });
        }
        return true;
      }

      // 4. Auth: POST /logout or POST /api/auth/logout
      if (method === 'POST' && (pathname === '/logout' || pathname === '/api/auth/logout')) {
        const session = await currentSession(request);
        const params = parseBodyParams(request, rawBody);
        if (session) {
          if (!checkCsrf(request, params, session.csrfToken)) {
            if (isJson) sendJson(response, 403, { error: 'invalid CSRF token' });
            else sendHtml(response, 403, 'invalid CSRF token');
            return true;
          }
          await deleteSession(db, session.rawToken);
        }
        const clearCookie = formatClearSessionCookie({ secure: secureCookie });
        if (isJson) {
          response.writeHead(204, { 'set-cookie': clearCookie });
          response.end();
        } else {
          redirect(response, '/login', { 'set-cookie': clearCookie });
        }
        return true;
      }

      // 5. Auth: GET /api/auth/me
      if (method === 'GET' && pathname === '/api/auth/me') {
        const session = await currentSession(request);
        if (!session) {
          sendJson(response, 401, { error: 'unauthenticated' });
          return true;
        }
        const orgs = await listUserOrgs(db, session.user.id);
        const spaces = await listUserSpaces(db, session.user.id);
        sendJson(response, 200, {
          user: session.user,
          orgs,
          spaces,
          csrfToken: session.csrfToken,
        });
        return true;
      }

      // 6. Dashboard: GET /
      if (method === 'GET' && pathname === '/') {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) {
            sendJson(response, 401, { error: 'unauthenticated' });
          } else {
            redirect(response, '/login');
          }
          return true;
        }
        const app = await currentApp();
        const [orgs, spaces, installedRepos] = await Promise.all([
          listUserOrgs(db, session.user.id),
          listUserSpaces(db, session.user.id),
          listAvailableAppRepos(db, options.secretKey, {
            ...(app ? { app } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.apiBase ? { apiBase: options.apiBase } : {}),
          }),
        ]);
        if (isJson) {
          sendJson(response, 200, {
            user: session.user,
            app: app ? { id: app.id, slug: app.slug } : null,
            orgs,
            spaces,
            installedRepos,
            csrfToken: session.csrfToken,
          });
        } else {
          sendHtml(
            response,
            200,
            renderDashboardPage({
              user: session.user,
              csrfToken: session.csrfToken,
              app,
              githubHost,
              installedRepos,
              orgs,
              spaces,
              sitesDomain,
              sitesPort,
              ...(options.requireUserToken ? { requireUserToken: true } : {}),
              ...(url.searchParams.get('error')
                ? { error: url.searchParams.get('error') as string }
                : {}),
              ...(url.searchParams.get('notice')
                ? { notice: url.searchParams.get('notice') as string }
                : {}),
            }),
          );
        }
        return true;
      }

      // 7. Orgs: POST /orgs or POST /api/orgs
      if (method === 'POST' && (pathname === '/orgs' || pathname === '/api/orgs')) {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) sendJson(response, 401, { error: 'unauthenticated' });
          else redirect(response, '/login');
          return true;
        }
        const params = parseBodyParams(request, rawBody);
        if (!checkCsrf(request, params, session.csrfToken)) {
          if (isJson) sendJson(response, 403, { error: 'invalid CSRF token' });
          else redirect(response, `/?error=${encodeURIComponent('invalid CSRF token')}`);
          return true;
        }
        try {
          const created = await createOrgForUser(db, {
            userId: session.user.id,
            slug: params.slug ?? '',
            name: params.name ?? '',
          });
          if (isJson) {
            sendJson(response, 201, { org: created });
          } else {
            redirect(
              response,
              `/?notice=${encodeURIComponent(`Created organisation ${created.slug}`)}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'could not create organisation';
          if (isJson) {
            sendJson(response, 400, { error: message });
          } else {
            redirect(response, `/?error=${encodeURIComponent(message)}`);
          }
        }
        return true;
      }

      // 8. Spaces: POST /spaces, POST /orgs/:org/spaces, or POST /api/orgs/:org/spaces
      const createSpaceMatch =
        pathname === '/spaces'
          ? { orgFromPath: null }
          : /^(?:\/api)?\/orgs\/([a-z0-9-]+)\/spaces$/.exec(pathname)
            ? {
                orgFromPath: /^(?:\/api)?\/orgs\/([a-z0-9-]+)\/spaces$/.exec(pathname)?.[1] ?? null,
              }
            : null;

      if (method === 'POST' && createSpaceMatch) {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) sendJson(response, 401, { error: 'unauthenticated' });
          else redirect(response, '/login');
          return true;
        }
        const params = parseBodyParams(request, rawBody);
        if (!checkCsrf(request, params, session.csrfToken)) {
          if (isJson) sendJson(response, 403, { error: 'invalid CSRF token' });
          else redirect(response, `/?error=${encodeURIComponent('invalid CSRF token')}`);
          return true;
        }
        const orgSlug = (
          createSpaceMatch.orgFromPath ??
          params.org_slug ??
          params.orgSlug ??
          ''
        ).trim();
        const slug = (params.slug ?? '').trim();
        const name = (params.name ?? slug).trim();
        const rawRepo = (params.repo ?? '').trim();
        const contentRoot = params.content_root ?? params.contentRoot ?? 'docs';
        const requestedRef = (params.default_ref ?? params.defaultRef ?? '').trim();
        const userToken = (params.user_token ?? params.userToken ?? '').trim() || undefined;
        const syncNow =
          params.sync_now === 'true' || params.syncNow === 'true' || params.sync_now === '1';

        try {
          const { owner, repo } = parseRepo(rawRepo);
          const app = await currentApp();
          const verified = await verifyRepoConnection(
            db,
            options.secretKey,
            {
              owner,
              repo,
              ...(userToken ? { userToken } : {}),
              ...(options.requireUserToken ? { requireUserToken: true } : {}),
            },
            {
              ...(app ? { app } : {}),
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.apiBase ? { apiBase: options.apiBase } : {}),
            },
          );
          const defaultRef = requestedRef || verified.defaultBranch || 'main';
          const created = await createSpaceForUser(db, {
            userId: session.user.id,
            orgSlug,
            slug,
            name,
            owner,
            repo,
            installationId: verified.installationId,
            contentRoot,
            defaultRef,
          });

          let syncResult: { jobId?: string | null; synced?: boolean; built?: boolean } = {};
          if (options.onSpaceSync) {
            syncResult = await options.onSpaceSync({
              spaceId: created.id,
              ref: defaultRef,
              syncNow,
            });
          }

          if (isJson) {
            sendJson(response, 201, {
              space: {
                id: created.id,
                orgSlug: created.orgSlug,
                slug: created.slug,
                name,
                repo: `${owner}/${repo}`,
                installationId: verified.installationId,
                contentRoot,
                defaultRef,
              },
              sync: syncResult,
            });
          } else {
            redirect(
              response,
              `/orgs/${encodeURIComponent(created.orgSlug)}/spaces/${encodeURIComponent(created.slug)}?notice=${encodeURIComponent('Connected repository and started site build')}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'could not create space';
          const status = /only an organisation owner|does not have admin or write access/.test(
            message,
          )
            ? 403
            : 400;
          if (isJson) {
            sendJson(response, status, { error: message });
          } else {
            redirect(response, `/?error=${encodeURIComponent(message)}`);
          }
        }
        return true;
      }

      // 9. Space details: GET /orgs/:org/spaces/:space or GET /api/orgs/:org/spaces/:space
      const spaceDetailMatch = /^(?:\/api)?\/orgs\/([a-z0-9-]+)\/spaces\/([a-z0-9-]+)$/.exec(
        pathname,
      );
      if (method === 'GET' && spaceDetailMatch?.[1] && spaceDetailMatch[2]) {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) sendJson(response, 401, { error: 'unauthenticated' });
          else redirect(response, '/login');
          return true;
        }
        const details = await getSpaceDetails(
          db,
          session.user.id,
          spaceDetailMatch[1],
          spaceDetailMatch[2],
        );
        if (!details) {
          if (isJson) sendJson(response, 404, { error: 'space not found' });
          else sendHtml(response, 404, 'space not found');
          return true;
        }
        if (isJson) {
          sendJson(response, 200, { space: details });
        } else {
          sendHtml(
            response,
            200,
            renderSpacePage({
              user: session.user,
              csrfToken: session.csrfToken,
              space: details,
              sitesDomain,
              sitesPort,
              ...(url.searchParams.get('error')
                ? { error: url.searchParams.get('error') as string }
                : {}),
              ...(url.searchParams.get('notice')
                ? { notice: url.searchParams.get('notice') as string }
                : {}),
            }),
          );
        }
        return true;
      }

      // 10. Space sync trigger: POST /orgs/:org/spaces/:space/sync or /api/orgs/:org/spaces/:space/sync
      const spaceSyncMatch = /^(?:\/api)?\/orgs\/([a-z0-9-]+)\/spaces\/([a-z0-9-]+)\/sync$/.exec(
        pathname,
      );
      if (method === 'POST' && spaceSyncMatch?.[1] && spaceSyncMatch[2]) {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) sendJson(response, 401, { error: 'unauthenticated' });
          else redirect(response, '/login');
          return true;
        }
        const params = parseBodyParams(request, rawBody);
        if (!checkCsrf(request, params, session.csrfToken)) {
          if (isJson) sendJson(response, 403, { error: 'invalid CSRF token' });
          else sendHtml(response, 403, 'invalid CSRF token');
          return true;
        }
        const orgSlug = spaceSyncMatch[1];
        const spaceSlug = spaceSyncMatch[2];
        const access = await getUserSpaceRole(db, session.user.id, orgSlug, spaceSlug);
        if (access?.spaceRole !== 'admin') {
          if (isJson) sendJson(response, 403, { error: 'admin role required' });
          else
            redirect(
              response,
              `/orgs/${encodeURIComponent(orgSlug)}/spaces/${encodeURIComponent(spaceSlug)}?error=${encodeURIComponent('admin role required')}`,
            );
          return true;
        }
        const details = await getSpaceDetails(db, session.user.id, orgSlug, spaceSlug);
        if (!details) {
          if (isJson) sendJson(response, 404, { error: 'space not found' });
          else sendHtml(response, 404, 'space not found');
          return true;
        }
        const syncNow =
          params.sync_now === 'true' || params.syncNow === 'true' || params.sync_now === '1';
        try {
          const syncRes = options.onSpaceSync
            ? await options.onSpaceSync({
                spaceId: details.id,
                ref: details.defaultRef,
                syncNow,
              })
            : {};
          if (isJson) {
            sendJson(response, 202, { ok: true, ...syncRes });
          } else {
            redirect(
              response,
              `/orgs/${encodeURIComponent(orgSlug)}/spaces/${encodeURIComponent(spaceSlug)}?notice=${encodeURIComponent('Synced and rebuilt site')}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'sync failed';
          if (isJson) {
            sendJson(response, 500, { error: message });
          } else {
            redirect(
              response,
              `/orgs/${encodeURIComponent(orgSlug)}/spaces/${encodeURIComponent(spaceSlug)}?error=${encodeURIComponent(message)}`,
            );
          }
        }
        return true;
      }

      // 11. Space member management: POST /orgs/:org/spaces/:space/members
      const spaceMembersMatch =
        /^(?:\/api)?\/orgs\/([a-z0-9-]+)\/spaces\/([a-z0-9-]+)\/members$/.exec(pathname);
      if (method === 'POST' && spaceMembersMatch?.[1] && spaceMembersMatch[2]) {
        const session = await currentSession(request);
        if (!session) {
          if (isJson) sendJson(response, 401, { error: 'unauthenticated' });
          else redirect(response, '/login');
          return true;
        }
        const params = parseBodyParams(request, rawBody);
        if (!checkCsrf(request, params, session.csrfToken)) {
          if (isJson) sendJson(response, 403, { error: 'invalid CSRF token' });
          else sendHtml(response, 403, 'invalid CSRF token');
          return true;
        }
        const orgSlug = spaceMembersMatch[1];
        const spaceSlug = spaceMembersMatch[2];
        try {
          const updated = await setSpaceMemberRole(db, {
            actorUserId: session.user.id,
            orgSlug,
            spaceSlug,
            targetEmail: params.email ?? '',
            role: (params.role ?? 'viewer') as SpaceRole,
          });
          if (isJson) {
            sendJson(response, 200, { member: updated });
          } else {
            redirect(
              response,
              `/orgs/${encodeURIComponent(orgSlug)}/spaces/${encodeURIComponent(spaceSlug)}?notice=${encodeURIComponent(`Updated ${updated.email} to ${updated.role}`)}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'could not update member';
          const status = /only a space admin/.test(message) ? 403 : 400;
          if (isJson) {
            sendJson(response, status, { error: message });
          } else {
            redirect(
              response,
              `/orgs/${encodeURIComponent(orgSlug)}/spaces/${encodeURIComponent(spaceSlug)}?error=${encodeURIComponent(message)}`,
            );
          }
        }
        return true;
      }

      return false;
    },
  };
}
