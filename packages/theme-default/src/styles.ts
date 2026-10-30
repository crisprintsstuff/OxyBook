// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_THEME_CSS = `:root {
  color-scheme: light dark;
  --ob-bg: #ffffff;
  --ob-fg: #1f2328;
  --ob-muted: #59636e;
  --ob-border: #d1d9e0;
  --ob-surface: #f6f8fa;
  --ob-surface-hover: #eaeef2;
  --ob-accent: #0969da;
  --ob-accent-subtle: #ddf4ff;
  --ob-tip: #1a7f37;
  --ob-warning: #9a6700;
  --ob-danger: #d1242f;
  --ob-header-h: 3.5rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ob-bg: #0d1117;
    --ob-fg: #e6edf3;
    --ob-muted: #8b949e;
    --ob-border: #30363d;
    --ob-surface: #161b22;
    --ob-surface-hover: #21262d;
    --ob-accent: #58a6ff;
    --ob-accent-subtle: rgba(56, 139, 253, 0.15);
    --ob-tip: #3fb950;
    --ob-warning: #d29922;
    --ob-danger: #f85149;
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
  line-height: 1.65;
  color: var(--ob-fg);
  background: var(--ob-bg);
}
.oxybook-header {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  height: var(--ob-header-h);
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--ob-border);
  background: var(--ob-bg);
}
.oxybook-header-left, .oxybook-header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.oxybook-mobile-toggle {
  display: none;
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--ob-border);
  border-radius: 6px;
  background: var(--ob-surface);
  color: var(--ob-fg);
  font-size: 0.875rem;
  cursor: pointer;
}
.oxybook-site-title {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--ob-fg);
  text-decoration: none;
}
.oxybook-site-logo {
  height: 1.5rem;
  width: auto;
}
.oxybook-header-links {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.oxybook-header-links a {
  color: var(--ob-muted);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
}
.oxybook-header-links a:hover { color: var(--ob-fg); }
.oxybook-version-select {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--ob-border);
  border-radius: 6px;
  background: var(--ob-surface);
  color: var(--ob-fg);
  font-size: 0.85rem;
}
.oxybook-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 220px;
  min-height: calc(100vh - var(--ob-header-h));
}
@media (max-width: 1120px) {
  .oxybook-layout { grid-template-columns: 260px minmax(0, 1fr); }
  .oxybook-toc { display: none; }
}
@media (max-width: 800px) {
  .oxybook-mobile-toggle { display: inline-flex; }
  .oxybook-layout { grid-template-columns: 1fr; }
  .oxybook-sidebar {
    display: none;
    border-right: none;
    border-bottom: 1px solid var(--ob-border);
  }
  body[data-sidebar-open="true"] .oxybook-sidebar {
    display: block;
  }
}
.oxybook-sidebar {
  border-right: 1px solid var(--ob-border);
  background: var(--ob-surface);
  padding: 1.25rem 1rem;
}
.oxybook-search { margin-bottom: 1rem; }
.oxybook-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.oxybook-nav ul ul {
  padding-left: 0.875rem;
  margin: 0.2rem 0 0.4rem 0.45rem;
  border-left: 1px solid var(--ob-border);
}
.oxybook-nav li { margin: 0.18rem 0; }
.oxybook-nav a, .oxybook-nav-group {
  display: block;
  padding: 0.3rem 0.55rem;
  border-radius: 6px;
  font-size: 0.92rem;
  color: var(--ob-fg);
  text-decoration: none;
}
.oxybook-nav-group {
  font-weight: 600;
  color: var(--ob-muted);
  margin-top: 0.35rem;
}
.oxybook-nav a:hover { background: var(--ob-surface-hover); }
.oxybook-nav a[aria-current="page"] {
  background: var(--ob-accent-subtle);
  color: var(--ob-accent);
  font-weight: 600;
}
.oxybook-nav li[data-active-branch="true"] > a:not([aria-current="page"]),
.oxybook-nav li[data-active-branch="true"] > .oxybook-nav-group {
  color: var(--ob-fg);
  font-weight: 600;
}
.oxybook-content {
  padding: 2rem 2.75rem 3rem;
  max-width: 54rem;
  width: 100%;
}
@media (max-width: 800px) {
  .oxybook-content { padding: 1.5rem 1.25rem 2.5rem; }
}
.oxybook-article h1, .oxybook-article h2, .oxybook-article h3, .oxybook-article h4 {
  line-height: 1.25;
  margin-top: 1.75rem;
  margin-bottom: 0.75rem;
}
.oxybook-article h1 { font-size: 2rem; margin-top: 0; }
.oxybook-article h2 {
  font-size: 1.45rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--ob-border);
}
.oxybook-article a { color: var(--ob-accent); }
.oxybook-article img { max-width: 100%; height: auto; border-radius: 6px; }
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
.oxybook-article :not(pre) > code {
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--ob-surface);
  border: 1px solid var(--ob-border);
}
.oxybook-article table {
  border-collapse: collapse;
  width: 100%;
  margin: 1rem 0;
}
.oxybook-article th, .oxybook-article td {
  border: 1px solid var(--ob-border);
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.oxybook-article th { background: var(--ob-surface); }
.oxybook-callout {
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  border-left: 4px solid var(--ob-accent);
  background: var(--ob-surface);
  border-radius: 0 6px 6px 0;
}
.oxybook-callout[data-callout="tip"] { border-left-color: var(--ob-tip); }
.oxybook-callout[data-callout="warning"],
.oxybook-callout[data-callout="caution"] { border-left-color: var(--ob-warning); }
.oxybook-callout[data-callout="danger"] { border-left-color: var(--ob-danger); }
.oxybook-callout-title {
  font-weight: 600;
  margin: 0 0 0.25rem;
}
.oxybook-callout-body > :first-child { margin-top: 0; }
.oxybook-callout-body > :last-child { margin-bottom: 0; }
.oxybook-tabs, .oxybook-code-group {
  margin: 1rem 0;
  border: 1px solid var(--ob-border);
  border-radius: 8px;
  overflow: hidden;
}
.oxybook-tabs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.35rem 0.5rem 0;
  background: var(--ob-surface);
  border-bottom: 1px solid var(--ob-border);
}
.oxybook-tab {
  padding: 0.4rem 0.85rem;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--ob-muted);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.oxybook-tab:hover { color: var(--ob-fg); }
.oxybook-tab[aria-selected="true"] {
  background: var(--ob-bg);
  color: var(--ob-accent);
  border-color: var(--ob-border);
  font-weight: 600;
}
.oxybook-tab-item { padding: 0.85rem 1rem; }
.oxybook-tab-item[hidden], .oxybook-code-panel[hidden] { display: none; }
.oxybook-code-group pre {
  margin: 0;
  border: none;
  border-radius: 0;
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
.oxybook-link-card:hover { border-color: var(--ob-accent); }
.oxybook-card-title, .oxybook-link-card-title {
  display: block;
  font-weight: 600;
  margin: 0 0 0.35rem;
}
.oxybook-link-card-description {
  display: block;
  font-size: 0.875rem;
  color: var(--ob-muted);
}
.oxybook-link-button {
  display: inline-block;
  padding: 0.45rem 0.9rem;
  border-radius: 6px;
  border: 1px solid var(--ob-accent);
  background: var(--ob-accent);
  color: #ffffff !important;
  text-decoration: none;
  font-weight: 600;
  margin: 0.25rem 0.5rem 0.25rem 0;
}
.oxybook-link-button[data-variant="secondary"],
.oxybook-link-button[data-variant="minimal"] {
  background: transparent;
  color: var(--ob-fg) !important;
  border-color: var(--ob-border);
}
.oxybook-badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  font-size: 0.78rem;
  font-weight: 600;
  border-radius: 999px;
  background: var(--ob-accent-subtle);
  color: var(--ob-accent);
}
.oxybook-steps > ol {
  counter-reset: ob-step;
  list-style: none;
  padding-left: 2.25rem;
}
.oxybook-steps > ol > li {
  counter-increment: ob-step;
  position: relative;
  margin: 1rem 0;
}
.oxybook-steps > ol > li::before {
  content: counter(ob-step);
  position: absolute;
  left: -2.25rem;
  top: 0.1rem;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  background: var(--ob-accent-subtle);
  color: var(--ob-accent);
  font-size: 0.82rem;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.oxybook-file-tree {
  padding: 0.75rem 1rem;
  border: 1px solid var(--ob-border);
  border-radius: 6px;
  background: var(--ob-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88rem;
}
.oxybook-placeholder {
  margin: 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px dashed var(--ob-border);
  border-radius: 6px;
  background: var(--ob-surface);
  font-size: 0.85rem;
  color: var(--ob-muted);
}
.oxybook-pager {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 3rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--ob-border);
}
.oxybook-pager-link {
  display: flex;
  flex-direction: column;
  padding: 0.65rem 0.9rem;
  border: 1px solid var(--ob-border);
  border-radius: 8px;
  text-decoration: none;
  color: var(--ob-fg);
  min-width: 10rem;
}
.oxybook-pager-link:hover { border-color: var(--ob-accent); }
.oxybook-pager-next { margin-left: auto; text-align: right; }
.oxybook-pager-label {
  font-size: 0.75rem;
  color: var(--ob-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.oxybook-pager-title {
  font-weight: 600;
  color: var(--ob-accent);
}
.oxybook-toc {
  padding: 1.75rem 1rem;
  border-left: 1px solid var(--ob-border);
  font-size: 0.85rem;
}
.oxybook-toc-inner {
  position: sticky;
  top: calc(var(--ob-header-h) + 1.5rem);
}
.oxybook-toc-title {
  font-weight: 600;
  margin: 0 0 0.5rem;
  color: var(--ob-fg);
}
.oxybook-toc ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.oxybook-toc li { margin: 0.25rem 0; }
.oxybook-toc li[data-depth="3"] { padding-left: 0.75rem; }
.oxybook-toc a {
  color: var(--ob-muted);
  text-decoration: none;
}
.oxybook-toc a:hover { color: var(--ob-accent); }
.oxybook-footer {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ob-border);
  font-size: 0.85rem;
  color: var(--ob-muted);
}`;
