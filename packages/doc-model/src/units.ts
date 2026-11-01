// SPDX-License-Identifier: AGPL-3.0-only

import { parse } from './parse.js';
import type { ParseOptions } from './types.js';

/**
 * Split a file into merge units whose concatenation is the file, byte for byte:
 * frontmatter one line per unit, then one unit per top-level block (the blank lines before
 * it included), then the trailing bytes. A three-way merge over these
 * units keeps every unit no side changed exactly as it was, and a conflict is always whole
 * blocks (ARCHITECTURE §4.5). A file that does not parse, or is not markdown, splits into
 * lines instead.
 */
export function mergeUnits(source: string, options: ParseOptions = {}): string[] {
  const markdown = /\.mdx?$/i.test(options.filename ?? '') || options.format !== undefined;
  const parsed = markdown ? parse(source, options) : null;
  if (!parsed?.ok) return lineUnits(source);
  const doc = parsed.doc;
  const units: string[] = [];
  let head = doc.bom ? '﻿' : '';
  if (doc.frontmatter) {
    const lines = lineUnits(doc.frontmatter.raw);
    lines[0] = head + (lines[0] ?? '');
    units.push(...lines);
    head = '';
  }
  for (const block of doc.blocks) {
    units.push(head + block.gapBefore + block.source);
    head = '';
  }
  // The trailing bytes are their own unit, so a block appended at the end is an insertion
  // and not an edit of the block before it.
  units.push(head + doc.trailing);
  if (units.join('') !== source) return lineUnits(source);
  return units.filter((unit) => unit !== '');
}

/** Lines with their line endings; the last may have none. */
export function lineUnits(source: string): string[] {
  const units = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return units;
}
