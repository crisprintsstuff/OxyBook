// SPDX-License-Identifier: AGPL-3.0-only

export { insertIntoTextSpan, listPlainTextSpans, reformatBlock } from './edit.js';
export { type ScalarValue, setFrontmatterScalar } from './frontmatter.js';
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
