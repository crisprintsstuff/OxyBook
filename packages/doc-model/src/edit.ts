// SPDX-License-Identifier: AGPL-3.0-only

import type { Block, MdastNode, SourceDoc, TextSpan } from './types.js';

const STOP_DESCENT = new Set([
  'html',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxTextExpression',
  'definition',
  'footnoteDefinition',
  'leafDirective',
  'textDirective',
]);

function blockById(doc: SourceDoc, blockId: string): Block {
  const block = doc.blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new Error(`unknown block ${blockId}`);
  return block;
}

function replaceBlock(doc: SourceDoc, next: Block): SourceDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((block) => (block.id === next.id ? next : block)),
  };
}

function fencedInner(source: string, value: string): { start: number; end: number } | null {
  const open = /^(```+|~~~+)[^\n]*\r?\n/.exec(source);
  if (!open || value.length === 0) return null;
  const start = open[0].length;
  if (source.slice(start, start + value.length) !== value) return null;
  return { start, end: start + value.length };
}

function collect(block: Block, node: MdastNode, doc: SourceDoc, spans: TextSpan[]): void {
  if (STOP_DESCENT.has(node.type)) return;
  if (node.type === 'containerDirective' && block.rawKind === 'directive') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    const startOff = node.position?.start.offset;
    const endOff = node.position?.end.offset;
    if (typeof startOff === 'number' && typeof endOff === 'number') {
      const start = doc.bodyStart + startOff;
      const end = doc.bodyStart + endOff;
      if (start >= block.start && end <= block.end) {
        const slice = block.source.slice(start - block.start, end - block.start);
        // Positions sometimes cover marker bytes the value does not (blockquote
        // continuations). Only spans whose bytes equal the text are editable
        // without inventing an escape.
        const marker =
          block.type === 'callout' && (node.value.includes(':::') || slice.includes(':::'));
        if (slice === node.value && !marker) {
          spans.push({ blockId: block.id, start, end, value: node.value });
        }
      }
    }
  }

  if (
    node.type === 'code' &&
    typeof node.value === 'string' &&
    node.position?.start.offset !== undefined &&
    doc.bodyStart + (node.position.start.offset ?? 0) === block.start
  ) {
    const inner = fencedInner(block.source, node.value);
    if (inner) {
      spans.push({
        blockId: block.id,
        start: block.start + inner.start,
        end: block.start + inner.end,
        value: node.value,
      });
    }
  }

  for (const child of node.children ?? []) collect(block, child, doc, spans);
}

/** Plain-text spans whose bytes can be replaced without touching a raw node. */
export function listPlainTextSpans(doc: SourceDoc): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const block of doc.blocks) {
    if (!block.editable || !block.mdast) continue;
    collect(block, block.mdast, doc, spans);
  }
  return spans;
}

/**
 * Insert `text` into a plain span. Only that span's bytes change; the rest of
 * the block, including any nested raw node, is copied from the original slice.
 */
export function insertIntoTextSpan(
  doc: SourceDoc,
  span: TextSpan,
  insertAt: number,
  text: string,
): SourceDoc {
  const block = blockById(doc, span.blockId);
  if (!block.editable) throw new Error(`block ${block.id} is read-only`);
  if (block.reformat) throw new Error(`block ${block.id} is already marked for reformat`);
  if (insertAt < 0 || insertAt > span.value.length)
    throw new Error('insert offset is out of range');
  const localStart = span.start - block.start;
  const localEnd = span.end - block.start;
  if (block.source.slice(localStart, localEnd) !== span.value) {
    throw new Error('text span does not match the block source');
  }
  const at = localStart + insertAt;
  return replaceBlock(doc, {
    ...block,
    edits: [...block.edits, { start: at, end: at, text }],
  });
}

/** Rebuild one block from its syntax tree using the file's style profile. */
export function reformatBlock(doc: SourceDoc, blockId: string): SourceDoc {
  const block = blockById(doc, blockId);
  if (!block.editable || !block.mdast) throw new Error(`block ${block.id} cannot be reformatted`);
  if (block.type === 'callout') {
    throw new Error(`block ${block.id} is a callout; reformatting would rewrite its marker lines`);
  }
  if (block.edits.length > 0) throw new Error(`block ${block.id} already has a text edit`);
  return replaceBlock(doc, { ...block, reformat: true });
}
