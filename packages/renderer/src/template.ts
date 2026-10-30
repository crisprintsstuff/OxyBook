// SPDX-License-Identifier: AGPL-3.0-only

import {
  render404Document,
  renderPageDocument,
  renderRedirectDocument,
  type ThemeConfig,
  type ThemeVersionLink,
} from '@oxybook/theme-default';
import type { NavItem } from './nav.js';
import type { SearchHeading } from './render.js';

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
  /** Available versions for the header version switcher. */
  versions?: readonly ThemeVersionLink[];
  /** Whether Pagefind should index this page (default true; false for hidden pages if desired). */
  searchable?: boolean;
  /** Optional default-theme configuration (`oxybook.yml` `theme:`). */
  theme?: ThemeConfig;
}

/**
 * Wrap a rendered page body in the default documentation theme (`@oxybook/theme-default`,
 * ARCHITECTURE §5.2–5.3, §6).
 */
export function renderDocumentHtml(options: DocumentHtmlOptions): string {
  return renderPageDocument(options);
}

export function render404Html(options: {
  siteTitle: string;
  nav: readonly NavItem[];
  versionPrefix?: string;
  versions?: readonly ThemeVersionLink[];
  theme?: ThemeConfig;
}): string {
  return render404Document(options);
}

export function renderRedirectHtml(options: {
  fromUrl: string;
  toUrl: string;
  siteTitle?: string;
}): string {
  return renderRedirectDocument(options);
}
