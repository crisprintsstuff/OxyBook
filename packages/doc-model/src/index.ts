// SPDX-License-Identifier: AGPL-3.0-only

export { CALLOUTS, parseCalloutOpener } from './callouts.js';
export {
  analyzeFile,
  analyzeSource,
  type CompatSummary,
  type FileCompat,
  formatPlaceholders,
  formatSummary,
  type Placeholder,
  type PlaceholderReason,
  ranked,
  STARTING_ALLOWLIST,
  summarize,
} from './compat.js';
export { insertIntoTextSpan, listPlainTextSpans, reformatBlock } from './edit.js';
export {
  type AlertKind,
  deleteEditorBlock,
  describeRawNode,
  type EditorBlockNode,
  type EditorDocument,
  type EditorInlineNode,
  type EditorListItemNode,
  type EditorMark,
  type EditorState,
  type EditorTableCellNode,
  type EditorTableRowNode,
  insertEditorBlock,
  markBlocksDirtyByRange,
  markBlocksDirtyFromPmSteps,
  moveEditorBlock,
  type OpenEditorResult,
  openEditorDocument,
  type PmStepMapRange,
  type SideTableEntry,
  type StepRange,
  serializeEditorState,
  sourceDocToEditorState,
  updateEditorBlock,
  updateEditorFrontmatter,
} from './editor-doc.js';
export {
  type FrontmatterInspection,
  inspectFrontmatter,
  KNOWN_FRONTMATTER_KEYS,
  type KnownFrontmatterFields,
  type KnownFrontmatterKey,
  type ScalarValue,
  setFrontmatterScalar,
  type UnknownFrontmatterEntry,
  updateFrontmatterField,
} from './frontmatter.js';
export { checkIdentity, divergence } from './identity.js';
export { formatFromFilename, parse, parseOrThrow } from './parse.js';
export { type ChangeRegion, changedRegion, isLineAligned, regionWithin } from './range.js';
export { exitCodeFor, formatReport, listMarkdownFiles, roundtripPath } from './roundtrip.js';
export { serialize, serializeBlock } from './serialize.js';
export type {
  Block,
  Divergence,
  FileReport,
  Format,
  Frontmatter,
  IdentityReport,
  LineEnding,
  MdastNode,
  ParseOptions,
  ParseResult,
  RawKind,
  SourceDoc,
  StyleProfile,
  TextEdit,
  TextSpan,
} from './types.js';
export { blockIsDirty } from './types.js';
