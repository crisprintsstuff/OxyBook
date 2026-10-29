// SPDX-License-Identifier: AGPL-3.0-only

import { isScalar, parseDocument } from 'yaml';
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
  parsed.setIn(path, value);
  let after = parsed.toString();
  if (!lf.endsWith('\n') && after.endsWith('\n')) after = after.slice(0, -1);
  const region = changedRegion(lf, after);
  if (!region) return doc;
  if (!regionWithin(region, range[0], range[1])) {
    throw new Error(
      `refusing to edit ${path.join('.')}: the yaml library would change bytes outside that scalar`,
    );
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
