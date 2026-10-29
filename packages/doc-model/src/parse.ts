// SPDX-License-Identifier: AGPL-3.0-only

import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { detectLineEnding, splitFrontmatter } from './frontmatter.js';
import { inferStyle } from './style.js';
import type {
  Block,
  Format,
  MdastNode,
  ParseOptions,
  ParseResult,
  RawKind,
  SourceDoc,
} from './types.js';

const CALLOUTS = new Set([
  'note',
  'tip',
  'info',
  'warning',
  'caution',
  'danger',
  'important',
  'details',
]);

export function formatFromFilename(filename: string | undefined): Format {
  if (filename?.toLowerCase().endsWith('.mdx')) return 'mdx';
  return 'md';
}

/**
 * `.md` is CommonMark + GFM + container directives.
 * `.mdx` is that plus MDX 3. The MDX plugin is not even attached for `.md`:
 * `<` and `{` must not change meaning because of a guess.
 */
function parseBody(body: string, format: Format): MdastNode {
  const processor = unified().use(remarkParse);
  if (format === 'mdx') processor.use(remarkMdx);
  processor.use(remarkGfm);
  processor.use(remarkDirective);
  return processor.parse(body) as MdastNode;
}

function offsetOf(node: MdastNode, edge: 'start' | 'end'): number | null {
  const value = node.position?.[edge].offset;
  return typeof value === 'number' ? value : null;
}

function annotate(node: MdastNode, body: string): void {
  const start = offsetOf(node, 'start');
  const end = offsetOf(node, 'end');
  if (start !== null && end !== null) {
    node.data = { ...node.data, oxySource: body.slice(start, end) };
  }
  for (const child of node.children ?? []) annotate(child, body);
}

function classify(
  node: MdastNode,
  source: string,
): { type: string; rawKind?: RawKind; editable: boolean } {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'thematicBreak':
    case 'code':
    case 'list':
    case 'table':
      return { type: node.type, editable: true };
    case 'blockquote': {
      if (/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(source)) {
        return { type: 'alert', editable: true };
      }
      return { type: 'blockquote', editable: true };
    }
    case 'html':
      if (source.trimStart().startsWith('<!--')) {
        return { type: 'html', rawKind: 'html-comment', editable: false };
      }
      return { type: 'html', rawKind: 'html', editable: false };
    case 'definition':
    case 'footnoteDefinition':
      return { type: node.type, rawKind: 'definition', editable: false };
    case 'containerDirective': {
      const name = String(node.name ?? '').toLowerCase();
      if (CALLOUTS.has(name)) return { type: 'containerDirective', editable: true };
      return { type: 'containerDirective', rawKind: 'directive', editable: false };
    }
    case 'leafDirective':
    case 'textDirective':
      return { type: node.type, rawKind: 'directive', editable: false };
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return { type: node.type, rawKind: 'mdx-jsx', editable: false };
    case 'mdxjsEsm':
      return { type: node.type, rawKind: 'mdx-esm', editable: false };
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      return { type: node.type, rawKind: 'mdx-expression', editable: false };
    default:
      return { type: node.type, rawKind: 'unparsed', editable: false };
  }
}

function unparseableMessage(error: unknown): string | null {
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError
  ) {
    return null;
  }
  if (error instanceof Error) return error.message;
  return 'unreadable markdown';
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const format = options.format ?? formatFromFilename(options.filename);
  const bom = source.charCodeAt(0) === 0xfeff;
  const base = bom ? 1 : 0;
  const split = splitFrontmatter(source, base);
  const bodyStart = split.bodyStart;
  const body = source.slice(bodyStart);

  let tree: MdastNode;
  try {
    tree = parseBody(body, format);
  } catch (error) {
    const message = unparseableMessage(error);
    if (message === null) throw error;
    return { ok: false, error: message };
  }

  const children = [...(tree.children ?? [])].sort((a, b) => {
    const as = offsetOf(a, 'start') ?? Number.POSITIVE_INFINITY;
    const bs = offsetOf(b, 'start') ?? Number.POSITIVE_INFINITY;
    return as - bs;
  });

  const blocks: Block[] = [];
  let cursor = bodyStart;
  for (const node of children) {
    const startOff = offsetOf(node, 'start');
    const endOff = offsetOf(node, 'end');
    if (startOff === null || endOff === null) {
      return {
        ok: false,
        error: `top-level ${node.type} has no source offset; refusing to drop or guess bytes`,
      };
    }
    const start = bodyStart + startOff;
    const end = bodyStart + endOff;
    if (end < start || start < cursor || end > source.length) {
      return {
        ok: false,
        error: `top-level ${node.type} overlaps another block or falls outside the file`,
      };
    }
    annotate(node, body);
    const blockSource = source.slice(start, end);
    const kind = classify(node, blockSource);
    blocks.push({
      id: `b${blocks.length + 1}`,
      type: kind.type,
      ...(kind.rawKind ? { rawKind: kind.rawKind } : {}),
      editable: kind.editable,
      source: blockSource,
      gapBefore: source.slice(cursor, start),
      start,
      end,
      edits: [],
      reformat: false,
      mdast: node,
    });
    cursor = end;
  }

  const doc: SourceDoc = {
    bom,
    lineEnding: detectLineEnding(source),
    hasTrailingNewline: source.endsWith('\n') || source.endsWith('\r'),
    format,
    bodyStart,
    frontmatter: split.frontmatter,
    blocks,
    trailing: source.slice(cursor),
    style: inferStyle(
      blocks.flatMap((block) => (block.mdast ? [block.mdast] : [])),
      body,
    ),
  };
  return { ok: true, doc };
}

export function parseOrThrow(source: string, options: ParseOptions = {}): SourceDoc {
  const result = parse(source, options);
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}
