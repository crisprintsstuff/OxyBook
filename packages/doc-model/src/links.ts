// SPDX-License-Identifier: AGPL-3.0-only

import { parse } from './parse.js';
import type { MdastNode, ParseOptions } from './types.js';

/**
 * Link destinations as byte ranges of the original file (ARCHITECTURE §2.5: renames patch
 * "only the link destination span; the rest of the referring file is untouched").
 * Inline links, images, and reference definitions in editable blocks are found; links
 * inside raw blocks (JSX, HTML, directives) are not touched and are counted instead.
 */

export interface LinkSpan {
  kind: 'link' | 'image' | 'definition';
  /** Absolute offsets of the destination, without `<` `>` when it is bracketed. */
  start: number;
  end: number;
  /** The destination exactly as written. */
  raw: string;
  angled: boolean;
  /** 1-based line of the link. */
  line: number;
}

export interface LinkScan {
  links: LinkSpan[];
  /** Links whose destination could not be located byte for byte; never rewritten. */
  skipped: { line: number; url: string }[];
  /** Raw (kept as is) blocks and inline HTML/JSX, with their source, for callers that report links there. */
  rawBlocks: { line: number; source: string }[];
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function sameUrl(raw: string, url: string): boolean {
  const plain = unescapeMarkdown(raw);
  if (plain === url) return true;
  try {
    return decodeURI(plain) === decodeURI(url) || encodeURI(plain) === url;
  } catch {
    return false;
  }
}

/** The destination after `](` or `]:` at `at`, as CommonMark reads it. */
function destinationAt(
  source: string,
  at: number,
  limit: number,
): { start: number; end: number; angled: boolean } | null {
  let i = at;
  while (i < limit && (source[i] === ' ' || source[i] === '\t')) i++;
  if (source[i] === '\r') i++;
  if (source[i] === '\n') i++;
  while (i < limit && (source[i] === ' ' || source[i] === '\t')) i++;
  if (source[i] === '<') {
    const close = source.indexOf('>', i + 1);
    if (close < 0 || close > limit || source.slice(i + 1, close).includes('\n')) return null;
    return { start: i + 1, end: close, angled: true };
  }
  const start = i;
  let depth = 0;
  while (i < limit) {
    const c = source[i] as string;
    if (c === '\\' && i + 1 < limit) {
      i += 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c <= ' ') break;
    i++;
  }
  return i > start ? { start, end: i, angled: false } : null;
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

/** Every link destination in a markdown or MDX file. */
export function scanLinks(source: string, options: ParseOptions = {}): LinkScan | null {
  const parsed = parse(source, options);
  if (!parsed.ok) return null;
  const doc = parsed.doc;
  const scan: LinkScan = { links: [], skipped: [], rawBlocks: [] };
  const offset = (node: MdastNode, edge: 'start' | 'end') => {
    const value = node.position?.[edge].offset;
    return typeof value === 'number' ? doc.bodyStart + value : null;
  };
  const visit = (node: MdastNode) => {
    // Inline HTML and JSX inside an editable block: kept as is, reported like raw blocks.
    if (node.type === 'html' || node.type.startsWith('mdx')) {
      const start = offset(node, 'start');
      const end = offset(node, 'end');
      if (start !== null && end !== null)
        scan.rawBlocks.push({ line: lineAt(source, start), source: source.slice(start, end) });
      return;
    }
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      const start = offset(node, 'start');
      const end = offset(node, 'end');
      const url = typeof node.url === 'string' ? node.url : '';
      if (start !== null && end !== null) {
        const opener = node.type === 'definition' ? ']:' : '](';
        let found: LinkSpan | null = null;
        // The first opener whose destination reads back as the node's URL (link text may
        // itself contain brackets).
        for (
          let at = source.indexOf(opener, start);
          at >= 0 && at < end;
          at = source.indexOf(opener, at + 1)
        ) {
          const dest = destinationAt(source, at + 2, end);
          if (dest && sameUrl(source.slice(dest.start, dest.end), url)) {
            found = {
              kind: node.type,
              start: dest.start,
              end: dest.end,
              raw: source.slice(dest.start, dest.end),
              angled: dest.angled,
              line: lineAt(source, start),
            };
            break;
          }
        }
        if (found) scan.links.push(found);
        else if (url) scan.skipped.push({ line: lineAt(source, start), url });
      }
      if (node.type === 'definition') return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const block of doc.blocks) {
    // A reference definition is a raw block, but its destination is still patched in place.
    if (block.rawKind === 'definition' && block.mdast) {
      visit(block.mdast);
      continue;
    }
    if (!block.editable || !block.mdast) {
      scan.rawBlocks.push({ line: lineAt(source, block.start), source: block.source });
      continue;
    }
    visit(block.mdast);
  }
  return scan;
}

/**
 * Rewrite link destinations: `map` gets each destination as written and returns the new
 * one, or null to leave it. Only destination bytes change. A destination that needs
 * brackets (spaces, unbalanced parentheses) gets them.
 */
export function rewriteLinks(
  source: string,
  options: ParseOptions,
  map: (raw: string, link: LinkSpan) => string | null,
): {
  text: string;
  changed: LinkSpan[];
  skipped: LinkScan['skipped'];
  rawBlocks: LinkScan['rawBlocks'];
} | null {
  const scan = scanLinks(source, options);
  if (!scan) return null;
  const changes: { link: LinkSpan; next: string }[] = [];
  for (const link of scan.links) {
    const next = map(link.raw, link);
    if (next !== null && next !== link.raw) changes.push({ link, next });
  }
  let text = source;
  for (const { link, next } of [...changes].sort((a, b) => b.link.start - a.link.start)) {
    const needsAngles = !link.angled && /[\s<>]|\((?![^()]*\))/.test(next);
    const replacement = needsAngles ? `<${next}>` : next;
    text = text.slice(0, link.start) + replacement + text.slice(link.end);
  }
  return {
    text,
    changed: changes.map((c) => c.link),
    skipped: scan.skipped,
    rawBlocks: scan.rawBlocks,
  };
}

/** Split a destination into its path and its `?query#fragment` suffix. */
export function splitHref(href: string): { path: string; suffix: string } {
  const cut = href.search(/[?#]/);
  return cut < 0
    ? { path: href, suffix: '' }
    : { path: href.slice(0, cut), suffix: href.slice(cut) };
}

/** True for destinations that are not relative file paths (URLs, mailto, absolute, anchors). */
export function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#') || href === ''
  );
}

/**
 * The repository path a relative destination in `fromFile` points to, or null for
 * anything that is not a relative file path or leaves the repository.
 */
export function resolveHref(fromFile: string, href: string): string | null {
  if (isExternalHref(href)) return null;
  let path = splitHref(unescapeMarkdown(href)).path;
  try {
    path = decodeURI(path);
  } catch {
    // Keep it as written.
  }
  const parts = fromFile.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** The relative destination from `fromFile` to `toFile` (both repository paths). */
export function hrefBetween(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...Array(from.length - shared).fill('..'), ...to.slice(shared)].join('/');
}
