// SPDX-License-Identifier: AGPL-3.0-only

import { directiveToMarkdown } from 'mdast-util-directive';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { type Options, toMarkdown } from 'mdast-util-to-markdown';
import type { Block, LineEnding, MdastNode, SourceDoc, StyleProfile, TextEdit } from './types.js';

function applyEdits(source: string, edits: readonly TextEdit[], lineEnding: LineEnding): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > out.length) {
      throw new Error('text edit falls outside its block');
    }
    const text = lineEnding === '\r\n' ? edit.text.replace(/\n/g, '\r\n') : edit.text;
    out = out.slice(0, edit.start) + text + out.slice(edit.end);
  }
  return out;
}

function sourceHandle(node: { data?: { oxySource?: string }; value?: unknown }): string {
  if (typeof node.data?.oxySource === 'string') return node.data.oxySource;
  if (typeof node.value === 'string') return node.value;
  throw new Error('raw node is missing its original source');
}

function renderFromMdast(node: MdastNode, style: StyleProfile, setext: boolean): string {
  const options = {
    bullet: style.bullet,
    emphasis: style.emphasis,
    strong: style.strong,
    fence: style.fence,
    rule: style.rule,
    ruleRepetition: style.ruleRepetition,
    listItemIndent: style.listItemIndent,
    setext,
    extensions: [gfmToMarkdown(), directiveToMarkdown()],
    handlers: {
      html: sourceHandle,
      mdxJsxFlowElement: sourceHandle,
      mdxJsxTextElement: sourceHandle,
      mdxjsEsm: sourceHandle,
      mdxFlowExpression: sourceHandle,
      mdxTextExpression: sourceHandle,
    },
  } as Options;
  let rendered = toMarkdown(node as never, options);
  if (rendered.endsWith('\r\n')) rendered = rendered.slice(0, -2);
  else if (rendered.endsWith('\n')) rendered = rendered.slice(0, -1);
  return rendered;
}

export function serializeBlock(block: Block, doc: SourceDoc): string {
  if (block.reformat) {
    if (!block.mdast) throw new Error(`block ${block.id} has no syntax tree to reformat`);
    const setext = block.mdast.type === 'heading' && !block.source.startsWith('#');
    let rendered = renderFromMdast(block.mdast, doc.style, setext);
    if (doc.lineEnding === '\r\n') rendered = rendered.replace(/\n/g, '\r\n');
    return rendered;
  }
  if (block.edits.length > 0) return applyEdits(block.source, block.edits, doc.lineEnding);
  return block.source;
}

/**
 * Unedited blocks contribute their original slices and the gaps around them.
 * A dirty block contributes only a replacement of its own slice.
 */
export function serialize(doc: SourceDoc): string {
  let out = doc.bom ? '\uFEFF' : '';
  if (doc.frontmatter) out += doc.frontmatter.raw;
  for (const block of doc.blocks) {
    out += block.gapBefore;
    out += serializeBlock(block, doc);
  }
  out += doc.trailing;
  return out;
}
