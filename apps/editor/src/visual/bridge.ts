// SPDX-License-Identifier: AGPL-3.0-only

import {
  type EditorBlockNode,
  type EditorState,
  type FrontmatterInspection,
  type KnownFrontmatterKey,
  openEditorDocument,
  serializeEditorState,
  updateEditorFrontmatter,
} from '@oxybook/doc-model/editor';
import type { Node as PmNode } from 'prosemirror-model';
import { schema } from './schema.ts';

/**
 * The bridge between a ProseMirror document and the doc-model editor state
 * (ARCHITECTURE §3.4).
 *
 * Unedited blocks keep their exact bytes because ProseMirror reuses the node objects
 * of top-level blocks a transaction did not touch. The session remembers which model
 * block each loaded node came from; a node that is still the same object serializes
 * from the model's side table, byte for byte. Only a block that was edited (a new node
 * object) is converted back and re-serialized.
 */

export interface VisualSession {
  model: EditorState;
  frontmatter: FrontmatterInspection;
  readonly originals: WeakMap<PmNode, EditorBlockNode>;
}

export type VisualOpen =
  | { mode: 'visual'; session: VisualSession; doc: PmNode }
  | { mode: 'source-only'; reason: string };

/** Load a page for the visual editor, or say why it must stay in source mode. */
export function openVisual(source: string, path: string): VisualOpen {
  const opened = openEditorDocument(source, { filename: path });
  if (opened.mode === 'source-only') {
    return {
      mode: 'source-only',
      reason:
        opened.reason === 'unparseable'
          ? `This page could not be parsed (${opened.detail}), so it opens in source mode.`
          : 'This page does not round-trip exactly yet, so it opens in source mode to keep its bytes safe.',
    };
  }
  let doc: PmNode;
  try {
    doc = schema.nodeFromJSON(withoutEmptyText(opened.state.doc));
    doc.check();
  } catch (error) {
    return {
      mode: 'source-only',
      reason: `This page has a structure the visual editor cannot show yet (${error instanceof Error ? error.message : String(error)}), so it opens in source mode.`,
    };
  }
  const originals = new WeakMap<PmNode, EditorBlockNode>();
  opened.state.doc.content.forEach((block, index) => {
    originals.set(doc.child(index), block);
  });
  return {
    mode: 'visual',
    doc,
    session: { model: opened.state, frontmatter: opened.frontmatter, originals },
  };
}

/** The file's text for this ProseMirror document. */
export function serializeVisual(session: VisualSession, doc: PmNode): string {
  const content: EditorBlockNode[] = [];
  doc.forEach((node) => {
    content.push(session.originals.get(node) ?? (toModel(node) as EditorBlockNode));
  });
  return serializeEditorState({ ...session.model, doc: { type: 'doc', content } });
}

/** Change a known frontmatter key; only that scalar's bytes change. */
export function setFrontmatter(
  session: VisualSession,
  key: KnownFrontmatterKey,
  value: string | boolean,
): void {
  session.model = updateEditorFrontmatter(session.model, key, value);
  session.frontmatter = {
    ...session.frontmatter,
    exists: true,
    known: { ...session.frontmatter.known, [key]: value },
  };
}

const LEAVES = new Set(['horizontal_rule', 'raw_block', 'hard_break', 'image', 'raw_inline']);
const OPTIONAL_ATTRS = new Set(['openerLine', 'closerLine']);

type Json = { [key: string]: unknown };

/** A ProseMirror node as doc-model JSON: the shape `serializeEditorState` expects. */
export function toModel(node: PmNode): Json {
  if (node.isText) {
    const out: Json = { type: 'text', text: node.text ?? '' };
    if (node.marks.length > 0) {
      out.marks = node.marks.map((mark) =>
        mark.type.name === 'link'
          ? { type: 'link', attrs: { ...mark.attrs } }
          : { type: mark.type.name },
      );
    }
    return out;
  }
  const out: Json = { type: node.type.name };
  if (Object.keys(node.type.spec.attrs ?? {}).length > 0) {
    const attrs: Json = {};
    for (const [key, value] of Object.entries(node.attrs)) {
      if (OPTIONAL_ATTRS.has(key) && value == null) continue;
      attrs[key] = value;
    }
    out.attrs = attrs;
  }
  if (!LEAVES.has(node.type.name)) {
    const children: Json[] = [];
    node.forEach((child) => {
      children.push(toModel(child));
    });
    out.content = children;
  }
  return out;
}

/** ProseMirror refuses empty text nodes; the model can hold them, and they carry no bytes. */
function withoutEmptyText(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(
        (item) =>
          !(
            item &&
            typeof item === 'object' &&
            (item as Json).type === 'text' &&
            (item as Json).text === ''
          ),
      )
      .map(withoutEmptyText);
  }
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [key, child] of Object.entries(value)) out[key] = withoutEmptyText(child);
    return out;
  }
  return value;
}
