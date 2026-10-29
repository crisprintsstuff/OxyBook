// SPDX-License-Identifier: AGPL-3.0-only

export type Format = 'md' | 'mdx';

export type LineEnding = '\n' | '\r\n';

/** Kinds of source the visual editor must not rewrite. Mirrors ARCHITECTURE §3.3. */
export type RawKind =
  | 'mdx-jsx'
  | 'mdx-esm'
  | 'mdx-expression'
  | 'html'
  | 'html-comment'
  | 'directive'
  | 'definition'
  | 'unparsed';

export interface StyleProfile {
  bullet: '-' | '*' | '+';
  emphasis: '*' | '_';
  strong: '*' | '_';
  fence: '`' | '~';
  fenceLength: number;
  orderedDelimiter: '.' | ')';
  /** mdast-util-to-markdown's list item indent mode. */
  listItemIndent: 'one' | 'tab' | 'mixed';
  /** Whitespace that nested lists actually used, when one width dominated. */
  listIndent: string;
  rule: '-' | '*' | '_';
  ruleRepetition: number;
  /** True when table cells were padded with spaces inside the pipes. */
  tablePad: boolean;
}

export interface Frontmatter {
  /** Bytes from the opening `---` through the closing delimiter, excluding any BOM. */
  raw: string;
  /** YAML between the delimiter lines. Offsets from the Document API are into this string. */
  yaml: string;
  /** Where `yaml` begins inside `raw`. */
  yamlOffset: number;
  /** False when the yaml package reported parse errors. The bytes are still preserved. */
  parseable: boolean;
  /** Absolute offsets of `raw` in the original file (BOM excluded from the start). */
  start: number;
  end: number;
}

/**
 * A pending edit against a block's original source.
 * Offsets are into that original slice, not into a previously edited version.
 */
export interface TextEdit {
  start: number;
  end: number;
  /** Uses `\n`. Serialize converts to the file's line ending. */
  text: string;
}

export interface MdastNode {
  type: string;
  value?: unknown;
  children?: MdastNode[];
  position?: {
    start: { offset?: number | null; line?: number; column?: number };
    end: { offset?: number | null; line?: number; column?: number };
  };
  data?: { oxySource?: string; [key: string]: unknown };
  name?: string;
  [key: string]: unknown;
}

export interface Block {
  id: string;
  type: string;
  rawKind?: RawKind;
  /** False for raw-preservation blocks. Their source is copied back verbatim. */
  editable: boolean;
  /** Original bytes of this block, not including the gap before it. */
  source: string;
  /** Bytes between the previous block (or the frontmatter) and this one. */
  gapBefore: string;
  /** Absolute offsets into the original string, BOM included. */
  start: number;
  end: number;
  edits: TextEdit[];
  /**
   * When set, serialize rebuilds this block from mdast with the style profile
   * instead of applying `edits`.
   */
  reformat: boolean;
  mdast: MdastNode | null;
  /** Set on a folded container (`:::name`, `:::name Title`, `:::name[Title]`). */
  calloutName?: string;
  calloutTitle?: string | null;
  /** False when the closing `:::` was missing and the block runs through EOF. */
  calloutClosed?: boolean;
}

export interface SourceDoc {
  bom: boolean;
  lineEnding: LineEnding;
  hasTrailingNewline: boolean;
  format: Format;
  /** Index where the markdown body (the string passed to remark) begins. */
  bodyStart: number;
  frontmatter: Frontmatter | null;
  blocks: Block[];
  trailing: string;
  style: StyleProfile;
}

export interface ParseOptions {
  filename?: string;
  /** Overrides the extension of `filename`. A `.md` path is never inferred as MDX. */
  format?: Format;
}

export type ParseResult = { ok: true; doc: SourceDoc } | { ok: false; error: string };

export interface TextSpan {
  blockId: string;
  /** Absolute offsets into the original file. The slice equals `value`. */
  start: number;
  end: number;
  value: string;
}

export interface Divergence {
  offset: number;
  line: number;
  column: number;
  expectedSnippet: string;
  actualSnippet: string;
}

export interface IdentityReport {
  status: 'pass' | 'fail' | 'unparseable';
  detail?: string;
  divergence?: Divergence;
}

export interface FileReport {
  file: string;
  status: 'pass' | 'fail' | 'unparseable' | 'error';
  detail?: string;
}

export function blockIsDirty(block: Block): boolean {
  return block.reformat || block.edits.length > 0;
}
