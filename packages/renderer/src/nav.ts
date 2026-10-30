// SPDX-License-Identifier: AGPL-3.0-only

import posixPath from 'node:path/posix';
import { parse as parseYaml } from 'yaml';

/**
 * Per-directory navigation config from `_dir.yml` (ARCHITECTURE §2.3).
 */
export interface DirConfig {
  title?: string;
  order: string[];
}

export interface NavPageInput {
  /** Path relative to the content root, e.g. 'index.md', 'guides/install.md'. */
  path: string;
  /** Resolved site URL, e.g. '/', '/guides/install'. */
  url: string;
  title: string;
  navTitle?: string | null;
  hidden?: boolean;
}

export interface NavItem {
  /** File or directory name without extension, e.g. 'getting-started' or 'guides'. */
  name: string;
  /** Label shown in the sidebar (`nav_title ?? title`, or `_dir.yml` `title`). */
  title: string;
  /** Site URL when this node is a page or a directory with an index page; null for a pure directory. */
  url: string | null;
  /** Child nodes when this node is a directory. */
  children: NavItem[];
}

const INDEX_FILE = /^index\.mdx?$/i;
const README_FILE = /^readme\.md$/i;

function stripPageExt(name: string): string {
  return name.replace(/\.mdx?$/i, '');
}

/**
 * Parse a `_dir.yml` file (ARCHITECTURE §2.3). Never throws on invalid YAML.
 */
export function parseDirConfig(yamlSource: string): DirConfig {
  if (!yamlSource.trim()) return { order: [] };
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    return { order: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { order: [] };
  }
  const raw = parsed as Record<string, unknown>;
  const config: DirConfig = { order: [] };
  if (typeof raw.title === 'string' && raw.title.trim() !== '') {
    config.title = raw.title.trim();
  }
  if (Array.isArray(raw.order)) {
    for (const item of raw.order) {
      if (typeof item === 'string' && item.trim() !== '') {
        config.order.push(stripPageExt(item.trim().replace(/\/+$/, '')));
      }
    }
  }
  return config;
}

function normalizeDirMap(
  input?: ReadonlyMap<string, string | DirConfig> | Readonly<Record<string, string | DirConfig>>,
): Map<string, DirConfig> {
  const map = new Map<string, DirConfig>();
  if (!input) return map;
  const entries = input instanceof Map ? input.entries() : Object.entries(input);
  for (const [rawDir, rawCfg] of entries) {
    const dir = rawDir
      .replace(/^(?:\.\/|\/)+/, '')
      .replace(/(?:\/|^)_dir\.ya?ml$/i, '')
      .replace(/\/+$/, '');
    const normalizedDir = dir === '.' ? '' : dir;
    const cfg = typeof rawCfg === 'string' ? parseDirConfig(rawCfg) : rawCfg;
    map.set(normalizedDir, cfg);
  }
  return map;
}

function pageLabel(page: NavPageInput): string {
  return page.navTitle && page.navTitle.trim() !== '' ? page.navTitle.trim() : page.title;
}

function findDirectoryIndexPage(pagesInDir: readonly NavPageInput[]): NavPageInput | undefined {
  const indexPage = pagesInDir.find((p) => INDEX_FILE.test(posixPath.basename(p.path)));
  if (indexPage) return indexPage;
  return pagesInDir.find((p) => README_FILE.test(posixPath.basename(p.path)));
}

function orderCandidates(candidates: readonly NavItem[], order: readonly string[]): NavItem[] {
  if (candidates.length === 0) return [];
  const remaining = [...candidates];
  const ordered: NavItem[] = [];

  for (const key of order) {
    let idx = remaining.findIndex((item) => item.name === key);
    if (idx < 0) {
      const lower = key.toLowerCase();
      idx = remaining.findIndex((item) => item.name.toLowerCase() === lower);
    }
    if (idx >= 0) {
      const [picked] = remaining.splice(idx, 1);
      if (picked) ordered.push(picked);
    }
  }

  remaining.sort(
    (a, b) =>
      a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name),
  );
  return [...ordered, ...remaining];
}

/**
 * Build the sidebar navigation tree from the page tree and `_dir.yml` files
 * (ARCHITECTURE §2.2–2.4).
 *
 * - Hidden pages (`hidden: true`) are omitted from the sidebar.
 * - `index.md` / `index.mdx` (or `README.md` when no `index.*` exists) is the page
 *   for its directory.
 * - Direct children of each directory (pages and subdirectories) are ordered according
 *   to that directory's `_dir.yml` `order:` list (without extension), followed by any
 *   unlisted items sorted alphabetically by title.
 */
export function buildNavTree(
  pages: readonly NavPageInput[],
  dirConfigs?:
    | ReadonlyMap<string, string | DirConfig>
    | Readonly<Record<string, string | DirConfig>>,
): NavItem[] {
  const dirs = normalizeDirMap(dirConfigs);
  const visible = pages.filter((p) => !p.hidden);

  const pagesByDir = new Map<string, NavPageInput[]>();
  const childDirsByDir = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!pagesByDir.has(dir)) pagesByDir.set(dir, []);
    if (!childDirsByDir.has(dir)) childDirsByDir.set(dir, new Set());
  };

  ensureDir('');
  for (const page of visible) {
    const cleanPath = page.path.replace(/^\/+/, '');
    const rawDir = posixPath.dirname(cleanPath);
    const dir = rawDir === '.' ? '' : rawDir;
    ensureDir(dir);
    pagesByDir.get(dir)?.push(page);

    let cur = dir;
    while (cur !== '') {
      const parentRaw = posixPath.dirname(cur);
      const parent = parentRaw === '.' ? '' : parentRaw;
      ensureDir(parent);
      childDirsByDir.get(parent)?.add(cur);
      cur = parent;
    }
  }

  const buildDir = (dir: string, isRoot: boolean): NavItem[] => {
    const dirPages = pagesByDir.get(dir) ?? [];
    const subDirs = [...(childDirsByDir.get(dir) ?? [])];
    const cfg = dirs.get(dir);
    const order = cfg?.order ?? [];
    const indexPage = findDirectoryIndexPage(dirPages);
    const indexExplicitlyOrdered =
      indexPage !== undefined &&
      order.some((k) => {
        const lower = k.toLowerCase();
        const base = stripPageExt(posixPath.basename(indexPage.path)).toLowerCase();
        return lower === 'index' || lower === base;
      });

    const candidates: NavItem[] = [];

    for (const page of dirPages) {
      if (indexPage && page.path === indexPage.path && (!isRoot || !indexExplicitlyOrdered)) {
        continue;
      }
      const name = stripPageExt(posixPath.basename(page.path));
      candidates.push({
        name,
        title: pageLabel(page),
        url: page.url,
        children: [],
      });
    }

    for (const subDir of subDirs) {
      const subName = posixPath.basename(subDir);
      const subCfg = dirs.get(subDir);
      const subPages = pagesByDir.get(subDir) ?? [];
      const subIndex = findDirectoryIndexPage(subPages);
      const subChildren = buildDir(subDir, false);
      if (!subIndex && subChildren.length === 0) continue;

      const subTitle = subCfg?.title ?? (subIndex ? pageLabel(subIndex) : undefined) ?? subName;
      candidates.push({
        name: subName,
        title: subTitle,
        url: subIndex ? subIndex.url : null,
        children: subChildren,
      });
    }

    const ordered = orderCandidates(candidates, order);
    if (isRoot && indexPage && !indexExplicitlyOrdered) {
      return [
        {
          name: stripPageExt(posixPath.basename(indexPage.path)),
          title: pageLabel(indexPage),
          url: indexPage.url,
          children: [],
        },
        ...ordered,
      ];
    }
    return ordered;
  };

  return buildDir('', true);
}
