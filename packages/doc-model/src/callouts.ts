// SPDX-License-Identifier: AGPL-3.0-only

import type { Block, MdastNode, RawKind } from './types.js';

export const CALLOUTS: ReadonlySet<string> = new Set([
  'note',
  'tip',
  'info',
  'warning',
  'caution',
  'danger',
  'important',
  'details',
]);

interface Line {
  start: number;
  /** End of the line's text, before CR/LF. */
  contentEnd: number;
  text: string;
}

interface Span {
  start: number;
  end: number;
  name: string;
  title: string | null;
  closed: boolean;
}

/**
 * `:::name`, `:::name Title`, `::: name Title`, and `:::name[Title]`.
 * A bare `:::` is a closer, not an opener.
 */
export function parseCalloutOpener(text: string): { name: string; title: string | null } | null {
  const bracket = /^:::[ \t]*([A-Za-z][\w-]*)\[([^\]]*)\][ \t]*$/.exec(text);
  if (bracket?.[1]) {
    const title = bracket[2]?.trim() ?? '';
    return { name: bracket[1].toLowerCase(), title: title.length > 0 ? title : null };
  }
  const plain = /^:::[ \t]*([A-Za-z][\w-]*)(?:[ \t]+(\S.*?))?[ \t]*$/.exec(text);
  if (!plain?.[1]) return null;
  const title = plain[2]?.trim() ?? '';
  return { name: plain[1].toLowerCase(), title: title.length > 0 ? title : null };
}

function isCloser(text: string): boolean {
  return /^:::[ \t]*$/.test(text);
}

function linesOf(source: string, from: number): Line[] {
  const lines: Line[] = [];
  let start = from;
  for (let i = from; i < source.length; i++) {
    if (source.charCodeAt(i) !== 10) continue;
    const contentEnd = i > start && source.charCodeAt(i - 1) === 13 ? i - 1 : i;
    lines.push({ start, contentEnd, text: source.slice(start, contentEnd) });
    start = i + 1;
  }
  if (start < source.length) {
    lines.push({ start, contentEnd: source.length, text: source.slice(start) });
  }
  return lines;
}

function isOpaque(block: Block): boolean {
  return (
    block.type === 'code' ||
    block.type === 'html' ||
    block.rawKind === 'html' ||
    block.rawKind === 'html-comment' ||
    block.rawKind === 'mdx-jsx' ||
    block.rawKind === 'mdx-esm' ||
    block.rawKind === 'mdx-expression'
  );
}

function lineIsOpaque(blocks: readonly Block[], offset: number): boolean {
  return blocks.some((block) => isOpaque(block) && offset >= block.start && offset < block.end);
}

function atColumnZero(source: string, offset: number, bodyStart: number): boolean {
  return offset === bodyStart || source[offset - 1] === '\n';
}

/**
 * Column-0 container directives, including the `:::name Title` form
 * remark-directive does not parse. Each match becomes one block that owns
 * every byte from the opening line through the matching closer (or EOF if
 * the closer is missing). Nested containers stay inside the outer block.
 * Fenced code, indented code, HTML, and MDX are not scanned for markers.
 */
export function foldCallouts(source: string, blocks: Block[], bodyStart: number): Block[] {
  const lines = linesOf(source, bodyStart);
  const stack: { name: string; title: string | null; start: number }[] = [];
  const spans: Span[] = [];

  for (const line of lines) {
    if (!atColumnZero(source, line.start, bodyStart)) continue;
    if (lineIsOpaque(blocks, line.start)) continue;
    const opener = parseCalloutOpener(line.text);
    if (opener && blocks.some((block) => block.start === line.start)) {
      stack.push({ name: opener.name, title: opener.title, start: line.start });
      continue;
    }
    if (
      isCloser(line.text) &&
      stack.length > 0 &&
      blocks.some((block) => block.end === line.contentEnd)
    ) {
      const frame = stack.pop();
      if (frame && stack.length === 0) {
        spans.push({
          start: frame.start,
          end: line.contentEnd,
          name: frame.name,
          title: frame.title,
          closed: true,
        });
      }
    }
  }
  const unclosed = stack[0];
  if (unclosed) {
    spans.push({
      start: unclosed.start,
      end: source.length,
      name: unclosed.name,
      title: unclosed.title,
      closed: false,
    });
  }
  if (spans.length === 0) return blocks;

  const folded: Block[] = [];
  let index = 0;
  for (const span of spans) {
    while (index < blocks.length) {
      const block = blocks[index];
      if (!block || block.end > span.start) break;
      folded.push(block);
      index++;
    }
    const consumed: Block[] = [];
    while (index < blocks.length) {
      const block = blocks[index];
      if (!block || block.start < span.start || block.start >= span.end || block.end > span.end) {
        break;
      }
      consumed.push(block);
      index++;
    }
    const first = consumed[0];
    const last = consumed[consumed.length - 1];
    const aligned =
      first !== undefined &&
      last !== undefined &&
      first.start === span.start &&
      (span.closed ? last.end === span.end : span.end === source.length);
    if (!aligned) {
      folded.push(...consumed);
      continue;
    }
    folded.push(calloutBlock(source, bodyStart, span, consumed));
  }
  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;
    folded.push(block);
    index++;
  }
  return folded.map((block, blockIndex) => ({ ...block, id: `b${blockIndex + 1}` }));
}

function isMarkerLine(source: string): boolean {
  if (source.includes('\n') || source.includes('\r')) return false;
  return parseCalloutOpener(source) !== null || isCloser(source);
}

function calloutBlock(
  source: string,
  bodyStart: number,
  span: Span,
  consumed: readonly Block[],
): Block {
  const first = consumed[0];
  if (!first) throw new Error('callout span did not cover a block');
  const children: MdastNode[] = [];
  for (const block of consumed) {
    if (!block.mdast || isMarkerLine(block.source)) continue;
    children.push(block.mdast);
  }
  const known = CALLOUTS.has(span.name);
  const editable = span.closed && known;
  const rawKind: RawKind | undefined = editable ? undefined : 'directive';
  const mdast: MdastNode = {
    type: 'containerDirective',
    name: span.name,
    children,
    data: { oxySource: source.slice(span.start, span.end) },
    position: {
      start: { offset: span.start - bodyStart, line: 1, column: 1 },
      end: { offset: span.end - bodyStart, line: 1, column: 1 },
    },
  };
  return {
    id: first.id,
    type: 'callout',
    ...(rawKind ? { rawKind } : {}),
    editable,
    source: source.slice(span.start, span.end),
    gapBefore: first.gapBefore,
    start: span.start,
    end: span.end,
    edits: [],
    reformat: false,
    mdast,
    calloutName: span.name,
    calloutTitle: span.title,
    calloutClosed: span.closed,
  };
}
