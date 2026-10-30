// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { CALLOUTS } from './callouts.js';
import { parse } from './parse.js';
import type { MdastNode, SourceDoc } from './types.js';

/**
 * The H3 compatibility count (MVP.md): what in a docs tree would not render as
 * written, given that OxyBook never executes MDX (ARCHITECTURE §5.2).
 *
 * A "placeholder" is something the renderer will replace with a visible stand-in
 * and a build warning. Everything else counted here renders, or is dropped on
 * purpose (imports, MDX comments), or degrades without a placeholder (raw `!!!`
 * admonition text), and is reported so the numbers can drive what ships.
 */

/** The M1 starting allowlist from MVP.md. Slice 1 of docs/M1-PLAN.md tests it. */
export const STARTING_ALLOWLIST: readonly string[] = [
  'Callout',
  'Tabs',
  'TabItem',
  'Card',
  'CodeGroup',
];

export type PlaceholderReason =
  | 'unknown-component'
  | 'dynamic-props'
  | 'expression'
  | 'export'
  | 'directive';

export interface Placeholder {
  reason: PlaceholderReason;
  /** Component name, directive name, or a short source excerpt. */
  name: string;
  line: number | null;
}

export interface FileCompat {
  file: string;
  format: 'md' | 'mdx';
  parsed: boolean;
  error?: string;
  /** JSX element name → count. Lowercase names are intrinsic HTML. */
  components: Record<string, number>;
  /** Component names whose props were not all static literals. */
  dynamicProps: Record<string, number>;
  /** `import ... from '<specifier>'` → count. */
  imports: Record<string, number>;
  exports: number;
  expressions: number;
  /** `{/* ... *\/}` only. Dropped by the renderer, not placeholders. */
  expressionComments: number;
  /** `:::name` containers folded to callouts, by name. These render. */
  callouts: Record<string, number>;
  githubAlerts: number;
  /** Leaf (`::name`) and unknown container (`:::name`) directives, by name. Placeholders. */
  directives: Record<string, number>;
  /**
   * `:name` text directives. In the corpus these are literal text that remark-directive
   * reads as a directive (`localhost:8000`, `4.5:1`), so the renderer must print the
   * source back. Counted, not placeholders.
   */
  textDirectives: Record<string, number>;
  /** MkDocs `!!! type` / `??? type` admonitions, by type. Raw text in v1. */
  mkdocsAdmonitions: Record<string, number>;
  /** pymdownx tabs (`=== "Title"`). Raw text in v1. */
  mkdocsTabs: number;
  /** Raw HTML blocks and inline HTML, comments excluded. */
  html: number;
  /** Capitalised tags inside raw HTML in `.md` (Vue components in VitePress). */
  htmlComponents: Record<string, number>;
  placeholders: Placeholder[];
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function lineOf(node: MdastNode): number | null {
  const line = node.position?.start.line;
  return typeof line === 'number' ? line : null;
}

function isStaticAttribute(attribute: MdastNode): boolean {
  // mdxJsxExpressionAttribute is `{...spread}`: never static.
  if (attribute.type !== 'mdxJsxAttribute') return false;
  const value = attribute.value as unknown;
  if (value === null || value === undefined || typeof value === 'string') return true;
  if (typeof value === 'object' && (value as MdastNode).type === 'mdxJsxAttributeValueExpression') {
    // JSON-literal expressions parse without evaluation (ARCHITECTURE §5.2).
    const text = String((value as MdastNode).value ?? '').trim();
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isCommentExpression(value: string): boolean {
  const text = value.trim();
  return /^\/\*[\s\S]*\*\/$/.test(text) || /^\/\/[^\n]*$/.test(text);
}

const IMPORT_FROM = /\bfrom\s*(['"])([^'"]+)\1/g;
const BARE_IMPORT = /^\s*import\s*(['"])([^'"]+)\1/gm;

function countEsm(value: string, result: FileCompat, node: MdastNode): void {
  let foundImport = false;
  for (const match of value.matchAll(IMPORT_FROM)) {
    if (match[2]) {
      bump(result.imports, match[2]);
      foundImport = true;
    }
  }
  for (const match of value.matchAll(BARE_IMPORT)) {
    if (match[2]) {
      bump(result.imports, match[2]);
      foundImport = true;
    }
  }
  const lines = value.split('\n');
  const exportIndex = lines.findIndex((line) => /^\s*export\b/.test(line));
  if (exportIndex >= 0) {
    // Adjacent import/export lines arrive as one mdxjsEsm node; point at the export.
    const start = lineOf(node);
    result.exports++;
    result.placeholders.push({
      reason: 'export',
      name: excerpt(lines[exportIndex] ?? value),
      line: start === null ? null : start + exportIndex,
    });
  } else if (!foundImport && value.trim().length > 0) {
    // ESM that is neither an import nor an export is not valid MDX; count it as an export.
    result.exports++;
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

const HTML_COMPONENT = /<([A-Z][\w.-]*)/g;

function walk(node: MdastNode, result: FileCompat, allow: ReadonlySet<string>): void {
  switch (node.type) {
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const name = typeof node.name === 'string' ? node.name : '';
      // A fragment (<>...</>) has no name and renders its children.
      if (name) {
        bump(result.components, name);
        const intrinsic = /^[a-z]/.test(name);
        if (!intrinsic && !allow.has(name)) {
          result.placeholders.push({ reason: 'unknown-component', name, line: lineOf(node) });
        } else {
          const attributes = (node.attributes as MdastNode[] | undefined) ?? [];
          if (!attributes.every(isStaticAttribute)) {
            bump(result.dynamicProps, name);
            result.placeholders.push({ reason: 'dynamic-props', name, line: lineOf(node) });
          }
        }
      }
      break;
    }
    case 'mdxjsEsm':
      countEsm(String(node.value ?? ''), result, node);
      break;
    case 'mdxFlowExpression':
    case 'mdxTextExpression': {
      const value = String(node.value ?? '');
      if (isCommentExpression(value)) {
        result.expressionComments++;
      } else {
        result.expressions++;
        result.placeholders.push({
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
      if (node.type === 'textDirective') {
        bump(result.textDirectives, `:${name}`);
        break;
      }
      if (node.type === 'containerDirective' && CALLOUTS.has(name.toLowerCase())) {
        // Nested or unfolded `:::note`: a callout, as parse() classifies it.
        bump(result.callouts, name.toLowerCase());
        break;
      }
      const marker = node.type === 'containerDirective' ? ':::' : '::';
      bump(result.directives, `${marker}${name}`);
      result.placeholders.push({
        reason: 'directive',
        name: `${marker}${name}`,
        line: lineOf(node),
      });
      break;
    }
    case 'html': {
      const value = String(node.value ?? '');
      if (!value.trimStart().startsWith('<!--')) {
        result.html++;
        if (result.format === 'md') {
          for (const match of value.matchAll(HTML_COMPONENT)) {
            if (match[1]) bump(result.htmlComponents, match[1]);
          }
        }
      }
      break;
    }
    default:
      break;
  }
  for (const child of node.children ?? []) walk(child, result, allow);
}

const MKDOCS_ADMONITION = /^[ \t]*(?:!!!|\?\?\?\+?)[ \t]+([A-Za-z][\w-]*)/gm;
const MKDOCS_TAB = /^[ \t]*===\+?[ \t]+"/gm;

function emptyCompat(file: string, format: 'md' | 'mdx'): FileCompat {
  return {
    file,
    format,
    parsed: true,
    components: {},
    dynamicProps: {},
    imports: {},
    exports: 0,
    expressions: 0,
    expressionComments: 0,
    callouts: {},
    githubAlerts: 0,
    directives: {},
    textDirectives: {},
    mkdocsAdmonitions: {},
    mkdocsTabs: 0,
    html: 0,
    htmlComponents: {},
    placeholders: [],
  };
}

/** Text outside fenced and indented code, so `!!!` inside a code sample is not counted. */
function proseOf(doc: SourceDoc): string {
  return doc.blocks
    .filter((block) => block.type !== 'code')
    .map((block) => block.source)
    .join('\n');
}

export function analyzeSource(
  source: string,
  file: string,
  options: { allowlist?: readonly string[] } = {},
): FileCompat {
  const format = file.toLowerCase().endsWith('.mdx') ? 'mdx' : 'md';
  const result = emptyCompat(file, format);
  const parsed = parse(source, { filename: file });
  if (!parsed.ok) {
    result.parsed = false;
    result.error = parsed.error;
    return result;
  }
  const allow = new Set(options.allowlist ?? STARTING_ALLOWLIST);
  for (const block of parsed.doc.blocks) {
    if (block.calloutName) {
      if (CALLOUTS.has(block.calloutName)) {
        bump(result.callouts, block.calloutName);
      } else {
        // `::: code-group`, `::: v-pre`: folded as one raw block, not a known callout.
        const name = `:::${block.calloutName}`;
        bump(result.directives, name);
        result.placeholders.push({
          reason: 'directive',
          name,
          line: source.slice(parsed.doc.bodyStart, block.start).split('\n').length,
        });
        continue;
      }
    }
    if (block.type === 'alert') result.githubAlerts++;
    if (block.mdast) {
      // A folded callout's root is synthetic; its children are the real nodes.
      if (block.calloutName) {
        // remark-directive may already have parsed the container; skip that node so the
        // callout is counted once.
        const children = block.mdast.children ?? [];
        const only = children.length === 1 ? children[0] : undefined;
        const inner =
          only?.type === 'containerDirective' &&
          String(only.name ?? '').toLowerCase() === block.calloutName
            ? (only.children ?? [])
            : children;
        for (const child of inner) walk(child, result, allow);
      } else {
        walk(block.mdast, result, allow);
      }
    }
  }
  // mdast lines count from the start of the body. Report lines in the file.
  const frontmatterLines = source.slice(0, parsed.doc.bodyStart).split('\n').length - 1;
  for (const placeholder of result.placeholders) {
    if (placeholder.line !== null) placeholder.line += frontmatterLines;
  }
  const prose = proseOf(parsed.doc);
  for (const match of prose.matchAll(MKDOCS_ADMONITION)) {
    if (match[1]) bump(result.mkdocsAdmonitions, match[1].toLowerCase());
  }
  result.mkdocsTabs = [...prose.matchAll(MKDOCS_TAB)].length;
  return result;
}

export function analyzeFile(
  file: string,
  display: string,
  options: { allowlist?: readonly string[] } = {},
): FileCompat {
  const buffer = readFileSync(file);
  const text = buffer.toString('utf8');
  if (!buffer.equals(Buffer.from(text, 'utf8'))) {
    const result = emptyCompat(display, display.endsWith('.mdx') ? 'mdx' : 'md');
    result.parsed = false;
    result.error = 'file is not valid UTF-8';
    return result;
  }
  return analyzeSource(text, display, options);
}

export interface CompatSummary {
  files: number;
  mdx: number;
  unparseable: number;
  /** Parsed files with no placeholder at all. */
  clean: number;
  placeholders: Record<PlaceholderReason, number>;
  /** Files with at least one placeholder of that reason. */
  filesWith: Record<PlaceholderReason, number>;
  components: Record<string, number>;
  /** Non-allowlisted component → number of files it appears in. */
  unknownComponentFiles: Record<string, number>;
  dynamicProps: Record<string, number>;
  imports: Record<string, number>;
  exports: number;
  expressions: number;
  expressionComments: number;
  callouts: Record<string, number>;
  githubAlerts: number;
  directives: Record<string, number>;
  textDirectives: Record<string, number>;
  mkdocsAdmonitions: Record<string, number>;
  /** Files containing at least one `!!!`/`???` admonition. */
  mkdocsAdmonitionFiles: number;
  mkdocsTabs: number;
  html: number;
  htmlComponents: Record<string, number>;
}

const REASONS: readonly PlaceholderReason[] = [
  'unknown-component',
  'dynamic-props',
  'expression',
  'export',
  'directive',
];

function zeroReasons(): Record<PlaceholderReason, number> {
  return {
    'unknown-component': 0,
    'dynamic-props': 0,
    expression: 0,
    export: 0,
    directive: 0,
  };
}

function merge(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) bump(into, key, value);
}

export function summarize(files: readonly FileCompat[]): CompatSummary {
  const summary: CompatSummary = {
    files: files.length,
    mdx: 0,
    unparseable: 0,
    clean: 0,
    placeholders: zeroReasons(),
    filesWith: zeroReasons(),
    components: {},
    unknownComponentFiles: {},
    dynamicProps: {},
    imports: {},
    exports: 0,
    expressions: 0,
    expressionComments: 0,
    callouts: {},
    githubAlerts: 0,
    directives: {},
    textDirectives: {},
    mkdocsAdmonitions: {},
    mkdocsAdmonitionFiles: 0,
    mkdocsTabs: 0,
    html: 0,
    htmlComponents: {},
  };
  for (const file of files) {
    if (file.format === 'mdx') summary.mdx++;
    if (!file.parsed) {
      summary.unparseable++;
      continue;
    }
    if (file.placeholders.length === 0) summary.clean++;
    const reasons = new Set<PlaceholderReason>();
    const unknown = new Set<string>();
    for (const placeholder of file.placeholders) {
      summary.placeholders[placeholder.reason]++;
      reasons.add(placeholder.reason);
      if (placeholder.reason === 'unknown-component') unknown.add(placeholder.name);
    }
    for (const reason of reasons) summary.filesWith[reason]++;
    for (const name of unknown) bump(summary.unknownComponentFiles, name);
    merge(summary.components, file.components);
    merge(summary.dynamicProps, file.dynamicProps);
    merge(summary.imports, file.imports);
    summary.exports += file.exports;
    summary.expressions += file.expressions;
    summary.expressionComments += file.expressionComments;
    merge(summary.callouts, file.callouts);
    summary.githubAlerts += file.githubAlerts;
    merge(summary.directives, file.directives);
    merge(summary.textDirectives, file.textDirectives);
    merge(summary.mkdocsAdmonitions, file.mkdocsAdmonitions);
    if (Object.keys(file.mkdocsAdmonitions).length > 0) summary.mkdocsAdmonitionFiles++;
    summary.mkdocsTabs += file.mkdocsTabs;
    summary.html += file.html;
    merge(summary.htmlComponents, file.htmlComponents);
  }
  return summary;
}

/** Highest count first, then name, so output is stable. */
export function ranked(record: Record<string, number>, limit = Infinity): [string, number][] {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function list(record: Record<string, number>, limit: number): string {
  const entries = ranked(record, limit);
  if (entries.length === 0) return 'none';
  const shown = entries.map(([name, count]) => `\`${name}\` ${count}`).join(', ');
  const more = Object.keys(record).length - entries.length;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

export function formatSummary(title: string, summary: CompatSummary, limit = 10): string {
  const parsed = summary.files - summary.unparseable;
  const pct = parsed === 0 ? 0 : Math.round((summary.clean / parsed) * 1000) / 10;
  const lines = [
    `### ${title}`,
    '',
    `${summary.files} files (${summary.mdx} .mdx), ${summary.unparseable} unparseable. ${summary.clean} of ${parsed} parsed files (${pct}%) would render with no placeholder.`,
    '',
    '| placeholder cause | count | files |',
    '| --- | --- | --- |',
    ...REASONS.map(
      (reason) => `| ${reason} | ${summary.placeholders[reason]} | ${summary.filesWith[reason]} |`,
    ),
    '',
    `- Unknown components, by files affected: ${list(summary.unknownComponentFiles, limit)}`,
    `- All JSX elements: ${list(summary.components, limit)}`,
    `- Allowlisted or intrinsic with non-static props: ${list(summary.dynamicProps, limit)}`,
    `- Imports: ${list(summary.imports, limit)}`,
    `- Exports: ${summary.exports}. Expressions: ${summary.expressions} (plus ${summary.expressionComments} comments, dropped).`,
    `- Callouts (render): ${list(summary.callouts, limit)}. GitHub alerts (render): ${summary.githubAlerts}.`,
    `- Other directives (placeholders): ${list(summary.directives, limit)}`,
    `- Text directives (literal text, printed back): ${list(summary.textDirectives, limit)}`,
    `- MkDocs admonitions (raw in v1): ${list(summary.mkdocsAdmonitions, limit)} in ${summary.mkdocsAdmonitionFiles} files. pymdownx tabs: ${summary.mkdocsTabs}.`,
    `- Raw HTML nodes: ${summary.html}. Capitalised tags in .md HTML: ${list(summary.htmlComponents, limit)}`,
  ];
  return lines.join('\n');
}

/** One line per placeholder, `file:line: reason: name`, like a compiler warning. */
export function formatPlaceholders(files: readonly FileCompat[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (!file.parsed) {
      lines.push(`${file.file}: unparseable: ${file.error}`);
      continue;
    }
    for (const placeholder of file.placeholders) {
      const where = placeholder.line === null ? '' : `:${placeholder.line}`;
      lines.push(`${file.file}${where}: ${placeholder.reason}: ${placeholder.name}`);
    }
  }
  return lines.join('\n');
}
