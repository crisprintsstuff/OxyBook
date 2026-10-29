// SPDX-License-Identifier: AGPL-3.0-only

import { parse } from './parse.js';
import { changedRegion, lineAndColumn, snippet } from './range.js';
import { serialize } from './serialize.js';
import type { Divergence, IdentityReport, ParseOptions } from './types.js';

export function divergence(expected: string, actual: string): Divergence | undefined {
  const region = changedRegion(expected, actual);
  if (!region) return undefined;
  const place = lineAndColumn(expected, region.start);
  return {
    offset: region.start,
    line: place.line,
    column: place.column,
    expectedSnippet: snippet(expected, region.start),
    actualSnippet: snippet(actual, region.start),
  };
}

/** parse then serialize. Equal strings pass; a parse error is unparseable, not a failure. */
export function checkIdentity(source: string, options: ParseOptions = {}): IdentityReport {
  const parsed = parse(source, options);
  if (!parsed.ok) return { status: 'unparseable', detail: parsed.error };
  const actual = serialize(parsed.doc);
  if (actual === source) return { status: 'pass' };
  const found = divergence(source, actual);
  const detail = found
    ? `first divergence at line ${found.line} column ${found.column} (offset ${found.offset})`
    : 'serialize differed with no located divergence';
  return { status: 'fail', ...(found ? { divergence: found, detail } : { detail }) };
}
