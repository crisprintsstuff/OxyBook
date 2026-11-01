// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `@oxybook/doc-model/editor`: the parts the browser editor needs, with nothing that
 * touches the file system (no compatibility report, no round-trip CLI helpers).
 */

export { CALLOUTS } from './callouts.js';
export {
  type AlertKind,
  describeRawNode,
  type EditorBlockNode,
  type EditorDocument,
  type EditorInlineNode,
  type EditorListItemNode,
  type EditorMark,
  type EditorState,
  type EditorTableCellNode,
  type EditorTableRowNode,
  type OpenEditorResult,
  openEditorDocument,
  serializeEditorState,
  updateEditorFrontmatter,
} from './editor-doc.js';
export {
  type FrontmatterInspection,
  inspectFrontmatter,
  KNOWN_FRONTMATTER_KEYS,
  type KnownFrontmatterFields,
  type KnownFrontmatterKey,
  type ScalarValue,
  type UnknownFrontmatterEntry,
} from './frontmatter.js';
export { formatFromFilename } from './parse.js';
export type { Format, ParseOptions, RawKind } from './types.js';
