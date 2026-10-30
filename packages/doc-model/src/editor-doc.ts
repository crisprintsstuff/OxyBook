// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { type Options, toMarkdown } from 'mdast-util-to-markdown';
import {
  type FrontmatterInspection,
  inspectFrontmatter,
  type KnownFrontmatterKey,
  updateFrontmatterField,
} from './frontmatter.js';
import { divergence } from './identity.js';
import { parse } from './parse.js';
import { serialize } from './serialize.js';
import type {
  Block,
  Format,
  LineEnding,
  MdastNode,
  ParseOptions,
  RawKind,
  SourceDoc,
  StyleProfile,
} from './types.js';

export type EditorMark =
  | { type: 'strong' }
  | { type: 'em' }
  | { type: 'strike' }
  | { type: 'code' }
  | {
      type: 'link';
      attrs: {
        href: string;
        title: string | null;
        referenceType: 'full' | 'collapsed' | 'shortcut' | null;
        identifier: string | null;
      };
    };

export type EditorInlineNode =
  | {
      type: 'text';
      text: string;
      marks?: EditorMark[];
    }
  | {
      type: 'hard_break';
      attrs: { backslash: boolean };
    }
  | {
      type: 'image';
      attrs: {
        src: string;
        alt: string | null;
        title: string | null;
      };
    }
  | {
      type: 'raw_inline';
      attrs: {
        source: string;
        kind: RawKind;
        label: string;
      };
    };

export interface EditorListItemNode {
  type: 'list_item';
  attrs: { checked: boolean | null };
  content: EditorBlockNode[];
}

export interface EditorTableCellNode {
  type: 'table_header' | 'table_cell';
  content: EditorInlineNode[];
}

export interface EditorTableRowNode {
  type: 'table_row';
  content: EditorTableCellNode[];
}

export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export type EditorBlockNode =
  | {
      type: 'paragraph';
      attrs: { srcId?: string | null };
      content: EditorInlineNode[];
    }
  | {
      type: 'heading';
      attrs: { srcId?: string | null; level: 1 | 2 | 3 | 4 | 5 | 6; style: 'atx' | 'setext' };
      content: EditorInlineNode[];
    }
  | {
      type: 'code_block';
      attrs: {
        srcId?: string | null;
        language: string | null;
        meta: string | null;
        indented: boolean;
      };
      content: Array<{ type: 'text'; text: string }>;
    }
  | {
      type: 'blockquote';
      attrs: { srcId?: string | null };
      content: EditorBlockNode[];
    }
  | {
      type: 'alert';
      attrs: { srcId?: string | null; alertKind: AlertKind };
      content: EditorBlockNode[];
    }
  | {
      type: 'callout';
      attrs: {
        srcId?: string | null;
        name: string;
        title: string | null;
        openerLine?: string;
        closerLine?: string;
      };
      content: EditorBlockNode[];
    }
  | {
      type: 'bullet_list';
      attrs: { srcId?: string | null; spread: boolean };
      content: EditorListItemNode[];
    }
  | {
      type: 'ordered_list';
      attrs: { srcId?: string | null; start: number; spread: boolean };
      content: EditorListItemNode[];
    }
  | {
      type: 'task_list';
      attrs: { srcId?: string | null; spread: boolean };
      content: EditorListItemNode[];
    }
  | {
      type: 'table';
      attrs: { srcId?: string | null; align: Array<'left' | 'right' | 'center' | null> };
      content: EditorTableRowNode[];
    }
  | {
      type: 'horizontal_rule';
      attrs: { srcId?: string | null };
    }
  | {
      type: 'raw_block';
      attrs: {
        srcId?: string | null;
        source: string;
        kind: RawKind;
        label: string;
      };
    };

export interface SideTableEntry {
  srcId: string;
  source: string;
  gapBefore: string;
  initialNodeJson: string;
  originalBlock: Block;
}

export interface EditorDocument {
  type: 'doc';
  content: EditorBlockNode[];
}

export interface EditorState {
  sourceDoc: SourceDoc;
  doc: EditorDocument;
  sideTable: ReadonlyMap<string, SideTableEntry>;
  dirtyIds: ReadonlySet<string>;
}

export interface StepRange {
  /** 0-based top-level block index or character/position range in the document. */
  fromBlockIndex: number;
  toBlockIndex: number;
}

export interface PmStepMapRange {
  /** ProseMirror document position before/after step. */
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export type OpenEditorResult =
  | {
      mode: 'visual';
      state: EditorState;
      frontmatter: FrontmatterInspection;
      fileHash: string;
    }
  | {
      mode: 'source-only';
      reason: 'unparseable' | 'identity-failed';
      detail: string;
      source: string;
      fileHash: string;
    };

function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Human-readable label for a raw preservation block or inline node (ARCHITECTURE §3.3). */
export function describeRawNode(kind: RawKind, source: string, mdast?: MdastNode | null): string {
  if (kind === 'mdx-jsx') {
    const tagMatch = /^<\s*([A-Za-z0-9_.:-]+)/.exec(source.trim());
    const name = (typeof mdast?.name === 'string' && mdast.name) || tagMatch?.[1] || 'JSX';
    return `MDX component <${name}> — edit in source`;
  }
  if (kind === 'mdx-esm') {
    const word = source.trimStart().startsWith('export') ? 'export' : 'import';
    return `MDX ${word} — edit in source`;
  }
  if (kind === 'mdx-expression') {
    return 'MDX expression — edit in source';
  }
  if (kind === 'html-comment') {
    return 'HTML comment — edit in source';
  }
  if (kind === 'html') {
    return 'Raw HTML — edit in source';
  }
  if (kind === 'directive') {
    const name = typeof mdast?.name === 'string' && mdast.name ? `:::${mdast.name}` : 'Directive';
    return `${name} — edit in source`;
  }
  if (kind === 'definition') {
    return 'Link/footnote definition — edit in source';
  }
  return 'Unparsed region — edit in source';
}

function rawInlineFromMdast(node: MdastNode): EditorInlineNode {
  const source =
    typeof node.data?.oxySource === 'string'
      ? node.data.oxySource
      : typeof node.value === 'string'
        ? node.value
        : '';
  let kind: RawKind = 'unparsed';
  if (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') kind = 'mdx-jsx';
  else if (node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression')
    kind = 'mdx-expression';
  else if (node.type === 'html')
    kind = source.trimStart().startsWith('<!--') ? 'html-comment' : 'html';
  else if (node.type === 'textDirective' || node.type === 'leafDirective') kind = 'directive';
  else if (node.type === 'imageReference' || node.type === 'footnoteReference') kind = 'definition';

  return {
    type: 'raw_inline',
    attrs: {
      source,
      kind,
      label: describeRawNode(kind, source, node),
    },
  };
}

function addMark(inlines: EditorInlineNode[], mark: EditorMark): EditorInlineNode[] {
  return inlines.map((node) => {
    if (node.type !== 'text') return node;
    const existing = node.marks ?? [];
    return {
      ...node,
      marks: [...existing, mark],
    };
  });
}

function mdastToInlines(nodes: readonly MdastNode[] | undefined): EditorInlineNode[] {
  if (!nodes || nodes.length === 0) return [];
  const out: EditorInlineNode[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const text = typeof node.value === 'string' ? node.value : '';
        if (text.length > 0) {
          out.push({ type: 'text', text });
        }
        break;
      }
      case 'inlineCode': {
        const text = typeof node.value === 'string' ? node.value : '';
        out.push({
          type: 'text',
          text,
          marks: [{ type: 'code' }],
        });
        break;
      }
      case 'strong': {
        out.push(...addMark(mdastToInlines(node.children), { type: 'strong' }));
        break;
      }
      case 'emphasis': {
        out.push(...addMark(mdastToInlines(node.children), { type: 'em' }));
        break;
      }
      case 'delete': {
        out.push(...addMark(mdastToInlines(node.children), { type: 'strike' }));
        break;
      }
      case 'link': {
        const href = typeof node.url === 'string' ? node.url : '';
        const title = typeof node.title === 'string' ? node.title : null;
        out.push(
          ...addMark(mdastToInlines(node.children), {
            type: 'link',
            attrs: {
              href,
              title,
              referenceType: null,
              identifier: null,
            },
          }),
        );
        break;
      }
      case 'linkReference': {
        const refType =
          node.referenceType === 'full' ||
          node.referenceType === 'collapsed' ||
          node.referenceType === 'shortcut'
            ? node.referenceType
            : 'full';
        const identifier = typeof node.identifier === 'string' ? node.identifier : '';
        out.push(
          ...addMark(mdastToInlines(node.children), {
            type: 'link',
            attrs: {
              href: `#ref:${identifier}`,
              title: null,
              referenceType: refType,
              identifier,
            },
          }),
        );
        break;
      }
      case 'image': {
        out.push({
          type: 'image',
          attrs: {
            src: typeof node.url === 'string' ? node.url : '',
            alt: typeof node.alt === 'string' ? node.alt : null,
            title: typeof node.title === 'string' ? node.title : null,
          },
        });
        break;
      }
      case 'break': {
        const src = typeof node.data?.oxySource === 'string' ? node.data.oxySource : '';
        out.push({
          type: 'hard_break',
          attrs: { backslash: src.startsWith('\\') },
        });
        break;
      }
      default: {
        out.push(rawInlineFromMdast(node));
        break;
      }
    }
  }

  return out;
}

function mdastChildToBlock(node: MdastNode, format: Format): EditorBlockNode {
  const source = typeof node.data?.oxySource === 'string' ? node.data.oxySource : '';
  switch (node.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        attrs: { srcId: null },
        content: mdastToInlines(node.children),
      };
    case 'heading': {
      const depth = typeof node.depth === 'number' ? node.depth : 1;
      const level = Math.min(6, Math.max(1, depth)) as 1 | 2 | 3 | 4 | 5 | 6;
      const style = source.length > 0 && !source.trimStart().startsWith('#') ? 'setext' : 'atx';
      return {
        type: 'heading',
        attrs: { srcId: null, level, style },
        content: mdastToInlines(node.children),
      };
    }
    case 'code': {
      const text = typeof node.value === 'string' ? node.value : '';
      const indented = source.length > 0 && !source.startsWith('```') && !source.startsWith('~~~');
      return {
        type: 'code_block',
        attrs: {
          srcId: null,
          language: typeof node.lang === 'string' ? node.lang : null,
          meta: typeof node.meta === 'string' ? node.meta : null,
          indented,
        },
        content: text.length > 0 ? [{ type: 'text', text }] : [],
      };
    }
    case 'thematicBreak':
      return {
        type: 'horizontal_rule',
        attrs: { srcId: null },
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        attrs: { srcId: null },
        content: (node.children ?? []).map((child) => mdastChildToBlock(child, format)),
      };
    case 'list': {
      const items = (node.children ?? []).map(
        (item): EditorListItemNode => ({
          type: 'list_item',
          attrs: {
            checked: typeof item.checked === 'boolean' ? item.checked : null,
          },
          content: (item.children ?? []).map((child) => mdastChildToBlock(child, format)),
        }),
      );
      const isTask = items.some((item) => item.attrs.checked !== null);
      const spread = Boolean(node.spread);
      if (isTask) {
        return {
          type: 'task_list',
          attrs: { srcId: null, spread },
          content: items,
        };
      }
      if (node.ordered) {
        return {
          type: 'ordered_list',
          attrs: {
            srcId: null,
            start: typeof node.start === 'number' ? node.start : 1,
            spread,
          },
          content: items,
        };
      }
      return {
        type: 'bullet_list',
        attrs: { srcId: null, spread },
        content: items,
      };
    }
    case 'table': {
      const rawAlign = Array.isArray(node.align) ? node.align : [];
      const align = rawAlign.map((a): 'left' | 'right' | 'center' | null =>
        a === 'left' || a === 'right' || a === 'center' ? a : null,
      );
      const rows = (node.children ?? []).map(
        (row, rowIndex): EditorTableRowNode => ({
          type: 'table_row',
          content: (row.children ?? []).map(
            (cell): EditorTableCellNode => ({
              type: rowIndex === 0 ? 'table_header' : 'table_cell',
              content: mdastToInlines(cell.children),
            }),
          ),
        }),
      );
      return {
        type: 'table',
        attrs: { srcId: null, align },
        content: rows,
      };
    }
    default: {
      let kind: RawKind = 'unparsed';
      if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') kind = 'mdx-jsx';
      else if (node.type === 'mdxjsEsm') kind = 'mdx-esm';
      else if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression')
        kind = 'mdx-expression';
      else if (node.type === 'html')
        kind = source.trimStart().startsWith('<!--') ? 'html-comment' : 'html';
      else if (
        node.type === 'containerDirective' ||
        node.type === 'leafDirective' ||
        node.type === 'textDirective'
      )
        kind = 'directive';
      else if (node.type === 'definition' || node.type === 'footnoteDefinition')
        kind = 'definition';
      return {
        type: 'raw_block',
        attrs: {
          srcId: null,
          source,
          kind,
          label: describeRawNode(kind, source, node),
        },
      };
    }
  }
}

function parseAlertBlock(block: Block, format: Format): EditorBlockNode {
  const match = /^>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i.exec(block.source);
  const alertKind = (match?.[1]?.toUpperCase() ?? 'NOTE') as AlertKind;
  const children = [...(block.mdast?.children ?? [])];
  if (children.length > 0 && children[0]?.type === 'paragraph') {
    const firstPara = children[0];
    const paraChildren = [...(firstPara.children ?? [])];
    if (paraChildren.length > 0 && paraChildren[0]?.type === 'text') {
      const firstText = String(paraChildren[0].value ?? '');
      const stripped = firstText.replace(
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i,
        '',
      );
      if (stripped.length > 0) {
        paraChildren[0] = { ...paraChildren[0], value: stripped };
        children[0] = { ...firstPara, children: paraChildren };
      } else {
        paraChildren.shift();
        const nextChild = paraChildren[0] as MdastNode | undefined;
        if (nextChild?.type === 'break') {
          paraChildren.shift();
        }
        if (paraChildren.length > 0) {
          children[0] = { ...firstPara, children: paraChildren };
        } else {
          children.shift();
        }
      }
    }
  }
  return {
    type: 'alert',
    attrs: { srcId: block.id, alertKind },
    content: children.map((child) => mdastChildToBlock(child, format)),
  };
}

function parseCalloutBlock(block: Block, format: Format): EditorBlockNode {
  const firstLineMatch = /^([^\r\n]*)(\r?\n|$)/.exec(block.source);
  const openerLine = firstLineMatch?.[1] ?? `:::${block.calloutName ?? 'note'}`;
  const closeMatch = /(\r?\n)(:::[ \t]*)$/.exec(block.source);
  const closerLine = closeMatch?.[2] ?? ':::';

  const innerStart = firstLineMatch ? firstLineMatch[0].length : 0;
  const innerEnd = closeMatch ? block.source.length - closeMatch[0].length : block.source.length;
  const innerSource = block.source.slice(innerStart, Math.max(innerStart, innerEnd));

  // If the interior has nested `:::` containers, preserve the interior as a raw block so nested
  // markers are never mangled (docs/M0-NOTES.md).
  const hasNestedContainer = /(?:^|\n):::/.test(innerSource);
  let content: EditorBlockNode[] = [];
  if (hasNestedContainer) {
    content = [
      {
        type: 'raw_block',
        attrs: {
          srcId: null,
          source: innerSource,
          kind: 'directive',
          label: 'Nested directive — edit in source',
        },
      },
    ];
  } else if (innerSource.trim().length > 0) {
    const innerParsed = parse(innerSource, { format });
    if (innerParsed.ok) {
      content = innerParsed.doc.blocks.map((innerBlock) =>
        sourceBlockToEditorBlock({ ...innerBlock, id: '' }, format),
      );
    } else {
      content = [
        {
          type: 'raw_block',
          attrs: {
            srcId: null,
            source: innerSource,
            kind: 'unparsed',
            label: 'Unparsed region — edit in source',
          },
        },
      ];
    }
  }

  return {
    type: 'callout',
    attrs: {
      srcId: block.id,
      name: block.calloutName ?? 'note',
      title: block.calloutTitle ?? null,
      openerLine,
      closerLine,
    },
    content,
  };
}

function sourceBlockToEditorBlock(block: Block, format: Format): EditorBlockNode {
  const srcId = block.id || null;
  if (!block.editable || !block.mdast) {
    const kind = block.rawKind ?? 'unparsed';
    return {
      type: 'raw_block',
      attrs: {
        srcId,
        source: block.source,
        kind,
        label: describeRawNode(kind, block.source, block.mdast),
      },
    };
  }

  if (block.type === 'alert') {
    const node = parseAlertBlock(block, format);
    return { ...node, attrs: { ...node.attrs, srcId } } as EditorBlockNode;
  }

  if (block.type === 'callout') {
    const node = parseCalloutBlock(block, format);
    return { ...node, attrs: { ...node.attrs, srcId } } as EditorBlockNode;
  }

  const converted = mdastChildToBlock(block.mdast, format);
  return {
    ...converted,
    attrs: { ...converted.attrs, srcId },
  } as EditorBlockNode;
}

function stripSrcId(node: EditorBlockNode): EditorBlockNode {
  return JSON.parse(
    JSON.stringify(node, (key, value) => (key === 'srcId' ? null : value)),
  ) as EditorBlockNode;
}

/**
 * Build an `EditorState` from a parsed `SourceDoc`.
 * Every top-level block gets `attrs.srcId` pointing to `sideTable`.
 */
export function sourceDocToEditorState(sourceDoc: SourceDoc): EditorState {
  const sideTable = new Map<string, SideTableEntry>();
  const content: EditorBlockNode[] = [];

  for (const block of sourceDoc.blocks) {
    const editorBlock = sourceBlockToEditorBlock(block, sourceDoc.format);
    content.push(editorBlock);
    sideTable.set(block.id, {
      srcId: block.id,
      source: block.source,
      gapBefore: block.gapBefore,
      initialNodeJson: JSON.stringify(stripSrcId(editorBlock)),
      originalBlock: block,
    });
  }

  return {
    sourceDoc,
    doc: {
      type: 'doc',
      content,
    },
    sideTable,
    dirtyIds: new Set<string>(),
  };
}

/**
 * Open a markdown/MDX file for the editor with the mandatory load-time identity
 * check (`serialize(parse(src)) === src`, ARCHITECTURE §3.4).
 * If the file is unparseable or fails the identity check, it opens in `source-only`
 * mode so the visual editor never corrupts a file.
 */
export function openEditorDocument(source: string, options: ParseOptions = {}): OpenEditorResult {
  const fileHash = sha256Hex(source);
  const parsed = parse(source, options);
  if (!parsed.ok) {
    return {
      mode: 'source-only',
      reason: 'unparseable',
      detail: parsed.error,
      source,
      fileHash,
    };
  }
  const serialized = serialize(parsed.doc);
  if (serialized !== source) {
    const diff = divergence(source, serialized);
    return {
      mode: 'source-only',
      reason: 'identity-failed',
      detail: diff
        ? `diverged at ${diff.line}:${diff.column}: expected ${diff.expectedSnippet}, got ${diff.actualSnippet}`
        : 'load-time identity check failed',
      source,
      fileHash,
    };
  }
  return {
    mode: 'visual',
    state: sourceDocToEditorState(parsed.doc),
    frontmatter: inspectFrontmatter(parsed.doc),
    fileHash,
  };
}

function inlinesToMdast(inlines: readonly EditorInlineNode[]): MdastNode[] {
  const result: MdastNode[] = [];

  for (const node of inlines) {
    if (node.type === 'hard_break') {
      result.push({
        type: 'break',
        data: { oxySource: node.attrs.backslash ? '\\\n' : '  \n' },
      });
      continue;
    }
    if (node.type === 'image') {
      result.push({
        type: 'image',
        url: node.attrs.src,
        alt: node.attrs.alt ?? '',
        title: node.attrs.title ?? null,
      });
      continue;
    }
    if (node.type === 'raw_inline') {
      result.push({
        type: 'html',
        value: node.attrs.source,
        data: { oxySource: node.attrs.source },
      });
      continue;
    }

    const marks = node.marks ?? [];
    const hasCode = marks.some((m) => m.type === 'code');
    let leaf: MdastNode = hasCode
      ? { type: 'inlineCode', value: node.text }
      : { type: 'text', value: node.text };

    for (const mark of marks) {
      if (mark.type === 'code') continue;
      if (mark.type === 'strong') {
        leaf = { type: 'strong', children: [leaf] };
      } else if (mark.type === 'em') {
        leaf = { type: 'emphasis', children: [leaf] };
      } else if (mark.type === 'strike') {
        leaf = { type: 'delete', children: [leaf] };
      } else if (mark.type === 'link') {
        if (mark.attrs.referenceType && mark.attrs.identifier !== null) {
          leaf = {
            type: 'linkReference',
            identifier: mark.attrs.identifier,
            label: mark.attrs.identifier,
            referenceType: mark.attrs.referenceType,
            children: [leaf],
          };
        } else {
          leaf = {
            type: 'link',
            url: mark.attrs.href,
            title: mark.attrs.title,
            children: [leaf],
          };
        }
      }
    }

    result.push(leaf);
  }

  return result;
}

function editorBlockToMdast(block: EditorBlockNode): MdastNode {
  switch (block.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        children: inlinesToMdast(block.content),
      };
    case 'heading':
      return {
        type: 'heading',
        depth: block.attrs.level,
        children: inlinesToMdast(block.content),
      };
    case 'code_block': {
      const value = block.content.map((c) => c.text).join('');
      return {
        type: 'code',
        lang: block.attrs.language,
        meta: block.attrs.meta,
        value,
      };
    }
    case 'horizontal_rule':
      return { type: 'thematicBreak' };
    case 'blockquote':
      return {
        type: 'blockquote',
        children: block.content.map((child) => editorBlockToMdast(child)),
      };
    case 'bullet_list':
      return {
        type: 'list',
        ordered: false,
        spread: block.attrs.spread,
        children: block.content.map((item) => ({
          type: 'listItem',
          spread: false,
          checked: null,
          children: item.content.map((child) => editorBlockToMdast(child)),
        })),
      };
    case 'ordered_list':
      return {
        type: 'list',
        ordered: true,
        start: block.attrs.start,
        spread: block.attrs.spread,
        children: block.content.map((item) => ({
          type: 'listItem',
          spread: false,
          checked: null,
          children: item.content.map((child) => editorBlockToMdast(child)),
        })),
      };
    case 'task_list':
      return {
        type: 'list',
        ordered: false,
        spread: block.attrs.spread,
        children: block.content.map((item) => ({
          type: 'listItem',
          spread: false,
          checked: item.attrs.checked ?? false,
          children: item.content.map((child) => editorBlockToMdast(child)),
        })),
      };
    case 'table':
      return {
        type: 'table',
        align: block.attrs.align,
        children: block.content.map((row) => ({
          type: 'tableRow',
          children: row.content.map((cell) => ({
            type: 'tableCell',
            children: inlinesToMdast(cell.content),
          })),
        })),
      };
    case 'raw_block':
      return {
        type: 'html',
        value: block.attrs.source,
        data: { oxySource: block.attrs.source },
      };
    case 'alert':
    case 'callout':
      throw new Error(`${block.type} uses dedicated block serialization`);
  }
}

function sourceHandle(node: { data?: { oxySource?: string }; value?: unknown }): string {
  if (typeof node.data?.oxySource === 'string') return node.data.oxySource;
  if (typeof node.value === 'string') return node.value;
  throw new Error('raw node is missing its original source');
}

function breakHandle(node: { data?: { oxySource?: string } }): string {
  if (typeof node.data?.oxySource === 'string') return node.data.oxySource;
  return '  \n';
}

function serializeDirtyEditorBlock(
  block: EditorBlockNode,
  style: StyleProfile,
  lineEnding: LineEnding,
): string {
  if (block.type === 'raw_block') {
    return block.attrs.source;
  }

  if (block.type === 'callout') {
    const eol = lineEnding;
    const defaultOpener = block.attrs.title
      ? `:::${block.attrs.name} ${block.attrs.title}`
      : `:::${block.attrs.name}`;
    const opener = block.attrs.openerLine ?? defaultOpener;
    const closer = block.attrs.closerLine ?? ':::';
    const body = block.content
      .map((child) => serializeDirtyEditorBlock(child, style, lineEnding))
      .join(`${eol}${eol}`);
    return body.length > 0 ? `${opener}${eol}${body}${eol}${closer}` : `${opener}${eol}${closer}`;
  }

  if (block.type === 'alert') {
    const eol = lineEnding;
    const inner = block.content
      .map((child) => serializeDirtyEditorBlock(child, style, '\n'))
      .join('\n\n');
    const prefixed = inner
      .split('\n')
      .map((line) => (line.length > 0 ? `> ${line}` : '>'))
      .join(eol);
    return `> [!${block.attrs.alertKind}]${prefixed ? `${eol}${prefixed}` : ''}`;
  }

  if (block.type === 'code_block' && block.attrs.indented) {
    const rawText = block.content.map((c) => c.text).join('');
    return rawText
      .split(/\r?\n/)
      .map((line) => `    ${line}`)
      .join(lineEnding);
  }

  const mdast = editorBlockToMdast(block);
  const setext = block.type === 'heading' && block.attrs.style === 'setext';
  const options = {
    bullet: style.bullet,
    bulletOrdered: style.orderedDelimiter,
    emphasis: style.emphasis,
    strong: style.strong,
    fence: style.fence,
    rule: style.rule,
    ruleRepetition: style.ruleRepetition,
    listItemIndent: style.listItemIndent,
    tablePipeAlign: style.tablePad,
    setext,
    extensions: [gfmToMarkdown({ tablePipeAlign: style.tablePad })],
    handlers: {
      html: sourceHandle,
      break: breakHandle,
    },
  } as Options;

  let rendered = toMarkdown(mdast as never, options);
  if (rendered.endsWith('\r\n')) rendered = rendered.slice(0, -2);
  else if (rendered.endsWith('\n')) rendered = rendered.slice(0, -1);
  if (lineEnding === '\r\n') rendered = rendered.replace(/\n/g, '\r\n');
  return rendered;
}

/**
 * Mark top-level blocks dirty by block index range (e.g. computed from ProseMirror step maps).
 */
export function markBlocksDirtyByRange(
  state: EditorState,
  ranges: readonly StepRange[],
): EditorState {
  const nextDirty = new Set(state.dirtyIds);
  for (const range of ranges) {
    const start = Math.max(0, range.fromBlockIndex);
    const end = Math.min(state.doc.content.length - 1, range.toBlockIndex);
    for (let i = start; i <= end; i++) {
      const block = state.doc.content[i];
      const srcId = block?.attrs.srcId;
      if (srcId) nextDirty.add(srcId);
    }
  }
  return {
    ...state,
    dirtyIds: nextDirty,
  };
}

/**
 * Map ProseMirror step ranges (`oldStart..oldEnd` / `newStart..newEnd`) onto top-level
 * block spans `[{ from, to }]` and mark every overlapping top-level block dirty (ARCHITECTURE §3.4).
 */
export function markBlocksDirtyFromPmSteps(
  state: EditorState,
  blockPositions: ReadonlyArray<{ srcId?: string | null; from: number; to: number }>,
  steps: readonly PmStepMapRange[],
): EditorState {
  const nextDirty = new Set(state.dirtyIds);
  for (const step of steps) {
    for (const pos of blockPositions) {
      if (!pos.srcId) continue;
      const overlapsNew = step.newStart <= pos.to && step.newEnd >= pos.from;
      const overlapsOld = step.oldStart <= pos.to && step.oldEnd >= pos.from;
      if (overlapsNew || overlapsOld) {
        nextDirty.add(pos.srcId);
      }
    }
  }
  return {
    ...state,
    dirtyIds: nextDirty,
  };
}

/**
 * Replace or mutate a top-level block in `state.doc.content` and mark its `srcId` dirty.
 */
export function updateEditorBlock(
  state: EditorState,
  blockIndex: number,
  nextBlock: EditorBlockNode,
): EditorState {
  if (blockIndex < 0 || blockIndex >= state.doc.content.length) {
    throw new Error(`block index ${blockIndex} is out of range`);
  }
  const prev = state.doc.content[blockIndex];
  const srcId = nextBlock.attrs.srcId ?? prev?.attrs.srcId ?? null;
  const withSrcId = {
    ...nextBlock,
    attrs: { ...nextBlock.attrs, srcId },
  } as EditorBlockNode;

  const nextContent = state.doc.content.map((b, idx) => (idx === blockIndex ? withSrcId : b));
  const nextDirty = new Set(state.dirtyIds);
  if (srcId) nextDirty.add(srcId);

  return {
    ...state,
    doc: {
      ...state.doc,
      content: nextContent,
    },
    dirtyIds: nextDirty,
  };
}

/**
 * Move a top-level block from `fromIndex` to `toIndex` without marking it dirty.
 * Because `srcId` travels with the node, its original source bytes are preserved (ARCHITECTURE §3.4).
 */
export function moveEditorBlock(
  state: EditorState,
  fromIndex: number,
  toIndex: number,
): EditorState {
  if (
    fromIndex < 0 ||
    fromIndex >= state.doc.content.length ||
    toIndex < 0 ||
    toIndex >= state.doc.content.length
  ) {
    throw new Error('block index out of range');
  }
  if (fromIndex === toIndex) return state;
  const nextContent = [...state.doc.content];
  const [moved] = nextContent.splice(fromIndex, 1);
  if (!moved) return state;
  nextContent.splice(toIndex, 0, moved);
  return {
    ...state,
    doc: {
      ...state.doc,
      content: nextContent,
    },
  };
}

/**
 * Delete a top-level block (including a `raw_block`, per ARCHITECTURE §3.3).
 */
export function deleteEditorBlock(state: EditorState, blockIndex: number): EditorState {
  if (blockIndex < 0 || blockIndex >= state.doc.content.length) {
    throw new Error(`block index ${blockIndex} is out of range`);
  }
  const nextContent = state.doc.content.filter((_, idx) => idx !== blockIndex);
  return {
    ...state,
    doc: {
      ...state.doc,
      content: nextContent,
    },
  };
}

/**
 * Insert a new top-level block at `blockIndex`. New blocks have `srcId: null` and are
 * serialized using the file's `StyleProfile`.
 */
export function insertEditorBlock(
  state: EditorState,
  blockIndex: number,
  newBlock: EditorBlockNode,
): EditorState {
  if (blockIndex < 0 || blockIndex > state.doc.content.length) {
    throw new Error(`insert index ${blockIndex} is out of range`);
  }
  const nextContent = [...state.doc.content];
  nextContent.splice(blockIndex, 0, {
    ...newBlock,
    attrs: { ...newBlock.attrs, srcId: null },
  } as EditorBlockNode);
  return {
    ...state,
    doc: {
      ...state.doc,
      content: nextContent,
    },
  };
}

/**
 * Update a known frontmatter key (`title`, `description`, `slug`, `nav_title`, `hidden`)
 * on an `EditorState`, preserving comments, key order, anchors, and quoting style.
 */
export function updateEditorFrontmatter(
  state: EditorState,
  key: KnownFrontmatterKey,
  value: string | boolean,
): EditorState {
  return {
    ...state,
    sourceDoc: updateFrontmatterField(state.sourceDoc, key, value),
  };
}

function isBlockDirty(block: EditorBlockNode, state: EditorState): boolean {
  const srcId = block.attrs.srcId;
  if (!srcId) return true;
  const entry = state.sideTable.get(srcId);
  if (!entry) return true;
  if (state.dirtyIds.has(srcId)) return true;
  return JSON.stringify(stripSrcId(block)) !== entry.initialNodeJson;
}

/**
 * Serialize an `EditorState` back to markdown/MDX (ARCHITECTURE §3.4):
 * - Unedited blocks with a `srcId` in `sideTable` emit `gapBefore + source` verbatim.
 * - Dirty or newly inserted blocks emit `(gapBefore || defaultGap) + serialize(block, styleProfile)`.
 * - `raw_block` and `raw_inline` always emit their `source` attribute verbatim.
 */
export function serializeEditorState(state: EditorState): string {
  const { sourceDoc, doc, sideTable } = state;
  // Fast path: if no blocks were added/removed/reordered and no block is dirty, delegate to `serialize(sourceDoc)`.
  const sameOrder =
    doc.content.length === sourceDoc.blocks.length &&
    doc.content.every((b, idx) => b.attrs.srcId === sourceDoc.blocks[idx]?.id);
  if (sameOrder && doc.content.every((b) => !isBlockDirty(b, state))) {
    return serialize(sourceDoc);
  }

  const eol = sourceDoc.lineEnding;
  const defaultBetweenGap = `${eol}${eol}`;
  let out = sourceDoc.bom ? '\uFEFF' : '';
  if (sourceDoc.frontmatter) {
    out += sourceDoc.frontmatter.raw;
  }

  for (let i = 0; i < doc.content.length; i++) {
    const block = doc.content[i];
    if (!block) continue;
    const srcId = block.attrs.srcId;
    const entry = srcId ? sideTable.get(srcId) : undefined;
    const dirty = isBlockDirty(block, state);

    let gapBefore: string;
    if (entry && i === 0 && sourceDoc.blocks[0]?.id === srcId) {
      gapBefore = entry.gapBefore;
    } else if (entry && sourceDoc.blocks[i]?.id === srcId) {
      gapBefore = entry.gapBefore;
    } else if (i === 0) {
      if (sourceDoc.frontmatter) {
        gapBefore = sourceDoc.blocks[0]?.gapBefore ?? eol;
      } else {
        gapBefore = '';
      }
    } else {
      gapBefore = entry && entry.gapBefore.length > 0 ? entry.gapBefore : defaultBetweenGap;
    }

    out += gapBefore;
    if (entry && !dirty) {
      out += entry.source;
    } else {
      out += serializeDirtyEditorBlock(block, sourceDoc.style, eol);
    }
  }

  out += sourceDoc.trailing;
  return out;
}
