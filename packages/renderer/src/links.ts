// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path/posix';
import { pageUrl } from '@oxybook/sync';

export type PageLookupInput =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>
  | ReadonlySet<string>;

export interface BrokenLinkWarning {
  reason: 'broken-link';
  href: string;
  resolvedPath: string;
  line: number | null;
}

export class StrictBuildError extends Error {
  readonly brokenLinks: readonly BrokenLinkWarning[];

  constructor(file: string, brokenLinks: readonly BrokenLinkWarning[]) {
    const details = brokenLinks
      .map((item) => {
        const where = item.line === null ? file : `${file}:${item.line}`;
        return `${where}: broken link "${item.href}" (resolved to "${item.resolvedPath}")`;
      })
      .join('; ');
    super(`strict build failed with ${brokenLinks.length} broken link(s): ${details}`);
    this.name = 'StrictBuildError';
    this.brokenLinks = brokenLinks;
  }
}

export interface LinkResolution {
  href: string;
  broken: boolean;
  resolvedPath: string | null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isExternalOrAnchor(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return true;
  }
  return SCHEME.test(trimmed);
}

function splitHref(rawHref: string): { pathname: string; search: string; hash: string } {
  let rest = rawHref;
  let hash = '';
  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    hash = rest.slice(hashIndex);
    rest = rest.slice(0, hashIndex);
  }
  let search = '';
  const searchIndex = rest.indexOf('?');
  if (searchIndex >= 0) {
    search = rest.slice(searchIndex);
    rest = rest.slice(0, searchIndex);
  }
  return { pathname: rest, search, hash };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function applyVersionPrefix(url: string, versionPrefix: string | undefined): string {
  if (!versionPrefix || versionPrefix === '/') return url;
  const cleanPrefix = `/${versionPrefix.replace(/^\/+|\/+$/g, '')}`;
  if (url === '/') return `${cleanPrefix}/`;
  return `${cleanPrefix}${url.startsWith('/') ? url : `/${url}`}`;
}

export function normalizePageMap(input: PageLookupInput | undefined): Map<string, string> | null {
  if (!input) return null;
  if (input instanceof Map) {
    return new Map(input);
  }
  if (input instanceof Set) {
    const map = new Map<string, string>();
    for (const relPath of input) {
      map.set(relPath, pageUrl(relPath, input));
    }
    return map;
  }
  const map = new Map<string, string>();
  for (const [relPath, url] of Object.entries(input)) {
    map.set(relPath, url);
  }
  return map;
}

function resolveRelativeTarget(pathname: string, currentPagePath: string): string {
  const decoded = safeDecode(pathname);
  if (decoded.startsWith('/')) {
    const stripped = decoded.replace(/^\/+/, '');
    return stripped === '' ? '.' : path.normalize(stripped);
  }
  const dir = path.dirname(currentPagePath);
  const joined = dir === '.' || dir === '' ? decoded : path.join(dir, decoded);
  return path.normalize(joined);
}

/**
 * Rewrite a relative `.md`/`.mdx` or internal page link to its site URL, and report
 * whether the target is missing when a page table (`pages`) is supplied (§2.5, §5.2).
 */
export function resolvePageLink(
  rawHref: string,
  currentPagePath: string,
  pageMap: ReadonlyMap<string, string> | null,
  assets?: ReadonlySet<string>,
  versionPrefix?: string,
): LinkResolution {
  if (isExternalOrAnchor(rawHref)) {
    return { href: rawHref, broken: false, resolvedPath: null };
  }
  const { pathname, search, hash } = splitHref(rawHref);
  if (pathname === '') {
    return { href: rawHref, broken: false, resolvedPath: null };
  }

  const relTarget = resolveRelativeTarget(pathname, currentPagePath);

  if (pageMap) {
    const direct = pageMap.get(relTarget);
    if (direct !== undefined) {
      return {
        href: `${applyVersionPrefix(direct, versionPrefix)}${search}${hash}`,
        broken: false,
        resolvedPath: relTarget,
      };
    }

    if (!/\.mdx?$/i.test(relTarget)) {
      const candidates = [
        `${relTarget}.md`,
        `${relTarget}.mdx`,
        relTarget === '.' ? 'index.md' : `${relTarget}/index.md`,
        relTarget === '.' ? 'index.mdx' : `${relTarget}/index.mdx`,
        relTarget === '.' ? 'README.md' : `${relTarget}/README.md`,
      ];
      for (const candidate of candidates) {
        const hit = pageMap.get(candidate);
        if (hit !== undefined) {
          return {
            href: `${applyVersionPrefix(hit, versionPrefix)}${search}${hash}`,
            broken: false,
            resolvedPath: candidate,
          };
        }
      }
      const asUrl = pathname.startsWith('/')
        ? pathname.length > 1
          ? pathname.replace(/\/+$/, '')
          : '/'
        : `/${relTarget.replace(/\/+$/, '')}`;
      for (const [pagePath, url] of pageMap.entries()) {
        if (url === asUrl) {
          return {
            href: `${applyVersionPrefix(url, versionPrefix)}${search}${hash}`,
            broken: false,
            resolvedPath: pagePath,
          };
        }
      }
    }

    if (assets?.has(relTarget)) {
      return {
        href: `${applyVersionPrefix(`/${relTarget}`, versionPrefix)}${search}${hash}`,
        broken: false,
        resolvedPath: relTarget,
      };
    }

    const fallbackUrl =
      /\.mdx?$/i.test(relTarget) && !relTarget.startsWith('..')
        ? pageUrl(relTarget, new Set([relTarget]))
        : pathname.startsWith('/')
          ? pathname
          : `/${relTarget.replace(/^(\.\.\/)+/, '')}`;

    return {
      href: `${applyVersionPrefix(fallbackUrl, versionPrefix)}${search}${hash}`,
      broken: true,
      resolvedPath: relTarget,
    };
  }

  if (/\.mdx?$/i.test(relTarget) && !relTarget.startsWith('..')) {
    const computed = pageUrl(relTarget, new Set([relTarget]));
    return {
      href: `${applyVersionPrefix(computed, versionPrefix)}${search}${hash}`,
      broken: false,
      resolvedPath: relTarget,
    };
  }

  return { href: rawHref, broken: false, resolvedPath: null };
}

/**
 * Rewrite a relative asset `src` (such as `images/stack.svg` in `guides/install.md`)
 * to its site path (`/guides/images/stack.svg`), per ARCHITECTURE §2.2.
 */
export function resolveAssetLink(
  rawSrc: string,
  currentPagePath: string,
  assets?: ReadonlySet<string>,
  versionPrefix?: string,
): LinkResolution {
  if (isExternalOrAnchor(rawSrc)) {
    return { href: rawSrc, broken: false, resolvedPath: null };
  }
  const { pathname, search, hash } = splitHref(rawSrc);
  if (pathname === '') {
    return { href: rawSrc, broken: false, resolvedPath: null };
  }
  const relTarget = resolveRelativeTarget(pathname, currentPagePath);
  if (relTarget.startsWith('..')) {
    return {
      href: rawSrc,
      broken: assets !== undefined,
      resolvedPath: relTarget,
    };
  }
  const sitePath = applyVersionPrefix(`/${relTarget}`, versionPrefix);
  const broken = assets !== undefined && !assets.has(relTarget);
  return {
    href: `${sitePath}${search}${hash}`,
    broken,
    resolvedPath: relTarget,
  };
}
