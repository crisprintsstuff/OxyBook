// SPDX-License-Identifier: AGPL-3.0-only

import type { NavItem } from './nav.js';
import type { SearchHeading } from './render.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface DocumentHtmlOptions {
  siteTitle: string;
  pageTitle: string;
  description?: string;
  currentUrl: string;
  bodyHtml: string;
  nav: readonly NavItem[];
  headings?: readonly SearchHeading[];
  /** Optional version prefix (e.g. '2.x') for versioned assets and Pagefind bundle. */
  versionPrefix?: string;
  /** Whether Pagefind should index this page (default true; false for hidden pages if desired). */
  searchable?: boolean;
}

const DEFAULT_STYLES = `:root {
  color-scheme: light dark;
  --ob-bg: #ffffff;
  --ob-fg: #1f2328;
  --ob-muted: #59636e;
  --ob-border: #d1d9e0;
  --ob-surface: #f6f8fa;
  --ob-accent: #0969da;
  --ob-accent-subtle: #ddf4ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ob-bg: #0d1117;
    --ob-fg: #e6edf3;
    --ob-muted: #8b949e;
    --ob-border: #30363d;
    --ob-surface: #161b22;
    --ob-accent: #58a6ff;
    --ob-accent-subtle: rgba(56, 139, 253, 0.15);
  }
  .shiki, .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg, var(--ob-surface)) !important;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: var(--ob-fg);
  background: var(--ob-bg);
}
.oxybook-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 100vh;
}
@media (max-width: 800px) {
  .oxybook-layout { grid-template-columns: 1fr; }
}
.oxybook-sidebar {
  border-right: 1px solid var(--ob-border);
  background: var(--ob-surface);
  padding: 1.25rem 1rem;
}
.oxybook-site-title {
  display: block;
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--ob-fg);
  text-decoration: none;
  margin-bottom: 1rem;
}
.oxybook-search { margin-bottom: 1rem; }
.oxybook-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.oxybook-nav ul ul {
  padding-left: 0.875rem;
  margin-top: 0.25rem;
  border-left: 1px solid var(--ob-border);
}
.oxybook-nav li { margin: 0.2rem 0; }
.oxybook-nav a, .oxybook-nav-group {
  display: block;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.925rem;
  color: var(--ob-fg);
  text-decoration: none;
}
.oxybook-nav-group {
  font-weight: 600;
  color: var(--ob-muted);
}
.oxybook-nav a:hover { background: var(--ob-border); }
.oxybook-nav a[aria-current="page"] {
  background: var(--ob-accent-subtle);
  color: var(--ob-accent);
  font-weight: 600;
}
.oxybook-content {
  padding: 2rem 2.5rem;
  max-width: 56rem;
}
.oxybook-article img { max-width: 100%; height: auto; }
.oxybook-article pre {
  padding: 0.875rem 1rem;
  border-radius: 6px;
  background: var(--ob-surface);
  border: 1px solid var(--ob-border);
  overflow-x: auto;
}
.oxybook-article code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88em;
}
.oxybook-callout {
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  border-left: 4px solid var(--ob-accent);
  background: var(--ob-surface);
  border-radius: 0 6px 6px 0;
}
.oxybook-callout-title {
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.oxybook-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin: 1rem 0;
}
.oxybook-card, .oxybook-link-card {
  display: block;
  padding: 1rem;
  border: 1px solid var(--ob-border);
  border-radius: 8px;
  background: var(--ob-surface);
  color: var(--ob-fg);
  text-decoration: none;
}
.oxybook-placeholder {
  margin: 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px dashed var(--ob-border);
  border-radius: 6px;
  background: var(--ob-surface);
  font-size: 0.85rem;
  color: var(--ob-muted);
}`;

function renderNavItems(items: readonly NavItem[], currentUrl: string): string {
  if (items.length === 0) return '';
  const listItems = items.map((item) => {
    const active = item.url !== null && item.url === currentUrl;
    const head =
      item.url !== null
        ? `<a href="${escapeHtml(item.url)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(item.title)}</a>`
        : `<span class="oxybook-nav-group">${escapeHtml(item.title)}</span>`;
    const children = item.children.length > 0 ? renderNavItems(item.children, currentUrl) : '';
    return `<li>${head}${children}</li>`;
  });
  return `<ul>${listItems.join('')}</ul>`;
}

function normalizePrefix(versionPrefix: string | undefined): string {
  if (!versionPrefix) return '';
  const clean = versionPrefix.replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '';
}

/**
 * Wrap a rendered page body in a complete static HTML document with sidebar navigation
 * and Pagefind search hooks (ARCHITECTURE §5.2–5.3, §6).
 */
export function renderDocumentHtml(options: DocumentHtmlOptions): string {
  const prefix = normalizePrefix(options.versionPrefix);
  const homeUrl = prefix || '/';
  const fullTitle =
    options.pageTitle === options.siteTitle
      ? options.siteTitle
      : `${options.pageTitle} — ${options.siteTitle}`;
  const descriptionMeta =
    options.description && options.description.trim() !== ''
      ? `\n  <meta name="description" content="${escapeHtml(options.description.trim())}">`
      : '';
  const hasH1 = /<h1[\s>]/i.test(options.bodyHtml);
  const headingHtml = hasH1 ? '' : `<h1>${escapeHtml(options.pageTitle)}</h1>\n`;
  const pagefindAttr = options.searchable === false ? '' : ' data-pagefind-body';
  const navHtml = renderNavItems(options.nav, options.currentUrl);
  const bundlePath = `${prefix}/pagefind/`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>${descriptionMeta}
  <link rel="stylesheet" href="${escapeHtml(bundlePath)}pagefind-ui.css">
  <style>${DEFAULT_STYLES}</style>
</head>
<body>
  <div class="oxybook-layout">
    <aside class="oxybook-sidebar" data-pagefind-ignore>
      <a class="oxybook-site-title" href="${escapeHtml(homeUrl)}">${escapeHtml(options.siteTitle)}</a>
      <div id="oxybook-search" class="oxybook-search"></div>
      <nav class="oxybook-nav" aria-label="Documentation">${navHtml}</nav>
    </aside>
    <main class="oxybook-content"${pagefindAttr}>
      <article class="oxybook-article">
        ${headingHtml}${options.bodyHtml}
      </article>
    </main>
  </div>
  <script src="${escapeHtml(bundlePath)}pagefind-ui.js" defer></script>
  <script>
    window.addEventListener('DOMContentLoaded', function () {
      if (typeof window.PagefindUI === 'function') {
        new window.PagefindUI({
          element: '#oxybook-search',
          bundlePath: ${JSON.stringify(bundlePath)},
          showSubResults: true
        });
      }
    });
  </script>
</body>
</html>
`;
}

export function render404Html(options: {
  siteTitle: string;
  nav: readonly NavItem[];
  versionPrefix?: string;
}): string {
  const prefix = normalizePrefix(options.versionPrefix);
  const homeUrl = prefix || '/';
  const navHtml = renderNavItems(options.nav, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page not found — ${escapeHtml(options.siteTitle)}</title>
  <style>${DEFAULT_STYLES}</style>
</head>
<body>
  <div class="oxybook-layout">
    <aside class="oxybook-sidebar" data-pagefind-ignore>
      <a class="oxybook-site-title" href="${escapeHtml(homeUrl)}">${escapeHtml(options.siteTitle)}</a>
      <nav class="oxybook-nav" aria-label="Documentation">${navHtml}</nav>
    </aside>
    <main class="oxybook-content">
      <article class="oxybook-article">
        <h1>Page not found</h1>
        <p>The requested page does not exist. Return to <a href="${escapeHtml(homeUrl)}">${escapeHtml(options.siteTitle)}</a>.</p>
      </article>
    </main>
  </div>
</body>
</html>
`;
}

export function renderRedirectHtml(options: {
  fromUrl: string;
  toUrl: string;
  siteTitle?: string;
}): string {
  const to = options.toUrl;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Redirecting to ${escapeHtml(to)}</title>
  <link rel="canonical" href="${escapeHtml(to)}">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(to)}">
  <script>location.replace(${JSON.stringify(to)} + location.hash);</script>
</head>
<body>
  <p>Redirecting from <code>${escapeHtml(options.fromUrl)}</code> to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>…</p>
</body>
</html>
`;
}
