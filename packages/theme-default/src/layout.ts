// SPDX-License-Identifier: Apache-2.0

import { buildThemeClientScript } from './client.js';
import { DEFAULT_THEME_CSS } from './styles.js';
import type {
  ThemeConfig,
  ThemeHeading,
  ThemeNavItem,
  ThemePageLink,
  ThemePageProps,
  ThemeVersionLink,
} from './types.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePrefix(versionPrefix: string | undefined): string {
  if (!versionPrefix) return '';
  const clean = versionPrefix.replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '';
}

function isSafeCssColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$|^(?:rgb|hsl)a?\([0-9.,%\s]+\)$|^[a-zA-Z]{3,20}$/.test(value.trim());
}

export function buildThemeStyles(theme?: ThemeConfig): string {
  if (theme?.accentColor && isSafeCssColor(theme.accentColor)) {
    return `${DEFAULT_THEME_CSS}\n:root { --ob-accent: ${theme.accentColor.trim()}; }`;
  }
  return DEFAULT_THEME_CSS;
}

/**
 * Flatten the sidebar navigation tree into sequential reading order.
 */
export function flattenNavPages(nav: readonly ThemeNavItem[]): ThemePageLink[] {
  const result: ThemePageLink[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly ThemeNavItem[]) => {
    for (const item of items) {
      if (item.url !== null && !seen.has(item.url)) {
        seen.add(item.url);
        result.push({ title: item.title, url: item.url });
      }
      if (item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(nav);
  return result;
}

/**
 * Find the previous and next pages in sidebar reading order for `currentUrl`.
 */
export function findPrevNextPages(
  nav: readonly ThemeNavItem[],
  currentUrl: string,
): { prev: ThemePageLink | null; next: ThemePageLink | null } {
  const flat = flattenNavPages(nav);
  const idx = flat.findIndex((item) => item.url === currentUrl);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? (flat[idx - 1] ?? null) : null,
    next: idx + 1 < flat.length ? (flat[idx + 1] ?? null) : null,
  };
}

function containsUrl(item: ThemeNavItem, targetUrl: string): boolean {
  if (!targetUrl) return false;
  if (item.url === targetUrl) return true;
  return item.children.some((child) => containsUrl(child, targetUrl));
}

function renderNavItems(items: readonly ThemeNavItem[], currentUrl: string): string {
  if (items.length === 0) return '';
  const listItems = items.map((item) => {
    const active = item.url !== null && item.url === currentUrl;
    const activeBranch = containsUrl(item, currentUrl);
    const head =
      item.url !== null
        ? `<a href="${escapeHtml(item.url)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(item.title)}</a>`
        : `<span class="oxybook-nav-group">${escapeHtml(item.title)}</span>`;
    const children = item.children.length > 0 ? renderNavItems(item.children, currentUrl) : '';
    return `<li${activeBranch ? ' data-active-branch="true"' : ''}>${head}${children}</li>`;
  });
  return `<ul>${listItems.join('')}</ul>`;
}

function renderToc(headings: readonly ThemeHeading[] | undefined): string {
  const tocHeadings = (headings ?? []).filter(
    (h) => (h.depth === 2 || h.depth === 3) && Boolean(h.id ?? h.slug),
  );
  if (tocHeadings.length === 0) return '';
  const items = tocHeadings
    .map((h) => {
      const slug = h.id ?? h.slug ?? '';
      return `<li data-depth="${h.depth}"><a href="#${escapeHtml(slug)}">${escapeHtml(h.text)}</a></li>`;
    })
    .join('');
  return `\n    <aside class="oxybook-toc" aria-label="On this page" data-pagefind-ignore>
      <div class="oxybook-toc-inner">
        <p class="oxybook-toc-title">On this page</p>
        <ul>${items}</ul>
      </div>
    </aside>`;
}

function renderPager(prev: ThemePageLink | null, next: ThemePageLink | null): string {
  if (!prev && !next) return '';
  const prevHtml = prev
    ? `<a class="oxybook-pager-link oxybook-pager-prev" href="${escapeHtml(prev.url)}" rel="prev"><span class="oxybook-pager-label">Previous</span><span class="oxybook-pager-title">${escapeHtml(prev.title)}</span></a>`
    : '';
  const nextHtml = next
    ? `<a class="oxybook-pager-link oxybook-pager-next" href="${escapeHtml(next.url)}" rel="next"><span class="oxybook-pager-label">Next</span><span class="oxybook-pager-title">${escapeHtml(next.title)}</span></a>`
    : '';
  return `\n      <nav class="oxybook-pager" aria-label="Page navigation" data-pagefind-ignore>${prevHtml}${nextHtml}</nav>`;
}

function renderHeader(
  siteTitle: string,
  homeUrl: string,
  theme?: ThemeConfig,
  versions?: readonly ThemeVersionLink[],
): string {
  let logoHtml = '';
  if (typeof theme?.logo === 'string') {
    logoHtml = `<img class="oxybook-site-logo" src="${escapeHtml(theme.logo)}" alt="">`;
  } else if (theme?.logo && typeof theme.logo === 'object') {
    logoHtml = `<img class="oxybook-site-logo" src="${escapeHtml(theme.logo.src)}" alt="${escapeHtml(theme.logo.alt ?? '')}">`;
  }
  const versionSwitcher =
    versions && versions.length > 1
      ? `<select class="oxybook-version-select" data-version-switcher aria-label="Version">${versions
          .map(
            (v) =>
              `<option value="${escapeHtml(v.url)}"${v.current ? ' selected' : ''}>${escapeHtml(v.name)}</option>`,
          )
          .join('')}</select>`
      : '';
  const headerLinks =
    theme?.headerLinks && theme.headerLinks.length > 0
      ? `<nav class="oxybook-header-links" aria-label="Header links">${theme.headerLinks
          .map((link) => {
            const isExt = link.external ?? /^https?:\/\//i.test(link.href);
            const extAttrs = isExt ? ' rel="noopener noreferrer" target="_blank"' : '';
            return `<a href="${escapeHtml(link.href)}"${extAttrs}>${escapeHtml(link.label)}</a>`;
          })
          .join('')}</nav>`
      : '';

  return `  <header class="oxybook-header" data-pagefind-ignore>
    <div class="oxybook-header-left">
      <button type="button" class="oxybook-mobile-toggle" aria-expanded="false" aria-controls="oxybook-sidebar">Menu</button>
      <a class="oxybook-site-title" href="${escapeHtml(homeUrl)}">${logoHtml}<span>${escapeHtml(siteTitle)}</span></a>
    </div>
    <div class="oxybook-header-right">${versionSwitcher}${headerLinks}</div>
  </header>`;
}

function renderHeadExtras(theme?: ThemeConfig): string {
  const lines: string[] = [];
  if (theme?.favicon) {
    lines.push(`  <link rel="icon" href="${escapeHtml(theme.favicon)}">`);
  }
  if (theme?.customCssUrl) {
    lines.push(`  <link rel="stylesheet" href="${escapeHtml(theme.customCssUrl)}">`);
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/**
 * Render a complete documentation page with the default theme layout, `_dir.yml`
 * sidebar, "On this page" table of contents, prev/next links, interactive component
 * islands, and Pagefind search UI (ARCHITECTURE §5.2–5.5, §6).
 */
export function renderPageDocument(props: ThemePageProps): string {
  const prefix = normalizePrefix(props.versionPrefix);
  const homeUrl = prefix || '/';
  const fullTitle =
    props.pageTitle === props.siteTitle
      ? props.siteTitle
      : `${props.pageTitle} — ${props.siteTitle}`;
  const descriptionMeta =
    props.description && props.description.trim() !== ''
      ? `\n  <meta name="description" content="${escapeHtml(props.description.trim())}">`
      : '';
  const hasH1 = /<h1[\s>]/i.test(props.bodyHtml);
  const headingHtml = hasH1 ? '' : `<h1>${escapeHtml(props.pageTitle)}</h1>\n`;
  const pagefindAttr = props.searchable === false ? '' : ' data-pagefind-body';
  const navHtml = renderNavItems(props.nav, props.currentUrl);
  const tocHtml = renderToc(props.headings);
  const { prev, next } = findPrevNextPages(props.nav, props.currentUrl);
  const pagerHtml = renderPager(prev, next);
  const footerHtml = props.theme?.footer
    ? `\n      <footer class="oxybook-footer" data-pagefind-ignore>${escapeHtml(props.theme.footer)}</footer>`
    : '';
  const bundlePath = `${prefix}/pagefind/`;
  const headerHtml = renderHeader(props.siteTitle, homeUrl, props.theme, props.versions);
  const headExtras = renderHeadExtras(props.theme);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>${descriptionMeta}
  <link rel="stylesheet" href="${escapeHtml(bundlePath)}pagefind-ui.css">
  <style>${buildThemeStyles(props.theme)}</style>${headExtras}
</head>
<body>
${headerHtml}
  <div class="oxybook-layout">
    <aside id="oxybook-sidebar" class="oxybook-sidebar" data-pagefind-ignore>
      <div id="oxybook-search" class="oxybook-search"></div>
      <nav class="oxybook-nav" aria-label="Documentation">${navHtml}</nav>
    </aside>
    <main class="oxybook-content" id="oxybook-main"${pagefindAttr}>
      <article class="oxybook-article">
        ${headingHtml}${props.bodyHtml}
      </article>${pagerHtml}${footerHtml}
    </main>${tocHtml}
  </div>
  <script src="${escapeHtml(bundlePath)}pagefind-ui.js" defer></script>
  <script>${buildThemeClientScript(bundlePath)}</script>
</body>
</html>
`;
}

export function render404Document(options: {
  siteTitle: string;
  nav: readonly ThemeNavItem[];
  versionPrefix?: string;
  versions?: readonly ThemeVersionLink[];
  theme?: ThemeConfig;
}): string {
  const prefix = normalizePrefix(options.versionPrefix);
  const homeUrl = prefix || '/';
  const navHtml = renderNavItems(options.nav, '');
  const bundlePath = `${prefix}/pagefind/`;
  const headerHtml = renderHeader(options.siteTitle, homeUrl, options.theme, options.versions);
  const headExtras = renderHeadExtras(options.theme);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page not found — ${escapeHtml(options.siteTitle)}</title>
  <link rel="stylesheet" href="${escapeHtml(bundlePath)}pagefind-ui.css">
  <style>${buildThemeStyles(options.theme)}</style>${headExtras}
</head>
<body>
${headerHtml}
  <div class="oxybook-layout">
    <aside id="oxybook-sidebar" class="oxybook-sidebar" data-pagefind-ignore>
      <div id="oxybook-search" class="oxybook-search"></div>
      <nav class="oxybook-nav" aria-label="Documentation">${navHtml}</nav>
    </aside>
    <main class="oxybook-content" id="oxybook-main">
      <article class="oxybook-article">
        <h1>Page not found</h1>
        <p>The requested page does not exist. Return to <a href="${escapeHtml(homeUrl)}">${escapeHtml(options.siteTitle)}</a>.</p>
      </article>
    </main>
  </div>
  <script src="${escapeHtml(bundlePath)}pagefind-ui.js" defer></script>
  <script>${buildThemeClientScript(bundlePath)}</script>
</body>
</html>
`;
}

export function renderRedirectDocument(options: {
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
