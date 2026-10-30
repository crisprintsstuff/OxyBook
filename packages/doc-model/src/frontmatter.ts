// SPDX-License-Identifier: AGPL-3.0-only

import { isMap, isPair, isScalar, parseDocument } from 'yaml';
import { changedRegion, regionWithin } from './range.js';
import type { Frontmatter, LineEnding, SourceDoc } from './types.js';

interface Line {
  start: number;
  text: string;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      lines.push({ start, text: source.slice(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < source.length) lines.push({ start, text: source.slice(start) });
  return lines;
}

function yamlParses(yaml: string): boolean {
  if (yaml.replace(/\r\n/g, '\n').trim() === '') return true;
  const doc = parseDocument(yaml.replace(/\r\n/g, '\n'), { keepSourceTokens: true });
  return doc.errors.length === 0;
}

/**
 * YAML frontmatter is a leading `---` line, a body, and a closing `---` line.
 * A thematic break with no closer is left for the markdown parser.
 */
export function splitFrontmatter(
  source: string,
  base: number,
): { frontmatter: Frontmatter | null; bodyStart: number } {
  const rest = source.slice(base);
  if (!/^---[ \t]*\r?\n/.test(rest)) return { frontmatter: null, bodyStart: base };
  const lines = splitLines(rest);
  const opening = lines[0];
  if (!opening || !/^---[ \t]*\r?\n$/.test(opening.text)) {
    return { frontmatter: null, bodyStart: base };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const content = line.text.replace(/\r?\n$/, '');
    if (!/^---[ \t]*$/.test(content)) continue;
    const rawEnd = line.start + line.text.length;
    const yamlStart = opening.text.length;
    const yaml = rest.slice(yamlStart, line.start);
    return {
      frontmatter: {
        raw: rest.slice(0, rawEnd),
        yaml,
        yamlOffset: yamlStart,
        parseable: yamlParses(yaml),
        start: base,
        end: base + rawEnd,
      },
      bodyStart: base + rawEnd,
    };
  }
  return { frontmatter: null, bodyStart: base };
}

export type ScalarValue = string | number | boolean | null;

function toLf(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

/** Map an offset in `toLf(original)` back onto `original`. */
function mapLfOffset(original: string, lfOffset: number): number {
  let lf = 0;
  let index = 0;
  while (index < original.length && lf < lfOffset) {
    if (original.charCodeAt(index) === 13 && original.charCodeAt(index + 1) === 10) {
      index += 2;
      lf += 1;
    } else {
      index += 1;
      lf += 1;
    }
  }
  return index;
}

/**
 * Change one frontmatter scalar.
 *
 * `yaml`'s `Document.toString()` keeps comments, key order, anchors and quoting
 * for LF documents when `keepSourceTokens` is set, but it rewrites CRLF to LF.
 * The edit is therefore computed on an LF copy and spliced back into the
 * original bytes, and it is refused if the library would touch anything
 * outside that scalar.
 */
export function setFrontmatterScalar(
  doc: SourceDoc,
  key: string | readonly (string | number)[],
  value: ScalarValue,
): SourceDoc {
  const frontmatter = doc.frontmatter;
  if (!frontmatter) throw new Error('document has no frontmatter');
  if (!frontmatter.parseable) throw new Error('frontmatter did not parse; it is read-only');

  const path = typeof key === 'string' ? [key] : [...key];
  if (path.length === 0) throw new Error('frontmatter key path is empty');

  const lf = toLf(frontmatter.yaml);
  const parsed = parseDocument(lf, { keepSourceTokens: true });
  if (parsed.errors.length > 0) {
    throw new Error('frontmatter did not parse; it is read-only');
  }
  const node = parsed.getIn(path, true);
  if (!isScalar(node) || !node.range) {
    throw new Error(`frontmatter key ${path.join('.')} is not a scalar`);
  }
  const range = node.range;
  const originalSlice = lf.slice(range[0], range[1]);
  parsed.setIn(path, value);
  let after = parsed.toString();
  if (!lf.endsWith('\n') && after.endsWith('\n')) after = after.slice(0, -1);
  let region = changedRegion(lf, after);
  if (!region) return doc;
  if (!regionWithin(region, range[0], range[1])) {
    // `yaml`'s Document.toString() sometimes reformats unrelated flow collections
    // (e.g. `[1, 2, 3]` -> `[ 1, 2, 3 ]`). Try splicing only the target scalar range
    // and verify the resulting YAML still parses with the expected scalar value.
    const anchorMatch = /^(&\S+\s+)/.exec(originalSlice);
    const anchorPrefix = anchorMatch?.[1] ?? '';
    const bodySlice = originalSlice.slice(anchorPrefix.length);
    let formattedScalar: string;
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) {
      formattedScalar = String(value);
    } else if (bodySlice.startsWith("'") && bodySlice.endsWith("'") && !value.includes('\n')) {
      formattedScalar = `'${value.replace(/'/g, "''")}'`;
    } else if (bodySlice.startsWith('"') && bodySlice.endsWith('"')) {
      formattedScalar = JSON.stringify(value);
    } else if (
      /^[A-Za-z0-9_./ -]+$/.test(value) &&
      !/^(true|false|null|~|\d+(\.\d+)?)$/i.test(value.trim()) &&
      !value.startsWith(' ') &&
      !value.endsWith(' ')
    ) {
      formattedScalar = value;
    } else {
      formattedScalar = JSON.stringify(value);
    }
    const candidateLf = lf.slice(0, range[0]) + anchorPrefix + formattedScalar + lf.slice(range[1]);
    const checkDoc = parseDocument(candidateLf, { keepSourceTokens: true });
    const checkRegion = changedRegion(lf, candidateLf);
    if (
      checkDoc.errors.length === 0 &&
      checkDoc.getIn(path) === value &&
      checkRegion &&
      regionWithin(checkRegion, range[0], range[1])
    ) {
      after = candidateLf;
      region = checkRegion;
    } else {
      throw new Error(
        `refusing to edit ${path.join('.')}: the yaml library would change bytes outside that scalar`,
      );
    }
  }

  let replacement = after.slice(region.start, region.afterEnd);
  if (frontmatter.yaml.includes('\r\n')) replacement = replacement.replace(/\n/g, '\r\n');
  const start = mapLfOffset(frontmatter.yaml, region.start);
  const end = mapLfOffset(frontmatter.yaml, region.beforeEnd);
  const yaml = frontmatter.yaml.slice(0, start) + replacement + frontmatter.yaml.slice(end);
  const raw =
    frontmatter.raw.slice(0, frontmatter.yamlOffset) +
    yaml +
    frontmatter.raw.slice(frontmatter.yamlOffset + frontmatter.yaml.length);

  return {
    ...doc,
    frontmatter: { ...frontmatter, yaml, raw },
  };
}

export function detectLineEnding(source: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      if (i > 0 && source.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export const KNOWN_FRONTMATTER_KEYS = [
  'title',
  'description',
  'slug',
  'nav_title',
  'hidden',
] as const;

export type KnownFrontmatterKey = (typeof KNOWN_FRONTMATTER_KEYS)[number];

export interface KnownFrontmatterFields {
  title?: string;
  description?: string;
  slug?: string;
  nav_title?: string;
  hidden?: boolean;
}

export interface UnknownFrontmatterEntry {
  key: string;
  rawValue: string;
}

export interface FrontmatterInspection {
  exists: boolean;
  parseable: boolean;
  known: KnownFrontmatterFields;
  unknownKeys: UnknownFrontmatterEntry[];
  raw: string | null;
}

const KNOWN_KEY_SET = new Set<string>(KNOWN_FRONTMATTER_KEYS);

/**
 * Inspect frontmatter for the editor's metadata panel (ARCHITECTURE §2.4).
 * Known keys (`title`, `description`, `slug`, `nav_title`, `hidden`) are returned
 * as typed values; every other top-level key is returned read-only with its raw
 * source slice. If the YAML fails to parse, `parseable` is false and the panel
 * disables known-key editing while preserving `raw`.
 */
export function inspectFrontmatter(doc: SourceDoc): FrontmatterInspection {
  const fm = doc.frontmatter;
  if (!fm) {
    return {
      exists: false,
      parseable: true,
      known: {},
      unknownKeys: [],
      raw: null,
    };
  }
  if (!fm.parseable) {
    return {
      exists: true,
      parseable: false,
      known: {},
      unknownKeys: [],
      raw: fm.raw,
    };
  }
  const lf = toLf(fm.yaml);
  const parsed = parseDocument(lf, { keepSourceTokens: true });
  if (parsed.errors.length > 0 || (parsed.contents !== null && !isMap(parsed.contents))) {
    return {
      exists: true,
      parseable: false,
      known: {},
      unknownKeys: [],
      raw: fm.raw,
    };
  }

  const known: KnownFrontmatterFields = {};
  const unknownKeys: UnknownFrontmatterEntry[] = [];

  if (parsed.contents && isMap(parsed.contents)) {
    for (const item of parsed.contents.items) {
      if (!isPair(item) || !isScalar(item.key)) continue;
      const key = String(item.key.value ?? '');
      if (KNOWN_KEY_SET.has(key) && isScalar(item.value)) {
        const val = item.value.value;
        if (key === 'hidden') {
          if (typeof val === 'boolean') known.hidden = val;
        } else if (typeof val === 'string') {
          known[key as Exclude<KnownFrontmatterKey, 'hidden'>] = val;
        } else if (typeof val === 'number') {
          known[key as Exclude<KnownFrontmatterKey, 'hidden'>] = String(val);
        }
      } else {
        const valNode = item.value as { range?: [number, number, number] } | null;
        let rawValue = '';
        if (valNode?.range) {
          rawValue = lf.slice(valNode.range[0], valNode.range[1]).trim();
        } else {
          rawValue = String(parsed.get(key) ?? '');
        }
        unknownKeys.push({ key, rawValue });
      }
    }
  }

  return {
    exists: true,
    parseable: true,
    known,
    unknownKeys,
    raw: fm.raw,
  };
}

function formatYamlScalarLine(
  key: KnownFrontmatterKey,
  value: string | boolean,
  eol: LineEnding,
): string {
  if (typeof value === 'boolean') {
    return `${key}: ${value ? 'true' : 'false'}${eol}`;
  }
  if (
    /^[A-Za-z0-9_./ -]+$/.test(value) &&
    !/^(true|false|null|~|\d+(\.\d+)?)$/i.test(value.trim()) &&
    !value.startsWith(' ') &&
    !value.endsWith(' ')
  ) {
    return `${key}: ${value}${eol}`;
  }
  return `${key}: ${JSON.stringify(value)}${eol}`;
}

/**
 * Update a known frontmatter key from the metadata panel (ARCHITECTURE §2.4):
 * - If the key already exists as a scalar in `doc.frontmatter`, delegates to
 *   `setFrontmatterScalar` so only that scalar's bytes change.
 * - If `doc.frontmatter` exists and is parseable but does not yet have `key`,
 *   inserts `<key>: <value>` immediately before the closing `---` delimiter
 *   without modifying any existing lines.
 * - If `doc.frontmatter` is null, creates a minimal `---` frontmatter block at
 *   the top of the document.
 */
export function updateFrontmatterField(
  doc: SourceDoc,
  key: KnownFrontmatterKey,
  value: string | boolean,
): SourceDoc {
  const fm = doc.frontmatter;
  if (!fm) {
    const eol = doc.lineEnding;
    const yaml = formatYamlScalarLine(key, value, eol);
    const open = `---${eol}`;
    const close = `---${eol}`;
    const raw = `${open}${yaml}${close}`;
    const firstBlock = doc.blocks[0];
    const nextBlocks =
      firstBlock && firstBlock.gapBefore === ''
        ? [{ ...firstBlock, gapBefore: eol }, ...doc.blocks.slice(1)]
        : doc.blocks;
    const base = doc.bom ? 1 : 0;
    return {
      ...doc,
      frontmatter: {
        raw,
        yaml,
        yamlOffset: open.length,
        parseable: true,
        start: base,
        end: base + raw.length,
      },
      blocks: nextBlocks,
    };
  }

  if (!fm.parseable) {
    throw new Error('frontmatter did not parse; it is read-only');
  }

  const lf = toLf(fm.yaml);
  const parsed = parseDocument(lf, { keepSourceTokens: true });
  if (parsed.errors.length > 0) {
    throw new Error('frontmatter did not parse; it is read-only');
  }
  const existingNode = parsed.getIn([key], true);
  if (existingNode !== undefined) {
    return setFrontmatterScalar(doc, key, value);
  }

  const eol: LineEnding = fm.raw.includes('\r\n') ? '\r\n' : doc.lineEnding;
  const line = formatYamlScalarLine(key, value, eol);
  const needsLeadingNewline = fm.yaml.length > 0 && !fm.yaml.endsWith('\n');
  const nextYaml = `${fm.yaml}${needsLeadingNewline ? eol : ''}${line}`;
  const nextRaw =
    fm.raw.slice(0, fm.yamlOffset) + nextYaml + fm.raw.slice(fm.yamlOffset + fm.yaml.length);

  return {
    ...doc,
    frontmatter: {
      ...fm,
      yaml: nextYaml,
      raw: nextRaw,
    },
  };
}
