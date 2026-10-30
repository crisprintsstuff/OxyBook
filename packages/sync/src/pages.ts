// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path/posix';
import { type MdastNode, parse } from '@oxybook/doc-model';
import { parse as parseYaml } from 'yaml';

/**
 * Page rules from ARCHITECTURE §2.2–2.5. Paths here are relative to the content root
 * and use `/`.
 */

/** `*.md` / `*.mdx`, and no path segment starting with `_` or `.` (§2.2). */
export function isPagePath(relPath: string): boolean {
  if (!/\.mdx?$/i.test(relPath)) return false;
  return relPath
    .split('/')
    .every((segment) => !segment.startsWith('_') && !segment.startsWith('.'));
}

/** Non-page file under content root with no path segment starting with `_` or `.` (§2.2). */
export function isAssetPath(relPath: string): boolean {
  if (/\.mdx?$/i.test(relPath)) return false;
  return relPath
    .split('/')
    .every((segment) => segment !== '' && !segment.startsWith('_') && !segment.startsWith('.'));
}

/** `_dir.yml` inside a non-ignored directory under content root (§2.2–2.3). */
export function isDirConfigPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const base = parts.pop();
  if (base !== '_dir.yml') return false;
  return parts.every((segment) => !segment.startsWith('_') && !segment.startsWith('.'));
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '(?:/.*)?$';
  return new RegExp(out);
}

/** Whether `relPath` is matched by `exclude:` in `oxybook.yml` (§2.2). */
export function isExcluded(
  relPath: string,
  excludePatterns: readonly string[] | undefined,
): boolean {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  const cleanRel = relPath.replace(/^\/+/, '');
  for (const raw of excludePatterns) {
    const pattern = raw
      .trim()
      .replace(/^(?:\.\/|\/)+/, '')
      .replace(/\/+$/, '');
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) {
      if (globToRegExp(pattern).test(cleanRel)) return true;
    } else if (cleanRel === pattern || cleanRel.startsWith(`${pattern}/`)) {
      return true;
    }
  }
  return false;
}

/** Extract `exclude:` string list from raw `oxybook.yml` bytes without throwing. */
export function parseExcludeList(bytes: Buffer): string[] {
  try {
    const parsed = parseYaml(bytes.toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = (parsed as Record<string, unknown>).exclude;
      if (Array.isArray(raw)) {
        return raw.filter((item): item is string => typeof item === 'string');
      }
    }
  } catch {
    // Ignore malformed oxybook.yml.
  }
  return [];
}

/** Path relative to the content root, or null when the file is outside it. */
export function relativeToRoot(repoPath: string, root: string): string | null {
  if (!root) return repoPath;
  return repoPath.startsWith(`${root}/`) ? repoPath.slice(root.length + 1) : null;
}

const INDEX = /^index\.mdx?$/i;
const README = /^readme\.md$/i;

/**
 * URL from the path (§2.5): extension removed, `index` collapsed, case kept. `README.md`
 * is the directory page only when that directory has no `index.*` (§2.2). A `slug` is
 * relative to the directory, or absolute when it starts with `/`.
 */
export function pageUrl(relPath: string, allPagePaths: ReadonlySet<string>, slug?: string): string {
  const dir = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
  const base = path.basename(relPath);
  const hasIndex = [...allPagePaths].some(
    (other) =>
      (path.dirname(other) === '.' ? '' : path.dirname(other)) === dir &&
      INDEX.test(path.basename(other)),
  );
  let url: string;
  if (slug !== undefined && slug.trim() !== '') {
    const trimmed = slug.trim();
    url = trimmed.startsWith('/') ? trimmed : `/${dir ? `${dir}/` : ''}${trimmed}`;
  } else if (INDEX.test(base) || (README.test(base) && !hasIndex)) {
    url = `/${dir}`;
  } else {
    url = `/${dir ? `${dir}/` : ''}${base.replace(/\.mdx?$/i, '')}`;
  }
  const collapsed = url.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : '/';
}

export interface PageMeta {
  title: string;
  navTitle: string | null;
  hidden: boolean;
  slug: string | undefined;
  /** Body text for search: the source after the frontmatter. */
  text: string;
}

function textOf(node: MdastNode): string {
  if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode')) {
    return node.value;
  }
  return (node.children ?? []).map(textOf).join('');
}

/** Frontmatter keys from §2.4, then the first H1, then the filename. Never throws. */
export function pageMeta(relPath: string, bytes: Buffer): PageMeta {
  const fallback = path.basename(relPath).replace(/\.mdx?$/i, '');
  const source = bytes.toString('utf8');
  const parsed = parse(source, { filename: relPath });
  if (!parsed.ok) {
    return { title: fallback, navTitle: null, hidden: false, slug: undefined, text: source };
  }
  const doc = parsed.doc;
  let data: Record<string, unknown> = {};
  if (doc.frontmatter?.parseable) {
    try {
      const value = parseYaml(doc.frontmatter.yaml) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        data = value as Record<string, unknown>;
      }
    } catch {
      data = {};
    }
  }
  const str = (key: string) => {
    const value = data[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  let h1: string | undefined;
  for (const block of doc.blocks) {
    if (block.type === 'heading' && block.mdast?.depth === 1) {
      h1 = textOf(block.mdast).trim() || undefined;
      break;
    }
  }
  return {
    title: str('title') ?? h1 ?? fallback,
    navTitle: str('nav_title') ?? null,
    hidden: data.hidden === true,
    slug: str('slug'),
    text: source.slice(doc.bodyStart),
  };
}
