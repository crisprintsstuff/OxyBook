// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation item in the sidebar tree built from the file tree and `_dir.yml`
 * (ARCHITECTURE §2.3).
 */
export interface ThemeNavItem {
  /** File or directory name without extension, e.g. 'getting-started' or 'guides'. */
  name?: string;
  /** Label shown in the sidebar. */
  title: string;
  /** Site URL when this node is a page or a directory with an index page; null for a pure directory. */
  url: string | null;
  /** Child nodes when this node is a directory. */
  children: readonly ThemeNavItem[];
}

export interface ThemeHeading {
  depth: number;
  text: string;
  id?: string;
  slug?: string;
}

export interface ThemeVersionLink {
  name: string;
  url: string;
  current: boolean;
}

export interface ThemeHeaderLink {
  label: string;
  href: string;
  external?: boolean;
}

/**
 * Theme customization from `oxybook.yml` (ARCHITECTURE §5.5).
 */
export interface ThemeConfig {
  logo?: string | { src: string; alt?: string };
  favicon?: string;
  accentColor?: string;
  headerLinks?: readonly ThemeHeaderLink[];
  footer?: string;
  customCssUrl?: string;
}

export interface ThemePageLink {
  title: string;
  url: string;
}

export interface ThemePageProps {
  siteTitle: string;
  pageTitle: string;
  description?: string;
  currentUrl: string;
  bodyHtml: string;
  nav: readonly ThemeNavItem[];
  headings?: readonly ThemeHeading[];
  versions?: readonly ThemeVersionLink[];
  /** Optional version prefix (e.g. '2.x') for versioned assets and Pagefind bundle. */
  versionPrefix?: string;
  /** Whether Pagefind should index this page (default true; false for hidden pages). */
  searchable?: boolean;
  theme?: ThemeConfig;
}
