// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path/posix';
import {
  CALLOUTS,
  type MdastNode,
  type ParseResult,
  type Placeholder,
  type PlaceholderReason,
  parse,
  type SourceDoc,
  STARTING_ALLOWLIST,
} from '@oxybook/doc-model';
import { pageUrl } from '@oxybook/sync';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { type Handlers, type State, toHast } from 'mdast-util-to-hast';
import type { Highlighter } from 'shiki';
import { parse as parseYaml } from 'yaml';
import { type ComponentMap, resolveImports } from './config.js';
import { ensureLanguagesLoaded, highlightCodeToHast } from './highlight.js';
import {
  applyVersionPrefix,
  type BrokenLinkWarning,
  normalizePageMap,
  type PageLookupInput,
  resolveAssetLink,
  resolvePageLink,
  StrictBuildError,
} from './links.js';

/**
 * The M1 built-in component allowlist chosen from the Slice 1 compatibility report
 * (docs/M1-NOTES.md): the MVP starting list plus Starlight's built-ins and Fragment.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  ...STARTING_ALLOWLIST,
  'Aside',
  'Badge',
  'CardGrid',
  'Code',
  'FileTree',
  'Icon',
  'LinkButton',
  'LinkCard',
  'Steps',
  'Fragment',
];

/**
 * Container directives (`:::name`) outside `CALLOUTS` that the renderer handles
 * natively without a placeholder (docs/M1-NOTES.md Finding 1 & 2).
 */
export const DEFAULT_DIRECTIVES: readonly string[] = ['code-group'];

export interface UnparseableWarning {
  reason: 'unparseable';
  error: string;
  line: null;
}

export type BuildWarning = Placeholder | BrokenLinkWarning | UnparseableWarning;

export interface SearchHeading {
  depth: number;
  text: string;
  id: string;
}

/**
 * Search-document stream emitted by the renderer for each page (ARCHITECTURE §6).
 */
export interface SearchDocument {
  url: string;
  title: string;
  description: string | null;
  headings: SearchHeading[];
  text: string;
  version: string;
}

export interface RenderOptions {
  /** Path of the page relative to the content root (e.g. `guides/configure.mdx`). */
  filename?: string;
  /** Allowed JSX component names. Defaults to `DEFAULT_ALLOWLIST`. */
  allowlist?: readonly string[];
  /** Allowed non-callout `:::name` container directives. Defaults to `DEFAULT_DIRECTIVES`. */
  allowDirectives?: readonly string[];
  /** Import mapping from `oxybook.yml` (`components:`). */
  components?: ComponentMap;
  /** Known pages in the space for relative-link resolution and broken-link warnings. */
  pages?: PageLookupInput;
  /** Known asset paths under the content root for asset resolution and warnings. */
  assets?: ReadonlySet<string>;
  /** When true, unresolved internal links throw `StrictBuildError` (§5.2). */
  strict?: boolean;
  /** Version label for the search document (default `'default'`). */
  version?: string;
  /** URL prefix for non-default versions (e.g. `'/2.x'`). */
  versionPrefix?: string;
  /** Optional Shiki highlighter instance. `renderPage` loads the shared one automatically. */
  highlighter?: Highlighter | null;
}

export interface RenderResult {
  parsed: boolean;
  error?: string;
  html: string;
  hast: Root;
  placeholders: Placeholder[];
  brokenLinks: BrokenLinkWarning[];
  warnings: BuildWarning[];
  searchDoc: SearchDocument;
}

export type StaticPropValue =
  | string
  | number
  | boolean
  | null
  | StaticPropValue[]
  | { [key: string]: StaticPropValue };

export function extractStaticProps(
  attributes: readonly MdastNode[] | undefined,
): { ok: true; props: Record<string, StaticPropValue> } | { ok: false } {
  const props: Record<string, StaticPropValue> = {};
  if (!attributes) return { ok: true, props };

  for (const attr of attributes) {
    if (attr.type !== 'mdxJsxAttribute') {
      // mdxJsxExpressionAttribute (`{...spread}`) is never static.
      return { ok: false };
    }
    const attrName = typeof attr.name === 'string' ? attr.name : '';
    if (!attrName) return { ok: false };
    const value = attr.value as unknown;
    if (value === null || value === undefined) {
      props[attrName] = true;
      continue;
    }
    if (typeof value === 'string') {
      props[attrName] = value;
      continue;
    }
    if (
      typeof value === 'object' &&
      (value as MdastNode).type === 'mdxJsxAttributeValueExpression'
    ) {
      const exprText = String((value as MdastNode).value ?? '').trim();
      try {
        props[attrName] = JSON.parse(exprText) as StaticPropValue;
        continue;
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  }
  return { ok: true, props };
}

function isCommentExpression(value: string): boolean {
  const text = value.trim();
  return /^\/\*[\s\S]*\*\/$/.test(text) || /^\/\/[^\n]*$/.test(text);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

const IMPORT_FROM = /\bfrom\s*(['"])([^'"]+)\1/g;
const BARE_IMPORT = /^\s*import\s*(['"])([^'"]+)\1/gm;

function findExportInEsm(
  value: string,
  nodeStartLine: number | null,
): { name: string; line: number | null } | null {
  const lines = value.split('\n');
  const exportIndex = lines.findIndex((line) => /^\s*export\b/.test(line));
  if (exportIndex < 0) return null;
  return {
    name: excerpt(lines[exportIndex] ?? value),
    line: nodeStartLine === null ? null : nodeStartLine + exportIndex,
  };
}

function collectEsmBlocks(doc: SourceDoc): string[] {
  const esm: string[] = [];
  function visit(node: MdastNode): void {
    if (node.type === 'mdxjsEsm') {
      esm.push(String(node.value ?? ''));
    }
    for (const child of node.children ?? []) visit(child);
  }
  for (const block of doc.blocks) {
    if (block.mdast) visit(block.mdast);
  }
  return esm;
}

function collectCodeLanguages(doc: SourceDoc): Set<string> {
  const langs = new Set<string>();
  function visit(node: MdastNode): void {
    if (node.type === 'code' && typeof node.lang === 'string' && node.lang.trim()) {
      langs.add(node.lang);
    } else if (
      (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
      node.name === 'Code'
    ) {
      const extracted = extractStaticProps(node.attributes as MdastNode[] | undefined);
      if (extracted.ok && typeof extracted.props.lang === 'string') {
        langs.add(extracted.props.lang);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  for (const block of doc.blocks) {
    if (block.mdast) visit(block.mdast);
  }
  return langs;
}

function collectPlaceholders(
  source: string,
  doc: SourceDoc,
  allow: ReadonlySet<string>,
  allowDirectives: ReadonlySet<string>,
  importedComponents: ReadonlyMap<string, string>,
): Placeholder[] {
  const placeholders: Placeholder[] = [];
  const frontmatterLines = source.slice(0, doc.bodyStart).split('\n').length - 1;

  function lineOf(node: MdastNode): number | null {
    const line = node.position?.start.line;
    return typeof line === 'number' ? line + frontmatterLines : null;
  }

  function walk(node: MdastNode): void {
    switch (node.type) {
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const name = typeof node.name === 'string' ? node.name : '';
        if (name) {
          const mapped = importedComponents.get(name) ?? name;
          const intrinsic = /^[a-z]/.test(name);
          if (!intrinsic && !allow.has(name) && !allow.has(mapped)) {
            placeholders.push({ reason: 'unknown-component', name, line: lineOf(node) });
          } else {
            const extracted = extractStaticProps(node.attributes as MdastNode[] | undefined);
            if (!extracted.ok) {
              placeholders.push({ reason: 'dynamic-props', name, line: lineOf(node) });
            }
          }
        }
        break;
      }
      case 'mdxjsEsm': {
        const value = String(node.value ?? '');
        // Reset stateful regexes if needed; findExportInEsm checks export lines.
        IMPORT_FROM.lastIndex = 0;
        BARE_IMPORT.lastIndex = 0;
        const exp = findExportInEsm(value, lineOf(node));
        if (exp) {
          placeholders.push({
            reason: 'export',
            name: exp.name,
            line: exp.line,
          });
        }
        break;
      }
      case 'mdxFlowExpression':
      case 'mdxTextExpression': {
        const value = String(node.value ?? '');
        if (!isCommentExpression(value)) {
          placeholders.push({
            reason: 'expression',
            name: excerpt(value),
            line: lineOf(node),
          });
        }
        break;
      }
      case 'containerDirective':
      case 'leafDirective':
      case 'textDirective': {
        const name = String(node.name ?? '');
        if (node.type === 'textDirective') break;
        const lower = name.toLowerCase();
        if (
          node.type === 'containerDirective' &&
          (CALLOUTS.has(lower) || allowDirectives.has(lower))
        ) {
          break;
        }
        const marker = node.type === 'containerDirective' ? ':::' : '::';
        placeholders.push({
          reason: 'directive',
          name: `${marker}${name}`,
          line: lineOf(node),
        });
        break;
      }
      default:
        break;
    }
    for (const child of node.children ?? []) walk(child);
  }

  for (const block of doc.blocks) {
    if (block.calloutName) {
      const lower = block.calloutName.toLowerCase();
      if (!CALLOUTS.has(lower) && !allowDirectives.has(lower)) {
        const name = `:::${block.calloutName}`;
        const bodyLine = source.slice(doc.bodyStart, block.start).split('\n').length;
        placeholders.push({
          reason: 'directive',
          name,
          line: bodyLine + frontmatterLines,
        });
        continue;
      }
    }
    if (block.mdast) {
      if (block.calloutName) {
        const children = block.mdast.children ?? [];
        const only = children.length === 1 ? children[0] : undefined;
        const inner =
          only?.type === 'containerDirective' &&
          String(only.name ?? '').toLowerCase() === block.calloutName
            ? (only.children ?? [])
            : children;
        for (const child of inner) walk(child);
      } else {
        walk(block.mdast);
      }
    }
  }

  return placeholders;
}

function placeholderHast(
  mode: 'block' | 'inline',
  reason: PlaceholderReason,
  name: string,
): Element {
  const label =
    reason === 'unknown-component'
      ? `[Unsupported component: <${name}>]`
      : reason === 'dynamic-props'
        ? `[Dynamic props on <${name}>]`
        : reason === 'expression'
          ? `[Unsupported expression: {${name}}]`
          : reason === 'export'
            ? `[Unsupported export: ${name}]`
            : `[Unsupported directive: ${name}]`;
  return {
    type: 'element',
    tagName: mode === 'block' ? 'div' : 'span',
    properties: {
      className: ['oxybook-placeholder'],
      'data-placeholder-reason': reason,
      'data-placeholder-name': name,
    },
    children: [{ type: 'text', value: label }],
  };
}

function defaultCalloutTitle(variant: string): string {
  if (!variant) return 'Note';
  return variant.charAt(0).toUpperCase() + variant.slice(1).toLowerCase();
}

function renderCalloutHast(
  variant: string,
  title: string | null | undefined,
  children: ElementContent[],
): Element {
  const kind = variant.toLowerCase() || 'note';
  const resolvedTitle = title && title.trim() !== '' ? title.trim() : defaultCalloutTitle(kind);
  if (kind === 'details') {
    return {
      type: 'element',
      tagName: 'details',
      properties: {
        className: ['oxybook-callout', 'oxybook-callout-details'],
        'data-callout': 'details',
      },
      children: [
        {
          type: 'element',
          tagName: 'summary',
          properties: { className: ['oxybook-callout-title'] },
          children: [{ type: 'text', value: resolvedTitle }],
        },
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['oxybook-callout-body'] },
          children,
        },
      ],
    };
  }
  return {
    type: 'element',
    tagName: 'aside',
    properties: {
      className: ['oxybook-callout', `oxybook-callout-${kind}`],
      'data-callout': kind,
    },
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: { className: ['oxybook-callout-title'] },
        children: [{ type: 'text', value: resolvedTitle }],
      },
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['oxybook-callout-body'] },
        children,
      },
    ],
  };
}

function toElementContent(nodes: RootContent | RootContent[] | null | undefined): ElementContent[] {
  if (!nodes) return [];
  const list = Array.isArray(nodes) ? nodes : [nodes];
  return list.filter((node): node is ElementContent => node.type !== 'doctype');
}

function hastText(nodes: readonly ElementContent[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'element') {
      out += hastText(node.children);
    }
  }
  return out;
}

function slugifyHeading(text: string, counts: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  const seen = counts.get(base) ?? 0;
  counts.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

function stripGithubAlertPrefix(node: MdastNode): { kind: string; children: MdastNode[] } | null {
  const children = node.children ?? [];
  const first = children[0];
  if (first?.type !== 'paragraph') return null;
  const firstInlines = first.children ?? [];
  const firstInline = firstInlines[0];
  if (firstInline?.type !== 'text' || typeof firstInline.value !== 'string') {
    return null;
  }
  const match =
    /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\r?\n([ \t]*[\s\S]*)|[ \t]*$)/i.exec(
      firstInline.value,
    );
  if (!match?.[1]) return null;
  const kind = match[1].toLowerCase();
  const remainder = match[2] ?? '';
  let nextInlines: MdastNode[];
  if (remainder.length > 0) {
    nextInlines = [{ ...firstInline, value: remainder }, ...firstInlines.slice(1)];
  } else {
    const rest = firstInlines.slice(1);
    nextInlines = rest[0]?.type === 'break' ? rest.slice(1) : rest;
  }
  const nextChildren =
    nextInlines.length > 0
      ? [{ ...first, children: nextInlines }, ...children.slice(1)]
      : children.slice(1);
  return { kind, children: nextChildren };
}

function mdastPlainText(node: MdastNode): string {
  if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode')) {
    return node.value;
  }
  return (node.children ?? []).map(mdastPlainText).join('');
}

function extractFrontmatterFields(
  filename: string,
  doc: SourceDoc,
): { title: string; description: string | null; slug: string | undefined } {
  const fallback = path.basename(filename).replace(/\.mdx?$/i, '');
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
    const val = data[key];
    return typeof val === 'string' && val.trim() !== '' ? val.trim() : undefined;
  };
  let h1: string | undefined;
  for (const block of doc.blocks) {
    if (block.type === 'heading' && block.mdast?.depth === 1) {
      h1 = mdastPlainText(block.mdast).trim() || undefined;
      break;
    }
  }
  return {
    title: str('title') ?? h1 ?? fallback,
    description: str('description') ?? null,
    slug: str('slug'),
  };
}

function buildNormalizedRoot(
  source: string,
  doc: SourceDoc,
  allowDirectives: ReadonlySet<string>,
): MdastNode {
  const rootChildren: MdastNode[] = [];
  for (const block of doc.blocks) {
    if (block.calloutName !== undefined) {
      const lower = block.calloutName.toLowerCase();
      const bodyLine = source.slice(doc.bodyStart, block.start).split('\n').length;
      if (CALLOUTS.has(lower) || allowDirectives.has(lower)) {
        const children = block.mdast?.children ?? [];
        const only = children.length === 1 ? children[0] : undefined;
        const unwrapped =
          only?.type === 'containerDirective' && String(only.name ?? '').toLowerCase() === lower
            ? (only.children ?? [])
            : children;
        const inner = unwrapped.filter(
          (child) => !(child.type === 'paragraph' && child.data?.directiveLabel),
        );
        rootChildren.push({
          type: 'containerDirective',
          name: lower,
          children: inner,
          data: {
            ...block.mdast?.data,
            calloutTitle: block.calloutTitle ?? null,
            foldedCallout: true,
          },
          position: {
            start: { line: bodyLine, column: 1, offset: block.start - doc.bodyStart },
            end: { line: bodyLine, column: 1, offset: block.end - doc.bodyStart },
          },
        });
      } else {
        rootChildren.push({
          type: 'unknownFoldedDirective',
          name: `:::${block.calloutName}`,
          position: {
            start: { line: bodyLine, column: 1, offset: block.start - doc.bodyStart },
            end: { line: bodyLine, column: 1, offset: block.end - doc.bodyStart },
          },
        });
      }
      continue;
    }
    if (block.mdast) {
      rootChildren.push(block.mdast);
    }
  }
  return { type: 'root', children: rootChildren };
}

function renderParsedPage(
  source: string,
  parsed: ParseResult,
  options: RenderOptions = {},
): RenderResult {
  const filename = options.filename ?? 'index.md';
  const allow = new Set(options.allowlist ?? DEFAULT_ALLOWLIST);
  const allowDirectives = new Set(
    (options.allowDirectives ?? DEFAULT_DIRECTIVES).map((d) => d.toLowerCase()),
  );
  const pageMap = normalizePageMap(options.pages);
  const version = options.version ?? 'default';
  const highlighter = options.highlighter ?? null;

  if (!parsed.ok) {
    const fallbackTitle = path.basename(filename).replace(/\.mdx?$/i, '');
    const baseUrl =
      pageMap?.get(filename) ??
      pageUrl(filename, pageMap ? new Set(pageMap.keys()) : new Set([filename]));
    const fullUrl = applyVersionPrefix(baseUrl, options.versionPrefix);
    const fallbackEl: Element = {
      type: 'element',
      tagName: 'pre',
      properties: {
        className: ['oxybook-unparseable'],
        'data-error': parsed.error,
      },
      children: [{ type: 'text', value: source }],
    };
    const hast: Root = { type: 'root', children: [fallbackEl] };
    const html = toHtml(hast, { allowDangerousHtml: true });
    const unparseableWarning: UnparseableWarning = {
      reason: 'unparseable',
      error: parsed.error,
      line: null,
    };
    return {
      parsed: false,
      error: parsed.error,
      html,
      hast,
      placeholders: [],
      brokenLinks: [],
      warnings: [unparseableWarning],
      searchDoc: {
        url: fullUrl,
        title: fallbackTitle,
        description: null,
        headings: [],
        text: source,
        version,
      },
    };
  }

  const doc = parsed.doc;
  const fm = extractFrontmatterFields(filename, doc);
  const baseUrl =
    pageMap?.get(filename) ??
    pageUrl(filename, pageMap ? new Set(pageMap.keys()) : new Set([filename]), fm.slug);
  const fullUrl = applyVersionPrefix(baseUrl, options.versionPrefix);
  const frontmatterLines = source.slice(0, doc.bodyStart).split('\n').length - 1;
  const esmBlocks = collectEsmBlocks(doc);
  const importedComponents = resolveImports(esmBlocks, options.components);

  const placeholders = collectPlaceholders(source, doc, allow, allowDirectives, importedComponents);
  const brokenLinks: BrokenLinkWarning[] = [];
  const headings: SearchHeading[] = [];
  const slugCounts = new Map<string, number>();

  function fileLineOf(node: MdastNode): number | null {
    const line = node.position?.start.line;
    return typeof line === 'number' ? line + frontmatterLines : null;
  }

  function resolveInternalHref(rawHref: string, node: MdastNode): string {
    const res = resolvePageLink(rawHref, filename, pageMap, options.assets, options.versionPrefix);
    if (res.broken) {
      brokenLinks.push({
        reason: 'broken-link',
        href: rawHref,
        resolvedPath: res.resolvedPath ?? rawHref,
        line: fileLineOf(node),
      });
    }
    return res.href;
  }

  function renderBuiltinComponent(
    targetName: string,
    props: Record<string, StaticPropValue>,
    children: ElementContent[],
    mode: 'block' | 'inline',
    node: MdastNode,
  ): ElementContent | ElementContent[] {
    switch (targetName) {
      case 'Fragment':
        return children;

      case 'Callout':
      case 'Aside':
      case 'Admonition': {
        const variant =
          typeof props.type === 'string'
            ? props.type
            : typeof props.variant === 'string'
              ? props.variant
              : 'note';
        const title = typeof props.title === 'string' ? props.title : null;
        return renderCalloutHast(variant, title, children);
      }

      case 'Tabs': {
        const tabItems = children.filter(
          (child): child is Element =>
            child.type === 'element' &&
            Array.isArray(child.properties?.className) &&
            (child.properties.className as string[]).includes('oxybook-tab-item'),
        );
        const tabButtons: ElementContent[] = tabItems.map((item, idx) => {
          const val = String(item.properties?.['data-tab-value'] ?? idx);
          const label = String(item.properties?.['data-tab-label'] ?? val);
          return {
            type: 'element',
            tagName: 'button',
            properties: {
              type: 'button',
              role: 'tab',
              className: ['oxybook-tab'],
              'data-tab-value': val,
              'aria-selected': idx === 0 ? 'true' : 'false',
            },
            children: [{ type: 'text', value: label }],
          };
        });
        const nav: ElementContent[] =
          tabButtons.length > 0
            ? [
                {
                  type: 'element',
                  tagName: 'div',
                  properties: { className: ['oxybook-tabs-list'], role: 'tablist' },
                  children: tabButtons,
                },
              ]
            : [];
        return {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['oxybook-tabs'],
            ...(typeof props.groupId === 'string' ? { 'data-tabs-group': props.groupId } : {}),
            ...(typeof props.syncKey === 'string' ? { 'data-tabs-group': props.syncKey } : {}),
          },
          children: [...nav, ...children],
        };
      }

      case 'TabItem': {
        const value =
          typeof props.value === 'string'
            ? props.value
            : typeof props.label === 'string'
              ? props.label
              : 'tab';
        const label =
          typeof props.label === 'string'
            ? props.label
            : typeof props.title === 'string'
              ? props.title
              : value;
        return {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['oxybook-tab-item'],
            role: 'tabpanel',
            'data-tab-value': value,
            'data-tab-label': label,
          },
          children,
        };
      }

      case 'Card': {
        const title = typeof props.title === 'string' ? props.title : null;
        const icon = typeof props.icon === 'string' ? props.icon : null;
        const header: ElementContent[] = title
          ? [
              {
                type: 'element',
                tagName: 'h3',
                properties: { className: ['oxybook-card-title'] },
                children: [{ type: 'text', value: title }],
              },
            ]
          : [];
        return {
          type: 'element',
          tagName: 'section',
          properties: {
            className: ['oxybook-card'],
            ...(icon ? { 'data-icon': icon } : {}),
          },
          children: [
            ...header,
            {
              type: 'element',
              tagName: 'div',
              properties: { className: ['oxybook-card-body'] },
              children,
            },
          ],
        };
      }

      case 'CardGrid':
        return {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['oxybook-card-grid'],
            ...(props.stagger ? { 'data-stagger': 'true' } : {}),
          },
          children,
        };

      case 'LinkCard': {
        const rawHref = typeof props.href === 'string' ? props.href : '#';
        const href = resolveInternalHref(rawHref, node);
        const title = typeof props.title === 'string' ? props.title : rawHref;
        const description = typeof props.description === 'string' ? props.description : null;
        const inner: ElementContent[] = [
          {
            type: 'element',
            tagName: 'span',
            properties: { className: ['oxybook-link-card-title'] },
            children: [{ type: 'text', value: title }],
          },
        ];
        if (description) {
          inner.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['oxybook-link-card-description'] },
            children: [{ type: 'text', value: description }],
          });
        }
        inner.push(...children);
        return {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['oxybook-link-card'],
            href,
          },
          children: inner,
        };
      }

      case 'CodeGroup':
        return {
          type: 'element',
          tagName: 'div',
          properties: { className: ['oxybook-code-group'] },
          children,
        };

      case 'Steps':
        return {
          type: 'element',
          tagName: 'div',
          properties: { className: ['oxybook-steps'] },
          children,
        };

      case 'FileTree':
        return {
          type: 'element',
          tagName: 'div',
          properties: { className: ['oxybook-file-tree'] },
          children,
        };

      case 'Badge': {
        const text = typeof props.text === 'string' ? props.text : null;
        const variant =
          typeof props.variant === 'string'
            ? props.variant
            : typeof props.type === 'string'
              ? props.type
              : null;
        const badgeChildren: ElementContent[] =
          children.length > 0 ? children : text ? [{ type: 'text', value: text }] : [];
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['oxybook-badge'],
            ...(variant ? { 'data-badge-variant': variant } : {}),
          },
          children: badgeChildren,
        };
      }

      case 'Code': {
        const code = typeof props.code === 'string' ? props.code : hastText(children);
        const lang = typeof props.lang === 'string' ? props.lang : null;
        return highlightCodeToHast(code, lang, highlighter);
      }

      case 'Icon': {
        const name = typeof props.name === 'string' ? props.name : '';
        const label = typeof props.label === 'string' ? props.label : undefined;
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['oxybook-icon'],
            'data-icon': name,
            ...(label ? { 'aria-label': label } : { 'aria-hidden': 'true' }),
          },
          children: [],
        };
      }

      case 'LinkButton': {
        const rawHref = typeof props.href === 'string' ? props.href : '#';
        const href = resolveInternalHref(rawHref, node);
        const variant = typeof props.variant === 'string' ? props.variant : null;
        return {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['oxybook-link-button'],
            href,
            ...(variant ? { 'data-variant': variant } : {}),
          },
          children,
        };
      }

      default:
        return {
          type: 'element',
          tagName: mode === 'block' ? 'div' : 'span',
          properties: {
            className: [`oxybook-component-${targetName.toLowerCase()}`],
          },
          children,
        };
    }
  }

  function renderIntrinsicElement(
    tagName: string,
    props: Record<string, StaticPropValue>,
    children: ElementContent[],
    node: MdastNode,
  ): Element {
    const properties: Record<string, string | number | boolean | (string | number)[]> = {};
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === false) continue;
      if (key === 'href' && typeof value === 'string' && tagName === 'a') {
        properties.href = resolveInternalHref(value, node);
      } else if (key === 'src' && typeof value === 'string' && tagName === 'img') {
        const res = resolveAssetLink(value, filename, options.assets, options.versionPrefix);
        if (res.broken) {
          brokenLinks.push({
            reason: 'broken-link',
            href: value,
            resolvedPath: res.resolvedPath ?? value,
            line: fileLineOf(node),
          });
        }
        properties.src = res.href;
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        properties[key === 'className' ? 'className' : key] = value;
      } else {
        properties[key] = JSON.stringify(value);
      }
    }
    return {
      type: 'element',
      tagName,
      properties,
      children,
    };
  }

  function handleJsxElement(
    state: State,
    node: MdastNode,
    mode: 'block' | 'inline',
  ): ElementContent | ElementContent[] {
    const rawName = typeof node.name === 'string' ? node.name : '';
    if (!rawName) {
      return toElementContent(state.all(node as Parameters<State['all']>[0]));
    }
    const mapped = importedComponents.get(rawName) ?? rawName;
    const intrinsic = /^[a-z]/.test(rawName);
    const isAllowed = intrinsic || allow.has(rawName) || allow.has(mapped);
    if (!isAllowed) {
      return placeholderHast(mode, 'unknown-component', rawName);
    }
    const extracted = extractStaticProps(node.attributes as MdastNode[] | undefined);
    if (!extracted.ok) {
      return placeholderHast(mode, 'dynamic-props', rawName);
    }
    const children = toElementContent(state.all(node as Parameters<State['all']>[0]));
    if (intrinsic && !importedComponents.has(rawName)) {
      return renderIntrinsicElement(rawName, extracted.props, children, node);
    }
    const targetName = allow.has(mapped) ? mapped : rawName;
    return renderBuiltinComponent(targetName, extracted.props, children, mode, node);
  }

  const customHandlers: Record<
    string,
    (state: State, node: MdastNode) => ElementContent | ElementContent[]
  > = {
    heading(state: State, node: MdastNode) {
      const depth =
        typeof node.depth === 'number' && node.depth >= 1 && node.depth <= 6 ? node.depth : 2;
      const children = toElementContent(state.all(node as Parameters<State['all']>[0]));
      const text = hastText(children).trim();
      const id = slugifyHeading(text, slugCounts);
      headings.push({ depth, text, id });
      return {
        type: 'element',
        tagName: `h${depth}`,
        properties: { id },
        children,
      };
    },

    code(_state: State, node: MdastNode) {
      const code = String(node.value ?? '');
      const lang = typeof node.lang === 'string' ? node.lang : null;
      return highlightCodeToHast(code, lang, highlighter);
    },

    link(state: State, node: MdastNode) {
      const rawHref = String(node.url ?? '');
      const href = resolveInternalHref(rawHref, node);
      const children = toElementContent(state.all(node as Parameters<State['all']>[0]));
      return {
        type: 'element',
        tagName: 'a',
        properties: {
          href,
          ...(typeof node.title === 'string' && node.title ? { title: node.title } : {}),
        },
        children,
      };
    },

    image(_state: State, node: MdastNode) {
      const rawSrc = String(node.url ?? '');
      const res = resolveAssetLink(rawSrc, filename, options.assets, options.versionPrefix);
      if (res.broken) {
        brokenLinks.push({
          reason: 'broken-link',
          href: rawSrc,
          resolvedPath: res.resolvedPath ?? rawSrc,
          line: fileLineOf(node),
        });
      }
      return {
        type: 'element',
        tagName: 'img',
        properties: {
          src: res.href,
          alt: String(node.alt ?? ''),
          ...(typeof node.title === 'string' && node.title ? { title: node.title } : {}),
        },
        children: [],
      };
    },

    blockquote(state: State, node: MdastNode) {
      const alert = stripGithubAlertPrefix(node);
      if (alert) {
        const alertNode: MdastNode = { ...node, children: alert.children };
        const children = toElementContent(state.all(alertNode as Parameters<State['all']>[0]));
        return renderCalloutHast(alert.kind, null, children);
      }
      const children = toElementContent(state.all(node as Parameters<State['all']>[0]));
      return {
        type: 'element',
        tagName: 'blockquote',
        properties: {},
        children,
      };
    },

    containerDirective(state: State, node: MdastNode) {
      const name = String(node.name ?? '');
      const lower = name.toLowerCase();
      if (CALLOUTS.has(lower)) {
        let title =
          typeof node.data?.calloutTitle === 'string' ? (node.data.calloutTitle as string) : null;
        let bodyNodes = node.children ?? [];
        const firstChild = bodyNodes[0];
        if (!title && firstChild?.type === 'paragraph' && firstChild.data?.directiveLabel) {
          const labelHast = toElementContent(state.all(firstChild as Parameters<State['all']>[0]));
          title = hastText(labelHast).trim() || null;
          bodyNodes = bodyNodes.slice(1);
        }
        const bodyParent: MdastNode = { ...node, children: bodyNodes };
        const children = toElementContent(state.all(bodyParent as Parameters<State['all']>[0]));
        return renderCalloutHast(lower, title, children);
      }
      if (allowDirectives.has(lower)) {
        const children = toElementContent(state.all(node as Parameters<State['all']>[0]));
        return {
          type: 'element',
          tagName: 'div',
          properties: {
            className: [`oxybook-${lower}`],
          },
          children,
        };
      }
      return placeholderHast('block', 'directive', `:::${name}`);
    },

    unknownFoldedDirective(_state: State, node: MdastNode) {
      const name = String(node.name ?? ':::');
      return placeholderHast('block', 'directive', name);
    },

    leafDirective(_state: State, node: MdastNode) {
      const name = `::${String(node.name ?? '')}`;
      return placeholderHast('block', 'directive', name);
    },

    textDirective(_state: State, node: MdastNode) {
      const literal =
        typeof node.data?.oxySource === 'string'
          ? node.data.oxySource
          : `:${String(node.name ?? '')}`;
      return { type: 'text', value: literal };
    },

    mdxJsxFlowElement(state: State, node: MdastNode) {
      return handleJsxElement(state, node, 'block');
    },

    mdxJsxTextElement(state: State, node: MdastNode) {
      return handleJsxElement(state, node, 'inline');
    },

    mdxjsEsm(_state: State, node: MdastNode) {
      const value = String(node.value ?? '');
      const exp = findExportInEsm(value, fileLineOf(node));
      if (exp) {
        return placeholderHast('block', 'export', exp.name);
      }
      return [];
    },

    mdxFlowExpression(_state: State, node: MdastNode) {
      const value = String(node.value ?? '');
      if (isCommentExpression(value)) return [];
      return placeholderHast('block', 'expression', excerpt(value));
    },

    mdxTextExpression(_state: State, node: MdastNode) {
      const value = String(node.value ?? '');
      if (isCommentExpression(value)) return [];
      return placeholderHast('inline', 'expression', excerpt(value));
    },
  };

  const normalizedRoot = buildNormalizedRoot(source, doc, allowDirectives);
  const hastTree = toHast(normalizedRoot as Parameters<typeof toHast>[0], {
    allowDangerousHtml: true,
    handlers: customHandlers as unknown as Partial<Handlers>,
  });
  const root: Root =
    hastTree.type === 'root'
      ? hastTree
      : { type: 'root', children: toElementContent(hastTree as RootContent) };

  if (options.strict && brokenLinks.length > 0) {
    throw new StrictBuildError(filename, brokenLinks);
  }

  const html = toHtml(root, { allowDangerousHtml: true });
  const plainText = hastText(toElementContent(root.children)).replace(/\s+/g, ' ').trim();
  const warnings: BuildWarning[] = [...placeholders, ...brokenLinks];

  return {
    parsed: true,
    html,
    hast: root,
    placeholders,
    brokenLinks,
    warnings,
    searchDoc: {
      url: fullUrl,
      title: fm.title,
      description: fm.description,
      headings,
      text: plainText,
      version,
    },
  };
}

export function renderPageSync(source: string, options: RenderOptions = {}): RenderResult {
  const parsed = parse(source, { filename: options.filename });
  return renderParsedPage(source, parsed, options);
}

/**
 * Render a markdown or MDX page to hast and HTML, with Shiki syntax highlighting,
 * allowlisted components with static props, relative link rewriting, and zero evaluation
 * of customer code (ARCHITECTURE §5.2).
 */
export async function renderPage(
  source: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const parsed = parse(source, { filename: options.filename });
  let highlighter = options.highlighter;
  if (highlighter === undefined) {
    const langs = parsed.ok ? collectCodeLanguages(parsed.doc) : [];
    highlighter = await ensureLanguagesLoaded(langs);
  }
  return renderParsedPage(source, parsed, { ...options, highlighter });
}
